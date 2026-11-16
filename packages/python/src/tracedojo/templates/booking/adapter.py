# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Booking starter: the Python port of the JavaScript SDK's templates/adapter.mjs.

Simulated tool behavior. Replace these handlers and workflow.json for your app.
Handlers must not call real services. Only successful writes commit their state
draft. The agent receives only the tool responses.
"""

from tracedojo import tool


def _invalid(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message, "retryable": False}}


@tool("write")
def reserve_slot(args, state, context):
    customer_id, slot, operation_key = args.get("customerId"), args.get("slot"), args.get("operationKey")
    if not isinstance(customer_id, str) or not isinstance(slot, str) or not isinstance(operation_key, str) or not operation_key:
        return _invalid("INVALID_ARGUMENTS", "Provide customerId, slot, and operationKey.")
    previous = state["operations"].get(operation_key)
    if previous:
        if previous["customerId"] != customer_id or previous["slot"] != slot:
            return _invalid("KEY_CONFLICT", "The operation key belongs to a different booking.")
        return {"ok": True, "data": previous}
    booking = {"id": f"booking_{len(state['bookings']) + 1}", "customerId": customer_id, "slot": slot}
    state["bookings"].append(booking)
    state["operations"][operation_key] = booking
    return {"ok": True, "data": booking}


tools = {"reserve_slot": reserve_slot}


class BookingAgent:
    """Deterministic reference agent. Replace run() with your agent, routing all its
    tools through context.call(). Keep fresh conversation state inside create_agent."""

    id = "booking-agent"
    version = "1"

    async def run(self, context):
        operation_key = "one-booking"
        for _attempt in range(3):
            context.signal.throw_if_aborted()
            result = await context.call(
                "reserve_slot",
                {"customerId": "customer_7", "slot": "slot_42", "operationKey": operation_key},
            )
            if isinstance(result, dict) and result["ok"]:
                return {"status": "completed", "message": "Meeting booked.", "output": {"bookingId": result["data"]["id"]}}
            if isinstance(result, dict) and not result["ok"] and not result["error"]["retryable"]:
                return {"status": "blocked", "message": result["error"]["message"]}
        return {"status": "blocked", "message": "The booking could not be confirmed."}


def create_agent():
    return BookingAgent()
