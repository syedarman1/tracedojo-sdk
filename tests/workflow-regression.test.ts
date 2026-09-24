// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  runWorkflow,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';
import {
  compareWorkflowBatches,
  comparisonExitCode,
  comparisonSummary,
} from '../packages/sdk/src/compare.js';

const config = JSON.parse(
  await readFile('packages/sdk/templates/workflow.json', 'utf8'),
);
const good: WorkflowAdapter = await import(
  new URL('../packages/sdk/templates/adapter.mjs', import.meta.url).href
);
const bad: WorkflowAdapter = {
  tools: good.tools,
  createAgent() {
    const agent = good.createAgent();
    let attempts = 0;
    return {
      ...agent,
      version: 'unsafe',
      run: (context) =>
        agent.run({
          ...context,
          call: (name, args) =>
            context.call(name, { ...args, operationKey: String(++attempts) }),
        }),
    };
  },
};

test('regression gate detects new failures, permits existing failures and recognizes fixes', async () => {
  const base = await runWorkflow(config, good, { trials: 3 });
  const broken = await runWorkflow(config, bad, { trials: 3 });
  const regression = compareWorkflowBatches(base, broken);
  assert.equal(comparisonExitCode(regression), 1);
  assert.equal(regression.scenarios[0]!.candidateFailures, 3);
  assert.ok(regression.scenarios[0]!.regressedChecks.includes('one-booking'));
  assert.equal(comparisonExitCode(compareWorkflowBatches(broken, broken)), 0);
  assert.equal(
    compareWorkflowBatches(broken, base).scenarios[0]!.status,
    'improved',
  );
  assert.match(comparisonSummary(regression), /Regressions found/);
  const noControl: WorkflowAdapter = {
    tools: good.tools,
    createAgent: () => ({
      id: 'booking-agent',
      version: 'broken',
      async run() {
        return { status: 'blocked', message: 'Broken' };
      },
    }),
  };
  const blocked = await runWorkflow(config, noControl);
  assert.equal(compareWorkflowBatches(base, blocked).status, 'regressed');
  assert.equal(compareWorkflowBatches(blocked, base).status, 'incomparable');
});

test('gate refuses missing, mismatched, partial and unreached evidence', async () => {
  const base = await runWorkflow(config, good);
  assert.equal(comparisonExitCode(compareWorkflowBatches(undefined, base)), 3);
  assert.equal(compareWorkflowBatches(base, undefined).status, 'incomparable');
  assert.equal(
    compareWorkflowBatches(base, await runWorkflow(config, good, { trials: 2 }))
      .status,
    'incomparable',
  );
  const changed = structuredClone(config);
  changed.title = 'Changed conditions';
  assert.equal(
    compareWorkflowBatches(base, await runWorkflow(changed, good)).status,
    'incomparable',
  );
  const partial = {
    ...base,
    runs: base.runs.slice(0, 1),
    skippedReason: 'Interrupted',
  };
  assert.equal(compareWorkflowBatches(base, partial).status, 'incomparable');
  const unreached = structuredClone(config);
  unreached.scenarios[0].fault.occurrence = 99;
  const untested = await runWorkflow(unreached, good);
  assert.equal(
    compareWorkflowBatches(untested, untested).status,
    'incomparable',
  );
  const forged = structuredClone(base);
  forged.runs[0]!.initialState.extra = 'different starting state';
  assert.equal(compareWorkflowBatches(base, forged).status, 'incomparable');
  assert.throws(() => compareWorkflowBatches({}, base));
});

test('gate detects a newly failing assertion even when total failed trials are unchanged', async () => {
  const input = structuredClone(config);
  input.checks.push({
    id: 'label',
    label: 'Result label',
    type: 'equals',
    source: 'completion',
    path: '/output/label',
    expected: 'correct',
  });
  const adapter = (switchFailure: boolean): WorkflowAdapter => ({
    tools: good.tools,
    createAgent() {
      const agent = good.createAgent();
      return {
        ...agent,
        async run(context) {
          let sawError = false;
          const result = await agent.run({
            ...context,
            call: async (name, args) => {
              const response = await context.call(name, args);
              if (typeof response === 'string' || !response.ok) sawError = true;
              return response;
            },
          });
          return {
            ...result,
            output: {
              bookingId: sawError && !switchFailure ? 'wrong' : 'booking_1',
              label: sawError && switchFailure ? 'wrong' : 'correct',
            },
          };
        },
      };
    },
  });
  const result = compareWorkflowBatches(
    await runWorkflow(input, adapter(false)),
    await runWorkflow(input, adapter(true)),
  );
  assert.equal(result.status, 'regressed');
  assert.equal(
    result.scenarios[0]!.baseFailures,
    result.scenarios[0]!.candidateFailures,
  );
  assert.ok(result.scenarios[0]!.regressedChecks.includes('label'));
});

test('compare CLI preserves destinations and produces incomplete evidence for a missing baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dojo-compare-'));
  const cli = resolve('packages/sdk/dist/cli.js');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'compare', ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
  try {
    await writeFile(
      join(dir, 'candidate.json'),
      JSON.stringify(await runWorkflow(config, good)),
    );
    const args = [
      '--base',
      'missing.json',
      '--candidate',
      'candidate.json',
      '--out',
      'result.json',
      '--summary',
      'summary.md',
    ];
    assert.equal(run(...args).status, 3);
    assert.equal(
      JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')).status,
      'incomparable',
    );
    assert.equal(run(...args).status, 2);
    await writeFile(
      join(dir, 'base.json'),
      await readFile(join(dir, 'candidate.json')),
    );
    assert.equal(
      run(
        '--base',
        'base.json',
        '--candidate',
        'candidate.json',
        '--out',
        'unused.json',
        '--summary',
        'summary.md',
      ).status,
      2,
    );
    await assert.rejects(readFile(join(dir, 'unused.json')));
    assert.equal(
      run(
        '--base',
        'base.json',
        '--candidate',
        'candidate.json',
        '--out',
        'pass.json',
      ).status,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
