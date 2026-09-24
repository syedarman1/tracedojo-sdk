import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { importLangSmithTrace } from '../packages/sdk/src/langsmith.js';
import { createLangChainTools } from '../packages/sdk/src/langchain.js';
import { sanitizeWorkflowBatch } from '../packages/sdk/src/privacy.js';
import {
  runWorkflow,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';

const config = JSON.parse(
  await readFile(
    new URL('../packages/sdk/templates/workflow.json', import.meta.url),
    'utf8',
  ),
);
const starter: WorkflowAdapter = await import(
  new URL('../packages/sdk/templates/adapter.mjs', import.meta.url).href
);
const trace = {
  id: 'root',
  trace_id: 'root',
  name: 'Booking agent',
  run_type: 'chain',
  inputs: {
    input: 'Book one meeting for private@company.com',
    api_key: 'private-value',
  },
  child_runs: [
    {
      id: 'tool',
      trace_id: 'root',
      parent_run_id: 'root',
      name: 'reserve_slot',
      run_type: 'tool',
      inputs: { customerId: 'customer_7' },
      outputs: { id: 'booking_1' },
    },
  ],
};

test('LangSmith nested and flat exports become redacted drafts, never passing tests', () => {
  const nested = importLangSmithTrace(trace);
  const { child_runs, ...root } = trace;
  assert.deepEqual(importLangSmithTrace([root, ...child_runs]), nested);
  assert.deepEqual(
    importLangSmithTrace({ runs: [root, ...child_runs] }),
    nested,
  );
  assert.equal(nested.status, 'needs_review');
  assert.equal(nested.observedCalls[0]?.name, 'reserve_slot');
  assert.match(nested.taskCandidate, /redacted@private.invalid/);
  assert.doesNotMatch(JSON.stringify(nested), /private-value|private@company/);
  assert.ok(nested.required.length >= 3);
});

test('LangSmith imports reject mixed, incomplete, duplicate, malformed and oversized traces', () => {
  const { child_runs, ...root } = trace;
  for (const input of [
    [],
    {},
    [child_runs[0]],
    [root, { ...root, id: 'second' }],
    [root, ...child_runs, ...child_runs],
    [root, { ...child_runs[0], trace_id: 'different' }],
    [root, { ...child_runs[0], parent_run_id: 'missing' }],
    { ...trace, inputs: { task: 'x'.repeat(5_000_001) } },
  ])
    assert.throws(() => importLangSmithTrace(input));
});

test('real LangChain tools route through the simulated boundary and validate arguments', async () => {
  const batch = await runWorkflow(config, {
    tools: starter.tools,
    createAgent: () => ({
      id: 'langchain-booking',
      version: '1',
      async run(context) {
        const [reserve] = createLangChainTools(context, [
          {
            name: 'reserve_slot',
            description: 'Reserve a meeting slot.',
            schema: z.object({
              customerId: z.string(),
              slot: z.string(),
              operationKey: z.string(),
            }),
          },
        ]);
        await assert.rejects(reserve!.invoke({ customerId: 7 }));
        for (let i = 0; i < 3; i++) {
          const result = JSON.parse(
            await reserve!.invoke({
              customerId: 'customer_7',
              slot: 'slot_42',
              operationKey: 'stable',
            }),
          );
          if (typeof result !== 'string' && result.ok)
            return {
              status: 'completed',
              message: 'Booked',
              output: { bookingId: result.data.id },
            };
          if (
            typeof result !== 'string' &&
            !result.ok &&
            !result.error.retryable
          )
            return { status: 'blocked', message: 'Blocked' };
        }
        return { status: 'blocked', message: 'No confirmation' };
      },
    }),
  });
  assert.equal(batch.baseline.status, 'passed');
  assert.ok(batch.runs.every((r) => r.status === 'passed'));
});

test('redaction keeps verdicts intact and rejects secret collisions instead of changing failures to passes', async () => {
  const input = structuredClone(config);
  input.initialState.privateData = {
    password: 'credential',
    email: 'real@company.com',
  };
  const batch = sanitizeWorkflowBatch(await runWorkflow(input, starter));
  assert.doesNotMatch(JSON.stringify(batch), /credential|real@company/);
  assert.deepEqual(sanitizeWorkflowBatch(batch), batch);
  input.checks.push({
    id: 'private-check',
    label: 'Private field',
    type: 'equals',
    path: '/privateData/password',
    expected: '[REDACTED]',
  });
  const failed = await runWorkflow(input, starter);
  assert.equal(failed.baseline.status, 'failed');
  assert.throws(() => sanitizeWorkflowBatch(failed));
});

test('CLI scaffolds and runs from a separate directory, preserves files, and reports regressions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracedojo-cli-'));
  const cli = resolve('packages/sdk/dist/cli.js');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run('init', '--out', 'dojo').status, 0);
    assert.equal(run('init', '--out', 'dojo').status, 2);
    const args = [
      'test',
      '--config',
      'dojo/workflow.json',
      '--adapter',
      'dojo/adapter.mjs',
      '--out',
      'report.json',
    ];
    const passed = run(...args);
    assert.equal(passed.status, 0, passed.stderr);
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.runs.length, 5);
    const adapter = join(dir, 'dojo/adapter.mjs');
    const source = await readFile(adapter, 'utf8');
    await writeFile(
      adapter,
      source.replace('operationKey,\n', 'operationKey: String(attempt),\n'),
    );
    const failed = run(...args.slice(0, -1), 'failed.json');
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    await writeFile(adapter, 'throw new Error("sensitive-import-error")');
    const collision = run(...args);
    assert.equal(collision.status, 2);
    assert.doesNotMatch(
      collision.stderr,
      /sensitive-import-error|Could not load/,
    );
    const invalid = run(...args.slice(0, -1), 'invalid.json');
    assert.equal(invalid.status, 2);
    assert.doesNotMatch(invalid.stderr, /sensitive-import-error/);
    await assert.rejects(readFile(join(dir, 'invalid.json')));
    await writeFile(join(dir, 'trace.json'), JSON.stringify(trace));
    assert.equal(
      run(
        'import-langsmith',
        'trace.json',
        '--draft-only',
        '--out',
        'draft.json',
      ).status,
      0,
    );
    assert.equal(
      JSON.parse(await readFile(join(dir, 'draft.json'), 'utf8')).status,
      'needs_review',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
