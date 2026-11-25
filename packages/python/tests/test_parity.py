# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Cross-language parity: the Python SDK against the built JavaScript SDK.

For each workflow case both SDKs run equivalent fixtures. Reports must be
byte-identical after removing random IDs, timestamps, and durations; each SDK must
accept the other's output; and compare, privacy, summaries, and imported report IDs
must agree. Requires Node and ``npm run build`` at the repository root. Set
TRACEDOJO_REQUIRE_PARITY=1 (as CI does) to fail instead of skipping without them.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import random
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

import tracedojo
from tracedojo import dumps, loads, parse_batch, run_workflow_sync, stable_json
from tracedojo.compare import compare_workflow_batches, comparison_summary
from tracedojo.privacy import sanitize_batch, sanitize_json
from tracedojo.reports import parse_workflow_reports
from tracedojo.schema import SchemaError, parse_workflow
from tracedojo.summary import workflow_summary

HERE = Path(__file__).parent / "parity"
SDK = Path(__file__).resolve().parents[2] / "sdk"
BRIDGE = HERE / "js_bridge.mjs"
NODE = shutil.which("node")

if not NODE or not (SDK / "dist" / "index.js").is_file():
    if os.environ.get("TRACEDOJO_REQUIRE_PARITY") == "1":
        raise RuntimeError("Parity tests need Node and a built JS SDK (npm run build).")
    pytest.skip("Node or the built JS SDK is unavailable.", allow_module_level=True)


def js(request: dict[str, Any]) -> Any:
    result = subprocess.run(
        [NODE, str(BRIDGE)], input=dumps(request), capture_output=True, text=True, timeout=120, check=False
    )
    assert result.returncode == 0, result.stderr
    return loads(result.stdout)


