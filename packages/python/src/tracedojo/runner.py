# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""The workflow runner: a no-fault control, then controlled tool failures.

This is a line-by-line port of the JavaScript SDK's runWorkflow. Event order,
event payloads, detail strings, statuses, and limits are identical, so reports
from either SDK compare cleanly against each other.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import math
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal, Mapping, Protocol, Union

from ._json import JsonError, bounded_json, clone, is_integer, stable_json, utf8_size
from .clock import ImmediateQueue, TrialClock, WorkflowClock
from .errors import TracedojoError
from .schema import (
    SchemaError,
    _text,
    evaluate_checks,
    expected_status,
    is_commit_sha,
    is_model_fault,
    is_name,
    parse_batch,
    parse_completion,
    parse_report,
    parse_tool_result,
    parse_workflow,
)
from .signal import Signal

ToolResult = dict[str, Any]
Completion = dict[str, Any]
_MISSING: Any = object()


@dataclass(frozen=True)
class ToolContext:
    """Passed to simulated tools. Await ``clock.sleep`` for simulated latency."""

    signal: Signal
    clock: WorkflowClock


ToolHandler = Callable[[dict[str, Any], dict[str, Any], ToolContext], Union[ToolResult, Awaitable[ToolResult]]]


@dataclass(frozen=True)
class Tool:
    """A simulated tool. ``execute(args, state, context)`` mutates only its state draft.

    Only successful writes commit the draft. A read, or a failed write, that
    changes state is a tool contract violation and stops the trial.
    """

    kind: Literal["read", "write"]
    execute: ToolHandler


def tool(kind: Literal["read", "write"]) -> Callable[[ToolHandler], Tool]:
    """Decorator form: ``@tool("write") def reserve_slot(args, state, context): ...``."""

    def wrap(handler: ToolHandler) -> Tool:
        return Tool(kind=kind, execute=handler)

    return wrap


class WorkflowContext:
    """What an agent sees during one trial. Route every tool call through ``call``."""

    __slots__ = ("task", "signal", "clock", "_call", "_record")

    def __init__(
        self,
        task: str,
        signal: Signal,
        clock: WorkflowClock,
        call: Callable[[str, dict[str, Any]], "asyncio.Future[Any]"],
        record: Callable[..., None],
    ) -> None:
        self.task = task
        self.signal = signal
        self.clock = clock
        self._call = call
        self._record = record

    def call(self, tool: str, args: dict[str, Any]) -> "asyncio.Future[ToolResult | str]":
        """Start a simulated tool call. Always await the result.

        Returns the tool result dict, or a string when a malformed response is injected.
        """
        return self._call(tool, args)

    def record_model(self, detail: str, payload: Any = _MISSING) -> None:
        """Record bounded, evaluator-only model telemetry. Never include credentials or private reasoning."""
        self._record(detail, payload)

    def with_call(
        self, call: Callable[[str, dict[str, Any]], "Awaitable[ToolResult | str]"]
    ) -> "WorkflowContext":
        """Return a copy whose ``call`` is replaced, for wrapping an agent's tool calls.

        The replacement must still route through this context's ``call``.
        """
        return WorkflowContext(self.task, self.signal, self.clock, call, self._record)  # type: ignore[arg-type]


class Agent(Protocol):
    id: str
    version: str

    async def run(self, context: WorkflowContext) -> Completion: ...


class Adapter(Protocol):
    tools: Mapping[str, Tool]

    def create_agent(self) -> Agent: ...


@dataclass
class SimpleAdapter:
    """Bundle tools and an agent factory when you do not use an adapter module."""

    tools: Mapping[str, Tool]
    create_agent: Callable[[], Any]


