# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""LangGraph and LangChain adapter.

Hand your existing graph simulated stand-ins for its tools. Each stand-in keeps
the original tool's name, description, and argument schema, but routes the call
through ``context.call`` so TraceDojo can inject faults and record evidence. The
original tool function is never invoked.

Install with ``pip install "tracedojo[langgraph]"``. Requires ``langchain-core``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Sequence, Union

try:
    from langchain_core.messages import AIMessage, BaseMessage
    from langchain_core.tools import BaseTool, StructuredTool
    from pydantic_core import to_jsonable_python
except ImportError as error:  # pragma: no cover - exercised only without the extra
    raise ImportError('Install the LangGraph extra: pip install "tracedojo[langgraph]"') from error

from ._json import bounded_json, dumps
from .runner import WorkflowContext

__all__ = ["ToolSpec", "create_tools", "LangGraphAgent"]


@dataclass(frozen=True)
class ToolSpec:
    """A tool definition without an implementation. ``args_schema`` is a pydantic
    model class or a JSON Schema dict, as accepted by LangChain's StructuredTool."""

    name: str
    description: str
    args_schema: Any


ToolLike = Union[BaseTool, ToolSpec]


def create_tools(context: WorkflowContext, definitions: Sequence[ToolLike]) -> list[BaseTool]:
    """Pass these tools to your LangGraph agent instead of its live tools.

    Accepts your real LangChain tools (only their name, description, and schema
    are used) or :class:`ToolSpec` definitions. Each tool returns the simulated
    result as a JSON string, exactly like the JavaScript SDK's LangChain adapter.
    Invoke the graph asynchronously (``ainvoke``/``astream``).
    """
    names = [d.name for d in definitions]
    if len(set(names)) != len(names):
        raise ValueError("Tool names must be unique.")
    tools: list[BaseTool] = []
    for definition in definitions:
        tools.append(_simulated(context, definition))
    return tools


def _simulated(context: WorkflowContext, definition: ToolLike) -> BaseTool:
    name = definition.name

    async def call(**kwargs: Any) -> str:
        args = to_jsonable_python(kwargs)
        bounded_json(args, 16000)
        return dumps(await context.call(name, args))

    return StructuredTool.from_function(
        coroutine=call,
        name=name,
        description=definition.description,
        args_schema=definition.args_schema,
        infer_schema=False,
    )


Completion = dict[str, Any]


def _default_completion(state: Mapping[str, Any]) -> Completion:
    messages: Sequence[BaseMessage] = state.get("messages", [])
    final = next((m for m in reversed(messages) if isinstance(m, AIMessage)), None)
    text: Any = "" if final is None else getattr(final, "text", "")
    if callable(text):  # langchain-core < 1.0 exposes text() as a method
        text = text()
    if not isinstance(text, str):
        text = "" if final is None else str(final.content)
    return {"status": "completed", "message": text[:10000]}


class LangGraphAgent:
    """A TraceDojo agent that builds a fresh LangGraph graph for every trial.

    ``build_graph(tools)`` receives the simulated tools and returns a compiled graph.
    ``to_completion(state)`` maps the final graph state to a completion dict with
    ``status`` ("completed" or "blocked"), ``message``, and optional JSON ``output``.
    The default reports the last AI message as completed; supply your own mapping
    so that blocked outcomes and structured outputs can be checked.
    """

    def __init__(
        self,
        id: str,
        version: str,
        tools: Sequence[ToolLike],
        build_graph: Callable[[list[BaseTool]], Any],
        *,
        to_completion: Callable[[Mapping[str, Any]], Union[Completion, Awaitable[Completion]]] = _default_completion,
        inputs: Callable[[WorkflowContext], Mapping[str, Any]] | None = None,
        config: Mapping[str, Any] | None = None,
    ) -> None:
        self.id = id
        self.version = version
        self._tools = list(tools)
        self._build_graph = build_graph
        self._to_completion = to_completion
        self._inputs = inputs or (lambda context: {"messages": [("user", context.task)]})
        self._config = dict(config or {})

    async def run(self, context: WorkflowContext) -> Completion:
        graph = self._build_graph(create_tools(context, self._tools))
        state = await graph.ainvoke(self._inputs(context), config=self._config or None)
        completion = self._to_completion(state)
        if hasattr(completion, "__await__"):
            completion = await completion  # type: ignore[misc]
        return completion  # type: ignore[return-value]
