// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { readFileSync } from 'node:fs';

// Trace text stays in JSON data; it is never interpolated into executable code.
const fixture = JSON.parse(
  readFileSync(new URL('./trace.json', import.meta.url), 'utf8'),
);
export const toolSignatures = fixture.signatures;
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const blocked = (message) => ({
  ok: false,
  error: { code: 'TODO_SIMULATION', message, retryable: false },
});

export const tools = Object.fromEntries(
  toolSignatures.map((signature) => [
    signature.alias,
    {
      // TODO: Review the tool's actual semantics. Trace outputs cannot establish writes.
      kind: 'read',
      execute(args) {
        // TODO: Add a second `state` argument and replace fixture matching with
        // a synchronous state simulation. Mutations require kind: 'write'.
        const matches = fixture.observedCalls.filter(
          (call) =>
            call.alias === signature.alias &&
            stable(call.inputs) === stable(args),
        );
        if (!matches.length)
          return blocked('Implement this tool for unobserved inputs.');
        if (
          matches.some((call) => call.error || !Object.hasOwn(call, 'outputs'))
        )
          return blocked(
            'Recorded error or missing output. Implement the tool response.',
          );
        if (new Set(matches.map((call) => stable(call.outputs))).size !== 1)
          return blocked(
            'These inputs have different recorded results. Implement stateful behavior.',
          );
        return { ok: true, data: structuredClone(matches[0].outputs) };
      },
    },
  ]),
);

// TODO: Replace this scripted playback with your agent; keep its state in the factory.
export function createAgent() {
  return {
    id: 'imported-trace-playback',
    version: 'needs-review',
    async run({ call, signal }) {
      for (const observed of fixture.observedCalls) {
        signal.throwIfAborted();
        const result = await call(
          observed.alias,
          structuredClone(observed.inputs),
        );
        if (typeof result === 'string' || !result.ok)
          return {
            status: 'blocked',
            message:
              'Scripted playback interrupted. Review tool stubs and connect your agent.',
          };
      }
      return {
        status: 'completed',
        message:
          'Recorded calls replayed. Application correctness has not been checked.',
      };
    },
  };
}
