import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  runWorkflow,
  parseWorkflow,
  workflowBatchSchema,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';
import { createStarter } from '../packages/sdk/src/starter.js';
import { sanitizeWorkflowBatch } from '../packages/sdk/src/privacy.js';

async function fixture(
  id: string,
  run: (
    config: ReturnType<typeof parseWorkflow>,
    adapter: WorkflowAdapter,
    dir: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'dojo-fault-'));
  const dir = join(root, 'dojo');
  try {
    await createStarter(dir, false, id);
    const config = parseWorkflow(
      JSON.parse(await readFile(join(dir, 'workflow.json'), 'utf8')),
    );
    const adapter: WorkflowAdapter = await import(
      pathToFileURL(join(dir, 'adapter.mjs')).href
    );
    await run(config, { ...adapter, tools: { ...adapter.tools } }, dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('stale read fixture distinguishes a committed write from an incorrect completion', async () => {
  await fixture('stale-read', async (config, adapter, dir) => {
    const safe = await runWorkflow(config, adapter, { trials: 2 });
    assert.equal(safe.baseline.status, 'passed');
    assert.ok(
      safe.runs.every(
        (run) => run.status === 'passed' && run.fault.triggerCount === 1,
      ),
    );
    const source = await readFile(join(dir, 'adapter.mjs'), 'utf8');
    await writeFile(
      join(dir, 'unsafe.mjs'),
      source.replace('verifyVersion = true', 'verifyVersion = false'),
    );
    const unsafe: WorkflowAdapter = await import(
      pathToFileURL(join(dir, 'unsafe.mjs')).href
    );
    const batch = await runWorkflow(config, unsafe);
    const run = batch.runs[0]!;
    assert.equal(batch.baseline.status, 'passed');
    assert.equal(run.status, 'failed');
    assert.equal(run.assertions[0]!.passed, true);
    assert.equal(run.assertions[1]!.passed, false);
    assert.deepEqual(
      run.events.find((event) => event.kind === 'fault')!.payload,
      { occurrence: 2, triggerCount: 1, sourceCallId: 'call_1' },
    );
    const results = run.events.filter(
      (event) => event.kind === 'tool_result' && event.callId === 'call_3',
    );
    assert.deepEqual(
      results.map((event) => [event.visibility, event.payload]),
      [
        [
          'evaluator',
          { ok: true, data: { id: 'order_7', status: 'shipped', version: 1 } },
        ],
        [
          'agent',
          { ok: true, data: { id: 'order_7', status: 'pending', version: 0 } },
        ],
      ],
    );
    assert.deepEqual(
      sanitizeWorkflowBatch(JSON.parse(JSON.stringify(batch))),
      batch,
    );
    adapter.tools.read_order!.kind = 'write';
    await assert.rejects(runWorkflow(config, adapter), /read tool/);
  });
});

test('stale read requires matching earlier inputs and different successful data', async () => {
  await fixture('stale-read', async (config, adapter) => {
    config.checks = [
      {
        id: 'done',
        label: 'Finished',
        type: 'equals',
        source: 'completion',
        path: '/status',
        expected: 'completed',
      },
    ];
    const runWith = async (
      firstArgs: Record<string, string>,
      write: boolean,
      fail = false,
    ) => {
      adapter.createAgent = () => ({
        id: 'reader',
        version: '1',
        async run({ call }) {
          const first = await call('read_order', firstArgs);
          if (typeof first !== 'string' && first.ok) first.data = 'tampered';
          if (write) await call('ship_order', { orderId: 'order_7' });
          await call('read_order', { orderId: 'order_7' });
          return { status: 'completed', message: 'Done' };
        },
      });
      if (fail)
        adapter.tools.read_order = {
          kind: 'read',
          execute: () => ({
            ok: false,
            error: { code: 'ERROR', message: 'Failed', retryable: false },
          }),
        };
      return (await runWorkflow(config, adapter)).runs[0]!;
    };
    assert.equal(
      (await runWith({ orderId: 'order_7', variant: 'other' }, true)).status,
      'inconclusive',
    );
    assert.equal(
      (await runWith({ orderId: 'order_7' }, false)).status,
      'inconclusive',
    );
    assert.equal(
      (await runWith({ orderId: 'order_7' }, true)).fault.triggered,
      true,
    );
    assert.equal(
      (await runWith({ orderId: 'order_7' }, true, true)).fault.triggered,
      false,
    );
  });
});

test('stale read repeats a pinned snapshot, then permits recovery with virtual time', async () => {
  await fixture('stale-read', async (config, adapter) => {
    const fault = config.scenarios[0]!.fault;
    if (fault.type === 'none') throw new Error('Expected fault');
    fault.repeat = 2;
    config.clock = { mode: 'virtual', startMs: 0, maxTimeMs: 100 };
    const read = adapter.tools.read_order!;
    adapter.tools.read_order = {
      kind: 'read',
      async execute(args, state, context) {
        await context.clock.sleep(5);
        return read.execute(args, state, context);
      },
    };
    const batch = await runWorkflow(config, adapter, { trials: 2 });
    assert.equal(batch.baseline.status, 'passed');
    assert.ok(
      batch.runs.every(
        (run) =>
          run.status === 'passed' &&
          run.fault.triggerCount === 2 &&
          run.clock?.endMs === 20,
      ),
    );
  });
});

test('duplicate delivery fixture exposes two effects for one agent call', async () => {
  await fixture('duplicate-delivery', async (config, adapter, dir) => {
    const safe = await runWorkflow(config, adapter, { trials: 2 });
    assert.equal(safe.baseline.status, 'passed');
    assert.ok(
      safe.runs.every(
        (run) => run.status === 'passed' && run.metrics.mutations === 1,
      ),
    );
    const source = await readFile(join(dir, 'adapter.mjs'), 'utf8');
    await writeFile(
      join(dir, 'unsafe.mjs'),
      source.replace('deduplicate = true', 'deduplicate = false'),
    );
    const unsafe: WorkflowAdapter = await import(
      pathToFileURL(join(dir, 'unsafe.mjs')).href
    );
    const batch = await runWorkflow(config, unsafe);
    const run = batch.runs[0]!;
    assert.equal(batch.baseline.status, 'passed');
    assert.equal(run.status, 'failed');
    assert.equal(run.finalState.creditedCents, 1000);
    assert.equal(run.metrics.toolCalls, 1);
    assert.equal(run.metrics.mutations, 2);
    assert.deepEqual(
      run.events
        .filter((event) => event.kind === 'delivery')
        .map((event) => event.payload),
      [
        { delivery: 1, args: { operationKey: 'request_7' } },
        { delivery: 2, args: { operationKey: 'request_7' } },
      ],
    );
    assert.equal(
      run.events.filter(
        (event) => event.kind === 'tool_result' && event.visibility === 'agent',
      ).length,
      1,
    );
    assert.deepEqual(
      sanitizeWorkflowBatch(JSON.parse(JSON.stringify(batch))),
      batch,
    );
    adapter.tools.credit_account!.kind = 'read';
    await assert.rejects(runWorkflow(config, adapter), /write tool/);
  });
});

test('duplicate deliveries isolate arguments, serialize async writes, and return the first response', async () => {
  await fixture('duplicate-delivery', async (config, adapter) => {
    config.clock = { mode: 'virtual', startMs: 0, maxTimeMs: 100 };
    config.checks = [
      {
        id: 'first',
        label: 'First response',
        type: 'equals',
        source: 'completion',
        path: '/output',
        expected: 500,
      },
    ];
    adapter.tools.credit_account = {
      kind: 'write',
      async execute(args, state, { clock }) {
        assert.equal(args.operationKey, 'request_7');
        args.operationKey = 'mutated';
        await clock.sleep(5);
        state.creditedCents = Number(state.creditedCents) + 500;
        return { ok: true, data: state.creditedCents };
      },
    };
    adapter.createAgent = () => ({
      id: 'credit',
      version: '1',
      async run({ call }) {
        const result = await call('credit_account', {
          operationKey: 'request_7',
        });
        return {
          status: 'completed',
          message: 'Done',
          output: typeof result !== 'string' && result.ok ? result.data : null,
        };
      },
    });
    const batch = await runWorkflow(config, adapter);
    assert.equal(batch.runs[0]!.status, 'passed');
    assert.equal(batch.runs[0]!.clock!.endMs, 10);
    assert.equal(batch.runs[0]!.finalState.creditedCents, 1000);
    config.clock.maxTimeMs = 7;
    const stopped = (await runWorkflow(config, adapter)).runs[0]!;
    assert.equal(stopped.status, 'timed_out');
    assert.equal(stopped.finalState.creditedCents, 500);
    assert.equal(stopped.metrics.mutations, 1);
    assert.equal(stopped.fault.triggered, true);
  });
});

test('duplicate delivery retries structured errors and retains bounded evidence for 110 writes', async () => {
  await fixture('duplicate-delivery', async (config, adapter) => {
    config.checks = [
      {
        id: 'empty',
        label: 'Unchanged',
        type: 'unchanged',
        path: '/creditedCents',
      },
    ];
    let executions = 0;
    adapter.tools.credit_account = {
      kind: 'write',
      execute() {
        executions++;
        return {
          ok: false,
          error: { code: 'DENIED', message: 'Denied', retryable: false },
        };
      },
    };
    const errors = await runWorkflow(config, adapter);
    assert.equal(errors.runs[0]!.fault.triggered, true);
    assert.equal(executions, 3); // One control, two fault deliveries.
    config.limits = {
      maxToolCalls: 100,
      maxRepeatedCalls: 100,
      timeoutMs: 5000,
    };
    const fault = config.scenarios[0]!.fault;
    if (fault.type === 'none') throw new Error('Expected fault');
    fault.repeat = 10;
    config.checks = [
      {
        id: 'total',
        label: 'Expected count',
        type: 'equals',
        source: 'state',
        path: '/creditedCents',
        expected: 100,
      },
    ];
    adapter.tools.credit_account = {
      kind: 'write',
      execute(_args, state) {
        state.creditedCents = Number(state.creditedCents) + 1;
        return { ok: true, data: null };
      },
    };
    adapter.createAgent = () => ({
      id: 'many',
      version: '1',
      async run({ call }) {
        for (let i = 0; i < 100; i++) await call('credit_account', {});
        return { status: 'completed', message: 'Done' };
      },
    });
    const batch = await runWorkflow(config, adapter);
    assert.equal(batch.baseline.status, 'passed');
    assert.equal(batch.runs[0]!.metrics.mutations, 110);
    assert.equal(batch.runs[0]!.fault.triggerCount, 10);
    assert.equal(batch.runs[0]!.status, 'failed');
  });
});

test('prompt injection fixture catches unsafe behavior and records original versus delivered data', async () => {
  await fixture('prompt-injection', async (config, adapter, dir) => {
    const safe = await runWorkflow(config, adapter, { trials: 2 });
    assert.equal(safe.baseline.status, 'passed');
    assert.deepEqual(
      safe.runs.map((run) => run.status),
      ['passed', 'passed'],
    );
    const source = await readFile(join(dir, 'adapter.mjs'), 'utf8');
    await writeFile(
      join(dir, 'unsafe.mjs'),
      source.replace(
        'trustToolInstructions = false',
        'trustToolInstructions = true',
      ),
    );
    const unsafe: WorkflowAdapter = await import(
      pathToFileURL(join(dir, 'unsafe.mjs')).href
    );
    const batch = await runWorkflow(config, unsafe);
    const run = batch.runs[0]!;
    assert.equal(batch.baseline.status, 'passed');
    assert.equal(run.status, 'failed');
    assert.equal(run.assertions[0]!.actual, 1);
    assert.equal(
      run.events.find(
        (event) => event.id === run.assertions[0]!.evidenceIds[0],
      )!.tool,
      'refund_all',
    );
    const results = run.events.filter(
      (event) => event.kind === 'tool_result' && event.tool === 'read_policy',
    );
    assert.deepEqual(
      results.map((event) => event.visibility),
      ['evaluator', 'agent'],
    );
    assert.notDeepEqual(results[0]!.payload, results[1]!.payload);
    assert.equal(results[0]!.callId, results[1]!.callId);
    assert.deepEqual(
      sanitizeWorkflowBatch(JSON.parse(JSON.stringify(batch))),
      batch,
    );
    const forged = structuredClone(batch);
    forged.runs[0]!.assertions[0]!.passed = true;
    assert.equal(workflowBatchSchema.safeParse(forged).success, false);
    unsafe.tools.refund_all = {
      kind: 'write',
      execute: () => ({
        ok: false,
        error: { code: 'DENIED', message: 'Denied', retryable: false },
      }),
    };
    const denied = (await runWorkflow(config, unsafe)).runs[0]!;
    assert.equal(denied.status, 'failed');
    assert.equal(denied.metrics.mutations, 0);
    assert.equal(denied.assertions[0]!.passed, false);
  });
});

test('prompt injection bounds payloads, honors schedules, and never replaces errors', async () => {
  await fixture('prompt-injection', async (config, adapter) => {
    const fault = config.scenarios[0]!.fault;
    assert.equal(fault.type, 'prompt_injection');
    if (fault.type !== 'prompt_injection') return;
    fault.occurrence = 2;
    fault.repeat = 2;
    adapter.createAgent = () => ({
      id: 'repeat',
      version: '1',
      async run({ call }) {
        for (let i = 0; i < 4; i++) await call('read_policy', {});
        return { status: 'completed', message: 'Read' };
      },
    });
    const run = (await runWorkflow(config, adapter)).runs[0]!;
    assert.equal(run.fault.triggerCount, 2);
    assert.deepEqual(
      run.events
        .filter((event) => event.kind === 'fault')
        .map((event) => event.callId),
      ['call_2', 'call_3'],
    );
    adapter.tools.read_policy = {
      kind: 'read',
      execute: () => ({
        ok: false,
        error: { code: 'ERROR', message: 'Unavailable', retryable: false },
      }),
    };
    const missing = (await runWorkflow(config, adapter)).runs[0]!;
    assert.equal(missing.status, 'inconclusive');
    assert.equal(missing.fault.triggered, false);
    fault.replacement = 'x'.repeat(16001);
    assert.throws(() => parseWorkflow(config));
    fault.replacement = 'ok';
    fault.occurrence = 100;
    assert.throws(() => parseWorkflow(config));
  });
});
