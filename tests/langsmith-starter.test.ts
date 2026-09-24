import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createLangSmithStarter } from '../packages/sdk/src/langsmith-starter.js';
import {
  importLangSmithTrace,
  inferToolSignatures,
} from '../packages/sdk/src/langsmith.js';
import {
  runWorkflow,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';

const tool = {
  id: 'z-first',
  parent_run_id: 'root',
  name: 'CRM/upsert ${process.exit(99)}',
  run_type: 'tool',
  inputs: { id: 1, email: 'real@company.com' },
  outputs: { value: '`${process.exit(99)}`', secret: 'private-credential' },
};
const trace = {
  id: 'root',
  name: 'Example',
  run_type: 'chain',
  inputs: { task: 'Update a contact' },
  child_runs: [tool],
};

test('signatures merge observed optional fields and types without assuming API semantics', () => {
  const draft = importLangSmithTrace({
    ...trace,
    child_runs: [
      tool,
      {
        ...tool,
        id: 'a-second',
        inputs: { id: 'two', nested: [null, { flag: true }] },
        outputs: null,
      },
    ],
  });
  assert.equal(draft.observedCalls[0]!.id, 'z-first');
  const [signature] = inferToolSignatures(draft);
  assert.equal(signature!.alias, 'tool_1');
  assert.equal(signature!.samples, 2);
  assert.deepEqual(signature!.inputs, {
    type: 'object',
    properties: {
      email: { type: 'string' },
      id: { anyOf: [{ type: 'number' }, { type: 'string' }] },
      nested: {
        type: 'array',
        items: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              properties: { flag: { type: 'boolean' } },
              required: ['flag'],
            },
          ],
        },
      },
    },
    required: ['id'],
  });
});

test('CLI imports executable stubs safely, produces an interrupted-playback failure, and preserves files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dojo-import-'));
  const cli = resolve('packages/sdk/dist/cli.js');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  try {
    await writeFile(join(dir, 'input.json'), JSON.stringify(trace));
    const imported = run('import-langsmith', 'input.json', '--out', 'dojo');
    assert.equal(imported.status, 0, imported.stderr);
    const source = await readFile(join(dir, 'dojo/adapter.mjs'), 'utf8');
    assert.doesNotMatch(source, /process.exit\(99\)/);
    const fixture = await readFile(join(dir, 'dojo/trace.json'), 'utf8');
    assert.doesNotMatch(fixture, /private-credential|real@company.com/);
    assert.match(fixture, /observed_only/);
    const result = run('test', '--out', 'report.json');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.baseline.status, 'passed');
    assert.equal(report.baseline.metrics.mutations, 0);
    assert.equal(report.baseline.agent.id, 'imported-trace-playback');
    assert.equal(report.runs[0].status, 'failed');
    assert.equal(report.runs[0].fault.triggered, true);
    assert.equal(
      run('import-langsmith', 'input.json', '--out', 'dojo').status,
      2,
    );
    assert.equal(await readFile(join(dir, 'dojo/adapter.mjs'), 'utf8'), source);
    assert.equal(
      run(
        'import-langsmith',
        'input.json',
        '--draft-only',
        '--out',
        'draft.json',
      ).status,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ambiguous, missing and error outputs block playback instead of inventing a passing result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dojo-review-'));
  try {
    const missing = Object.fromEntries(
      Object.entries(tool).filter(([key]) => key !== 'outputs'),
    );
    const variants = [
      [tool, { ...tool, id: 'second', outputs: { value: 'different' } }],
      [missing],
      [{ ...tool, error: 'Rejected by service' }],
    ];
    for (const [index, calls] of variants.entries()) {
      const destination = join(dir, String(index));
      await createLangSmithStarter(
        { ...trace, child_runs: calls },
        destination,
      );
      const config = JSON.parse(
        await readFile(join(destination, 'workflow.json'), 'utf8'),
      );
      const adapter: WorkflowAdapter = await import(
        pathToFileURL(join(destination, 'adapter.mjs')).href
      );
      const batch = await runWorkflow(config, adapter);
      assert.equal(batch.baseline.status, 'failed');
      assert.equal(batch.runs.length, 0);
      assert.ok(batch.skippedReason);
    }
    await assert.rejects(
      createLangSmithStarter(
        {
          ...trace,
          child_runs: Array.from({ length: 91 }, (_, i) => ({
            ...tool,
            id: `tool-${i}`,
          })),
        },
        join(dir, 'too-many'),
      ),
      /90 tool calls/,
    );
    await assert.rejects(readFile(join(dir, 'too-many/workflow.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
