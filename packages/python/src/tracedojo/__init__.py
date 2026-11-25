# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""TraceDojo: controlled tool failures and state assertions for AI agents."""

from ._json import bounded_json, dumps, loads, stable_json
from .clock import WorkflowClock
from .errors import TracedojoError
from .runner import (
    Adapter,
    Agent,
    SimpleAdapter,
    Tool,
    ToolContext,
    TrialStopped,
    WorkflowContext,
    run_workflow,
    run_workflow_sync,
    tool,
)
from .schema import (
    SchemaError,
    evaluate_checks,
    is_model_fault,
    parse_batch,
    parse_report,
    parse_workflow,
    workflow_exit_code,
)
from .signal import Cancelled, Signal

__version__ = "0.1.7"

__all__ = [
    "Adapter",
    "Agent",
    "Cancelled",
    "SchemaError",
    "Signal",
    "SimpleAdapter",
    "Tool",
    "ToolContext",
    "TracedojoError",
    "TrialStopped",
    "WorkflowClock",
    "WorkflowContext",
    "bounded_json",
    "dumps",
    "evaluate_checks",
    "is_model_fault",
    "loads",
    "parse_batch",
    "parse_report",
    "parse_workflow",
    "run_workflow",
    "run_workflow_sync",
    "stable_json",
    "tool",
    "workflow_exit_code",
]