def fixture(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(f"parity_fixture_{name}", HERE / "fixtures" / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def suite(name: str) -> dict[str, Any]:
    if name == "booking":
        return loads((SDK / "templates" / "workflow.json").read_text("utf-8"))
    if name == "booking-virtual":
        return {**suite("booking"), "clock": {"mode": "virtual"}}
    if name in ("stale-read", "duplicate-delivery", "prompt-injection"):
        return loads((SDK / "templates" / "faults" / name / "workflow.json").read_text("utf-8"))
    if name == "stale-read-repeat":
        workflow = suite("stale-read")
        workflow["scenarios"][0]["fault"]["repeat"] = 2
        return workflow
    if name == "limits-hang":
        workflow = suite("limits")
        workflow["limits"] = {**workflow["limits"], "timeoutMs": 150}
        return workflow
    return loads((HERE / "workflows" / f"{name}.json").read_text("utf-8"))


SHA = "0123456789abcdef0123456789abcdef01234567"
CASES = [
    ("booking", "stable", "booking", 1),
    ("booking", "new-key", "booking", 1),
    ("booking", "stable", "booking", 3),
    ("booking", "virtual-stable", "booking-virtual", 1),
    ("booking", "virtual-new-key", "booking-virtual", 2),
    ("faults", "stale-read:safe", "stale-read", 1),
    ("faults", "stale-read:unsafe", "stale-read", 1),
    ("faults", "stale-read:safe", "stale-read-repeat", 1),
    ("faults", "duplicate-delivery:safe", "duplicate-delivery", 1),
    ("faults", "duplicate-delivery:unsafe", "duplicate-delivery", 1),
    ("faults", "prompt-injection:safe", "prompt-injection", 1),
    ("faults", "prompt-injection:unsafe", "prompt-injection", 1),
    *[("checks", v, "checks", 1) for v in ("good", "bad-order", "extra-calls", "forbidden", "unknown", "concurrent")],
    *[
        ("limits", v, "limits", 1)
        for v in (
            "ok",
            "repeat",
            "call-limit",
            "catch-stop",
            "agent-error",
            "bad-completion",
            "read-mutates",
            "tool-throws",
            "unawaited",
            "evidence",
            "model",
        )
    ],
    ("limits", "hang", "limits-hang", 1),
    *[
        ("limits", v, "clock", 1)
        for v in ("ok", "clock-contract", "clock-limit", "clock-budget", "parallel-sleeps", "unawaited-sleep")
    ],
]


def case_id(case: tuple[Any, ...]) -> str:
    return f"{case[2]}-{case[1]}-x{case[3]}"


def normalize(batch: dict[str, Any]) -> dict[str, Any]:
    """Drop values that are random or timing-dependent by design."""
    batch = copy.deepcopy(batch)
    for report in [batch["baseline"], *batch["runs"]]:
        report["id"] = "run_00000000-0000-4000-8000-000000000000"
        report["createdAt"] = "2026-01-01T00:00:00.000Z"
        report["metrics"]["durationMs"] = 0
        if "execution" in report:
            report["execution"]["id"] = "00000000-0000-4000-8000-000000000000"
    return batch


_cache: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}


def run_both(case: tuple[str, str, str, int]) -> tuple[dict[str, Any], dict[str, Any]]:
    key = case_id(case)
    if key not in _cache:
        name, variant, workflow_name, trials = case
        workflow = suite(workflow_name)
        commit = SHA if trials > 1 else None
        python = run_workflow_sync(
            copy.deepcopy(workflow), fixture(name).make_adapter(variant), trials=trials, commit_sha=commit
        )
        javascript = js(
            {"op": "run", "fixture": name, "variant": variant, "workflow": workflow, "trials": trials, "commitSha": commit}
        )
        _cache[key] = (python, javascript)
    return _cache[key]


@pytest.mark.parametrize("case", CASES, ids=case_id)
def test_reports_match_javascript_byte_for_byte(case: tuple[str, str, str, int]) -> None:
    python, javascript = run_both(case)
    # Same verdicts first, for a readable failure.
    assert [r["status"] for r in [python["baseline"], *python["runs"]]] == [
        r["status"] for r in [javascript["baseline"], *javascript["runs"]]
    ]
    assert dumps(normalize(python), 2) == dumps(normalize(javascript), 2)


def test_cases_exercise_every_fault_check_and_outcome() -> None:
    faults, checks, statuses, issues = set(), set(), set(), set()
    for case in CASES:
        python, _ = run_both(case)
        for report in [python["baseline"], *python["runs"]]:
            faults.add(report["scenario"]["fault"]["type"])
            checks.update(d["type"] for d in report["definitions"])
            statuses.add(report["status"])
            issues.add(report.get("issue"))
    assert faults == {"none", *tracedojo.schema.FAULT_TYPES, "prompt_injection"}
    assert checks == {"count", "equals", "unchanged", "forbidden_tool", "tool_calls", "tool_order"}
    assert statuses == {"passed", "failed", "inconclusive", "timed_out"}
    assert issues >= {
        None,
        "agent_error",
        "tool_contract",
        "call_limit",
        "repeated_calls",
        "timed_out",
        "unawaited_calls",
        "evidence_limit",
        "clock_limit",
        "clock_contract",
    }


def test_each_sdk_accepts_the_others_batches() -> None:
    pythons = [run_both(case)[0] for case in CASES]
    javascripts = [run_both(case)[1] for case in CASES]
    verdicts = js({"op": "validate-batch", "values": pythons})
    assert all(v["ok"] for v in verdicts), [v for v in verdicts if not v["ok"]]
    for batch in javascripts:
        assert stable_json(parse_batch(batch)) == stable_json(batch)
    # The JS schema returns Python batches unchanged (no stripped or defaulted fields).
    for verdict, batch in zip(verdicts, pythons):
        assert stable_json(verdict["value"]) == stable_json(batch)


def test_tampered_reports_are_rejected_by_both() -> None:
    python, _ = run_both(("booking", "new-key", "booking", 1))
    tampered = []
    flipped = copy.deepcopy(python)
    flipped["runs"][0]["status"] = "passed"
    tampered.append(flipped)
    hidden = copy.deepcopy(python)
    hidden["runs"][0]["events"] = [e for e in hidden["runs"][0]["events"] if e["kind"] != "mutation"]
    tampered.append(hidden)
    extra = copy.deepcopy(python)
    extra["baseline"]["surprise"] = True
    tampered.append(extra)
    count = copy.deepcopy(python)
    count["runs"][0]["fault"]["triggerCount"] = 0
    tampered.append(count)
    assert not any(v["ok"] for v in js({"op": "validate-batch", "values": tampered}))
    for batch in tampered:
        with pytest.raises(SchemaError):
            parse_batch(batch)


def test_ci_gate_compares_mixed_language_batches() -> None:
    py_ok, js_ok = run_both(("booking", "stable", "booking", 3))
    py_bad, js_bad = run_both(("booking", "new-key", "booking", 1))
    single_py, single_js = run_both(("booking", "stable", "booking", 1))
    pairs = [
        (js_ok, py_ok),
        (py_ok, js_ok),
        (single_js, py_bad),
        (single_py, js_bad),
        (py_bad, single_js),
        (single_py, py_ok),
        (None, py_ok),
        (single_py, run_both(("faults", "stale-read:safe", "stale-read", 1))[0]),
    ]
    javascript = js({"op": "compare", "pairs": [list(pair) for pair in pairs]})
    statuses = [r["result"]["status"] for r in javascript]
    assert statuses == [
        "no_regressions",
        "no_regressions",
        "regressed",
        "regressed",
        "no_regressions",
        "incomparable",
        "incomparable",
        "incomparable",
    ]
    assert javascript[4]["result"]["scenarios"][0]["status"] == "improved"
    for (base, candidate), expected in zip(pairs, javascript):
        result = compare_workflow_batches(base, candidate)
        assert result == expected["result"]
        assert comparison_summary(result) == expected["summary"]


def test_imported_report_ids_and_redaction_match() -> None:
    python, _ = run_both(("checks", "good", "checks", 1))
    batch = copy.deepcopy(python)
    batch["baseline"]["completion"]["message"] = "Mail ops@acme.io with api_key=abc123 and Bearer tok.en"
    batch["baseline"]["events"][-1]["detail"] = batch["baseline"]["completion"]["message"]
    batch["baseline"]["events"][-1]["payload"]["message"] = batch["baseline"]["completion"]["message"]
    for source in (python, batch):
        expected = js({"op": "parse-reports", "value": source})
        assert dumps(parse_workflow_reports(source), 2) == dumps(expected, 2)
    assert dumps(sanitize_batch(batch), 2) == dumps(js({"op": "sanitize-batch", "value": batch}), 2)


def test_sanitizer_matches_javascript() -> None:
    values = [
        "token td_upload_" + "a" * 64 + " end",
        "sk-proj-ABCDEFGHIJKLMNOPQRST and ghp_" + "x" * 24,
        "Authorization: Bearer abc.def-ghi",
        "bearer xyz",
        "password = 'hunter2', API-KEY: \"q w\" secret=s3;x",
        "write to Jane.Doe@Company.COM or ops@example.com or a@b.invalid",
        "jordan@example.com, x@mail.example.org, y@example.net, z@ci.test, q@example.company.com",
        "épassword=1 x_password=2 passwordless",
        {"Authorization": "x", "nested": {"api_key": 1, "safe": "sb_secret_abc"}},
        {"user@corp.io": 1, "redacted@private.invalid": 2},
        [" secret: value", "KKY"],
    ]
    expected = js({"op": "sanitize", "values": values})
    for value, verdict in zip(values, expected):
        if verdict["ok"]:
            assert sanitize_json(value) == verdict["value"], value
        else:
            with pytest.raises(Exception):
                sanitize_json(value)


def test_summaries_match_javascript() -> None:
    for case in CASES[::3]:
        python, _ = run_both(case)
        expected = js({"op": "summary", "value": python})
        assert workflow_summary(python) == expected["summary"]
        assert tracedojo.workflow_exit_code(python) == expected["exitCode"]


def _random_value(rng: random.Random, depth: int = 0) -> Any:
    pick = rng.randrange(9 if depth < 4 else 6)
    if pick == 0:
        return None
    if pick == 1:
        return rng.random() < 0.5
    if pick == 2:
        return rng.choice(
            [0, -0.0, 1, -1, 2**53 - 1, 2**53 + 1, 1e21, 1e20, 123456789012345678901234, 1.5, -2.25e-7, 1e-6, 1e-7, 5e-324, 1.7976931348623157e308, 0.1 + 0.2, 100.0, 1e16, 12345.678]
        )
    if pick == 3:
        return rng.uniform(-1e30, 1e30) * rng.choice([1, 1e-20, 1e-5, 1e5])
    if pick in (4, 5):
        alphabet = ["a", "Z", "0", " ", '"', "\\", "\n", "\x1f", "\x7f", "é", " ", "﻿", "\U0001f389", "\U00010000", "\ud800", "￿"]
        return "".join(rng.choice(alphabet) for _ in range(rng.randrange(6)))
    if pick in (6, 7):
        return {_random_key(rng): _random_value(rng, depth + 1) for _ in range(rng.randrange(5))}
    return [_random_value(rng, depth + 1) for _ in range(rng.randrange(4))]


def _random_key(rng: random.Random) -> str:
    return rng.choice(["b", "a", "B", "10", "2", "01", "é", "Ａ", "\U0001f389", "", "", "__proto__x", "4294967295", "4294967294"]) + rng.choice(["", "x"])


def test_stable_json_fingerprints_and_formatting_match() -> None:
    rng = random.Random(20261115)
    values = [_random_value(rng) for _ in range(400)]
    values += [{"\U0001f389": 1, "Ａ": 2, "": 3}, [-0.0, 1e21, 1e-7, 2**60], {"2": 1, "10": 2, "a": 3, "01": 4}]
    expected = js({"op": "stable", "values": values})
    for value, result in zip(values, expected):
        text = stable_json(value)
        assert text == result["json"], value
        assert tracedojo._json.dumps(value, 2) == result["stringify"], value


def test_workflow_parsing_matches_zod() -> None:
    base = suite("booking")
    variants: list[Any] = [
        base,
        {**base, "title": " ﻿ Spaced title  "},
        {**base, "title": "\x1c"},
        {**base, "title": "   "},
        {**base, "extra": 1},
        {**base, "limits": {"maxToolCalls": 100.0}},
        {**base, "limits": {"maxToolCalls": True}},
        {**base, "limits": {"maxToolCalls": 1.5}},
        {**base, "clock": {"mode": "virtual"}},
        {**base, "clock": {"mode": "real"}},
        {**base, "scenarios": [{"id": "baseline", "title": "x", "fault": {"type": "unavailable", "tool": "reserve_slot"}}]},
        {**base, "scenarios": [{"id": "a", "title": "x", "fault": {"type": "permission_revoked", "tool": "t", "repeat": 2}}]},
        {**base, "scenarios": [{"id": "a", "title": "x", "fault": {"type": "unavailable", "tool": "t", "occurrence": 100, "repeat": 2}}]},
        {**base, "scenarios": [{"id": "a", "title": "x", "fault": {"type": "prompt_injection", "tool": "t"}}]},
        {**base, "scenarios": [{"id": "a", "title": "x", "fault": {"type": "prompt_injection", "tool": "t", "replacement": None}}]},
        {**base, "checks": [{"id": "c", "label": "l", "type": "tool_calls", "tool": "t"}]},
        {**base, "checks": [{"id": "c", "label": "l", "type": "tool_calls", "tool": "t", "min": 3, "max": 2}]},
        {**base, "checks": [{"id": "c", "label": "l", "type": "tool_order", "tools": ["t"]}]},
        {**base, "checks": [{"id": "c", "label": "l", "type": "equals", "path": "x", "expected": 1}]},
        {**base, "checks": [{"id": "c", "label": "l", "type": "equals", "path": "/a~2", "expected": 1}]},
        {**base, "checks": [{"id": "c", "label": "l", "type": "count", "path": "", "expected": -1}]},
        {**base, "checks": [{"id": "-c", "label": "l", "type": "unchanged", "path": ""}]},
        {**base, "checks": [{"id": "c", "label": "l", "type": "unchanged", "path": ""}] * 2},
        {**base, "task": "x" * 10001},
        {**base, "initialState": []},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "rate_limited", "target": "model"}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "server_error", "target": "model", "status": 529, "occurrence": 2, "repeat": 3}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "server_error", "target": "model", "status": 500.0}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "model_timeout", "target": "model", "delayMs": 600000}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "stream_cut", "target": "model", "afterChunks": 0}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "stream_stall", "target": "model", "afterChunks": 1000, "delayMs": 0}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "rate_limited", "target": "model", "status": 503}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "server_error", "target": "model", "status": 501}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "rate_limited", "target": "model", "afterChunks": 1}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "stream_cut", "target": "model", "delayMs": 5}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "model_timeout", "target": "model", "delayMs": 600001}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "stream_stall", "target": "model", "afterChunks": 1.5}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "rate_limited", "target": "tool"}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "rate_limited"}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "rate_limited", "target": "model", "tool": "reserve_slot"}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "rate_limited", "target": "model", "occurrence": 100, "repeat": 2}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "rate_limited", "target": "model", "repeat": 11}}]},
        {**base, "scenarios": [{"id": "m", "title": "x", "fault": {"type": "unavailable", "tool": "t", "target": "model"}}]},
        "not a workflow",
    ]
    expected = js({"op": "parse-workflow", "values": variants})
    for value, verdict in zip(variants, expected):
        if verdict["ok"]:
            assert stable_json(parse_workflow(value)) == stable_json(verdict["value"]), value
        else:
            with pytest.raises(SchemaError):
                parse_workflow(value)


