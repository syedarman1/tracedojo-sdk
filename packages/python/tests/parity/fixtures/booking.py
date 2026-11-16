# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Parity fixture: the shipped booking adapter, with the demo's key bug and a virtual-time wrapper."""

from tracedojo import SimpleAdapter, tool
from tracedojo.templates.booking import adapter as reference


def make_adapter(variant):
    stable = not variant.endswith("new-key")
    virtual = variant.startswith("virtual")
    if virtual:

        @tool("write")
        async def reserve_slot(args, state, context):
            await context.clock.sleep(25)
            return reference.reserve_slot.execute(args, state, context)

        tools = {"reserve_slot": reserve_slot}
    else:
        tools = reference.tools

    class Agent:
        def __init__(self):
            self.inner = reference.create_agent()
            self.attempt = 0
            self.id = self.inner.id
            self.version = ("stable-key" if stable else "new-key-per-retry") + ("-virtual" if virtual else "")

        async def run(self, context):
            async def call(name, args):
                if not stable:
                    self.attempt += 1
                    args = {**args, "operationKey": f"attempt_{self.attempt}"}
                result = await context.call(name, args)
                if virtual and (isinstance(result, str) or (not result["ok"] and result["error"]["retryable"])):
                    await context.clock.sleep(1000)
                return result

            return await self.inner.run(context.with_call(call))

    return SimpleAdapter(tools=tools, create_agent=Agent)
