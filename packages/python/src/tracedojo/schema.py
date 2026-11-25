# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Workflow and report contracts, mirroring the JavaScript SDK's zod schemas.

Every parser returns the same normalized value zod would (defaults filled, text
fields trimmed) and raises SchemaError where zod would reject the input. Report
validation includes the cross-checks that recompute assertions and statuses from
the recorded evidence, so a report accepted here is accepted by the dashboard.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Callable

from ._json import (
    Json,
    JsonError,
    State,
    bounded_json,
    is_integer,
    is_number,
    js_len,
    js_string,
    stable_json,
)

__all__ = [
    "SchemaError",
    "FAULT_TYPES",
    "MODEL_FAULT_TYPES",
    "is_model_fault",
    "parse_workflow",
    "parse_fault",
    "parse_checks",
    "parse_completion",
    "parse_tool_result",
    "parse_report",
    "parse_batch",
    "evaluate_checks",
    "workflow_exit_code",
    "is_name",
    "is_commit_sha",
]


class SchemaError(ValueError):
    """Input or output does not satisfy the TraceDojo contract."""


def _fail(message: str = "Invalid input.") -> Any:
    raise SchemaError(message)


_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}", re.ASCII)
_POINTER = re.compile(r"(?:/(?:[^~]|~[01])*)*", re.DOTALL)
_SHA = re.compile(r"[a-f0-9]{40}")
_HEX64 = re.compile(r"[a-f0-9]{64}")
_RUN_ID = re.compile(r"run_[a-f0-9-]{36}")
_UUID = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"
    r"|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff"
)
_DATETIME = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z"
)
# ECMAScript WhiteSpace and LineTerminator code points (String.prototype.trim).
_JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

FAULT_TYPES = (
    "timeout_before",
    "timeout_after",
    "unavailable",
    "malformed",
    "permission_revoked",
    "duplicate_delivery",
    "stale_read",
)
# Model-layer faults are injected by the proxy runner between an agent and its
# model API. They target every proxied model request, not a named tool.
MODEL_FAULT_TYPES = (
    "rate_limited",
    "server_error",
    "model_timeout",
    "stream_cut",
    "stream_stall",
)
MODEL_FAULT_STATUSES = (500, 502, 503, 504, 529)
ISSUES = (
    "agent_error",
    "tool_contract",
    "call_limit",
    "repeated_calls",
    "cancelled",
    "timed_out",
    "unawaited_calls",
    "evidence_limit",
    "initialization",
    "clock_limit",
    "clock_contract",
)
EVENT_KINDS = (
    "request",
    "model",
    "tool_call",
    "tool_result",
    "delivery",
    "mutation",
    "fault",
    "completion",
    "error",
    "limit",
)
STATUSES = ("passed", "failed", "inconclusive", "cancelled", "timed_out")


def is_name(value: object) -> bool:
    return isinstance(value, str) and _NAME.fullmatch(value) is not None


def is_commit_sha(value: object) -> bool:
    return isinstance(value, str) and _SHA.fullmatch(value) is not None


def _is_json(value: object) -> bool:
    try:
        bounded_json(value, 2**62)
    except JsonError:
        return False
    return True


# -- primitive validators ----------------------------------------------------


def _name(value: object) -> str:
    return value if is_name(value) else _fail()  # type: ignore[return-value]


def _trimmed(value: object, minimum: int, maximum: int) -> str:
    if not isinstance(value, str):
        _fail()
    text = value.strip(_JS_SPACE)  # type: ignore[union-attr]
    if not minimum <= js_len(text) <= maximum:
        _fail()
    return text


def _text(value: object) -> str:
    return _trimmed(value, 1, 2000)


def _string(value: object, maximum: int) -> str:
    if not isinstance(value, str) or js_len(value) > maximum:
        _fail()
    return value  # type: ignore[return-value]


def _int(value: object, minimum: int, maximum: float = float("inf")) -> int:
    if not is_integer(value) or not minimum <= value <= maximum:  # type: ignore[operator]
        _fail()
    return int(value)  # type: ignore[call-overload]


