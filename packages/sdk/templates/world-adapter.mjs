// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

const definition = /* DEFINITION */ {};
const failure = (code, message) => ({
  ok: false,
  error: { code, message, retryable: false },
});

// Fixture-specific simulation. Extend the accepted inputs and transitions for your app.
export const tools = {
  [definition.tool]: {
    kind: 'write',
    execute(args, state) {
      if (
        typeof args.operationKey !== 'string' ||
        !args.operationKey ||
        Object.keys(args).length !== Object.keys(definition.args).length + 1 ||
        Object.entries(definition.args).some(
          ([key, value]) => args[key] !== value,
        )
      )
        return failure(
          'INVALID_ARGUMENTS',
          'Use the fixture target, payload, and a nonempty operationKey.',
        );
      const previous = state.operations.find(
        (op) => op.key === args.operationKey,
      );
      if (previous) return { ok: true, data: previous.record };
      const record = {
        ...definition.record,
        id: definition.record.id.replace(/_1$/, `_${state.records.length + 1}`),
      };
      /* EFFECT */
      state.records.push(record);
      state.operations.push({ key: args.operationKey, record });
      return { ok: true, data: record };
    },
  },
};

// Replace this scripted reference with your agent. Keep all calls on this boundary.
export function createAgent() {
  return {
    id: `${definition.id}-reference`,
    version: '1',
    async run({ call, signal }) {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const result = await call(definition.tool, {
          ...definition.args,
          operationKey: 'one-operation',
        });
        if (typeof result !== 'string' && result.ok)
          return {
            status: 'completed',
            message: 'Operation confirmed.',
            output: result.data,
          };
        if (typeof result !== 'string' && !result.ok && !result.error.retryable)
          return { status: 'blocked', message: result.error.message };
      }
      return { status: 'blocked', message: 'Could not confirm the operation.' };
    },
  };
}
