import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runWorkflow,
  workflowReportSchema,
  type WorkflowAdapter,
  type WorkflowContext,
  type WorkflowAgent,
} from '../packages/sdk/src/index.js';
import { compareWorkflowBatches } from '../packages/sdk/src/compare.js';
import { parseWorkflowReports } from '../packages/sdk/src/reports.js';

const input = {
  schemaVersion: 'workflow/1',
  id: 'clock',
  title: 'Clock',
  task: 'Add once',
  clock: { mode: 'virtual', startMs: 1000, maxTimeMs: 10000 },
  initialState: { total: 0 },
  checks: [
    {
      id: 'once',
      label: 'One write',
      type: 'equals',
      path: '/total',
      expected: 1,
    },
  ],
  scenarios: [
    {
      id: 'timeout',
      title: 'Request timeout',
      fault: { type: 'timeout_before', tool: 'add' },
    },
  ],
};
const tools: WorkflowAdapter['tools'] = {
  add: {
    kind: 'write',
    async execute(_args, state, { clock }) {
      await clock.sleep(25);
      state.total = (state.total as number) + 1;
      return { ok: true, data: clock.now() };
    },
  },
};
const adapter = (run: WorkflowAgent['run']): WorkflowAdapter => ({
  tools,
  createAgent: () => ({ id: 'clock-agent', version: '1', run }),
});
const done = { status: 'completed' as const, message: 'Done' };

test('virtual backoff advances without real waiting, resets each trial, and timestamps evidence', async () => {
  const starts: number[] = [];
  const subject = adapter(async ({ call, clock }) => {
    starts.push(clock.now());
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call('add', {});
      if (typeof result !== 'string' && result.ok) return done;
      await clock.sleep(1000);
    }
    return { status: 'blocked', message: 'No result' };
  });
  const batch = await runWorkflow(input, subject, { trials: 2 });
  assert.deepEqual(starts, [1000, 1000, 1000]);
  assert.equal(batch.baseline.clock!.endMs, 1025);
  assert.deepEqual(
    batch.runs.map((r) => r.clock!.endMs),
    [2025, 2025],
  );
  assert.ok(batch.runs.every((r) => r.status === 'passed'));
  assert.deepEqual(
    batch.runs[0]!.events.filter((e) => e.kind === 'tool_call').map(
      (e) => e.timeMs,
    ),
    [1000, 2000],
  );
  assert.equal(compareWorkflowBatches(batch, batch).status, 'no_regressions');
  const imported = parseWorkflowReports(batch);
  assert.deepEqual(imported[0]!.clock, batch.baseline.clock);
  assert.deepEqual(imported[1]!.events, batch.runs[0]!.events);
  const forged = structuredClone(batch.baseline);
  forged.events[0]!.timeMs = 999;
  assert.throws(() => workflowReportSchema.parse(forged));
  const wrongEnd = structuredClone(batch.baseline);
  wrongEnd.clock!.endMs++;
  assert.throws(() => workflowReportSchema.parse(wrongEnd));
});

test('invalid tool sleeps keep their clock diagnosis and cannot commit a draft', async () => {
  const batch = await runWorkflow(input, {
    tools: {
      add: {
        kind: 'write',
        async execute(_args, state, { clock }) {
          try {
            await clock.sleep(-1);
          } catch {
            /* Simulate a tool swallowing the error. */
          }
          state.total = 1;
          return { ok: true, data: null };
        },
      },
    },
    createAgent: () => ({
      id: 'clock-agent',
      version: '1',
      async run({ call }) {
        await call('add', {});
        return done;
      },
    }),
  });
  assert.equal(batch.baseline.issue, 'clock_contract');
  assert.equal(batch.baseline.metrics.mutations, 0);
});

test('cancellation closes pending virtual sleeps without advancing time', async () => {
  const controller = new AbortController();
  const batch = await runWorkflow(
    input,
    adapter(async ({ clock }) => {
      const sleep = clock.sleep(100);
      controller.abort();
      await sleep;
      return done;
    }),
    { signal: controller.signal },
  );
  assert.equal(batch.baseline.status, 'cancelled');
  assert.equal(batch.baseline.clock!.endMs, 1000);
});

test('parallel sleeps wake by due time and ready calls run before a later timer', async () => {
  const seen: number[] = [];
  const batch = await runWorkflow(
    input,
    adapter(async ({ clock, call }) => {
      await Promise.all([
        (async () => {
          await clock.sleep(500);
          seen.push(clock.now());
        })(),
        (async () => {
          await clock.sleep(100);
          seen.push(clock.now());
          await call('add', {});
          seen.push(clock.now());
        })(),
      ]);
      return done;
    }),
  );
  assert.deepEqual(seen.slice(0, 3), [1100, 1125, 1500]);
  assert.equal(batch.baseline.status, 'passed');
  assert.equal(batch.baseline.clock!.endMs, 1500);
});

test('virtual budgets, invalid delays, and excessive zero sleeps cannot be caught into passing results', async () => {
  for (const [mode, issue] of [
    ['budget', 'timed_out'],
    ['invalid', 'clock_contract'],
    ['loop', 'clock_limit'],
  ] as const) {
    const batch = await runWorkflow(
      input,
      adapter(async ({ clock }) => {
        try {
          if (mode === 'loop')
            for (let i = 0; i < 1001; i++) await clock.sleep(0);
          else await clock.sleep(mode === 'budget' ? 20000 : -1);
        } catch {
          /* An agent must not erase the scheduler failure. */
        }
        return done;
      }),
    );
    assert.equal(batch.baseline.issue, issue);
    assert.equal(batch.baseline.metrics.mutations, 0);
    if (mode === 'budget') assert.equal(batch.baseline.clock!.endMs, 11000);
  }
});

test('unawaited clock work is rejected and closed clocks cannot advance returned reports', async () => {
  let leaked: WorkflowContext['clock'] | undefined;
  const batch = await runWorkflow(
    input,
    adapter(async ({ clock }) => {
      leaked = clock;
      void clock.sleep(500);
      return done;
    }),
  );
  assert.equal(batch.baseline.issue, 'unawaited_calls');
  assert.equal(batch.baseline.clock!.endMs, 1000);
  await assert.rejects(leaked!.sleep(10));
  assert.equal(leaked!.now(), 1000);
});

test('wall time still bounds hung virtual handlers and clock configuration affects comparison', async () => {
  const hung = await runWorkflow(
    { ...input, limits: { timeoutMs: 10 } },
    adapter(async () => new Promise(() => {})),
  );
  assert.equal(hung.baseline.status, 'timed_out');
  assert.equal(hung.baseline.clock!.endMs, 1000);
  const subject = adapter(async ({ call }) => {
    await call('add', {});
    return done;
  });
  const real = await runWorkflow(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== 'clock'),
    ),
    subject,
  );
  const virtual = await runWorkflow(input, subject);
  assert.equal(real.baseline.clock, undefined);
  assert.ok(real.baseline.events.every((e) => e.timeMs === undefined));
  assert.equal(compareWorkflowBatches(real, virtual).status, 'incomparable');
});