def _bool(value: object) -> bool:
    return value if isinstance(value, bool) else _fail()  # type: ignore[return-value]


def _json(value: object) -> Json:
    return value if _is_json(value) else _fail()  # type: ignore[return-value]


def _object(value: object) -> dict[str, Json]:
    if not isinstance(value, dict) or not _is_json(value):
        _fail()
    return value  # type: ignore[return-value]


def _pointer(value: object) -> str:
    if not isinstance(value, str) or js_len(value) > 500 or not _POINTER.fullmatch(value):
        _fail()
    return value  # type: ignore[return-value]


def _strict(value: object, required: tuple[str, ...], optional: tuple[str, ...] = ()) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail()
    keys = set(value)  # type: ignore[arg-type]
    if not set(required) <= keys or keys - set(required) - set(optional):
        _fail()
    return value  # type: ignore[return-value]


def _literal(value: object, expected: str) -> str:
    return expected if value == expected and isinstance(value, str) else _fail()


def _enum(value: object, options: tuple[str, ...]) -> str:
    return value if isinstance(value, str) and value in options else _fail()  # type: ignore[return-value]


def _array(value: object, minimum: int, maximum: int, item: Callable[[Any], Any]) -> list[Any]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail()
    return [item(v) for v in value]  # type: ignore[union-attr]


# -- workflow ----------------------------------------------------------------


def parse_clock(value: object, report: bool = False) -> dict[str, Any]:
    keys = ("mode", "startMs", "maxTimeMs") + (("endMs",) if report else ())
    data = _strict(value, ("mode",) + (("endMs",) if report else ()), keys)
    clock: dict[str, Any] = {
        "mode": _literal(data["mode"], "virtual"),
        "startMs": _int(data.get("startMs", 0), 0, 8_000_000_000_000_000),
        "maxTimeMs": _int(data.get("maxTimeMs", 60000), 1, 86400000),
    }
    if report:
        clock["endMs"] = _int(data["endMs"], 0, 8_000_000_100_000_000)
    return clock


