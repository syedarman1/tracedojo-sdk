// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

const deduplicate = true;
export const tools = {
  credit_account: {
    kind: 'write',
    execute(args, state) {
      if (args.operationKey !== 'request_7')
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Expected request_7.',
            retryable: false,
          },
        };
      if (!deduplicate || !state.processed.includes(args.operationKey)) {
        state.creditedCents += 500;
        state.processed.push(args.operationKey);
      }
      return { ok: true, data: { creditedCents: 500 } };
    },
  },
};
export function createAgent() {
  return {
    id: 'credit-requester',
    version: deduplicate ? 'safe-1' : 'unsafe-1',
    async run({ call }) {
      const result = await call('credit_account', {
        operationKey: 'request_7',
      });
      return {
        status: result?.ok ? 'completed' : 'blocked',
        message: 'Credit requested.',
      };
    },
  };
}
