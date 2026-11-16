# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""LangGraph adapter: a real StateGraph with ToolNode, driven by a scripted chat model."""

from __future__ import annotations

import json
from typing import Any

import pytest

pytest.importorskip("langgraph")

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool as lc_tool
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from tracedojo import run_workflow_sync
from tracedojo.demo import booking_workflow
from tracedojo.langgraph import LangGraphAgent, ToolSpec, create_tools
from tracedojo.templates.booking import adapter as booking

LIVE_CALLS: list[Any] = []


@lc_tool
def reserve_slot(customerId: str, slot: str, operationKey: str) -> dict:
    """Reserve a meeting slot for a customer. Reuse operationKey when retrying."""
    LIVE_CALLS.append((customerId, slot, operationKey))  # must never run under TraceDojo
    raise AssertionError("The live tool was called.")


class ScriptedModel(BaseChatModel):
    """Deterministic stand-in for an LLM: books, retries retryable errors, reports honestly."""

    stable_key: bool = True

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedModel":
        return self

    def _generate(self, messages: list[Any], stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        results = [m for m in messages if isinstance(m, ToolMessage)]
        if results:
            try:
                last = json.loads(results[-1].content)
            except ValueError:
                last = None
            if isinstance(last, dict) and last.get("ok"):
                return self._say(json.dumps({"status": "completed", "bookingId": last["data"]["id"]}))
            if isinstance(last, dict) and not last["error"]["retryable"]:
                return self._say(json.dumps({"status": "blocked", "reason": last["error"]["message"]}))
            if len(results) >= 3:
                return self._say(json.dumps({"status": "blocked", "reason": "Could not confirm."}))
        key = "one-booking" if self.stable_key else f"attempt_{len(results) + 1}"
        call = {"name": "reserve_slot", "args": {"customerId": "customer_7", "slot": "slot_42", "operationKey": key}, "id": f"tc_{len(results)}"}
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[call]))])

    @staticmethod
    def _say(text: str) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])


def build(model: ScriptedModel):
    def graph(tools):
        bound = model.bind_tools(tools)

        async def agent(state: MessagesState):
            return {"messages": [await bound.ainvoke(state["messages"])]}

        builder = StateGraph(MessagesState)
        builder.add_node("agent", agent)
        builder.add_node("tools", ToolNode(tools))
        builder.add_edge(START, "agent")
        builder.add_conditional_edges("agent", tools_condition)
        builder.add_edge("tools", "agent")
        return builder.compile()

    return graph


def to_completion(state):
    final = json.loads(state["messages"][-1].content)
    if final["status"] == "completed":
        return {"status": "completed", "message": "Meeting booked.", "output": {"bookingId": final["bookingId"]}}
    return {"status": "blocked", "message": final["reason"]}


def adapter(stable: bool):
    class Adapter:
        tools = booking.tools

        @staticmethod
        def create_agent():
            return LangGraphAgent(
                "langgraph-booking",
                "stable" if stable else "new-key",
                [reserve_slot],
                build(ScriptedModel(stable_key=stable)),
                to_completion=to_completion,
            )

    return Adapter


def test_langgraph_agent_passes_every_booking_fault_with_a_stable_key():
    batch = run_workflow_sync(booking_workflow(), adapter(True))
    assert batch["baseline"]["status"] == "passed"
    assert [r["status"] for r in batch["runs"]] == ["passed"] * 5
    assert LIVE_CALLS == []
    revoked = batch["runs"][-1]
    assert revoked["completion"]["status"] == "blocked"


def test_langgraph_agent_duplicates_a_booking_when_it_changes_the_key():
    batch = run_workflow_sync(booking_workflow(), adapter(False))
    lost = batch["runs"][0]
    assert lost["scenario"]["id"] == "lost-confirmation"
    assert lost["status"] == "failed"
    assert lost["metrics"]["mutations"] == 2
    failed = {a["id"] for a in lost["assertions"] if not a["passed"]}
    assert "one-booking" in failed
    assert LIVE_CALLS == []


def test_simulated_tools_keep_name_description_and_schema():
    class Ctx:
        async def call(self, name, args):
            return {"ok": True, "data": {"name": name, "args": args}}

    spec = ToolSpec("lookup", "Look something up.", {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]})
    simulated, from_spec = create_tools(Ctx(), [reserve_slot, spec])  # type: ignore[arg-type]
    assert simulated.name == "reserve_slot"
    assert simulated.description == reserve_slot.description
    assert simulated.args == reserve_slot.args
    assert from_spec.name == "lookup"
    import asyncio

    text = asyncio.run(from_spec.ainvoke({"q": "x"}))
    assert json.loads(text) == {"ok": True, "data": {"name": "lookup", "args": {"q": "x"}}}
    with pytest.raises(ValueError):
        create_tools(Ctx(), [spec, spec])  # type: ignore[arg-type]
