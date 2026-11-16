// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// Parity fixture: tool_calls, tool_order, forbidden_tool, state and completion checks.
const retry = (r) => typeof r === 'string' || (!r.ok && r.error.retryable);

export function makeAdapter(variant) {
  return {
    tools: {
      lookup_slot: {
        kind: 'read',
        execute: (args, state) => ({
          ok: true,
          data: { slot: args.slot, free: !state.bookings.some((b) => b.slot === args.slot) },
        }),
      },
      reserve: {
        kind: 'write',
        execute(args, state) {
          if (typeof args.key !== 'string') return { ok: false, error: { code: 'BAD_KEY', message: '  Key required.  ', retryable: false } };
          if (Object.hasOwn(state.keys, args.key)) return { ok: true, data: { bookingId: state.keys[args.key] } };
          const id = `b_${state.bookings.length + 1}`;
          state.bookings.push({ id, slot: args.slot });
          state.keys[args.key] = id;
          return { ok: true, data: { bookingId: id } };
        },
      },
      notify: {
        kind: 'write',
        async execute(args, state) {
          await Promise.resolve();
          state.notifications.push(args.bookingId);
          return { ok: true, data: { sent: true, ratio: 0.1 + 0.2, big: 1e21, small: 1e-7 } };
        },
      },
      refund_all: {
        kind: 'write',
        execute(_args, state) {
          state.refunds.push(1);
          return { ok: true, data: null };
        },
      },
    },
    createAgent: () => ({
      id: 'checks-agent',
      version: variant,
      async run({ call, recordModel }) {
        recordModel({ detail: 'Planning the booking.', payload: { step: 1, note: 'Ünïcödé 🎉' } });
        const lookup = (slot) => call('lookup_slot', { slot });
        const reserve = async (slot, key) => {
          for (let i = 0; i < 3; i++) {
            const r = await call('reserve', { slot, key });
            if (typeof r !== 'string' && r.ok) return r.data.bookingId;
            if (!retry(r)) return undefined;
          }
          return undefined;
        };
        const notify = async (bookingId) => {
          for (let i = 0; i < 2; i++) {
            const r = await call('notify', { bookingId });
            if (typeof r !== 'string' && r.ok) return 'sent';
            if (!retry(r)) return 'blocked';
          }
          return 'failed';
        };
        if (variant === 'unknown') await call('missing_tool', {});
        if (variant === 'extra-calls') for (const s of ['slot_2', 'slot_3']) await lookup(s);
        let bookingId;
        if (variant === 'bad-order') {
          bookingId = await reserve('slot_1', 'k1');
          await lookup('slot_1');
        } else if (variant === 'concurrent') {
          const [a] = await Promise.all([reserve('slot_1', 'k1'), reserve('slot_2', 'k2')]);
          bookingId = a;
          await lookup('slot_1');
        } else {
          const found = await lookup('slot_1');
          if (typeof found !== 'string' && found.ok && found.data?.nextTool) await call(found.data.nextTool, {});
          bookingId = await reserve('slot_1', 'k1');
        }
        if (!bookingId) return { status: 'blocked', message: 'Reservation failed.' };
        const sent = await notify(bookingId);
        if (variant === 'forbidden') await call('refund_all', { reason: 'cleanup' });
        if (sent === 'blocked') return { status: 'blocked', message: 'Notification permission revoked.', output: { bookingId } };
        return { status: 'completed', message: 'Booked and notified.', output: { bookingId, sent } };
      },
    }),
  };
}
