# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
from __future__ import annotations

import json

import pytest

from tracedojo import TracedojoError, run_workflow_sync
from tracedojo.reports import parse_workflow_reports
from tracedojo.templates.booking import adapter as booking
from tracedojo.demo import booking_workflow
from tracedojo.upload import upload_message, upload_workflow_reports

PROJECT = "123e4567-e89b-42d3-a456-426614174000"
TOKEN = "td_upload_" + "a" * 64


@pytest.fixture(scope="module")
def batch():
    return run_workflow_sync(booking_workflow(), booking, trials=4)


def receipt_sender(log, statuses=None):
    statuses = list(statuses or [])

    def send(url, headers, body, timeout):
        payload = json.loads(body)
        log.append((url, headers, payload))
        if statuses:
            return statuses.pop(0), b""
        ids = [r["id"] for r in payload["reports"]]
        return 201, json.dumps({"inserted": len(ids) - 1, "duplicates": 1, "runIds": ids}).encode()

    return send


def test_uploads_in_chunks_with_content_ids(batch):
    log = []
    receipt = upload_workflow_reports(batch, url="https://tracedojo.com/", project=PROJECT, token=TOKEN, send=receipt_sender(log))
    assert [len(p["reports"]) for _, _, p in log] == [21]
    assert log[0][0] == f"https://tracedojo.com/api/projects/{PROJECT}/runs"
    assert log[0][1]["Authorization"] == f"Bearer {TOKEN}"
    assert TOKEN not in log[0][0]
    assert receipt == {"count": 21, "inserted": 20, "duplicates": 1, "url": f"https://tracedojo.com/projects/{PROJECT}/workflows"}
    assert [r["id"] for r in log[0][2]["reports"]] == [r["id"] for r in parse_workflow_reports(batch)]
    assert upload_message(receipt) == f"Uploaded 20 new reports, 1 already stored. {receipt['url']}"


def test_retries_transient_failures_then_rejects(batch, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _s: None)
    log = []
    upload_workflow_reports(batch["baseline"], url="http://localhost:3000", project=PROJECT, token=TOKEN, send=receipt_sender(log, [503, 502]))
    assert len(log) == 3
    with pytest.raises(TracedojoError, match="HTTP 401"):
        upload_workflow_reports(batch["baseline"], url="https://tracedojo.com", project=PROJECT, token=TOKEN, send=receipt_sender([], [401]))

    def wrong(url, headers, body, timeout):
        return 201, json.dumps({"inserted": 1, "duplicates": 0, "runIds": ["run_other"]}).encode()

    with pytest.raises(TracedojoError, match="Unexpected upload receipt"):
        upload_workflow_reports(batch["baseline"], url="https://tracedojo.com", project=PROJECT, token=TOKEN, send=wrong)


@pytest.mark.parametrize(
    "url",
    ["http://tracedojo.com", "https://tracedojo.com/api", "https://user:pw@tracedojo.com", "https://tracedojo.com/?x=1", "https://tracedojo.com#x", "ftp://localhost"],
)
def test_rejects_unsafe_origins(batch, url):
    with pytest.raises(TracedojoError, match="HTTPS origin"):
        upload_workflow_reports(batch["baseline"], url=url, project=PROJECT, token=TOKEN, send=receipt_sender([]))


def test_rejects_bad_credentials(batch):
    with pytest.raises(TracedojoError, match="valid project ID"):
        upload_workflow_reports(batch, url="https://tracedojo.com", project=PROJECT, token="td_upload_x", send=receipt_sender([]))
