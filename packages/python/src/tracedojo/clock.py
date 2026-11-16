# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""Per-trial clock: real wall time, or a virtual clock that advances only when idle."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any, Callable, Protocol

from ._json import is_integer
from .signal import Signal


class WorkflowClock(Protocol):
    def now(self) -> int:
        """Epoch milliseconds in real mode; configured start plus elapsed time in virtual mode."""

    def sleep(self, ms: int) -> "asyncio.Future[None]":
        """Awaitable delay; virtual sleeps advance simulated time without waiting."""


class ClockClosed(RuntimeError):
    pass


class _Api:
    __slots__ = ("now", "sleep")

    def __init__(self, now: Callable[[], int], sleep: Callable[[int], "asyncio.Future[None]"]):
        object.__setattr__(self, "now", now)
        object.__setattr__(self, "sleep", sleep)

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("The workflow clock is read-only.")


def _quiet(future: "asyncio.Future[None]") -> None:
    if not future.cancelled():
        future.exception()


class ImmediateQueue:
    """setImmediate for asyncio.

    Node runs every promise continuation before the next setImmediate callback.
    asyncio has a single ready queue, so a callback here runs only once the loop
    has nothing else ready, one callback per idle point, in FIFO order. This keeps
    the runner's call admission and virtual time ordering identical to the JS SDK.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._queue: deque[Callable[[], None]] = deque()
        self._handle: asyncio.Handle | None = None
        self._rounds = 0

    def call(self, callback: Callable[[], None]) -> Callable[[], None]:
        self._queue.append(callback)
        self._arm()
        return callback

    def cancel(self, callback: Callable[[], None]) -> None:
        try:
            self._queue.remove(callback)
        except ValueError:
            pass

    def wait(self) -> "asyncio.Future[None]":
        future: asyncio.Future[None] = self._loop.create_future()

        def wake() -> None:
            if not future.done():
                future.set_result(None)

        self.call(wake)
        return future

    def _arm(self) -> None:
        if self._handle is None and self._queue:
            self._handle = self._loop.call_soon(self._tick)

    def _busy(self) -> bool:
        ready = getattr(self._loop, "_ready", None)
        if ready is not None:
            return len(ready) > 0
        # Event loops without an inspectable ready queue: yield a fixed number of times.
        self._rounds += 1
        if self._rounds < 16:
            return True
        self._rounds = 0
        return False

    def _tick(self) -> None:
        self._handle = None
        if not self._queue:
            return
        if self._busy():
            self._handle = self._loop.call_soon(self._tick)
            return
        self._queue.popleft()()
        self._arm()


class TrialClock:
    """Port of the JS TrialClock. Only the frozen ``api`` is exposed to agents and tools."""

    def __init__(
        self,
        config: dict[str, Any] | None,
        signal: Signal,
        on_fault: Callable[[str], None],
        immediate: ImmediateQueue,
    ) -> None:
        self._immediate = immediate
        self._config = config
        self._signal = signal
        self._on_fault = on_fault
        self._loop = asyncio.get_running_loop()
        self._elapsed = 0
        self._sleeps = 0
        self._holds = 0
        self._closed = False
        self._waiters: dict[asyncio.Future[None], dict[str, Any]] = {}
        self._pump: Callable[[], None] | None = None
        self.api: WorkflowClock = _Api(self._now, self._sleep)  # type: ignore[assignment]
        signal.add_listener(self.close)

    @property
    def pending(self) -> int:
        return len(self._waiters)

    def hold(self) -> Callable[[], None]:
        """Let a ready runner transaction start before advancing to a later timer."""
        self._holds += 1

        def release() -> None:
            self._holds -= 1

        return release

    @property
    def snapshot(self) -> dict[str, Any] | None:
        return {**self._config, "endMs": self._now()} if self._config else None

    def _now(self) -> int:
        if self._config:
            return self._config["startMs"] + self._elapsed
        return int(time.time() * 1000)

    def _sleep(self, ms: int) -> "asyncio.Future[None]":
        future: asyncio.Future[None] = self._loop.create_future()
        # Abandoned work must not produce "exception was never retrieved" warnings.
        future.add_done_callback(_quiet)
        if self._closed or self._signal.aborted:
            future.set_exception(ClockClosed("Trial clock is closed."))
            return future
        if not is_integer(ms) or not 0 <= ms <= 86400000 or abs(ms) >= 2**53:
            self._fail("clock_contract")
            future.set_exception(ValueError("Delay must be an integer from 0 to 86400000."))
            return future
        self._sleeps += 1
        if self._sleeps > 1000:
            self._fail("clock_limit")
            future.set_exception(RuntimeError("Trial sleep limit exceeded."))
            return future
        waiter: dict[str, Any] = {"due": self._elapsed + int(ms)}
        self._waiters[future] = waiter
        if self._config:
            self._schedule()
        else:

            def fire() -> None:
                if self._waiters.pop(future, None) is not None and not future.done():
                    future.set_result(None)

            waiter["timer"] = self._loop.call_later(int(ms) / 1000, fire)
        return future

    def _fail(self, reason: str) -> None:
        self._on_fault(reason)
        self.close()

    def _schedule(self) -> None:
        if self._pump or self._closed or not self._waiters:
            return
        self._pump = self._immediate.call(self._advance)

    def _advance(self) -> None:
        self._pump = None
        if self._closed:
            return
        if self._holds:
            self._schedule()
            return
        due = min(w["due"] for w in self._waiters.values())
        assert self._config is not None
        if due > self._config["maxTimeMs"]:
            self._elapsed = self._config["maxTimeMs"]
            self._fail("timed_out")
            return
        self._elapsed = due
        for future, waiter in list(self._waiters.items()):
            if waiter["due"] == due:
                del self._waiters[future]
                if not future.done():
                    future.set_result(None)
        # Yield so resumed code can register its next timer before time moves again.
        self._schedule()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._signal.remove_listener(self.close)
        if self._pump:
            self._immediate.cancel(self._pump)
            self._pump = None
        for future, waiter in self._waiters.items():
            timer = waiter.get("timer")
            if timer:
                timer.cancel()
            if not future.done():
                future.set_exception(ClockClosed("Trial clock is closed."))
        self._waiters.clear()