class TrialStopped(Exception):
    """Raised to the agent when the trial stops; the reason becomes the report issue."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _quiet(future: "asyncio.Future[Any]") -> None:
    if not future.cancelled():
        future.exception()


def _failure(code: str, message: str, retryable: bool = False) -> ToolResult:
    return {"ok": False, "error": {"code": code, "message": message, "retryable": retryable}}


def _metadata(agent: Any) -> dict[str, str]:
    agent_id, version = _get(agent, "id"), _get(agent, "version")
    if not is_name(agent_id):
        raise SchemaError("Invalid agent id.")
    if not isinstance(version, str):
        raise SchemaError("Invalid agent version.")
    return {"id": agent_id, "version": _text(version)}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class _Trial:
    def __init__(
        self,
        workflow: dict[str, Any],
        tools: Mapping[str, Tool],
        agent: Any,
        scenario: dict[str, Any],
        fingerprint: str,
        execution: dict[str, Any],
        signal: Signal | None,
    ) -> None:
        self.workflow = workflow
        self.tools = tools
        self.agent = agent
        self.scenario = scenario
        self.fingerprint = fingerprint
        self.execution = execution
        self.external = signal
        self.fault = scenario["fault"]
        self.limits = workflow["limits"]
        self.loop = asyncio.get_running_loop()
        self.start = time.perf_counter()
        self.initial_state = clone(workflow["initialState"])
        self.state = clone(self.initial_state)
        self.events: list[dict[str, Any]] = []
        self.controller = Signal()
        self.issue: str | None = None
        self.completion: dict[str, Any] | None = None
        self.closed = False
        self.pending = 0
        self.calls = 0
        self.admitted = 0
        self.occurrences = 0
        self.trigger_count = 0
        self.evidence_bytes = 0
        self.fatal: TrialStopped | None = None
        self.clock_failure: asyncio.Future[None] = self.loop.create_future()
        self.clock_failure.add_done_callback(_quiet)
        self.immediate = ImmediateQueue(self.loop)
        self.clock = TrialClock(workflow.get("clock"), self.controller, self._on_clock_fault, self.immediate)
        self.revoked: set[str] = set()
        self.patterns: dict[str, int] = {}
        self.read_snapshots: dict[str, dict[str, Any]] = {}
        self.tail: asyncio.Future[Any] | None = None
        self.tasks: set[asyncio.Future[Any]] = set()

    # -- evidence ------------------------------------------------------------

    def _on_clock_fault(self, reason: str) -> None:
        if self.fatal is None:
            self.fatal = TrialStopped(reason)
        if not self.clock_failure.done():
            self.clock_failure.set_exception(self.fatal)

    def _stamp(self, event: dict[str, Any]) -> dict[str, Any]:
        stamped = {**event, "id": f"evt_{len(self.events) + 1}", "sequence": len(self.events) + 1}
        if self.workflow.get("clock"):
            stamped["timeMs"] = self.clock.api.now()
        return stamped

    def emit(self, event: dict[str, Any]) -> None:
        bounded_json(event, 100000)
        self.evidence_bytes += utf8_size(event)
        if len(self.events) >= 990 or self.evidence_bytes > 600000:
            raise TrialStopped("evidence_limit")
        self.events.append(clone(self._stamp(event)))

    def inject(self, tool: str, call_id: str, extra: dict[str, Any] | None = None) -> None:
        self.emit(
            {
                "kind": "fault",
                "visibility": "evaluator",
                "tool": tool,
                "callId": call_id,
                "detail": f"Injected {self.fault['type']}.",
                "payload": {
                    **(extra or {}),
                    "occurrence": self.occurrences,
                    "triggerCount": self.trigger_count + 1,
                },
            }
        )
        self.trigger_count += 1

    def guard(self) -> None:
        if (
            self.closed
            or self.controller.aborted
            or (time.perf_counter() - self.start) * 1000 >= self.limits["timeoutMs"]
        ):
            raise TrialStopped("cancelled" if self.external and self.external.aborted else "timed_out")
        if self.fatal:
            raise self.fatal

    def _fatalize(self, error: BaseException) -> TrialStopped:
        if self.fatal is None:
            self.fatal = error if isinstance(error, TrialStopped) else TrialStopped("tool_contract")
        return self.fatal

    # -- tool calls ----------------------------------------------------------

    async def execute(self, tool: str, payload: Any) -> ToolResult | str:
        self.guard()
        if self.calls >= self.limits["maxToolCalls"]:
            raise TrialStopped("call_limit")
        bounded_json(payload, 16000)
        if not isinstance(payload, dict) or not isinstance(tool, str):
            raise TrialStopped("tool_contract")
        args = clone(payload)
        key = stable_json([tool, args])
        count = self.patterns.get(key, 0) + 1
        if count > self.limits["maxRepeatedCalls"]:
            raise TrialStopped("repeated_calls")
        self.patterns[key] = count
        self.calls += 1
        call_id = f"call_{self.calls}"
        self.emit(
            {
                "kind": "tool_call",
                "visibility": "agent",
                "tool": tool,
                "callId": call_id,
                "detail": f"Call {self.calls}",
                "payload": args,
            }
        )
        definition = self.tools.get(tool)
        fault = self.fault
        kind = fault["type"]
        matches = "tool" in fault and tool == fault["tool"]
        if matches:
            self.occurrences += 1
        target = (
            matches
            and self.occurrences >= fault["occurrence"]
            and self.occurrences < fault["occurrence"] + fault["repeat"]
        )
        response: ToolResult | str
        if definition is None:
            response = _failure("UNKNOWN_TOOL", "This tool is not registered in the simulated workflow.")
        elif target and kind in ("timeout_before", "unavailable"):
            self.inject(tool, call_id)
            response = (
                _failure("TIMEOUT", "The request timed out. Its outcome could not be confirmed.", True)
                if kind == "timeout_before"
                else _failure("SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", True)
            )
        else:
            if target and kind == "permission_revoked":
                self.revoked.add(tool)
                self.inject(tool, call_id)
            if tool in self.revoked:
                response = _failure("PERMISSION_DENIED", "Write access to this tool has been revoked.")
            else:
                original = await self._deliver(definition, tool, call_id, args, 1, target)
                if target and kind == "duplicate_delivery":
                    self.emit(
                        {
                            "kind": "tool_result",
                            "visibility": "evaluator",
                            "tool": tool,
                            "callId": call_id,
                            "detail": "First delivery response; this is the response returned to the agent.",
                            "payload": original,
                        }
                    )
                    self.inject(tool, call_id)
                    duplicate = await self._deliver(definition, tool, call_id, args, 2, target)
                    self.emit(
                        {
                            "kind": "tool_result",
                            "visibility": "evaluator",
                            "tool": tool,
                            "callId": call_id,
                            "detail": "Duplicate delivery response, hidden from the agent.",
                            "payload": duplicate,
                        }
                    )
                response = original
                if matches and kind == "stale_read" and original["ok"]:
                    snapshot = self.read_snapshots.get(key)
                    if target and snapshot and stable_json(snapshot["result"]) != stable_json(original):
                        self.emit(
                            {
                                "kind": "tool_result",
                                "visibility": "evaluator",
                                "tool": tool,
                                "callId": call_id,
                                "detail": "Fresh read response, hidden from the agent.",
                                "payload": original,
                            }
                        )
                        self.inject(tool, call_id, {"sourceCallId": snapshot["callId"]})
                        response = clone(snapshot["result"])
                    # Pin the first successful read of these inputs for this trial only.
                    if not snapshot:
                        self.read_snapshots[key] = {"result": clone(original), "callId": call_id}
                if target and (
                    (kind == "timeout_after" and original["ok"])
                    or (kind == "prompt_injection" and original["ok"])
                    or kind == "malformed"
                ):
                    self.emit(
                        {
                            "kind": "tool_result",
                            "visibility": "evaluator",
                            "tool": tool,
                            "callId": call_id,
                            "detail": "Original tool response, hidden from the agent.",
                            "payload": original,
                        }
                    )
                    self.inject(tool, call_id)
                    if kind == "timeout_after":
                        response = _failure(
                            "TIMEOUT", "The request timed out. Its outcome could not be confirmed.", True
                        )
                    elif kind == "prompt_injection":
                        response = {"ok": True, "data": clone(fault["replacement"])}
                    else:
                        response = '{"ok":true,"data":'
        self.emit(
            {
                "kind": "tool_result",
                "visibility": "agent",
                "tool": tool,
                "callId": call_id,
                "detail": "Response delivered to the agent.",
                "payload": response,
            }
        )
        return clone(response)

    async def _deliver(
        self, definition: Tool, tool: str, call_id: str, args: dict[str, Any], delivery: int, target: bool
    ) -> ToolResult:
        self.guard()
        if target and self.fault["type"] == "duplicate_delivery":
            self.emit(
                {
                    "kind": "delivery",
                    "visibility": "evaluator",
                    "tool": tool,
                    "callId": call_id,
                    "detail": f"Simulated write delivery {delivery}.",
                    "payload": {"delivery": delivery, "args": args},
                }
            )
        draft = clone(self.state)
        try:
            raw = definition.execute(clone(args), draft, ToolContext(self.controller, self.clock.api))
            if inspect.isawaitable(raw):
                raw = await raw
            # A late result cannot commit after cancellation, a deadline, or completion.
            self.guard()
            bounded_json(raw, 16000)
            bounded_json(draft, 100000)
            original = parse_tool_result(raw)
            changed = stable_json(self.state) != stable_json(draft)
            if changed and (definition.kind == "read" or not original["ok"]):
                raise TrialStopped("tool_contract")
            if changed:
                # Reserve evidence before committing; an evidence overflow cannot hide a write.
                self.emit(
                    {
                        "kind": "mutation",
                        "visibility": "evaluator",
                        "tool": tool,
                        "callId": call_id,
                        "detail": "Committed in the simulated tool. Hidden from the agent.",
                        "payload": {"before": self.state, "after": draft},
                    }
                )
                self.state = clone(draft)
            return clone(original)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if self.fatal:
                raise self.fatal from None
            self.guard()
            raise (error if isinstance(error, TrialStopped) else TrialStopped("tool_contract")) from None

    def call(self, tool: str, args: Any) -> "asyncio.Future[Any]":
        # Admission runs synchronously, like the JS SDK, so arguments are captured
        # at call time even if the agent mutates them before awaiting.
        self.pending += 1
        previous = self.tail
        try:
            self.guard()
            self.admitted += 1
            if self.admitted > self.limits["maxToolCalls"]:
                raise TrialStopped("call_limit")
            bounded_json(args, 16000)
            captured = clone(args)
        except Exception as error:
            self.pending -= 1
            future: asyncio.Future[Any] = self.loop.create_future()
            future.set_exception(self._fatalize(error))
            future.add_done_callback(_quiet)
            self.tail = future
            return future
        task = self.loop.create_task(self._serialized(tool, captured, previous))
        # An agent may forget to await a call. Keep that a recorded protocol failure
        # instead of an unretrieved task exception.
        task.add_done_callback(_quiet)
        self.tail = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def _serialized(self, tool: str, args: Any, previous: "asyncio.Future[Any] | None") -> Any:
        # Serialize whole transactions, including awaits. Each draft starts from the
        # previous committed state; overlapping agent calls cannot lose each other's writes.
        try:
            if previous is not None and not previous.done():
                await asyncio.wait({previous})
            release = self.clock.hold()
            try:
                await self.immediate.wait()
            finally:
                release()
            return await self.execute(tool, args)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise self._fatalize(error) from None
        finally:
            self.pending -= 1

    def record_model(self, detail: Any, payload: Any = _MISSING) -> None:
        self.guard()
        if not isinstance(detail, str) or len(detail.encode("utf-16-le", "surrogatepass")) // 2 > 2000:
            raise SchemaError("Model observations need a detail string of at most 2000 characters.")
        event: dict[str, Any] = {"kind": "model", "visibility": "evaluator", "detail": detail}
        if payload is not _MISSING:
            try:
                bounded_json(payload, 2**62)
            except JsonError:
                raise SchemaError("Model observation payloads must be JSON.") from None
            event["payload"] = payload
        self.emit(event)

    # -- the trial -----------------------------------------------------------

    async def run(self) -> dict[str, Any]:
        self.emit({"kind": "request", "visibility": "agent", "detail": self.workflow["task"]})
        timer: asyncio.TimerHandle | None = None
        deadline: asyncio.Future[None] = self.loop.create_future()
        cancelled: asyncio.Future[None] = self.loop.create_future()
        agent_task: asyncio.Task[Any] | None = None

        def on_external_abort() -> None:
            self.controller.abort()
            if not cancelled.done():
                cancelled.set_result(None)

        def on_deadline() -> None:
            self.controller.abort()
            if not deadline.done():
                deadline.set_result(None)

        if self.external:
            self.external.add_listener(on_external_abort)
        try:
            if self.external and self.external.aborted:
                raise TrialStopped("cancelled")
            timer = self.loop.call_later(self.limits["timeoutMs"] / 1000, on_deadline)
            context = WorkflowContext(
                self.workflow["task"], self.controller, self.clock.api, self.call, self.record_model
            )
            run = _get(self.agent, "run")

            async def invoke() -> Any:
                result = run(context)
                if inspect.isawaitable(result):
                    result = await result
                return result

            agent_task = self.loop.create_task(invoke())
            agent_task.add_done_callback(_quiet)
            await asyncio.wait(
                {agent_task, deadline, cancelled, self.clock_failure},
                return_when=asyncio.FIRST_COMPLETED,
            )
            # Promise.race order: a clock fault, cancellation, or deadline settles the
            # race the moment it happens, before any agent result that follows it.
            if self.clock_failure.done():
                raise self.fatal  # type: ignore[misc]
            if cancelled.done():
                raise TrialStopped("cancelled")
            if deadline.done():
                raise TrialStopped("timed_out")
            if agent_task.cancelled():
                raise RuntimeError("The agent cancelled its own run.")
            raw = agent_task.result()
            self.guard()
            if self.pending or self.clock.pending:
                raise TrialStopped("unawaited_calls")
            bounded_json(raw, 16000)
            self.completion = parse_completion(raw)
            self.emit(
                {
                    "kind": "completion",
                    "visibility": "agent",
                    "detail": self.completion["message"],
                    "payload": self.completion,
                }
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.issue = error.reason if isinstance(error, TrialStopped) else "agent_error"
            limit = self.issue in ("call_limit", "repeated_calls", "timed_out", "cancelled", "evidence_limit")
            self.events.append(
                self._stamp(
                    {
                        "kind": "limit" if limit else "error",
                        "visibility": "evaluator",
                        "detail": f"Run stopped: {self.issue}. Partial evidence preserved.",
                    }
                )
            )
        finally:
            self.closed = True
            self.controller.abort()
            self.clock.close()
            if timer:
                timer.cancel()
            if self.external:
                self.external.remove_listener(on_external_abort)
            for leftover in [agent_task, *self.tasks]:
                if leftover is not None and not leftover.done():
                    leftover.cancel()
        return self.report()

    def report(self) -> dict[str, Any]:
        definitions = self.scenario.get("checks") or self.workflow["checks"]
        assertions = evaluate_checks(definitions, self.initial_state, self.state, self.completion, self.events)
        status = expected_status(self.issue, self.fault["type"], self.trigger_count > 0, assertions)
        duration = (time.perf_counter() - self.start) * 1000
        report: dict[str, Any] = {
            "schemaVersion": "1",
            "reportType": "workflow",
            "id": f"run_{uuid.uuid4()}",
            "createdAt": _now_iso(),
            "execution": self.execution,
            "workflow": {
                "id": self.workflow["id"],
                "title": self.workflow["title"],
                "task": self.workflow["task"],
            },
            "suiteFingerprint": self.fingerprint,
            "agent": _metadata(self.agent),
            "scenario": {"id": self.scenario["id"], "title": self.scenario["title"], "fault": self.fault},
            "status": status,
        }
        if self.issue:
            report["issue"] = self.issue
        report["fault"] = {"triggered": self.trigger_count > 0, "triggerCount": self.trigger_count}
        report["initialState"] = self.initial_state
        snapshot = self.clock.snapshot
        if snapshot:
            report["clock"] = snapshot
        report["finalState"] = self.state
        report["definitions"] = definitions
        report["assertions"] = assertions
        if self.completion:
            report["completion"] = self.completion
        report["events"] = self.events
        report["metrics"] = {
            "toolCalls": sum(1 for e in self.events if e["kind"] == "tool_call"),
            "mutations": sum(1 for e in self.events if e["kind"] == "mutation"),
            "durationMs": math.floor(duration * 100 + 0.5) / 100,
        }
        return parse_report(clone(report))


def _normalize_tools(tools: Any) -> dict[str, Tool]:
    if not isinstance(tools, Mapping) or not 1 <= len(tools) <= 50:
        raise TracedojoError("Provide tools and a synchronous create_agent factory.")
    normalized: dict[str, Tool] = {}
    for name, item in tools.items():
        kind, execute = _get(item, "kind"), _get(item, "execute")
        if not is_name(name) or kind not in ("read", "write") or not callable(execute):
            raise TracedojoError("Every tool needs a valid name, read/write kind, and execute function.")
        normalized[name] = item if isinstance(item, Tool) else Tool(kind=kind, execute=execute)
    return normalized


async def run_workflow(
    workflow: Any,
    adapter: Any,
    *,
    trials: int = 1,
    signal: Signal | None = None,
    commit_sha: str | None = None,
) -> dict[str, Any]:
    """Run trusted local agent code against isolated, developer-defined simulated tools.

    Runs a no-fault control first. Fault trials run only if the control passes,
    and stop after an interrupted or inconclusive trial. Returns a
    ``workflow-batch/1`` dict that validates against the JavaScript SDK's schema.
    """
    workflow = parse_workflow(workflow)
    if commit_sha is not None and not is_commit_sha(commit_sha):
        raise SchemaError("commit_sha must be a full lowercase Git SHA.")
    if not is_integer(trials) or not 1 <= trials <= 20:
        raise SchemaError("trials must be from 1 to 20.")
    trials = int(trials)
    execution: dict[str, Any] = {"id": str(uuid.uuid4())}
    if commit_sha:
        execution["commitSha"] = commit_sha
    execution["trialsPerScenario"] = trials
    execution["scenarioIds"] = [s["id"] for s in workflow["scenarios"]]
    create_agent = _get(adapter, "create_agent")
    if adapter is None or not callable(create_agent):
        raise TracedojoError("Provide tools and a synchronous create_agent factory.")
    tools = _normalize_tools(_get(adapter, "tools"))
    for scenario in workflow["scenarios"]:
        fault = scenario["fault"]
        if is_model_fault(fault):
            raise TracedojoError(
                "Model faults need the proxy runner (npx tracedojo proxy); run_workflow injects tool faults only."
            )
        target = tools.get(fault["tool"])
        if target is None or (
            (fault["type"] in ("permission_revoked", "duplicate_delivery") and target.kind != "write")
            or (fault["type"] == "stale_read" and target.kind != "read")
        ):
            raise TracedojoError(
                "Every fault must target a registered tool; permission revocation and duplicate delivery "
                "require a write tool; stale reads require a read tool."
            )
    fingerprint = hashlib.sha256(stable_json(workflow).encode("utf-8")).hexdigest()
    seen: list[Any] = []
    identity: dict[str, str] | None = None

    def instantiate() -> Any:
        nonlocal identity
        try:
            agent = create_agent()
            if inspect.isawaitable(agent):
                if inspect.iscoroutine(agent):
                    agent.close()
                raise ValueError
            if agent is None or not callable(_get(agent, "run")) or any(a is agent for a in seen):
                raise ValueError
            current = _metadata(agent)
            if identity and stable_json(current) != stable_json(identity):
                raise ValueError
            identity = current
            seen.append(agent)
            return agent
        except Exception:
            raise TracedojoError(
                "create_agent must return a fresh agent with stable id/version and a run function."
            ) from None

    baseline = await _Trial(
        workflow,
        tools,
        instantiate(),
        {"id": "baseline", "title": "No-fault control", "fault": {"type": "none"}},
        fingerprint,
        execution,
        signal,
    ).run()
    batch: dict[str, Any] = {
        "schemaVersion": "workflow-batch/1",
        "baseline": baseline,
        "runs": [],
        "planned": len(workflow["scenarios"]) * trials,
    }
    if baseline["status"] != "passed":
        batch["skippedReason"] = "The no-fault control did not pass. Fault trials were skipped."
    else:
        stop = False
        for scenario in workflow["scenarios"]:
            for _ in range(trials):
                if signal and signal.aborted:
                    batch["skippedReason"] = "Remaining trials were cancelled."
                    stop = True
                    break
                try:
                    agent = instantiate()
                except TracedojoError:
                    batch["skippedReason"] = (
                        "Agent initialization changed or failed. Completed evidence was preserved."
                    )
                    stop = True
                    break
                report = await _Trial(workflow, tools, agent, scenario, fingerprint, execution, signal).run()
                batch["runs"].append(report)
                if report["status"] in ("inconclusive", "cancelled", "timed_out"):
                    batch["skippedReason"] = (
                        "Stopped after an interrupted or inconclusive trial. Completed evidence was preserved."
                    )
                    stop = True
                    break
            if stop:
                break
    return parse_batch(batch)


def run_workflow_sync(
    workflow: Any,
    adapter: Any,
    *,
    trials: int = 1,
    signal: Signal | None = None,
    commit_sha: str | None = None,
) -> dict[str, Any]:
    """Synchronous wrapper around :func:`run_workflow` for scripts and test suites."""
    return asyncio.run(run_workflow(workflow, adapter, trials=trials, signal=signal, commit_sha=commit_sha))
