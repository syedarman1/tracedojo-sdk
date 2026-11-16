# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Scripted booking demo: a known failure and its fix, using the same engine and
tools as customer tests. Mirrors ``tracedojo demo`` in the JavaScript SDK."""

from __future__ import annotations

import os
from importlib import resources
from pathlib import Path
from typing import Any

from ._json import dumps, loads
from .errors import TracedojoError
from .privacy import sanitize_batch
from .runner import SimpleAdapter, run_workflow
from .schema import parse_workflow
from .templates.booking import adapter as reference


def booking_workflow() -> dict[str, Any]:
    """The booking starter suite shared with the JavaScript SDK."""
    text = resources.files("tracedojo.templates.booking").joinpath("workflow.json").read_text("utf-8")
    return parse_workflow(loads(text))


def demo_adapter(stable: bool) -> SimpleAdapter:
    """The reference agent with a stable operation key, or a new key per retry (the bug)."""

    class Agent:
        def __init__(self) -> None:
            self._inner = reference.create_agent()
            self._attempt = 0
            self.id = self._inner.id
            self.version = "stable-key" if stable else "new-key-per-retry"

        async def run(self, context: Any) -> Any:
            def call(tool: str, args: dict[str, Any]) -> Any:
                if not stable:
                    self._attempt += 1
                    args = {**args, "operationKey": f"attempt_{self._attempt}"}
                return context.call(tool, args)

            return await self._inner.run(context.with_call(call))

    return SimpleAdapter(tools=reference.tools, create_agent=Agent)


def _write_new(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


async def run_demo(directory: str | os.PathLike[str]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Write before.json and after.json into a new directory and return both batches."""
    target = Path(directory)
    # Reserve a new directory before doing any work. Preserve earlier evidence.
    target.mkdir(mode=0o700)
    workflow = booking_workflow()
    workflow["scenarios"] = [s for s in workflow["scenarios"] if s["id"] == "lost-confirmation"]
    before = sanitize_batch(await run_workflow(workflow, demo_adapter(False)))
    _write_new(target / "before.json", dumps(before, 2) + "\n")
    after = sanitize_batch(await run_workflow(workflow, demo_adapter(True)))
    _write_new(target / "after.json", dumps(after, 2) + "\n")
    if (
        before["baseline"]["status"] != "passed"
        or after["baseline"]["status"] != "passed"
        or not before["runs"]
        or before["runs"][0]["status"] != "failed"
        or not after["runs"]
        or after["runs"][0]["status"] != "passed"
    ):
        raise TracedojoError(
            "The demo did not reproduce its expected failure and fix. Inspect the saved reports."
        )
    return before, after