def parse_fault(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail()
    kind = value.get("type")  # type: ignore[union-attr]
    if kind == "none":
        _strict(value, ("type",))
        return {"type": "none"}
    if kind == "prompt_injection":
        data = _strict(value, ("type", "tool", "replacement"), ("occurrence", "repeat"))
        replacement = data["replacement"]
        try:
            bounded_json(replacement, 16000)
        except JsonError:
            _fail("Injected data exceeds the size or depth limit.")
    elif kind in FAULT_TYPES:
        data = _strict(value, ("type", "tool"), ("occurrence", "repeat"))
    elif kind in MODEL_FAULT_TYPES:
        return _model_fault(value)
    else:
        return _fail()
    fault: dict[str, Any] = {
        "type": kind,
        "tool": _name(data["tool"]),
        "occurrence": _int(data.get("occurrence", 1), 1, 100),
        "repeat": _int(data.get("repeat", 1), 1, 10),
    }
    if kind == "prompt_injection":
        fault["replacement"] = data["replacement"]
    if fault["occurrence"] + fault["repeat"] - 1 > 100 or (
        kind == "permission_revoked" and fault["repeat"] != 1
    ):
        _fail("Invalid fault schedule.")
    return fault


def _model_fault(value: object) -> dict[str, Any]:
    data = _strict(value, ("type", "target"), ("occurrence", "repeat", "status", "afterChunks", "delayMs"))
    kind = data["type"]
    fault: dict[str, Any] = {
        "type": kind,
        "target": _literal(data["target"], "model"),
        "occurrence": _int(data.get("occurrence", 1), 1, 100),
        "repeat": _int(data.get("repeat", 1), 1, 10),
    }
    if "status" in data:
        # HTTP status for server_error: 500, 502, 503, 504, or 529 (default 503).
        status = data["status"]
        if not is_integer(status) or int(status) not in MODEL_FAULT_STATUSES:
            _fail()
        fault["status"] = int(status)
    if "afterChunks" in data:
        # Stream events forwarded before stream_cut or stream_stall (default 1).
        fault["afterChunks"] = _int(data["afterChunks"], 0, 1000)
    if "delayMs" in data:
        # How long model_timeout and stream_stall hold the connection open (default 10000).
        fault["delayMs"] = _int(data["delayMs"], 0, 600000)
    if (
        fault["occurrence"] + fault["repeat"] - 1 > 100
        or ("status" in fault and kind != "server_error")
        or ("afterChunks" in fault and kind not in ("stream_cut", "stream_stall"))
        or ("delayMs" in fault and kind not in ("model_timeout", "stream_stall"))
    ):
        _fail("Invalid fault schedule.")
    return fault


def is_model_fault(fault: dict[str, Any]) -> bool:
    """True for proxy-only faults that target the model API instead of a tool."""
    return "target" in fault


def parse_check(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail()
    kind = value.get("type")  # type: ignore[union-attr]
    base = ("id", "label", "type")
    if kind == "forbidden_tool":
        data = _strict(value, base + ("tool",))
        return {"id": _name(data["id"]), "label": _text(data["label"]), "type": kind, "tool": _name(data["tool"])}
    if kind == "tool_calls":
        data = _strict(value, base + ("tool",), ("min", "max"))
        check: dict[str, Any] = {
            "id": _name(data["id"]),
            "label": _text(data["label"]),
            "type": kind,
            "tool": _name(data["tool"]),
        }
        if "min" in data:
            check["min"] = _int(data["min"], 0, 1000)
        if "max" in data:
            check["max"] = _int(data["max"], 0, 1000)
        if ("min" not in check and "max" not in check) or (
            "min" in check and "max" in check and check["min"] > check["max"]
        ):
            _fail("Set min, max, or both, with min no greater than max.")
        return check
    if kind == "tool_order":
        data = _strict(value, base + ("tools",))
        return {
            "id": _name(data["id"]),
            "label": _text(data["label"]),
            "type": kind,
            "tools": _array(data["tools"], 2, 20, _name),
        }
    if kind == "equals":
        data = _strict(value, base + ("path", "expected"), ("source",))
        return {
            "id": _name(data["id"]),
            "label": _text(data["label"]),
            "type": kind,
            "source": _enum(data.get("source", "state"), ("state", "completion")),
            "path": _pointer(data["path"]),
            "expected": _json(data["expected"]),
        }
    if kind == "count":
        data = _strict(value, base + ("path", "expected"))
        return {
            "id": _name(data["id"]),
            "label": _text(data["label"]),
            "type": kind,
            "path": _pointer(data["path"]),
            "expected": _int(data["expected"], 0),
        }
    if kind == "unchanged":
        data = _strict(value, base + ("path",))
        return {"id": _name(data["id"]), "label": _text(data["label"]), "type": kind, "path": _pointer(data["path"])}
    if kind == "text":
        data = _strict(value, base + ("path",), ("source", "includes", "excludes"))
        check = {
            "id": _name(data["id"]),
            "label": _text(data["label"]),
            "type": kind,
            "source": _enum(data.get("source", "state"), ("state", "completion")),
            "path": _pointer(data["path"]),
        }
        for key in ("includes", "excludes"):
            if key in data:
                check[key] = _array(data[key], 1, 20, _phrase)
        if "includes" not in check and "excludes" not in check:
            _fail("Set includes, excludes, or both.")
        return check
    return _fail()


def _phrase(value: object) -> str:
    text = _string(value, 200)
    return text if text else _fail()  # type: ignore[return-value]


_UPPER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def _text_of(value: object) -> str:
    """Every string under a value, depth first with keys in UTF-16 order, one per line."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [_text_of(v) for v in value]
    elif isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode("utf-16-be", "surrogatepass"))
        parts = [_text_of(value[k]) for k in keys]
    else:
        return ""
    return "\n".join(p for p in parts if p)


def _excerpt(value: str) -> str:
    return value[:500] + "\u2026" if len(value) > 500 else value


def parse_checks(value: object) -> list[dict[str, Any]]:
    checks = _array(value, 1, 50, parse_check)
    if len({c["id"] for c in checks}) != len(checks):
        _fail("Check IDs must be unique.")
    return checks


def _limits(value: object) -> dict[str, int]:
    data = _strict(value, (), ("maxToolCalls", "maxRepeatedCalls", "timeoutMs"))
    return {
        "maxToolCalls": _int(data.get("maxToolCalls", 20), 1, 100),
        "maxRepeatedCalls": _int(data.get("maxRepeatedCalls", 5), 1, 100),
        "timeoutMs": _int(data.get("timeoutMs", 5000), 1, 1800000),
    }


def _scenario(value: object) -> dict[str, Any]:
    data = _strict(value, ("id", "title", "fault"), ("checks",))
    scenario: dict[str, Any] = {
        "id": _name(data["id"]),
        "title": _text(data["title"]),
        "fault": parse_fault(data["fault"]),
    }
    if "checks" in data:
        scenario["checks"] = parse_checks(data["checks"])
    return scenario


def parse_workflow(value: object) -> dict[str, Any]:
    """Validate a workflow/1 suite and return it with defaults applied."""
    try:
        bounded_json(value, 500000)
    except JsonError as error:
        raise SchemaError(str(error)) from None
    data = _strict(
        value,
        ("schemaVersion", "id", "title", "task", "initialState", "checks", "scenarios"),
        ("clock", "limits"),
    )
    workflow: dict[str, Any] = {
        "schemaVersion": _literal(data["schemaVersion"], "workflow/1"),
        "id": _name(data["id"]),
        "title": _text(data["title"]),
        "task": _trimmed(data["task"], 1, 10000),
        "initialState": _object(data["initialState"]),
    }
    if "clock" in data:
        workflow["clock"] = parse_clock(data["clock"])
    workflow["checks"] = parse_checks(data["checks"])
    workflow["scenarios"] = _array(data["scenarios"], 1, 10, _scenario)
    workflow["limits"] = _limits(data.get("limits", {}))
    ids = [s["id"] for s in workflow["scenarios"]]
    if len(set(ids)) != len(ids) or any(
        s["id"] == "baseline" or s["fault"]["type"] == "none" for s in workflow["scenarios"]
    ):
        _fail("Scenario IDs must be unique and cannot use the reserved baseline.")
    return workflow


def parse_completion(value: object) -> dict[str, Any]:
    data = _strict(value, ("status", "message"), ("output",))
    completion: dict[str, Any] = {
        "status": _enum(data["status"], ("completed", "blocked")),
        "message": _string(data["message"], 10000),
    }
    if "output" in data:
        completion["output"] = _json(data["output"])
    return completion


def parse_tool_result(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail()
    if value.get("ok") is True:  # type: ignore[union-attr]
        data = _strict(value, ("ok", "data"))
        return {"ok": True, "data": _json(data["data"])}
    if value.get("ok") is False:  # type: ignore[union-attr]
        data = _strict(value, ("ok", "error"))
        error = _strict(data["error"], ("code", "message", "retryable"))
        return {
            "ok": False,
            "error": {
                "code": _name(error["code"]),
                "message": _text(error["message"]),
                "retryable": _bool(error["retryable"]),
            },
        }
    return _fail()


# -- checks ------------------------------------------------------------------

_MISSING = object()


def _at(value: Any, path: str) -> tuple[bool, Any]:
    """Resolve a JSON Pointer with the same own-property semantics as the JS SDK."""
    current = value
    if path != "":
        for raw in path[1:].split("/"):
            key = raw.replace("~1", "/").replace("~0", "~")
            if isinstance(current, dict):
                if key not in current:
                    return False, _MISSING
                current = current[key]
            elif isinstance(current, list):
                if key == "length":
                    current = len(current)
                elif re.fullmatch(r"0|[1-9][0-9]*", key) and int(key) < len(current):
                    current = current[int(key)]
                else:
                    return False, _MISSING
            else:
                return False, _MISSING
    if current is _MISSING:
        return False, _MISSING
    return True, current


def _plural(n: int) -> str:
    return "" if n == 1 else "s"


def evaluate_checks(
    definitions: list[dict[str, Any]],
    initial: State,
    final: State,
    completion: dict[str, Any] | None,
    events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Port of evaluateChecks; results must match the JavaScript SDK exactly."""
    results: list[dict[str, Any]] = []
    for check in definitions:
        kind = check["type"]
        if kind == "forbidden_tool":
            attempts = [e for e in events if e["kind"] == "tool_call" and e.get("tool") == check["tool"]]
            results.append(
                {
                    "id": check["id"],
                    "label": check["label"],
                    "passed": not attempts,
                    "detail": "No forbidden tool call was attempted."
                    if not attempts
                    else "The agent attempted a forbidden tool call.",
                    "actual": len(attempts),
                    "expected": 0,
                    "evidenceIds": [e["id"] for e in attempts],
                }
            )
            continue
        if kind == "tool_calls":
            calls = [e for e in events if e["kind"] == "tool_call" and e.get("tool") == check["tool"]]
            n = len(calls)
            low, high = check.get("min"), check.get("max")
            passed = (low is None or n >= low) and (high is None or n <= high)
            if low is None:
                expected_range = f"at most {high}"
            elif high is None:
                expected_range = f"at least {low}"
            elif low == high:
                expected_range = f"exactly {low}"
            else:
                expected_range = f"between {low} and {high}"
            expected: dict[str, Any] = {}
            if low is not None:
                expected["min"] = low
            if high is not None:
                expected["max"] = high
            results.append(
                {
                    "id": check["id"],
                    "label": check["label"],
                    "passed": passed,
                    "detail": f"The agent called {check['tool']} {n} time{_plural(n)}; expected {expected_range}.",
                    "actual": n,
                    "expected": expected,
                    "evidenceIds": [e["id"] for e in calls],
                }
            )
            continue
        if kind == "tool_order":
            calls = [e for e in events if e["kind"] == "tool_call"]
            tools = check["tools"]
            matched: list[dict[str, Any]] = []
            for event in calls:
                if len(matched) < len(tools) and event.get("tool") == tools[len(matched)]:
                    matched.append(event)
            passed = len(matched) == len(tools)
            results.append(
                {
                    "id": check["id"],
                    "label": check["label"],
                    "passed": passed,
                    "detail": "The agent called these tools in the expected order."
                    if passed
                    else f"No {tools[len(matched)]} call followed "
                    f"{tools[len(matched) - 1] if matched else 'the start'} in the expected order.",
                    "actual": [e.get("tool") for e in calls],
                    "expected": tools,
                    "evidenceIds": [e["id"] for e in matched],
                }
            )
            continue
        if kind == "text":
            from_completion = check["source"] == "completion"
            found, observed = _at(completion if from_completion else final, check["path"])
            where = check["path"] or "/"
            content = _text_of(observed) if found else ""
            lower = content.translate(_UPPER)
            missing = next((p for p in check.get("includes", []) if p.translate(_UPPER) not in lower), None)
            present = next((p for p in check.get("excludes", []) if p.translate(_UPPER) in lower), None)
            passed = found and missing is None and present is None
            if not found:
                detail = f"Missing value at {where}."
            elif missing is not None:
                detail = f"The text at {where} does not include {js_string(missing)}."
            elif present is not None:
                detail = f"The text at {where} includes {js_string(present)}, which it should not."
            else:
                detail = "The text includes every required phrase and none of the forbidden ones."
            text_result: dict[str, Any] = {"id": check["id"], "label": check["label"], "passed": passed, "detail": detail}
            if found:
                text_result["actual"] = _excerpt(content)
            text_kind = "completion" if from_completion else "mutation"
            text_result["evidenceIds"] = [e["id"] for e in events if e["kind"] == text_kind]
            results.append(text_result)
            continue
        from_completion = kind == "equals" and check["source"] == "completion"
        prior_found, prior = _at(initial, check["path"])
        found, observed = _at(completion if from_completion else final, check["path"])
        if kind == "unchanged":
            expected_value = prior if prior_found else _MISSING
        else:
            expected_value = check["expected"]
        if kind == "count":
            actual = len(observed) if found and isinstance(observed, list) else _MISSING
        else:
            actual = observed if found else _MISSING
        passed = (
            found
            and actual is not _MISSING
            and expected_value is not _MISSING
            and stable_json(actual) == stable_json(expected_value)
        )
        where = check["path"] or "/"
        if not found:
            detail = f"Missing value at {where}."
        elif kind == "count" and not isinstance(observed, list):
            detail = f"Expected an array at {where}."
        elif passed:
            detail = "The observed outcome matches this check."
        else:
            detail = "The observed outcome does not match this check."
        result: dict[str, Any] = {"id": check["id"], "label": check["label"], "passed": passed, "detail": detail}
        if prior_found:
            result["before"] = prior
        if actual is not _MISSING:
            result["actual"] = actual
        if expected_value is not _MISSING:
            result["expected"] = expected_value
        evidence_kind = "completion" if from_completion else "mutation"
        result["evidenceIds"] = [e["id"] for e in events if e["kind"] == evidence_kind]
        results.append(result)
    return results


# -- reports -----------------------------------------------------------------


def _execution(value: object) -> dict[str, Any]:
    data = _strict(value, ("id", "trialsPerScenario", "scenarioIds"), ("commitSha",))
    if not isinstance(data["id"], str) or not _UUID.fullmatch(data["id"]):
        _fail()
    execution: dict[str, Any] = {"id": data["id"]}
    if "commitSha" in data:
        if not is_commit_sha(data["commitSha"]):
            _fail()
        execution["commitSha"] = data["commitSha"]
    execution["trialsPerScenario"] = _int(data["trialsPerScenario"], 1, 20)
    ids = _array(data["scenarioIds"], 1, 10, _name)
    if len(set(ids)) != len(ids) or "baseline" in ids:
        _fail("Invalid planned scenario IDs.")
    execution["scenarioIds"] = ids
    return execution


def _event(value: object) -> dict[str, Any]:
    data = _strict(
        value,
        ("id", "sequence", "kind", "visibility", "detail"),
        ("timeMs", "callId", "tool", "payload"),
    )
    event: dict[str, Any] = {}
    if "timeMs" in data:
        event["timeMs"] = _int(data["timeMs"], 0, 8_000_000_100_000_000)
    event["id"] = _name(data["id"])
    event["sequence"] = _int(data["sequence"], 1)
    event["kind"] = _enum(data["kind"], EVENT_KINDS)
    event["visibility"] = _enum(data["visibility"], ("agent", "evaluator"))
    event["detail"] = _string(data["detail"], 10000)
    if "callId" in data:
        event["callId"] = _name(data["callId"])
    if "tool" in data:
        event["tool"] = _name(data["tool"])
    if "payload" in data:
        event["payload"] = _json(data["payload"])
    return event


def _check_result(value: object) -> dict[str, Any]:
    data = _strict(
        value,
        ("id", "label", "passed", "detail", "evidenceIds"),
        ("before", "actual", "expected"),
    )
    result: dict[str, Any] = {
        "id": _name(data["id"]),
        "label": _text(data["label"]),
        "passed": _bool(data["passed"]),
        "detail": _text(data["detail"]),
    }
    for key in ("before", "actual", "expected"):
        if key in data:
            result[key] = _json(data[key])
    if not isinstance(data["evidenceIds"], list):
        _fail()
    result["evidenceIds"] = [_name(i) for i in data["evidenceIds"]]
    return result


def expected_status(issue: str | None, fault_type: str, triggered: bool, assertions: list[dict[str, Any]]) -> str:
    if issue in ("cancelled", "timed_out"):
        return issue  # type: ignore[return-value]
    if issue in ("call_limit", "repeated_calls"):
        return "failed"
    if issue or (fault_type != "none" and not triggered):
        return "inconclusive"
    return "passed" if all(a["passed"] for a in assertions) else "failed"


def parse_report(value: object) -> dict[str, Any]:
    """Validate a workflow report exactly as the dashboard and upload API do."""
    data = _strict(
        value,
        (
            "schemaVersion",
            "reportType",
            "id",
            "createdAt",
            "workflow",
            "suiteFingerprint",
            "agent",
            "scenario",
            "status",
            "fault",
            "initialState",
            "finalState",
            "definitions",
            "assertions",
            "events",
            "metrics",
        ),
        ("execution", "origin", "issue", "clock", "completion"),
    )
    report: dict[str, Any] = {
        "schemaVersion": _literal(data["schemaVersion"], "1"),
        "reportType": _literal(data["reportType"], "workflow"),
    }
    if not isinstance(data["id"], str) or not _RUN_ID.fullmatch(data["id"]):
        _fail()
    report["id"] = data["id"]
    created = data["createdAt"]
    match = _DATETIME.fullmatch(created) if isinstance(created, str) else None
    if not match:
        _fail()
    try:
        datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)))  # type: ignore[union-attr]
    except ValueError:
        _fail()
    report["createdAt"] = created
    if "execution" in data:
        report["execution"] = _execution(data["execution"])
    if "origin" in data:
        origin = _strict(data["origin"], ("kind", "originalId"))
        report["origin"] = {
            "kind": _literal(origin["kind"], "imported"),
            "originalId": _string(origin["originalId"], 100),
        }
    workflow = _strict(data["workflow"], ("id", "title", "task"))
    report["workflow"] = {
        "id": _name(workflow["id"]),
        "title": _text(workflow["title"]),
        "task": _string(workflow["task"], 10000),
    }
    if not isinstance(data["suiteFingerprint"], str) or not _HEX64.fullmatch(data["suiteFingerprint"]):
        _fail()
    report["suiteFingerprint"] = data["suiteFingerprint"]
    agent = _strict(data["agent"], ("id", "version"))
    report["agent"] = {"id": _name(agent["id"]), "version": _text(agent["version"])}
    scenario = _strict(data["scenario"], ("id", "title", "fault"))
    report["scenario"] = {
        "id": _name(scenario["id"]),
        "title": _text(scenario["title"]),
        "fault": parse_fault(scenario["fault"]),
    }
    report["status"] = _enum(data["status"], STATUSES)
    if "issue" in data:
        report["issue"] = _enum(data["issue"], ISSUES)
    fault = _strict(data["fault"], ("triggered", "triggerCount"))
    report["fault"] = {"triggered": _bool(fault["triggered"]), "triggerCount": _int(fault["triggerCount"], 0, 10)}
    report["initialState"] = _object(data["initialState"])
    if "clock" in data:
        report["clock"] = parse_clock(data["clock"], report=True)
    report["finalState"] = _object(data["finalState"])
    report["definitions"] = parse_checks(data["definitions"])
    report["assertions"] = _array(data["assertions"], 1, 50, _check_result)
    if "completion" in data:
        report["completion"] = parse_completion(data["completion"])
    report["events"] = _array(data["events"], 1, 1000, _event)
    metrics = _strict(data["metrics"], ("toolCalls", "mutations", "durationMs"))
    duration = metrics["durationMs"]
    if not is_number(duration) or duration < 0:
        _fail()
    report["metrics"] = {
        "toolCalls": _int(metrics["toolCalls"], 0, 100),
        "mutations": _int(metrics["mutations"], 0, 110),
        "durationMs": duration,
    }
    _check_report_consistency(report)
    return report


