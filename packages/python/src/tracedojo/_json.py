# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""JSON helpers that serialize exactly like JavaScript's JSON.stringify.

Report fingerprints and imported report IDs are SHA-256 digests of JSON text, so
the Python SDK must produce the same bytes as the JavaScript SDK for the same
values: JavaScript number formatting, UTF-16 key ordering, and string escaping.
"""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal
from typing import Any, Union

Json = Union[None, bool, int, float, str, list["Json"], dict[str, "Json"]]
State = dict[str, Json]

_SURROGATE = re.compile("[\ud800-\udfff]")
_INDEX_KEY = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_SAFE = 2**53


class JsonError(ValueError):
    """Raised when a value is not finite, acyclic, plain JSON within bounds."""


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_integer(value: object) -> bool:
    """Number.isInteger: integral floats count, booleans and non-finite values do not."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and value.is_integer()


def js_len(value: str) -> int:
    """String length in UTF-16 code units, as JavaScript and zod measure it."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _utf16_key(value: str) -> bytes:
    return value.encode("utf-16-be", "surrogatepass")


def js_number(value: int | float) -> str:
    """Format a number like JavaScript's Number.prototype.toString."""
    if isinstance(value, int):
        if -_SAFE < value < _SAFE:
            return str(value)
        value = float(value)
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    digits_tuple, exponent = Decimal(repr(abs(value))).as_tuple()[1:]
    digits = "".join(map(str, digits_tuple)).lstrip("0")
    stripped = digits.rstrip("0")
    exponent = int(exponent) + len(digits) - len(stripped)
    digits = stripped
    k = len(digits)
    n = k + exponent
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        text = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        mark = "+" if e >= 0 else "-"
        mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
        text = f"{mantissa}e{mark}{abs(e)}"
    return sign + text


def js_string(value: str) -> str:
    """Quote a string like JSON.stringify (well-formed: lone surrogates escaped)."""
    text = json.dumps(value, ensure_ascii=False)
    return _SURROGATE.sub(lambda m: "\\u%04x" % ord(m.group()), text)


def _ordered(value: dict[str, Any]) -> list[tuple[str, Any]]:
    # JavaScript enumerates array-index keys first, ascending, then insertion order.
    index = [k for k in value if _INDEX_KEY.match(k) and int(k) < 2**32 - 1]
    if not index:
        return list(value.items())
    rest = [k for k in value if not (_INDEX_KEY.match(k) and int(k) < 2**32 - 1)]
    return [(k, value[k]) for k in sorted(index, key=int)] + [(k, value[k]) for k in rest]


def _scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return js_string(value)
    if is_number(value):
        return js_number(value)
    raise JsonError("Expected finite, acyclic JSON data.")


def stable_json(value: Any) -> str:
    """Port of the SDK's stableJson: keys sorted by UTF-16 code units."""
    if isinstance(value, list):
        return "[" + ",".join(stable_json(item) for item in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: _utf16_key(kv[0]))
        return "{" + ",".join(f"{js_string(k)}:{stable_json(v)}" for k, v in items) + "}"
    return _scalar(value)


def dumps(value: Any, indent: int | None = None) -> str:
    """JSON.stringify(value, null, indent)."""
    if indent is None:
        return _compact(value)
    return _pretty(value, " " * indent, "")


def _compact(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_compact(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{js_string(k)}:{_compact(v)}" for k, v in _ordered(value)) + "}"
    return _scalar(value)


def _pretty(value: Any, step: str, current: str) -> str:
    inner = current + step
    if isinstance(value, list):
        if not value:
            return "[]"
        body = (",\n" + inner).join(_pretty(item, step, inner) for item in value)
        return f"[\n{inner}{body}\n{current}]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        body = (",\n" + inner).join(
            f"{js_string(k)}: {_pretty(v, step, inner)}" for k, v in _ordered(value)
        )
        return f"{{\n{inner}{body}\n{current}}}"
    return _scalar(value)


def utf8_size(value: Any) -> int:
    """Byte length of JSON.stringify(value) encoded as UTF-8."""
    return len(_compact(value).encode("utf-8"))


def _reject_constant(name: str) -> Any:
    raise JsonError(f"Invalid JSON value {name}.")


def loads(text: str) -> Any:
    """JSON.parse equivalent: rejects NaN and Infinity literals."""
    return json.loads(text, parse_constant=_reject_constant)


def bounded_json(value: Any, max_bytes: int = 5_000_000) -> None:
    """Validate before cloning, hashing, or schema checks of untrusted JSON."""
    nodes = 0
    path: set[int] = set()

    def walk(item: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > 100000 or depth > 30:
            raise JsonError("JSON is too deeply nested or too large.")
        if item is None or isinstance(item, (str, bool)):
            return
        if is_number(item):
            if isinstance(item, float) and not math.isfinite(item):
                raise JsonError("Expected finite, acyclic JSON data.")
            return
        if not isinstance(item, (list, dict)) or id(item) in path:
            if isinstance(item, (list, dict)):
                raise JsonError("Expected finite, acyclic JSON data.")
            raise JsonError("Expected plain JSON objects.")
        path.add(id(item))
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise JsonError("Expected plain JSON objects.")
                walk(child, depth + 1)
        else:
            for child in item:
                walk(child, depth + 1)
        path.discard(id(item))

    walk(value, 0)
    if utf8_size(value) > max_bytes:
        raise JsonError("JSON exceeds the size limit.")


def clone(value: Any) -> Any:
    """structuredClone for JSON values."""
    if isinstance(value, dict):
        return {k: clone(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clone(v) for v in value]
    return value
