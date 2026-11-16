// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// Parity fixture: run limits, protocol violations, and virtual clock failures.
const done = { status: 'completed', message: 'Done.' };

export function makeAdapter(variant) {
  return {
    tools: {
      echo: { kind: 'read', execute: (args) => ({ ok: true, data: args }) },
      write_blob: {
        kind: 'write',
        execute(args, state) {
          state.blob = `${args.n}`.padEnd(45000, 'x');
          return { ok: true, data: { n: args.n } };
        },
      },
      mutate_read: {
        kind: 'read',
        execute(_args, state) {
          state.blob = 'changed';
          return { ok: true, data: {} };
        },
      },
      boom: {
        kind: 'write',
        execute() {
          throw new Error('handler crashed');
        },
      },
    },
    createAgent: () => ({
      id: 'limits-agent',
      version: variant,
      async run({ call, clock, recordModel }) {
        switch (variant) {
          case 'ok':
            await call('echo', { a: 1 });
            return done;
          case 'repeat':
            for (let i = 0; i < 3; i++) await call('echo', { a: 1 });
            return done;
          case 'call-limit':
            for (let i = 0; i < 10; i++) await call('echo', { i });
            return done;
          case 'catch-stop':
            try {
              for (let i = 0; i < 10; i++) await call('echo', { i });
            } catch {
              return done;
            }
            return done;
          case 'agent-error':
            await call('echo', { a: 1 });
            throw new Error('agent crashed');
          case 'bad-completion':
            return { status: 'done', message: 'Not a valid status.' };
          case 'read-mutates':
            await call('mutate_read', {});
            return done;
          case 'tool-throws':
            await call('boom', {});
            return done;
          case 'unawaited':
            call('echo', { a: 1 });
            return done;
          case 'hang':
            await new Promise(() => undefined);
            return done;
          case 'evidence':
            for (let n = 0; n < 8; n++) await call('write_blob', { n });
            return done;
          case 'model':
            recordModel({ detail: 'Chose echo.', payload: { tokens: 12, cost: 0.0004 } });
            recordModel({ detail: 'No payload.' });
            await call('echo', { a: 1 });
            return { ...done, output: { list: [1, 2.5, -0, null, true, 'two'] } };
          case 'clock-contract':
            try {
              await clock.sleep(-1);
            } catch {}
            return done;
          case 'clock-limit':
            for (let i = 0; i < 1001; i++) await clock.sleep(0);
            return done;
          case 'clock-budget':
            await clock.sleep(6000);
            return done;
          case 'parallel-sleeps': {
            const later = (ms, tag) => clock.sleep(ms).then(() => call('echo', { tag, at: clock.now() }));
            await Promise.all([later(300, 'a'), later(100, 'b'), later(100, 'c')]);
            await clock.sleep(50);
            return { ...done, output: { now: clock.now() } };
          }
          case 'unawaited-sleep':
            clock.sleep(100);
            return done;
        }
        throw new Error(`unknown variant ${variant}`);
      },
    }),
  };
}