def _check_report_consistency(report: dict[str, Any]) -> None:
    events = report["events"]
    clock = report.get("clock")
    if clock:
        times = [e.get("timeMs") for e in events]
        valid_clock = (
            clock["endMs"] >= clock["startMs"]
            and clock["endMs"] - clock["startMs"] <= clock["maxTimeMs"]
            and times[0] == clock["startMs"]
            and times[-1] == clock["endMs"]
            and all(
                t is not None
                and t >= (times[i - 1] if i else clock["startMs"])  # type: ignore[operator]
                and t <= clock["endMs"]
                for i, t in enumerate(times)
            )
        )
    else:
        valid_clock = all("timeMs" not in e for e in events)
    fault_events = [e for e in events if e["kind"] == "fault"]
    valid_events = all(e["sequence"] == i + 1 and e["id"] == f"evt_{i + 1}" for i, e in enumerate(events))
    assertions = evaluate_checks(
        report["definitions"],
        report["initialState"],
        report["finalState"],
        report.get("completion"),
        events,
    )
    status = expected_status(
        report.get("issue"),
        report["scenario"]["fault"]["type"],
        report["fault"]["triggered"],
        assertions,
    )
    execution = report.get("execution")
    if (
        not valid_events
        or (execution and report["scenario"]["id"] != "baseline" and report["scenario"]["id"] not in execution["scenarioIds"])
        or not valid_clock
        or stable_json(assertions) != stable_json(report["assertions"])
        or status != report["status"]
        or report["fault"]["triggerCount"] != len(fault_events)
        or report["fault"]["triggered"] != (len(fault_events) > 0)
        or (report["scenario"]["fault"]["type"] == "none" and report["fault"]["triggered"])
        or report["metrics"]["toolCalls"] != sum(1 for e in events if e["kind"] == "tool_call")
        or report["metrics"]["mutations"] != sum(1 for e in events if e["kind"] == "mutation")
        or ("issue" not in report and "completion" not in report)
    ):
        _fail("Report outcomes contradict their recorded evidence.")


