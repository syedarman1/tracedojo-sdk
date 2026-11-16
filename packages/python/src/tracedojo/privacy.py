# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Pattern-based redaction of reports before they are written or uploaded.

The regular expressions reproduce the JavaScript SDK's (ASCII word boundaries,
ASCII case folding, ECMAScript whitespace) so both SDKs redact identically.
"""

from __future__ import annotations

import re
from typing import Any

from ._json import Json, bounded_json
from .errors import TracedojoError
from .schema import parse_batch, parse_report

_S = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_FLAGS = re.ASCII | re.IGNORECASE

_TOKENS = re.compile(
    r"\b(?:td_upload_[a-f0-9]{64}|sb_secret_[A-Za-z0-9_-]+|sk-(?:proj-)?[A-Za-z0-9_-]{16,}"
    r"|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b",
    re.ASCII,
)
_BEARER = re.compile(rf"\bBearer[{_S}]+[A-Za-z0-9._~+/=-]+", _FLAGS)
_ASSIGNMENT = re.compile(
    rf"\b(password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)[{_S}]*[:=][{_S}]*"
    rf"(?:\"[^\"\n]*\"|'[^'\n]*'|[^{_S},;}}]+)",
    _FLAGS,
)
_EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", _FLAGS)
_RESERVED_EMAIL = re.compile(r"@(?:[a-z0-9.-]+\.)?(?:example|invalid)\Z", _FLAGS)
_PRIVATE_KEY = re.compile(r"authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token", _FLAGS)


def _scrub(value: str) -> str:
    value = _TOKENS.sub("[REDACTED]", value)
    value = _BEARER.sub("Bearer [REDACTED]", value)
    value = _ASSIGNMENT.sub(lambda m: f'{m.group(1)}="[REDACTED]"', value)
    return _EMAIL.sub(
        lambda m: m.group() if _RESERVED_EMAIL.search(m.group()) else "redacted@private.invalid",
        value,
    )


def sanitize_json(value: Any) -> Json:
    """Pattern-based redaction, not comprehensive personal-data detection."""
    bounded_json(value)

    def walk(item: Any) -> Json:
        if isinstance(item, str):
            return _scrub(item)
        if isinstance(item, list):
            return [walk(v) for v in item]
        if isinstance(item, dict):
            entries = [
                (_scrub(key), "[REDACTED]" if _PRIVATE_KEY.search(key) else walk(child))
                for key, child in item.items()
            ]
            if len({key for key, _ in entries}) != len(entries):
                raise TracedojoError("Redaction would merge distinct fields. Remove private fields before export.")
            return dict(entries)
        return item

    return walk(value)


def sanitize_report(value: Any) -> dict[str, Any]:
    bounded_json(value)
    report = parse_report(value)
    # Revalidate after scrubbing. If distinct secrets collapse into a false match,
    # fail closed rather than silently changing a recorded verdict.
    return parse_report(sanitize_json(report))


def sanitize_batch(value: Any) -> dict[str, Any]:
    bounded_json(value)
    batch = parse_batch(value)
    scrubbed = sanitize_json(batch)
    assert isinstance(scrubbed, dict)
    return parse_batch(
        {
            **scrubbed,
            "baseline": sanitize_report(batch["baseline"]),
            "runs": [sanitize_report(run) for run in batch["runs"]],
        }
    )
