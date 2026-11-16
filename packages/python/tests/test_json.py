# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
from __future__ import annotations

import pytest

from tracedojo import bounded_json, dumps, loads, stable_json
from tracedojo._json import JsonError, js_number


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (1.5, "1.5"),
        (0.1 + 0.2, "0.30000000000000004"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (123e-7, "0.0000123"),
        (1e-7, "1e-7"),
        (-2.5e-7, "-2.5e-7"),
        (5e-324, "5e-324"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (2**53 + 1, "9007199254740992"),
        (10**25, "1e+25"),
    ],
)
def test_numbers_format_like_javascript(value, expected):
    assert js_number(value) == expected


def test_stable_json_sorts_by_utf16_code_units():
    assert stable_json({"\U0001f389": 1, "Ａ": 2, "b": 3, "a": [True, None]}) == '{"a":[true,null],"b":3,"\U0001f389":1,"Ａ":2}'


def test_dumps_orders_index_keys_like_javascript():
    assert dumps({"b": 1, "10": 2, "2": 3, "01": 4}) == '{"2":3,"10":2,"b":1,"01":4}'
    assert dumps({"a": []}, 2) == '{\n  "a": []\n}'


def test_bounded_json_rejects_non_json():
    for bad in ({1: "x"}, (1, 2), {"a": float("inf")}, {"a": object()}):
        with pytest.raises(JsonError):
            bounded_json(bad)
    cyclic: list = []
    cyclic.append(cyclic)
    with pytest.raises(JsonError):
        bounded_json(cyclic)
    deep: list = []
    node = deep
    for _ in range(31):
        node.append([])
        node = node[0]
    with pytest.raises(JsonError):
        bounded_json(deep)
    with pytest.raises(JsonError):
        bounded_json({"a": "x" * 100}, 50)
    shared = {"x": 1}
    bounded_json({"a": shared, "b": shared})


def test_loads_rejects_nan():
    with pytest.raises(JsonError):
        loads('{"a": NaN}')