def parse_batch(value: object) -> dict[str, Any]:
    """Validate a workflow-batch/1 file (no-fault control plus fault trials)."""
    data = _strict(value, ("schemaVersion", "baseline", "runs", "planned"), ("skippedReason",))
    batch: dict[str, Any] = {
        "schemaVersion": _literal(data["schemaVersion"], "workflow-batch/1"),
        "baseline": parse_report(data["baseline"]),
        "runs": _array(data["runs"], 0, 200, parse_report),
        "planned": _int(data["planned"], 1, 200),
    }
    if "skippedReason" in data:
        batch["skippedReason"] = _text(data["skippedReason"])
    base = batch["baseline"]
    runs = batch["runs"]

    def clock_key(report: dict[str, Any]) -> str:
        clock = report.get("clock")
        return stable_json([clock["startMs"], clock["maxTimeMs"]] if clock else None)

    execution = base.get("execution")
    if (
        base["scenario"]["fault"]["type"] != "none"
        or (execution and batch["planned"] != len(execution["scenarioIds"]) * execution["trialsPerScenario"])
        or len(runs) > batch["planned"]
        or (len(runs) < batch["planned"] and "skippedReason" not in batch)
        or (base["status"] != "passed" and runs)
        or any(
            r["suiteFingerprint"] != base["suiteFingerprint"]
            or stable_json(r.get("execution")) != stable_json(execution)
            or stable_json(r["agent"]) != stable_json(base["agent"])
            or clock_key(r) != clock_key(base)
            or r["scenario"]["fault"]["type"] == "none"
            for r in runs
        )
        or len({base["id"], *(r["id"] for r in runs)}) != len(runs) + 1
    ):
        _fail("Batch evidence is inconsistent.")
    return batch


def workflow_exit_code(batch: dict[str, Any]) -> int:
    """0 passed, 1 failed checks, 3 incomplete or inconclusive evidence."""
    reports = [batch["baseline"], *batch["runs"]]
    if batch.get("skippedReason") or any(r["status"] in ("inconclusive", "timed_out", "cancelled") for r in reports):
        return 3
    return 1 if any(r["status"] == "failed" for r in reports) else 0
