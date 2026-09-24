// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

// Simulated tool behavior. Replace these handlers and workflow.json for your app.
// Handlers are synchronous and must not call real services. Only successful
// writes commit their state draft. The agent receives only the tool responses.
export const tools = {
  reserve_slot: {
    kind: 'write',
    execute(args, state) {
      const { customerId, slot, operationKey } = args;
      if (
        typeof customerId !== 'string' ||
        typeof slot !== 'string' ||
        typeof operationKey !== 'string' ||
        !operationKey
      )
        return {
          ok: false,
          error: {
            code: 'INVALID_ARGUMENTS',
            message: 'Provide customerId, slot, and operationKey.',
            retryable: false,
          },
        };
      const previous = Object.hasOwn(state.operations, operationKey)
        ? state.operations[operationKey]
        : undefined;
      if (previous) {
        if (previous.customerId !== customerId || previous.slot !== slot)
          return {
            ok: false,
            error: {
              code: 'KEY_CONFLICT',
              message: 'The operation key belongs to a different booking.',
              retryable: false,
            },
          };
        return { ok: true, data: previous };
      }
      const booking = {
        id: `booking_${state.bookings.length + 1}`,
        customerId,
        slot,
      };
      state.bookings.push(booking);
      Object.defineProperty(state.operations, operationKey, {
        value: booking,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return { ok: true, data: booking };
    },
  },
};

// Deterministic reference agent. Replace run() with your agent, routing all its
// tools through context.call(). Keep fresh conversation state inside this factory.
export function createAgent() {
  return {
    id: 'booking-agent',
    version: '1',
    async run({ call, signal }) {
      const operationKey = 'one-booking';
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const result = await call('reserve_slot', {
          customerId: 'customer_7',
          slot: 'slot_42',
          operationKey,
        });
        if (typeof result !== 'string' && result.ok)
          return {
            status: 'completed',
            message: 'Meeting booked.',
            output: { bookingId: result.data.id },
          };
        if (typeof result !== 'string' && !result.ok && !result.error.retryable)
          return { status: 'blocked', message: result.error.message };
      }
      return {
        status: 'blocked',
        message: 'The booking could not be confirmed.',
      };
    },
  };
}
