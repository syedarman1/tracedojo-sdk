# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""``tracedojo`` command line: test, demo, compare, upload.

Flags, console output, never-overwrite behavior, and exit codes follow the
JavaScript CLI so CI scripts work the same in either language.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import os
import signal as os_signal
import sys
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any, Optional, Sequence

from ._json import bounded_json, dumps, loads
from .compare import compare_workflow_batches, comparison_exit_code, comparison_summary
from .demo import run_demo
from .errors import TracedojoError
from .privacy import sanitize_batch
from .runner import run_workflow
from .schema import is_commit_sha, parse_workflow, workflow_exit_code
from .signal import Signal
from .summary import workflow_summary
from .upload import upload_message, upload_workflow_reports

HELP = """TraceDojo for Python - test your agent against controlled tool failures

  tracedojo demo
  tracedojo test
  tracedojo test --config dojo/workflow.json --adapter dojo/adapter.py --out dojo-report.json
  tracedojo compare --base main-report.json --candidate pr-report.json --out comparison.json --summary comparison.md
  tracedojo upload dojo-report.json --url https://tracedojo.com --project PROJECT_UUID

Uploads use TRACEDOJO_UPLOAD_TOKEN from your environment; credentials stay local.

test runs a no-fault control followed by every configured scenario.
  --trials 1-20 independent attempts per scenario (default 1)
  --out    New JSON file; existing evidence is never overwritten
           Default: .tracedojo/reports/<unique-id>.json
  --summary  Optional new Markdown summary file for CI
  --commit   Full lowercase Git SHA to label reports for trends

The adapter is a trusted local Python module (.py) that defines `tools` and
`create_agent`. It can access your environment and network. Simulated tools may
be async and must operate only on their state draft. Deadlines are cooperative,
not process isolation. Model API calls in your adapter may incur provider
charges; the shipped reference agent uses no API.

Reports use the same format as the JavaScript SDK (@tracedojo/sdk). The dashboard,
`compare`, and the CI gate accept reports from either SDK.

Exit codes: 0 pass, 1 failed checks, 2 invalid input, 3 incomplete/inconclusive.
demo exits 0 when it reproduces both the expected failure and the passing fix.
"""

_OPTIONS = (
    "config",
    "adapter",
    "out",
    "trials",
    "summary",
    "commit",
    "url",
    "project",
    "base",
    "candidate",
    "base_sha",
    "head_sha",
)


def _read_json(path: str | Path) -> Any:
    file = Path(path)
    if file.stat().st_size > 5_000_000:
        raise TracedojoError("JSON exceeds the 5 MB limit.")
    value = loads(file.read_text("utf-8"))
    bounded_json(value)
    return value


def _reserve(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)


def _write(fd: int, text: str) -> None:
    data = text.encode("utf-8")
    while data:
        written = os.write(fd, data)
        data = data[written:]


def load_adapter(path: str | Path) -> ModuleType:
    """Import a trusted local adapter module that defines ``tools`` and ``create_agent``."""
    file = Path(path).resolve()
    name = f"tracedojo_adapter_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, file)
    if spec is None or spec.loader is None:
        raise TracedojoError("Could not load the adapter. Check its syntax and installed dependencies.")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(file.parent))
    try:
        sys.modules[name] = module
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise TracedojoError(
            "Could not load the adapter. Check its syntax and installed dependencies."
        ) from None
    finally:
        try:
            sys.path.remove(str(file.parent))
        except ValueError:
            pass
    return module


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tracedojo", add_help=False, allow_abbrev=False)
    parser.add_argument("positionals", nargs="*")
    parser.add_argument("-h", "--help", action="store_true")
    for option in _OPTIONS:
        parser.add_argument("--" + option.replace("_", "-"), dest=option)
    return parser


def _given(values: argparse.Namespace) -> set[str]:
    return {key for key in _OPTIONS if getattr(values, key) is not None}


def _install_cancel(signal: Signal) -> None:
    loop = asyncio.get_running_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, signal.abort)
        except (NotImplementedError, RuntimeError):  # Windows event loops
            pass


def _remove_cancel() -> None:
    loop = asyncio.get_running_loop()
    for sig in (os_signal.SIGINT, os_signal.SIGTERM):
        try:
            loop.remove_signal_handler(sig)
        except (NotImplementedError, RuntimeError):
            pass


async def _test(values: argparse.Namespace) -> int:
    if values.commit is not None and not is_commit_sha(values.commit):
        raise TracedojoError("--commit must be a full lowercase Git SHA.")
    config = values.config or "dojo/workflow.json"
    adapter_path = values.adapter or "dojo/adapter.py"
    workflow = parse_workflow(_read_json(config))
    try:
        trials = int(values.trials) if values.trials is not None else 1
    except ValueError:
        trials = 0
    if not 1 <= trials <= 20:
        raise TracedojoError("--trials must be from 1 to 20.")
    if not adapter_path.endswith(".py") or not Path(adapter_path).is_file():
        raise TracedojoError("Use a trusted local .py adapter module.")
    destination = Path(values.out or f".tracedojo/reports/{uuid.uuid4()}.json").resolve()
    # Reserve every destination before invoking customer code or a paid model.
    output = _reserve(destination)
    summary_path = Path(values.summary).resolve() if values.summary else None
    summary_fd: Optional[int] = None
    saved = False
    cancel = Signal()
    _install_cancel(cancel)
    try:
        if summary_path:
            summary_fd = _reserve(summary_path)
        adapter = load_adapter(adapter_path)
        batch = sanitize_batch(
            await run_workflow(workflow, adapter, trials=trials, signal=cancel, commit_sha=values.commit)
        )
        _write(output, dumps(batch, 2) + "\n")
        saved = True
        if summary_fd is not None:
            _write(summary_fd, workflow_summary(batch))
        print(f"Control: {batch['baseline']['status']}")
        for run in batch["runs"]:
            print(f"{run['scenario']['title']}: {run['status']}")
            for check in run["assertions"]:
                if not check["passed"]:
                    print(f"  {check['label']}: {check['detail']}")
        if batch.get("skippedReason"):
            print(batch["skippedReason"])
        print(f"Completed {len(batch['runs'])}/{batch['planned']} fault trials. Report: {destination}")
        return workflow_exit_code(batch)
    finally:
        _remove_cancel()
        os.close(output)
        if summary_fd is not None:
            os.close(summary_fd)
        if not saved:
            destination.unlink(missing_ok=True)
            if summary_fd is not None and summary_path:
                summary_path.unlink(missing_ok=True)


