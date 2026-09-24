import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  runWorkflow,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';

const config = JSON.parse(
  await readFile('packages/sdk/templates/workflow.json', 'utf8'),
);
const starter: WorkflowAdapter = await import(
  new URL('../packages/sdk/templates/adapter.mjs', import.meta.url).href
);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('queued calls are bounded before execution and cannot be caught into a pass', async () => {
  let executed = 0;
  const batch = await runWorkflow(
    { ...config, limits: { maxToolCalls: 3 } },
    {
      tools: {
        reserve_slot: {
          kind: 'write',
          async execute() {
            executed++;
            return { ok: true, data: null };
          },
        },
      },
      createAgent: () => ({
        id: 'queue',
        version: '1',
        async run({ call }) {
          await Promise.allSettled(
            Array.from({ length: 20 }, () => call('reserve_slot', {})),
          );
          return { status: 'completed', message: 'Ignored limits' };
        },
      }),
    },
  );
  assert.equal(batch.baseline.issue, 'call_limit');
  assert.equal(batch.baseline.status, 'failed');
  assert.equal(executed, 0);
});

test('blocking agent code is marked timed out when it returns after the deadline', async () => {
  const batch = await runWorkflow(
    { ...config, limits: { timeoutMs: 5 } },
    {
      ...starter,
      createAgent: () => ({
        id: 'blocking',
        version: '1',
        async run() {
          const until = performance.now() + 15;
          while (performance.now() < until) {
            /* Deliberately block timer callbacks. */
          }
          return { status: 'completed', message: 'Too late' };
        },
      }),
    },
  );
  assert.equal(batch.baseline.status, 'timed_out');
  assert.equal(batch.baseline.completion, undefined);
});

test('async handlers preserve successful recovery, idempotency, and all five fault boundaries', async () => {
  const adapter: WorkflowAdapter = {
    ...starter,
    tools: {
      reserve_slot: {
        kind: 'write',
        async execute(args, state, context) {
          await tick();
          context.signal.throwIfAborted();
          return starter.tools.reserve_slot!.execute(args, state, context);
        },
      },
    },
  };
  const batch = await runWorkflow(config, adapter, { trials: 2 });
  assert.equal(batch.baseline.status, 'passed');
  assert.equal(batch.runs.length, 10);
  assert.ok(
    batch.runs.every((run) => run.status === 'passed' && run.fault.triggered),
  );
  assert.equal(batch.runs[0]!.metrics.mutations, 1);
});

test('overlapping async calls serialize complete transactions and capture arguments at invocation', async () => {
  let active = 0,
    peak = 0;
  const input = {
    schemaVersion: 'workflow/1',
    id: 'counter',
    title: 'Counter',
    task: 'Add twice',
    initialState: { total: 0 },
    checks: [
      {
        id: 'sum',
        label: 'No lost update',
        type: 'equals',
        path: '/total',
        expected: 3,
      },
    ],
    scenarios: [
      {
        id: 'timeout',
        title: 'Timeout',
        fault: { type: 'timeout_after', tool: 'add' },
      },
    ],
  };
  const batch = await runWorkflow(input, {
    tools: {
      add: {
        kind: 'write',
        async execute(args, state) {
          active++;
          peak = Math.max(peak, active);
          const before = state.total as number;
          await tick();
          state.total = before + (args.amount as number);
          active--;
          return { ok: true, data: state.total };
        },
      },
    },
    createAgent: () => ({
      id: 'counter',
      version: '1',
      async run({ call }) {
        const args = { amount: 1 };
        const first = call('add', args);
        args.amount = 2;
        const second = call('add', args);
        args.amount = 100;
        await Promise.all([first, second]);
        return { status: 'completed', message: 'Done' };
      },
    }),
  });
  assert.equal(batch.baseline.status, 'passed');
  assert.equal(peak, 1);
  assert.equal(batch.baseline.finalState.total, 3);
  assert.deepEqual(
    batch.baseline.events
      .filter((e) => e.kind === 'mutation')
      .map((e) => e.callId),
    ['call_1', 'call_2'],
  );
});

test('cancelled async writes cannot commit late or change returned evidence', async () => {
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const controller = new AbortController();
  let toolSignal: AbortSignal | undefined;
  const running = runWorkflow(
    config,
    {
      ...starter,
      tools: {
        reserve_slot: {
          kind: 'write',
          async execute(args, state, context) {
            toolSignal = context.signal;
            started();
            await held;
            return starter.tools.reserve_slot!.execute(args, state, context);
          },
        },
      },
    },
    { signal: controller.signal },
  );
  await ready;
  controller.abort();
  const batch = await running;
  assert.equal(batch.baseline.status, 'cancelled');
  assert.equal(toolSignal!.aborted, true);
  assert.equal(batch.baseline.metrics.mutations, 0);
  const saved = JSON.stringify(batch);
  release();
  await tick();
  await tick();
  assert.equal(JSON.stringify(batch), saved);
});

test('a hanging async handler respects the wall deadline and rejected tools cannot become passes', async () => {
  const hang: WorkflowAdapter = {
    ...starter,
    tools: {
      reserve_slot: { kind: 'write', execute: () => new Promise(() => {}) },
    },
  };
  const timed = await runWorkflow(
    { ...config, limits: { timeoutMs: 10 } },
    hang,
  );
  assert.equal(timed.baseline.status, 'timed_out');
  assert.equal(timed.baseline.metrics.mutations, 0);
  const rejected = await runWorkflow(config, {
    ...starter,
    tools: {
      reserve_slot: {
        kind: 'write',
        async execute() {
          throw new Error('private error');
        },
      },
    },
  });
  assert.equal(rejected.baseline.issue, 'tool_contract');
  assert.doesNotMatch(JSON.stringify(rejected), /private error/);
});