# Model-layer faults are injected only by the JS proxy runner. These batches are real
# proxy runs against the repository's proxy fixtures and a stand-in model server.
MODEL_SCENARIOS = [
    {"id": "rate", "title": "Rate limited", "fault": {"type": "rate_limited", "target": "model"}},
    {"id": "overloaded", "title": "Overloaded", "fault": {"type": "server_error", "target": "model", "status": 529}},
    {"id": "slow", "title": "Model timeout", "fault": {"type": "model_timeout", "target": "model", "delayMs": 200}},
    {"id": "cut", "title": "Stream cut", "fault": {"type": "stream_cut", "target": "model", "afterChunks": 1}},
    {
        "id": "stall",
        "title": "Stream stall",
        "fault": {"type": "stream_stall", "target": "model", "afterChunks": 1, "delayMs": 200},
    },
]
_proxy: dict[int, dict[str, Any]] = {}


def proxy_batch(retries: int) -> dict[str, Any]:
    if retries not in _proxy:
        _proxy[retries] = js({"op": "proxy-model", "scenarios": MODEL_SCENARIOS, "retries": retries, "version": "1"})
    return _proxy[retries]


def test_model_fault_reports_round_trip() -> None:
    recovering, failing = proxy_batch(3), proxy_batch(0)
    for batch in (recovering, failing):
        assert [r["scenario"]["fault"]["type"] for r in batch["runs"]] == [s["fault"]["type"] for s in MODEL_SCENARIOS]
        assert all(r["fault"]["triggered"] for r in batch["runs"])
        assert stable_json(parse_batch(batch)) == stable_json(batch)
        assert stable_json(parse_batch(loads(dumps(parse_batch(batch))))) == stable_json(batch)
        assert dumps(parse_workflow_reports(batch), 2) == dumps(js({"op": "parse-reports", "value": batch}), 2)
        assert dumps(sanitize_batch(batch), 2) == dumps(js({"op": "sanitize-batch", "value": batch}), 2)
        expected = js({"op": "summary", "value": batch})
        assert workflow_summary(batch) == expected["summary"]
        assert tracedojo.workflow_exit_code(batch) == expected["exitCode"]
    assert {r["status"] for r in recovering["runs"]} == {"passed"}
    assert "failed" in {r["status"] for r in failing["runs"]}
    # Python-parsed batches stay valid for the JS schema.
    verdicts = js({"op": "validate-batch", "values": [parse_batch(recovering), parse_batch(failing)]})
    assert all(v["ok"] for v in verdicts)


