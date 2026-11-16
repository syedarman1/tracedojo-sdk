# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""The tracedojo command line, run as a subprocess like CI runs it."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from tracedojo import parse_batch

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "src" / "tracedojo" / "templates" / "booking"


def cli(*args: str, cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    environment = {**os.environ, "PYTHONPATH": str(ROOT / "src"), **(env or {})}
    return subprocess.run(
        [sys.executable, "-m", "tracedojo", *args], cwd=cwd, capture_output=True, text=True, env=environment, timeout=120
    )


@pytest.fixture()
def dojo(tmp_path: Path) -> Path:
    (tmp_path / "dojo").mkdir()
    shutil.copy(TEMPLATE / "workflow.json", tmp_path / "dojo" / "workflow.json")
    shutil.copy(TEMPLATE / "adapter.py", tmp_path / "dojo" / "adapter.py")
    return tmp_path


def break_adapter(path: Path) -> None:
    source = path.read_text()
    source = source.replace(
        '{"customerId": "customer_7", "slot": "slot_42", "operationKey": operation_key}',
        '{"customerId": "customer_7", "slot": "slot_42", "operationKey": str(_attempt)}',
    )
    path.write_text(source)


def test_help_and_unknown_commands(tmp_path: Path):
    assert cli("--help", cwd=tmp_path).returncode == 0
    result = cli("launch", cwd=tmp_path)
    assert result.returncode == 2 and "Unknown command" in result.stderr
    result = cli("test", "--bogus", "x", cwd=tmp_path)
    assert result.returncode == 2 and "Unsupported arguments" in result.stderr


def test_test_passes_writes_private_report_and_summary(dojo: Path):
    result = cli("test", "--out", "report.json", "--summary", "summary.md", "--trials", "2", "--commit", "a" * 40, cwd=dojo)
    assert result.returncode == 0, result.stderr
    assert "Control: passed" in result.stdout
    assert "Completed 10/10 fault trials." in result.stdout
    report = dojo / "report.json"
    assert stat.S_IMODE(report.stat().st_mode) == 0o600
    batch = parse_batch(json.loads(report.read_text()))
    assert batch["baseline"]["execution"]["commitSha"] == "a" * 40
    assert (dojo / "summary.md").read_text().startswith("## TraceDojo: Passed")


def test_test_fails_on_a_duplicate_booking_and_never_overwrites(dojo: Path):
    break_adapter(dojo / "dojo" / "adapter.py")
    result = cli("test", "--out", "report.json", cwd=dojo)
    assert result.returncode == 1, result.stderr
    assert "Booking succeeds, confirmation is lost: failed" in result.stdout
    before = (dojo / "report.json").read_text()
    again = cli("test", "--out", "report.json", cwd=dojo)
    assert again.returncode == 2 and "Refusing to overwrite" in again.stderr
    assert (dojo / "report.json").read_text() == before


def test_invalid_inputs_exit_2_without_leaking_or_leaving_files(dojo: Path):
    assert cli("test", "--trials", "0", cwd=dojo).returncode == 2
    assert cli("test", "--commit", "HEAD", cwd=dojo).returncode == 2
    (dojo / "dojo" / "adapter.py").write_text("def broken(:\n")
    result = cli("test", "--out", "report.json", cwd=dojo)
    assert result.returncode == 2 and "Could not load the adapter" in result.stderr
    assert not (dojo / "report.json").exists()
    (dojo / "dojo" / "workflow.json").write_text('{"schemaVersion": "workflow/1", "secret": "s3cr3t"}')
    result = cli("test", cwd=dojo)
    assert result.returncode == 2 and "s3cr3t" not in result.stderr


def test_compare_gates_regressions_and_incomplete_evidence(dojo: Path):
    assert cli("test", "--out", "base.json", cwd=dojo).returncode == 0
    break_adapter(dojo / "dojo" / "adapter.py")
    assert cli("test", "--out", "head.json", cwd=dojo).returncode == 1
    same = cli("compare", "--base", "base.json", "--candidate", "base.json", "--out", "same.json", cwd=dojo)
    assert same.returncode == 0, same.stderr
    regressed = cli(
        "compare", "--base", "base.json", "--candidate", "head.json", "--out", "cmp.json", "--summary", "cmp.md",
        "--base-sha", "a" * 40, "--head-sha", "b" * 40, cwd=dojo,
    )
    assert regressed.returncode == 1
    result = json.loads((dojo / "cmp.json").read_text())
    assert result["status"] == "regressed" and result["source"] == {"baseSha": "a" * 40, "headSha": "b" * 40}
    assert (dojo / "cmp.md").read_text().startswith("## TraceDojo: Regressions found")
    missing = cli("compare", "--base", "base.json", "--candidate", "nope.json", "--out", "missing.json", cwd=dojo)
    assert missing.returncode == 3


def test_demo_reproduces_the_failure_and_fix(tmp_path: Path):
    result = cli("demo", "--out", "demo", cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    assert "Before: failed" in result.stdout and "After:  passed" in result.stdout
    for name in ("before.json", "after.json"):
        parse_batch(json.loads((tmp_path / "demo" / name).read_text()))
    assert cli("demo", "--out", "demo", cwd=tmp_path).returncode == 2


def test_upload_requires_a_token_and_https(tmp_path: Path):
    (tmp_path / "r.json").write_text("{}")
    result = cli("upload", "r.json", "--url", "https://tracedojo.com", "--project", "x", cwd=tmp_path, env={"TRACEDOJO_UPLOAD_TOKEN": ""})
    assert result.returncode == 2 and "valid project ID" in result.stderr


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
def test_ctrl_c_cancels_and_saves_partial_evidence(dojo: Path):
    import signal
    import time

    (dojo / "dojo" / "adapter.py").write_text(
        "import asyncio\n"
        "from tracedojo.templates.booking.adapter import tools\n"
        "class Agent:\n"
        "    id = 'slow'\n"
        "    version = '1'\n"
        "    async def run(self, context):\n"
        "        open('started', 'w').close()\n"
        "        await asyncio.sleep(3)\n"
        "        return {'status': 'completed', 'message': 'late'}\n"
        "def create_agent():\n"
        "    return Agent()\n"
    )
    environment = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
    process = subprocess.Popen(
        [sys.executable, "-m", "tracedojo", "test", "--out", "report.json"],
        cwd=dojo, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    deadline = time.time() + 30
    while not (dojo / "started").exists() and time.time() < deadline:
        time.sleep(0.05)
    process.send_signal(signal.SIGINT)
    stdout, stderr = process.communicate(timeout=60)
    assert process.returncode == 3, stderr
    assert "Control: cancelled" in stdout
    batch = parse_batch(json.loads((dojo / "report.json").read_text()))
    assert batch["baseline"]["issue"] == "cancelled" and batch["runs"] == []
