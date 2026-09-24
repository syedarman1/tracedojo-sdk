// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import * as reference from './reference.mjs';

// Model a 25 ms service delay without waiting in real time.
export const tools = Object.fromEntries(
  Object.entries(reference.tools).map(([name, tool]) => [
    name,
    {
      ...tool,
      async execute(args, state, context) {
        await context.clock.sleep(25);
        context.signal.throwIfAborted();
        return tool.execute(args, state, context);
      },
    },
  ]),
);

export function createAgent() {
  const agent = reference.createAgent();
  return {
    ...agent,
    version: `${agent.version}-virtual-backoff`,
    async run(context) {
      return agent.run({
        ...context,
        call: async (name, args) => {
          const result = await context.call(name, args);
          // Back off for one virtual second before the reference agent retries.
          if (
            typeof result === 'string' ||
            (!result.ok && result.error.retryable)
          )
            await context.clock.sleep(1000);
          return result;
        },
      });
    },
  };
}
