# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Normalize a report, batch, or upload bundle into content-addressed reports."""

from __future__ import annotations

import hashlib
from typing import Any

from ._json import bounded_json, stable_json
from .privacy import sanitize_report
from .schema import SchemaError, _array, _literal, _strict, parse_batch, parse_report


def parse_workflow_reports(value: Any) -> list[dict[str, Any]]:
    """Port of parseWorkflowReports: imported IDs are derived from report content."""
    bounded_json(value)
    if isinstance(value, dict) and value.get("schemaVersion") == "workflow-upload/1":
        data = _strict(value, ("schemaVersion", "reports"))
        _literal(data["schemaVersion"], "workflow-upload/1")
        reports = _array(data["reports"], 1, 21, parse_report)
    else:
        try:
            reports = [parse_report(value)]
        except SchemaError:
            batch = parse_batch(value)
            reports = [batch["baseline"], *batch["runs"]]
    normalized = []
    for report in reports:
        data = {k: v for k, v in report.items() if k != "origin"}
        original_id = report["origin"]["originalId"] if "origin" in report else report["id"]
        sanitized = sanitize_report({**data, "id": original_id})
        digest = hashlib.sha256(stable_json(sanitized).encode("utf-8")).hexdigest()[:32]
        run_id = f"run_{digest[:8]}-{digest[8:12]}-{digest[12:16]}-{digest[16:20]}-{digest[20:]}"
        normalized.append(parse_report({**sanitized, "id": run_id, "origin": {"kind": "imported", "originalId": original_id}}))
    return normalized