def test_ci_gate_compares_model_fault_batches() -> None:
    recovering, failing = proxy_batch(3), proxy_batch(0)
    pairs = [(recovering, failing), (failing, recovering), (recovering, recovering)]
    javascript = js({"op": "compare", "pairs": [list(pair) for pair in pairs]})
    assert [r["result"]["status"] for r in javascript][:2] == ["regressed", "no_regressions"]
    for (base, candidate), expected in zip(pairs, javascript):
        result = compare_workflow_batches(base, candidate)
        assert result == expected["result"]
        assert comparison_summary(result) == expected["summary"]


def test_tampered_model_fault_reports_are_rejected_by_both() -> None:
    tampered = []
    for edit in (
        lambda b: b["runs"][1]["scenario"]["fault"].update(status=501),
        lambda b: b["runs"][0]["scenario"]["fault"].update(afterChunks=1),
        lambda b: b["runs"][0]["scenario"]["fault"].update(tool="reserve_slot"),
        lambda b: b["runs"][0]["scenario"]["fault"].update(target="tool"),
    ):
        batch = copy.deepcopy(proxy_batch(3))
        edit(batch)
        tampered.append(batch)
    assert not any(v["ok"] for v in js({"op": "validate-batch", "values": tampered}))
    for batch in tampered:
        with pytest.raises(SchemaError):
            parse_batch(batch)
