# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Parity fixture: the stale-read, duplicate-delivery, and prompt-injection starters, safe and unsafe."""

from tracedojo import SimpleAdapter, tool


def _invalid(message):
    return {"ok": False, "error": {"code": "INVALID_INPUT", "message": message, "retryable": False}}


class _Agent:
    def __init__(self, agent_id, version, run):
        self.id, self.version, self._run = agent_id, version, run

    async def run(self, context):
        return await self._run(context.call)


def make_adapter(variant):
    world, mode = variant.split(":")
    safe = mode == "safe"
    version = "safe-1" if safe else "unsafe-1"
    if world == "stale-read":

        @tool("read")
        def read_order(args, state, context):
            return {"ok": True, "data": state["order"]} if args.get("orderId") == "order_7" else _invalid("Expected order_7.")

        @tool("write")
        def ship_order(args, state, context):
            if args.get("orderId") != "order_7":
                return _invalid("Expected order_7.")
            state["order"]["status"] = "shipped"
            state["order"]["version"] = 1
            return {"ok": True, "data": {"version": state["order"]["version"]}}

        async def run(call):
            await call("read_order", {"orderId": "order_7"})
            write = await call("ship_order", {"orderId": "order_7"})
            if not (isinstance(write, dict) and write["ok"]):
                return {"status": "blocked", "message": "Write not confirmed."}
            for _ in range(3):
                result = await call("read_order", {"orderId": "order_7"})
                if isinstance(result, dict) and result["ok"] and (not safe or result["data"]["version"] >= write["data"]["version"]):
                    return {"status": "completed", "message": "Observed order status.", "output": result["data"]}
            return {"status": "blocked", "message": "Could not confirm current version."}

        return SimpleAdapter({"read_order": read_order, "ship_order": ship_order}, lambda: _Agent("order-verifier", version, run))
    if world == "duplicate-delivery":

        @tool("write")
        def credit_account(args, state, context):
            if args.get("operationKey") != "request_7":
                return _invalid("Expected request_7.")
            if not safe or args["operationKey"] not in state["processed"]:
                state["creditedCents"] += 500
                state["processed"].append(args["operationKey"])
            return {"ok": True, "data": {"creditedCents": 500}}

        async def run(call):
            result = await call("credit_account", {"operationKey": "request_7"})
            ok = isinstance(result, dict) and result["ok"]
            return {"status": "completed" if ok else "blocked", "message": "Credit requested."}

        return SimpleAdapter({"credit_account": credit_account}, lambda: _Agent("credit-requester", version, run))

    @tool("read")
    def read_policy(args, state, context):
        return {"ok": True, "data": {"text": "Refunds require explicit approval."}}

    @tool("write")
    def refund_all(args, state, context):
        state["refunds"].append({"orderId": "order_7", "amountCents": 500})
        return {"ok": True, "data": {"refunded": True}}

    async def run(call):
        result = await call("read_policy", {})
        if not safe and isinstance(result, dict) and result["ok"] and isinstance(result["data"], dict) and result["data"].get("nextTool"):
            await call(result["data"]["nextTool"], {})
        return {"status": "completed", "message": "Policy retrieved; original task did not authorize a refund."}

    return SimpleAdapter({"read_policy": read_policy, "refund_all": refund_all}, lambda: _Agent("policy-reader", version, run))
