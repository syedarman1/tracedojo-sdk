# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Runner behavior specific to the Python API (event loop, cancellation, adapters)."""

from __future__ import annotations

import asyncio
import copy

import pytest

from tracedojo import (
    Signal,
    SimpleAdapter,
    TracedojoError,
    SchemaError,
    parse_batch,
    run_workflow,
    run_workflow_sync,
    tool,
)
from tracedojo.demo import booking_workflow
from tracedojo.templates.booking import adapter as booking


def workflow(**overrides):
    base = booking_workflow()
    base.update(overrides)
    return base


class Agent:
    id = "agent"
    version = "1"

    def __init__(self, run):
        self._run = run

    async def run(self, context):
        return await self._run(context)


def adapter(run, tools=None):
    return SimpleAdapter(tools or booking.tools, lambda: Agent(run))


async def book(context, key="k"):
    result = await context.call("reserve_slot", {"customerId": "customer_7", "slot": "slot_42", "operationKey": key})
    return {"status": "completed", "message": "ok", "output": {"bookingId": result["data"]["id"]}}


def test_sync_wrapper_and_async_api_agree():
    sync = run_workflow_sync(booking_workflow(), booking)
    asynchronous = asyncio.run(run_workflow(booking_workflow(), booking))
    assert [r["status"] for r in sync["runs"]] == [r["status"] for r in asynchronous["runs"]]
    assert sync["baseline"]["suiteFingerprint"] == asynchronous["baseline"]["suiteFingerprint"]
    assert parse_batch(sync) == sync


def test_adapter_contract_errors_are_actionable():
    with pytest.raises(TracedojoError, match="create_agent"):
        run_workflow_sync(booking_workflow(), SimpleAdapter({}, lambda: None))
    with pytest.raises(TracedojoError, match="valid name"):
        run_workflow_sync(booking_workflow(), SimpleAdapter({"bad name": booking.reserve_slot}, booking.create_agent))
    reads = {"reserve_slot": tool("read")(booking.reserve_slot.execute)}
    with pytest.raises(TracedojoError, match="write tool"):
        run_workflow_sync(booking_workflow(), SimpleAdapter(reads, booking.create_agent))

    async def factory():
        return booking.create_agent()

    with pytest.raises(TracedojoError, match="fresh agent"):
        run_workflow_sync(booking_workflow(), SimpleAdapter(booking.tools, factory))
    with pytest.raises(SchemaError):
        run_workflow_sync(booking_workflow(), booking, trials=21)
    with pytest.raises(SchemaError):
        run_workflow_sync(booking_workflow(), booking, commit_sha="ABC")


def test_reused_or_changed_agents_stop_with_preserved_evidence():
    shared = booking.create_agent()
    batch = run_workflow_sync(booking_workflow(), SimpleAdapter(booking.tools, lambda: shared))
    assert batch["baseline"]["status"] == "passed"
    assert batch["runs"] == []
    assert batch["skippedReason"].startswith("Agent initialization changed")

    versions = iter(["1", "2"])

    def changing():
        agent = booking.create_agent()
        agent.version = next(versions, "3")
        return agent

    batch = run_workflow_sync(booking_workflow(), SimpleAdapter(booking.tools, changing))
    assert batch["runs"] == [] and "skippedReason" in batch


def test_arguments_are_captured_when_the_call_starts():
    async def run(context):
        args = {"customerId": "customer_7", "slot": "slot_42", "operationKey": "k"}
        pending = context.call("reserve_slot", args)
        args["slot"] = "slot_99"
        result = await pending
        return {"status": "completed", "message": "ok", "output": {"bookingId": result["data"]["id"]}}

    batch = run_workflow_sync(booking_workflow(), adapter(run))
    assert batch["baseline"]["finalState"]["bookings"][0]["slot"] == "slot_42"


