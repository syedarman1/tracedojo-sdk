# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Parity fixture: tool_calls, tool_order, forbidden_tool, state and completion checks."""

import asyncio

from tracedojo import SimpleAdapter, tool


def _retry(r):
    return isinstance(r, str) or (not r["ok"] and r["error"]["retryable"])


@tool("read")
def lookup_slot(args, state, context):
    return {"ok": True, "data": {"slot": args.get("slot"), "free": not any(b["slot"] == args.get("slot") for b in state["bookings"])}}


@tool("write")
def reserve(args, state, context):
    if not isinstance(args.get("key"), str):
        return {"ok": False, "error": {"code": "BAD_KEY", "message": "  Key required.  ", "retryable": False}}
    if args["key"] in state["keys"]:
        return {"ok": True, "data": {"bookingId": state["keys"][args["key"]]}}
    booking_id = f"b_{len(state['bookings']) + 1}"
    state["bookings"].append({"id": booking_id, "slot": args.get("slot")})
    state["keys"][args["key"]] = booking_id
    return {"ok": True, "data": {"bookingId": booking_id}}


@tool("write")
async def notify(args, state, context):
    await asyncio.sleep(0)
    state["notifications"].append(args.get("bookingId"))
    return {"ok": True, "data": {"sent": True, "ratio": 0.1 + 0.2, "big": 1e21, "small": 1e-7}}


@tool("write")
def refund_all(args, state, context):
    state["refunds"].append(1)
    return {"ok": True, "data": None}


class Agent:
    id = "checks-agent"

    def __init__(self, variant):
        self.version = variant

    async def run(self, ctx):
        variant = self.version
        ctx.record_model("Planning the booking.", {"step": 1, "note": "Ünïcödé \U0001f389"})
        call = ctx.call

        async def lookup(slot):
            return await call("lookup_slot", {"slot": slot})

        async def do_reserve(slot, key):
            for _ in range(3):
                r = await call("reserve", {"slot": slot, "key": key})
                if not isinstance(r, str) and r["ok"]:
                    return r["data"]["bookingId"]
                if not _retry(r):
                    return None
            return None

        async def do_notify(booking_id):
            for _ in range(2):
                r = await call("notify", {"bookingId": booking_id})
                if not isinstance(r, str) and r["ok"]:
                    return "sent"
                if not _retry(r):
                    return "blocked"
            return "failed"

        if variant == "unknown":
            await call("missing_tool", {})
        if variant == "extra-calls":
            for s in ("slot_2", "slot_3"):
                await lookup(s)
        if variant == "bad-order":
            booking_id = await do_reserve("slot_1", "k1")
            await lookup("slot_1")
        elif variant == "concurrent":
            booking_id, _ = await asyncio.gather(do_reserve("slot_1", "k1"), do_reserve("slot_2", "k2"))
            await lookup("slot_1")
        else:
            found = await lookup("slot_1")
            if not isinstance(found, str) and found["ok"] and isinstance(found["data"], dict) and found["data"].get("nextTool"):
                await call(found["data"]["nextTool"], {})
            booking_id = await do_reserve("slot_1", "k1")
        if not booking_id:
            return {"status": "blocked", "message": "Reservation failed."}
        sent = await do_notify(booking_id)
        if variant == "forbidden":
            await call("refund_all", {"reason": "cleanup"})
        if sent == "blocked":
            return {"status": "blocked", "message": "Notification permission revoked.", "output": {"bookingId": booking_id}}
        return {"status": "completed", "message": "Booked and notified.", "output": {"bookingId": booking_id, "sent": sent}}


def make_adapter(variant):
    return SimpleAdapter(
        {"lookup_slot": lookup_slot, "reserve": reserve, "notify": notify, "refund_all": refund_all},
        lambda: Agent(variant),
    )