def _compare(values: argparse.Namespace) -> int:
    if values.base_sha or values.head_sha:
        if not is_commit_sha(values.base_sha or "") or not is_commit_sha(values.head_sha or ""):
            raise TracedojoError("Provide both --base-sha and --head-sha as full commit hashes.")

    def read_optional(path: str) -> Any:
        try:
            return _read_json(path)
        except FileNotFoundError:
            return None

    result = compare_workflow_batches(read_optional(values.base), read_optional(values.candidate))
    destination = Path(values.out or f".tracedojo/comparisons/{uuid.uuid4()}.json").resolve()
    output = _reserve(destination)
    summary_path = Path(values.summary).resolve() if values.summary else None
    summary_fd: Optional[int] = None
    saved = False
    try:
        if summary_path:
            summary_fd = _reserve(summary_path)
        document = dict(result)
        if values.base_sha:
            document["source"] = {"baseSha": values.base_sha, "headSha": values.head_sha}
        _write(output, dumps(document, 2) + "\n")
        if summary_fd is not None:
            _write(summary_fd, comparison_summary(result))
        saved = True
        print(result["reason"])
        return comparison_exit_code(result)
    finally:
        os.close(output)
        if summary_fd is not None:
            os.close(summary_fd)
        if not saved:
            destination.unlink(missing_ok=True)
            if summary_fd is not None and summary_path:
                summary_path.unlink(missing_ok=True)


async def _demo(values: argparse.Namespace) -> int:
    directory = Path(values.out or f".tracedojo/demo-{uuid.uuid4()}").resolve()
    directory.parent.mkdir(parents=True, exist_ok=True)
    before, after = await run_demo(directory)
    print("A booking succeeded. Its confirmation timed out. The agent retried.")
    print(
        f"Before: {before['runs'][0]['status']} — {before['runs'][0]['metrics']['mutations']} "
        "committed writes; duplicate booking."
    )
    print(
        f"After:  {after['runs'][0]['status']} — {after['runs'][0]['metrics']['mutations']} "
        "committed write; the retry reused the original booking."
    )
    print("Both no-fault controls passed. Scripted example; no model calls.")
    print(
        f"Open before.json and after.json from {directory} in a project at https://tracedojo.com "
        "(sign-in required), using Workflows → Preview report. Preview does not save reports.\n"
        "Local dashboard and upload instructions: https://tracedojo.com/docs#inspect-and-save-reports"
    )
    return 0


def _run(argv: Sequence[str]) -> int:
    parser = _parser()
    try:
        values = parser.parse_args(list(argv))
    except SystemExit:
        raise TracedojoError("Unsupported arguments. See --help.") from None
    positionals = values.positionals
    command = positionals[0] if positionals else None
    if not command or values.help:
        print(HELP)
        return 0
    given = _given(values)
    if command == "upload":
        if len(positionals) != 2 or given - {"url", "project"}:
            raise TracedojoError("upload takes one report file and --url/--project.")
        receipt = upload_workflow_reports(
            _read_json(positionals[1]),
            url=values.url or os.environ.get("TRACEDOJO_URL", ""),
            project=values.project or os.environ.get("TRACEDOJO_PROJECT_ID", ""),
            token=os.environ.get("TRACEDOJO_UPLOAD_TOKEN", ""),
        )
        print(upload_message(receipt))
        return 0
    if command == "compare":
        allowed = {"base", "candidate", "out", "summary", "base_sha", "head_sha"}
        if len(positionals) != 1 or not values.base or not values.candidate or given - allowed:
            raise TracedojoError("compare requires --base and --candidate report files.")
        return _compare(values)
    allowed_by_command = {
        "test": {"config", "adapter", "out", "trials", "summary", "commit"},
        "demo": {"out"},
    }
    if command not in allowed_by_command:
        raise TracedojoError("Unknown command. See --help.")
    if given - allowed_by_command[command] or len(positionals) != 1:
        raise TracedojoError("Unsupported arguments. See --help.")
    runner = _test if command == "test" else _demo
    return asyncio.run(runner(values))


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        code = _run(sys.argv[1:] if argv is None else argv)
    except TracedojoError as error:
        print(str(error), file=sys.stderr)
        code = 2
    except FileExistsError as error:
        print(f"Refusing to overwrite existing evidence: {error.filename}", file=sys.stderr)
        code = 2
    except FileNotFoundError as error:
        print(f"File not found: {error.filename}", file=sys.stderr)
        code = 2
    except Exception:
        # Schema errors can contain customer inputs; never print them.
        print(
            "Invalid input or output. Check the file paths, JSON, and workflow contract.",
            file=sys.stderr,
        )
        code = 2
    return code


def entrypoint() -> None:
    sys.exit(main())


if __name__ == "__main__":
    entrypoint()
