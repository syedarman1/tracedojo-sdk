# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Upload reports to a TraceDojo project. The token never leaves this process
except in the Authorization header sent to the configured origin."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

from ._json import dumps, is_integer
from .errors import TracedojoError
from .reports import parse_workflow_reports
from .schema import _UUID

# send(url, headers, body, timeout_seconds) -> (status, response_body)
Sender = Callable[[str, dict[str, str], bytes, float], "tuple[int, bytes]"]

_TOKEN = re.compile(r"td_upload_[a-f0-9]{64}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        raise urllib.error.URLError("Redirects are not followed.")


def _urllib_send(url: str, headers: dict[str, str], body: bytes, timeout: float) -> "tuple[int, bytes]":
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def _origin(url: str) -> str:
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = parts.port
    except ValueError:
        raise TracedojoError("Use an HTTPS origin, or HTTP on localhost for development.") from None
    local = host in ("localhost", "127.0.0.1", "::1")
    if (
        not host
        or (parts.scheme != "https" and not (parts.scheme == "http" and local))
        or parts.path not in ("", "/")
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or "?" in url
        or "#" in url
    ):
        raise TracedojoError("Use an HTTPS origin, or HTTP on localhost for development.")
    netloc = f"[{host}]" if ":" in host else host
    if port is not None and port != (443 if parts.scheme == "https" else 80):
        netloc += f":{port}"
    return f"{parts.scheme}://{netloc}"


def upload_workflow_reports(
    value: Any,
    *,
    url: str,
    project: str,
    token: str,
    send: Optional[Sender] = None,
) -> dict[str, Any]:
    """Upload a report, batch, or bundle in chunks of 21. Safe to retry: the server deduplicates."""
    if not isinstance(project, str) or not _UUID.fullmatch(project) or not isinstance(token, str) or not _TOKEN.fullmatch(token):
        raise TracedojoError("Supply a valid project ID and TRACEDOJO_UPLOAD_TOKEN.")
    origin = _origin(url)
    reports = parse_workflow_reports(value)
    endpoint = f"{origin}/api/projects/{project}/runs"
    transport = send or _urllib_send
    inserted = duplicates = 0
    for start in range(0, len(reports), 21):
        chunk = reports[start : start + 21]
        body = dumps({"schemaVersion": "workflow-upload/1", "reports": chunk}).encode("utf-8")
        if len(body) > 5_000_000:
            raise TracedojoError("This upload exceeds 5 MB. Upload smaller report groups.")
        for attempt in range(3):
            try:
                status, raw = transport(
                    endpoint,
                    {"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
                    body,
                    30.0,
                )
            except Exception:
                if attempt < 2:
                    continue
                raise TracedojoError(
                    "Upload could not connect. The local report is preserved; retry safely."
                ) from None
            if status in (408, 500, 502, 503, 504) and attempt < 2:
                time.sleep(0.5 * 2**attempt)
                continue
            if status != 201:
                raise TracedojoError(
                    f"Upload rejected (HTTP {status}). Check your project, token, or quota. "
                    "The local report is preserved; retry safely."
                )
            try:
                receipt = json.loads(raw)
            except ValueError:
                receipt = None
            valid = (
                isinstance(receipt, dict)
                and is_integer(receipt.get("inserted"))
                and receipt["inserted"] >= 0
                and is_integer(receipt.get("duplicates"))
                and receipt["duplicates"] >= 0
                and isinstance(receipt.get("runIds"), list)
                and all(isinstance(i, str) for i in receipt["runIds"])
            )
            if (
                not valid
                or receipt["inserted"] + receipt["duplicates"] != len(chunk)  # type: ignore[index]
                or len(receipt["runIds"]) != len(chunk)  # type: ignore[index]
                or any(run_id != chunk[i]["id"] for i, run_id in enumerate(receipt["runIds"]))  # type: ignore[index]
            ):
                raise TracedojoError("Unexpected upload receipt. The local report is preserved; retry safely.")
            inserted += int(receipt["inserted"])  # type: ignore[index]
            duplicates += int(receipt["duplicates"])  # type: ignore[index]
            break
    return {
        "count": len(reports),
        "inserted": inserted,
        "duplicates": duplicates,
        "url": f"{origin}/projects/{project}/workflows",
    }


def upload_message(receipt: dict[str, Any]) -> str:
    """Report what the server stored, not how many reports the file held."""
    stored = f"{receipt['inserted']} new {'report' if receipt['inserted'] == 1 else 'reports'}"
    counts = f"{stored}, {receipt['duplicates']} already stored" if receipt["duplicates"] else stored
    return f"Uploaded {counts}. {receipt['url']}"
