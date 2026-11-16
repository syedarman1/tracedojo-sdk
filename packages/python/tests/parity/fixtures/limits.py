# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Parity fixture: run limits, protocol violations, and virtual clock failures."""

import asyncio

from tracedojo import SimpleAdapter, tool

DONE = {"status": "completed", "message": "Done."}


@tool("read")
def echo(args, state, context):
    return {"ok": True, "data": args}


@tool("write")
def write_blob(args, state, context):
    state["blob"] = str(args["n"]).ljust(45000, "x")
    return {"ok": True, "data": {"n": args["n"]}}


@tool("read")
def mutate_read(args, state, context):
    state["blob"] = "changed"
    return {"ok": True, "data": {}}


@tool("write")
def boom(args, state, context):
    raise RuntimeError("handler crashed")


class Agent:
    id = "limits-agent"

    def __init__(self, variant):
        self.version = variant

    async def run(self, ctx):
        v, call, clock = self.version, ctx.call, ctx.clock
        if v == "ok":
            await call("echo", {"a": 1})
            return DONE
        if v == "repeat":
            for _ in range(3):
                await call("echo", {"a": 1})
            return DONE
        if v == "call-limit":
            for i in range(10):
                await call("echo", {"i": i})
            return DONE
        if v == "catch-stop":
            try:
                for i in range(10):
                    await call("echo", {"i": i})
            except Exception:
                return DONE
            return DONE
        if v == "agent-error":
            await call("echo", {"a": 1})
            raise RuntimeError("agent crashed")
        if v == "bad-completion":
            return {"status": "done", "message": "Not a valid status."}
        if v == "read-mutates":
            await call("mutate_read", {})
            return DONE
        if v == "tool-throws":
            await call("boom", {})
            return DONE
        if v == "unawaited":
            call("echo", {"a": 1})
            return DONE
        if v == "hang":
            await asyncio.get_running_loop().create_future()
            return DONE
        if v == "evidence":
            for n in range(8):
                await call("write_blob", {"n": n})
            return DONE
        if v == "model":
            ctx.record_model("Chose echo.", {"tokens": 12, "cost": 0.0004})
            ctx.record_model("No payload.")
            await call("echo", {"a": 1})
            return {**DONE, "output": {"list": [1, 2.5, -0.0, None, True, "two"]}}
        if v == "clock-contract":
            try:
                await clock.sleep(-1)
            except Exception:
                pass
            return DONE
        if v == "clock-limit":
            for _ in range(1001):
                await clock.sleep(0)
            return DONE
        if v == "clock-budget":
            await clock.sleep(6000)
            return DONE
        if v == "parallel-sleeps":

            async def later(ms, tag):
                await clock.sleep(ms)
                return await call("echo", {"tag": tag, "at": clock.now()})

            await asyncio.gather(later(300, "a"), later(100, "b"), later(100, "c"))
            await clock.sleep(50)
            return {**DONE, "output": {"now": clock.now()}}
        if v == "unawaited-sleep":
            clock.sleep(100)
            return DONE
        raise RuntimeError(f"unknown variant {v}")


def make_adapter(variant):
    return SimpleAdapter(
        {"echo": echo, "write_blob": write_blob, "mutate_read": mutate_read, "boom": boom},
        lambda: Agent(variant),
    )
