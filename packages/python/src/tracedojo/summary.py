# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Markdown summary of a test batch for CI job summaries."""

from __future__ import annotations

import re
from typing import Any

from .schema import workflow_exit_code

_ESCAPE = re.compile(r"[&<>|`*_\[\]\\\r\n]")


def _escape(value: str) -> str:
    # Report labels are user data, including in Markdown rendered by CI providers.
    return _ESCAPE.sub(lambda m: " " if m.group() in "\r\n" else f"&#{ord(m.group())};", value)


def workflow_summary(batch: dict[str, Any]) -> str:
    status = ["Passed", "Failed", "", "Incomplete"][workflow_exit_code(batch)]
    base = batch["baseline"]
    lines = [
        f"## TraceDojo: {status}",
        "",
        f"{_escape(base['workflow']['title'])} · {_escape(base['agent']['id'])} ({_escape(base['agent']['version'])})",
        "",
        f"No-fault control: **{base['status']}**. Fault trials recorded: **{len(batch['runs'])}/{batch['planned']}**.",
        "",
        "| Scenario | Passed | Failed | Incomplete | Fault reached |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    groups: dict[str, list[dict[str, Any]]] = {}
    for run in batch["runs"]:
        groups.setdefault(run["scenario"]["id"], []).append(run)
    for group in groups.values():
        passed = sum(1 for r in group if r["status"] == "passed")
        failed = sum(1 for r in group if r["status"] == "failed")
        triggered = sum(1 for r in group if r["fault"]["triggered"])
        lines.append(
            f"| {_escape(group[0]['scenario']['title'])} | {passed} | {failed} | "
            f"{len(group) - passed - failed} | {triggered}/{len(group)} |"
        )
    if batch.get("skippedReason"):
        lines += ["", _escape(batch["skippedReason"])]
    problems = [r for r in [base, *batch["runs"]] if r["status"] != "passed"]
    if problems:
        lines += ["", "### Investigate", ""]
    for run in problems[:10]:
        lines.append(f"- {_escape(run['scenario']['title'])}: **{run['status']}** ({run['id']}).")
        if run.get("issue"):
            lines.append(f"  - Execution issue: {run['issue']}.")
        if run["scenario"]["fault"]["type"] != "none" and not run["fault"]["triggered"]:
            lines.append("  - The configured fault was not reached; recovery is untested.")
        for check in run["assertions"]:
            if not check["passed"]:
                lines.append(f"  - {_escape(check['label'])}: {_escape(check['detail'])}")
    if len(problems) > 10:
        lines.append(f"- {len(problems) - 10} more results need review in the JSON report.")
    lines += [
        "",
        "Open the JSON report in TraceDojo to inspect tool calls, committed changes, and assertion evidence.",
        "Counts describe these trials only; they are not a guarantee of production reliability.",
        "",
    ]
    return "\n".join(lines)
