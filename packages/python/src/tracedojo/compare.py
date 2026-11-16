# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Base-commit regression gating: compare matched observations, never treat missing
or changed evidence as a pass. Output is identical to the JavaScript SDK's compare."""

from __future__ import annotations

import re
from typing import Any

from ._json import bounded_json, stable_json
from .schema import parse_batch


def incomplete_comparison(reason: str) -> dict[str, Any]:
    return {"schemaVersion": "workflow-comparison/1", "status": "incomparable", "reason": reason, "scenarios": []}


def _group(runs: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        groups.setdefault(run["scenario"]["id"], []).append(run)
    return groups


def _conditions(run: dict[str, Any]) -> str:
    clock = run.get("clock")
    return stable_json(
        {
            "workflow": run["workflow"],
            "initialState": run["initialState"],
            "scenario": run["scenario"],
            "definitions": run["definitions"],
            "clock": {"mode": clock["mode"], "startMs": clock["startMs"], "maxTimeMs": clock["maxTimeMs"]}
            if clock
            else None,
        }
    )


def _failure_counts(runs: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for run in runs:
        for check in run["assertions"]:
            if not check["passed"]:
                counts[check["id"]] = counts.get(check["id"], 0) + 1
        if run.get("issue"):
            key = f"execution:{run['issue']}"
            counts[key] = counts.get(key, 0) + 1
    return counts


def _complete(batch: dict[str, Any]) -> bool:
    return (
        "skippedReason" not in batch
        and len(batch["runs"]) == batch["planned"]
        and batch["baseline"]["status"] == "passed"
        and all(run["status"] in ("passed", "failed") and run["fault"]["triggered"] for run in batch["runs"])
    )


def compare_workflow_batches(base_input: Any, candidate_input: Any) -> dict[str, Any]:
    """Pass ``None`` for a missing report; a missing side is incomparable, never a pass."""
    if base_input is None or candidate_input is None:
        return incomplete_comparison(
            "A baseline or candidate report is missing. Run both before gating regressions."
        )
    bounded_json(base_input)
    bounded_json(candidate_input)
    base = parse_batch(base_input)
    candidate = parse_batch(candidate_input)
    if (
        base["baseline"]["suiteFingerprint"] != candidate["baseline"]["suiteFingerprint"]
        or base["baseline"]["agent"]["id"] != candidate["baseline"]["agent"]["id"]
        or _conditions(base["baseline"]) != _conditions(candidate["baseline"])
    ):
        return incomplete_comparison(
            "Test conditions or agent identity changed. Review the suite and establish a matching baseline."
        )
    if base["baseline"]["status"] != "passed":
        return incomplete_comparison(
            "The baseline no-fault control did not pass. Establish a working baseline first."
        )
    if candidate["baseline"]["status"] == "failed":
        return {
            "schemaVersion": "workflow-comparison/1",
            "status": "regressed",
            "reason": "The candidate no-fault control regressed; its fault trials were skipped.",
            "scenarios": [
                {
                    "id": "baseline",
                    "title": "No-fault control",
                    "trials": 1,
                    "baseFailures": 0,
                    "candidateFailures": 1,
                    "regressedChecks": list(_failure_counts([candidate["baseline"]])),
                    "status": "regressed",
                }
            ],
        }
    if not _complete(base) or not _complete(candidate):
        return incomplete_comparison(
            "Trials are missing, interrupted, or did not reach their configured fault. Recovery is untested."
        )
    left, right = _group(base["runs"]), _group(candidate["runs"])
    if (
        base["planned"] != candidate["planned"]
        or len(left) != len(right)
        or any(len(right.get(key, [])) != len(runs) or key not in right for key, runs in left.items())
    ):
        return incomplete_comparison(
            "Scenario sets or trial counts differ. Run matching scenarios with equal trial counts."
        )
    scenarios = []
    for key, before in left.items():
        after = right[key]
        reference = _conditions(before[0])
        if any(_conditions(run) != reference for run in [*before, *after]):
            return incomplete_comparison(
                "Recorded scenario conditions differ despite the suite fingerprint. Review the evidence."
            )
        a, b = _failure_counts(before), _failure_counts(after)
        regressed_checks = [k for k, count in b.items() if count > a.get(k, 0)]
        base_failures = sum(1 for run in before if run["status"] == "failed")
        candidate_failures = sum(1 for run in after if run["status"] == "failed")
        regressed = candidate_failures > base_failures or bool(regressed_checks)
        improved = candidate_failures < base_failures or any(count > b.get(k, 0) for k, count in a.items())
        scenarios.append(
            {
                "id": key,
                "title": before[0]["scenario"]["title"],
                "trials": len(before),
                "baseFailures": base_failures,
                "candidateFailures": candidate_failures,
                "regressedChecks": regressed_checks,
                "status": "regressed" if regressed else "improved" if improved else "unchanged",
            }
        )
    regressions = sum(1 for s in scenarios if s["status"] == "regressed")
    return {
        "schemaVersion": "workflow-comparison/1",
        "status": "regressed" if regressions else "no_regressions",
        "reason": f"{regressions} scenario(s) regressed against the baseline."
        if regressions
        else "No new failures in matched trials. Existing failures may remain.",
        "scenarios": scenarios,
    }


def comparison_exit_code(result: dict[str, Any]) -> int:
    return {"incomparable": 3, "regressed": 1}.get(result["status"], 0)


_ESCAPE = re.compile(r"[&<>|`*_\[\]\\\r\n@]")


def _escape(value: str) -> str:
    return _ESCAPE.sub(lambda m: " " if m.group() in "\r\n" else f"&#{ord(m.group())};", value)


def comparison_summary(result: dict[str, Any]) -> str:
    heading = (
        "Regressions found"
        if result["status"] == "regressed"
        else "Comparison incomplete"
        if result["status"] == "incomparable"
        else "No regressions"
    )
    lines = [
        f"## TraceDojo: {heading}",
        "",
        _escape(result["reason"]),
        "",
        "| Scenario | Baseline failures | Candidate failures | Trials | Change |",
        "| --- | ---: | ---: | ---: | --- |",
        *(
            f"| {_escape(s['title'])} | {s['baseFailures']} | {s['candidateFailures']} | {s['trials']} | {s['status']} |"
            for s in result["scenarios"]
        ),
        "",
        *(
            f"- {_escape(s['title'])}: increased failures for {', '.join(_escape(c) for c in s['regressedChecks'])}."
            for s in result["scenarios"]
            if s["regressedChecks"]
        ),
        "",
        "Counts describe these observations, not statistical significance or a guarantee of reliability. "
        "Tool implementation equivalence requires review.",
        "",
    ]
    return "\n".join(lines)
