// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

const verifyVersion = true;
const invalid = {
  ok: false,
  error: {
    code: 'INVALID_INPUT',
    message: 'Expected order_7.',
    retryable: false,
  },
};
export const tools = {
  read_order: {
    kind: 'read',
    execute(args, state) {
      return args.orderId === 'order_7'
        ? { ok: true, data: state.order }
        : invalid;
    },
  },
  ship_order: {
    kind: 'write',
    execute(args, state) {
      if (args.orderId !== 'order_7') return invalid;
      state.order.status = 'shipped';
      state.order.version = 1;
      return { ok: true, data: { version: state.order.version } };
    },
  },
};
export function createAgent() {
  return {
    id: 'order-verifier',
    version: verifyVersion ? 'safe-1' : 'unsafe-1',
    async run({ call }) {
      await call('read_order', { orderId: 'order_7' });
      const write = await call('ship_order', { orderId: 'order_7' });
      if (!write?.ok)
        return { status: 'blocked', message: 'Write not confirmed.' };
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await call('read_order', { orderId: 'order_7' });
        if (
          result?.ok &&
          (!verifyVersion || result.data.version >= write.data.version)
        )
          return {
            status: 'completed',
            message: 'Observed order status.',
            output: result.data,
          };
      }
      return {
        status: 'blocked',
        message: 'Could not confirm current version.',
      };
    },
  };
}
