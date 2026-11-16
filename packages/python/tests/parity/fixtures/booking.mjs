// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// Parity fixture: the shipped booking adapter, with the demo's key bug and a virtual-time wrapper.
import * as reference from '../../../../sdk/templates/adapter.mjs';

export function makeAdapter(variant) {
  const stable = !variant.endsWith('new-key');
  const virtual = variant.startsWith('virtual');
  const tools = virtual
    ? {
        reserve_slot: {
          kind: 'write',
          async execute(args, state, context) {
            await context.clock.sleep(25);
            return reference.tools.reserve_slot.execute(args, state, context);
          },
        },
      }
    : reference.tools;
  return {
    tools,
    createAgent() {
      const agent = reference.createAgent();
      let attempt = 0;
      return {
        ...agent,
        version: `${stable ? 'stable-key' : 'new-key-per-retry'}${virtual ? '-virtual' : ''}`,
        run(context) {
          return agent.run({
            ...context,
            call: async (tool, args) => {
              const result = await context.call(
                tool,
                stable ? args : { ...args, operationKey: `attempt_${++attempt}` },
              );
              if (virtual && (typeof result === 'string' || (!result.ok && result.error.retryable)))
                await context.clock.sleep(1000);
              return result;
            },
          });
        },
      };
    },
  };
}
