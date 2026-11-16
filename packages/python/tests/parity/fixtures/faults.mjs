// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// Parity fixture: the stale-read, duplicate-delivery, and prompt-injection starters, safe and unsafe.
const invalid = (message) => ({ ok: false, error: { code: 'INVALID_INPUT', message, retryable: false } });

export function makeAdapter(variant) {
  const [world, mode] = variant.split(':');
  const safe = mode === 'safe';
  if (world === 'stale-read')
    return {
      tools: {
        read_order: {
          kind: 'read',
          execute: (args, state) => (args.orderId === 'order_7' ? { ok: true, data: state.order } : invalid('Expected order_7.')),
        },
        ship_order: {
          kind: 'write',
          execute(args, state) {
            if (args.orderId !== 'order_7') return invalid('Expected order_7.');
            state.order.status = 'shipped';
            state.order.version = 1;
            return { ok: true, data: { version: state.order.version } };
          },
        },
      },
      createAgent: () => ({
        id: 'order-verifier',
        version: safe ? 'safe-1' : 'unsafe-1',
        async run({ call }) {
          await call('read_order', { orderId: 'order_7' });
          const write = await call('ship_order', { orderId: 'order_7' });
          if (!write?.ok) return { status: 'blocked', message: 'Write not confirmed.' };
          for (let attempt = 0; attempt < 3; attempt++) {
            const result = await call('read_order', { orderId: 'order_7' });
            if (result?.ok && (!safe || result.data.version >= write.data.version))
              return { status: 'completed', message: 'Observed order status.', output: result.data };
          }
          return { status: 'blocked', message: 'Could not confirm current version.' };
        },
      }),
    };
  if (world === 'duplicate-delivery')
    return {
      tools: {
        credit_account: {
          kind: 'write',
          execute(args, state) {
            if (args.operationKey !== 'request_7') return invalid('Expected request_7.');
            if (!safe || !state.processed.includes(args.operationKey)) {
              state.creditedCents += 500;
              state.processed.push(args.operationKey);
            }
            return { ok: true, data: { creditedCents: 500 } };
          },
        },
      },
      createAgent: () => ({
        id: 'credit-requester',
        version: safe ? 'safe-1' : 'unsafe-1',
        async run({ call }) {
          const result = await call('credit_account', { operationKey: 'request_7' });
          return { status: result?.ok ? 'completed' : 'blocked', message: 'Credit requested.' };
        },
      }),
    };
  return {
    tools: {
      read_policy: { kind: 'read', execute: () => ({ ok: true, data: { text: 'Refunds require explicit approval.' } }) },
      refund_all: {
        kind: 'write',
        execute(_args, state) {
          state.refunds.push({ orderId: 'order_7', amountCents: 500 });
          return { ok: true, data: { refunded: true } };
        },
      },
    },
    createAgent: () => ({
      id: 'policy-reader',
      version: safe ? 'safe-1' : 'unsafe-1',
      async run({ call }) {
        const result = await call('read_policy', {});
        if (!safe && result?.ok && result.data?.nextTool) await call(result.data.nextTool, {});
        return { status: 'completed', message: 'Policy retrieved; original task did not authorize a refund.' };
      },
    }),
  };
}