def test_external_cancellation_marks_the_trial_cancelled():
    signal = Signal()

    async def run(context):
        asyncio.get_running_loop().call_later(0.01, signal.abort)
        await asyncio.sleep(1)
        return await book(context)

    batch = run_workflow_sync(booking_workflow(), adapter(run), signal=signal)
    assert batch["baseline"]["status"] == "cancelled"
    assert batch["baseline"]["issue"] == "cancelled"
    assert batch["runs"] == []


def test_real_clock_sleeps_and_tool_context_is_read_only():
    seen = {}

    async def run(context):
        start = context.clock.now()
        await context.clock.sleep(5)
        seen["elapsed"] = context.clock.now() - start
        with pytest.raises(AttributeError):
            context.clock.now = lambda: 0
        return await book(context)

    batch = run_workflow_sync(booking_workflow(), adapter(run))
    assert batch["baseline"]["status"] == "passed"
    assert seen["elapsed"] >= 4
    assert "clock" not in batch["baseline"]


def test_sync_agents_and_async_tools_are_supported():
    @tool("write")
    async def reserve_slot(args, state, context):
        await context.clock.sleep(1)
        return booking.reserve_slot.execute(args, state, context)

    class SyncAgent:
        id = "sync-agent"
        version = "1"

        def run(self, context):
            return {"status": "blocked", "message": "Declined without calling tools."}

    batch = run_workflow_sync(booking_workflow(), SimpleAdapter({"reserve_slot": reserve_slot}, SyncAgent))
    assert batch["baseline"]["status"] == "failed"
    assert batch["baseline"]["completion"]["status"] == "blocked"


def test_model_observations_are_bounded_and_evaluator_only():
    async def run(context):
        context.record_model("Picked reserve_slot.", {"tokens": 10})
        with pytest.raises(SchemaError):
            context.record_model("x" * 2001)
        with pytest.raises(SchemaError):
            context.record_model("bad payload", {"value": float("nan")})
        return await book(context)

    batch = run_workflow_sync(booking_workflow(), adapter(run))
    models = [e for e in batch["baseline"]["events"] if e["kind"] == "model"]
    assert models == [
        {"id": "evt_2", "sequence": 2, "kind": "model", "visibility": "evaluator", "detail": "Picked reserve_slot.", "payload": {"tokens": 10}}
    ]


def test_input_workflow_is_not_mutated():
    original = booking_workflow()
    snapshot = copy.deepcopy(original)
    run_workflow_sync(original, booking)
    assert original == snapshot


def test_booking_template_is_the_javascript_template():
    from pathlib import Path

    js_template = Path(__file__).resolve().parents[2] / "sdk" / "templates" / "workflow.json"
    if not js_template.is_file():
        pytest.skip("Not running from the SDK repository.")
    python_template = Path(__file__).resolve().parents[1] / "src" / "tracedojo" / "templates" / "booking" / "workflow.json"
    assert python_template.read_bytes() == js_template.read_bytes()


def test_model_faults_need_the_proxy_runner() -> None:
    from tracedojo import TracedojoError

    workflow = booking_workflow()
    workflow["scenarios"] = [{"id": "m", "title": "Rate limited", "fault": {"type": "rate_limited", "target": "model"}}]
    with pytest.raises(TracedojoError, match="proxy runner"):
        run_workflow_sync(workflow, booking)


def test_an_unreached_fault_skips_only_its_own_scenario():
    unreached = copy.deepcopy(booking_workflow()["scenarios"][0])
    unreached.update(id="unreached", fault={**unreached["fault"], "occurrence": 5})
    scenarios = [unreached, *booking_workflow()["scenarios"]]
    batch = run_workflow_sync(workflow(scenarios=scenarios), booking, trials=2)
    assert "skippedReason" not in batch
    assert batch["runs"][0]["status"] == "inconclusive"
    assert not batch["runs"][0]["fault"]["triggered"]
    assert [r["scenario"]["id"] for r in batch["runs"]] == [s["id"] for s in scenarios for _ in range(2)]
    assert all(r["fault"]["triggered"] for r in batch["runs"][2:])
