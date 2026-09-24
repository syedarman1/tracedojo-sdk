import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  runWorkflow,
  workflowBatchSchema,
  type WorkflowAdapter,
  type WorkflowBatch,
} from '../packages/sdk/src/index.js';
import { workflowTrends } from '../packages/sdk/src/trends.js';
import { parseWorkflowReports } from '../packages/sdk/src/reports.js';
import { sanitizeWorkflowBatch } from '../packages/sdk/src/privacy.js';

const config = JSON.parse(
  await readFile('packages/sdk/templates/workflow.json', 'utf8'),
);
const adapter: WorkflowAdapter = await import(
  new URL('../packages/sdk/templates/adapter.mjs', import.meta.url).href
);
const records = (batch: WorkflowBatch) => [batch.baseline, ...batch.runs];
const lost = (reports: unknown[]) =>
  workflowTrends(reports).series.find((series) =>
    series.id.endsWith(':lost-confirmation'),
  )!;

test('commit trends measure a real scripted regression and deduplicate imported evidence', async () => {
  const safe = await runWorkflow(config, adapter, {
    trials: 2,
    commitSha: 'a'.repeat(40),
  });
  const broken: WorkflowAdapter = {
    tools: adapter.tools,
    createAgent() {
      const agent = adapter.createAgent();
      let calls = 0;
      return {
        ...agent,
        version: 'unsafe',
        run(context) {
          return agent.run({
            ...context,
            call(tool, args) {
              return context.call(tool, {
                ...args,
                operationKey: String(calls++),
              });
            },
          });
        },
      };
    },
  };
  const unsafe = await runWorkflow(config, broken, {
    trials: 2,
    commitSha: 'b'.repeat(40),
  });
  const result = lost([
    ...records(safe),
    ...parseWorkflowReports(safe),
    ...records(unsafe),
  ]);
  assert.deepEqual(
    result.points.map((point) => point.passRate),
    [100, 0],
  );
  assert.deepEqual(
    result.points.map((point) => point.planned),
    [2, 2],
  );
  assert.equal(result.points[1]!.failed, 2);
  assert.deepEqual(sanitizeWorkflowBatch(safe), safe);
  assert.equal(safe.baseline.execution!.scenarioIds.length, 5);
  assert.ok(
    records(safe).every(
      (run) => run.execution!.id === safe.baseline.execution!.id,
    ),
  );
  assert.notEqual(safe.baseline.execution!.id, unsafe.baseline.execution!.id);
});

test('missing controls, missing trials, and entirely absent scenarios do not become passes', async () => {
  const batch = await runWorkflow(config, adapter, {
    trials: 2,
    commitSha: 'a'.repeat(40),
  });
  assert.equal(lost(batch.runs).points[0]!.passRate, null);
  const partial = records(batch).filter((run) => run.id !== batch.runs[0]!.id);
  assert.equal(lost(partial).points[0]!.incomplete, 1);
  assert.equal(lost(partial).points[0]!.passRate, null);
  const controlOnly = workflowTrends([batch.baseline]);
  assert.equal(controlOnly.series.length, 5);
  assert.ok(
    controlOnly.series.every(
      (series) =>
        series.points[0]!.passRate === null && series.points[0]!.planned === 2,
    ),
  );
  const interrupted = await runWorkflow(
    {
      ...config,
      scenarios: [
        {
          ...config.scenarios[0],
          fault: { ...config.scenarios[0].fault, occurrence: 99 },
        },
      ],
    },
    adapter,
    { commitSha: 'b'.repeat(40) },
  );
  assert.equal(lost(records(interrupted)).points[0]!.passRate, null);
  const blocked = await runWorkflow(
    config,
    {
      ...adapter,
      createAgent: () => ({
        id: 'blocked',
        version: '1',
        async run() {
          return { status: 'completed', message: 'Did nothing' };
        },
      }),
    },
    { commitSha: 'c'.repeat(40) },
  );
  assert.ok(
    workflowTrends(records(blocked)).series.every(
      (series) => series.points[0]!.passRate === null,
    ),
  );
});

test('reruns aggregate only matching commits and separate changed suites and legacy reports', async () => {
  const one = await runWorkflow(config, adapter, { commitSha: 'a'.repeat(40) });
  const two = await runWorkflow(config, adapter, {
    trials: 2,
    commitSha: 'a'.repeat(40),
  });
  const aggregate = lost([...records(one), ...records(two)]).points[0]!;
  assert.equal(aggregate.executions, 2);
  assert.equal(aggregate.planned, 3);
  assert.equal(aggregate.passRate, 100);
  const changed = await runWorkflow(
    { ...config, task: 'Changed task' },
    adapter,
    { commitSha: 'b'.repeat(40) },
  );
  assert.equal(
    workflowTrends([...records(one), ...records(changed)]).series.length,
    10,
  );
  const legacy = structuredClone(one);
  for (const report of records(legacy)) delete report.execution;
  assert.equal(workflowBatchSchema.safeParse(legacy).success, true);
  assert.equal(workflowTrends(records(legacy)).unlabelled, 6);
  assert.equal(workflowTrends(records(legacy)).series.length, 0);
});

test('conflicting provenance, duplicate identities, and mixed versions cannot yield a rate', async () => {
  const batch = await runWorkflow(config, adapter, {
    commitSha: 'a'.repeat(40),
  });
  const changed = structuredClone(batch);
  changed.runs[0]!.execution!.commitSha = 'b'.repeat(40);
  assert.equal(workflowBatchSchema.safeParse(changed).success, false);
  assert.ok(
    lost(records(changed)).points.every((point) => point.passRate === null),
  );
  const duplicate = structuredClone(batch.runs[0]!);
  duplicate.createdAt = '2020-01-01T00:00:00.000Z';
  assert.equal(lost([...records(batch), duplicate]).points[0]!.passRate, null);
  const unlabelled = structuredClone(batch);
  delete unlabelled.runs[0]!.execution!.commitSha;
  assert.equal(lost(records(unlabelled)).points[0]!.passRate, null);
  const mixed = await runWorkflow(
    config,
    {
      ...adapter,
      createAgent() {
        return { ...adapter.createAgent(), version: 'different' };
      },
    },
    { commitSha: 'a'.repeat(40) },
  );
  assert.equal(
    lost([...records(batch), ...records(mixed)]).points[0]!.passRate,
    null,
  );
  let called = false;
  await assert.rejects(
    runWorkflow(
      config,
      {
        ...adapter,
        createAgent() {
          called = true;
          return adapter.createAgent();
        },
      },
      { commitSha: 'invalid' },
    ),
  );
  assert.equal(called, false);
});
