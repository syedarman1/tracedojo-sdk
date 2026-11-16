# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Syed Arman
"""A minimal AbortSignal equivalent for cooperative cancellation."""

from __future__ import annotations

from typing import Callable


class Cancelled(Exception):
    """Raised by Signal.throw_if_aborted after cancellation."""


class Signal:
    """Cooperative cancellation flag shared by the runner, agents, and tools.

    Call ``abort()`` from the event loop thread (for example from a signal handler
    registered with ``loop.add_signal_handler``) to cancel remaining trials.
    """

    def __init__(self) -> None:
        self._aborted = False
        self._listeners: list[Callable[[], None]] = []

    @property
    def aborted(self) -> bool:
        return self._aborted

    def abort(self) -> None:
        if self._aborted:
            return
        self._aborted = True
        listeners, self._listeners = self._listeners, []
        for listener in listeners:
            listener()

    def throw_if_aborted(self) -> None:
        if self._aborted:
            raise Cancelled("The operation was aborted.")

    def add_listener(self, listener: Callable[[], None]) -> None:
        # Like AbortSignal.addEventListener: an already-aborted signal never fires again.
        if not self._aborted:
            self._listeners.append(listener)

    def remove_listener(self, listener: Callable[[], None]) -> None:
        try:
            self._listeners.remove(listener)
        except ValueError:
            pass
