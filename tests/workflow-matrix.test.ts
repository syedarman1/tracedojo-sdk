import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  generateFaultMatrix,
  parseWorkflowMatrix,
} from '../packages/sdk/src/matrix.js';
import { parseWorkflow } from '../packages/sdk/src/schema.js';
import { testFaultMatrix } from '../packages/sdk/src/matrix-cli.js';
import { createStarter } from '../packages/sdk/src/starter.js';
import { parseWorkflowReports } from '../packages/sdk/src/reports.js';
import { compareWorkflowBatches } from '../packages/sdk/src/compare.js';

const config = JSON.parse(
  await readFile('packages/sdk/templates/workflow.json', 'utf8'),
);
const cli = resolve('packages/sdk/dist/cli.js');
const inventory = [
  { name: 'reserve_slot', kind: 'write' },
  { name: 'lookup', kind: 'read' },
];

test('matrix generation is deterministic, preserves checks, and separates read/write faults', () => {
  const before = structuredClone(config);
  const matrix = generateFaultMatrix(config, inventory);
  assert.deepEqual(
    matrix,
    generateFaultMatrix(config, [...inventory].reverse()),
  );
  assert.deepEqual(config, before);
  assert.equal(matrix.suites.length, 2);
  assert.deepEqual(
    matrix.suites[0]!.workflow.scenarios.map(({ fault }) => fault.type),
    ['timeout_before', 'unavailable', 'malformed'],
  );
  const write = matrix.suites[1]!;
  assert.equal(write.workflow.scenarios.length, 6);
  assert.deepEqual(write.workflow.checks, parseWorkflow(config).checks);
  assert.deepEqual(
    write.workflow.scenarios.at(-1)!.checks?.map((check) => check.id),
    ['no-booking', 'no-state-change', 'honest-blocker'],
  );
  write.workflow.initialState.bookings = ['changed'];
  assert.deepEqual(matrix.suites[0]!.workflow.initialState.bookings, []);
  const blueprint = structuredClone(config);
  delete blueprint.scenarios;
  assert.equal(generateFaultMatrix(blueprint, inventory).suites.length, 2);
  const stale = generateFaultMatrix(blueprint, inventory, {
    faults: ['stale_read'],
  });
  assert.equal(stale.suites.length, 1);
  assert.deepEqual(stale.suites[0]!.workflow.scenarios[0]!.fault, {
    type: 'stale_read',
    tool: 'lookup',
    occurrence: 2,
    repeat: 1,
  });
});

test('matrix validates bounds, ambiguous overrides, selection, and traversal', () => {
  for (const bad of [
    [{ name: '../secret', kind: 'write' }],
    [{ name: 'ok', kind: 'unknown' }],
    [...inventory, inventory[0]],
    Array.from({ length: 51 }, (_, i) => ({ name: `tool${i}`, kind: 'read' })),
  ])
    assert.throws(() => generateFaultMatrix(config, bad));
  assert.throws(() =>
    generateFaultMatrix(config, inventory, { tools: ['missing'] }),
  );
  assert.throws(() =>
    generateFaultMatrix(config, inventory, { tools: ['lookup', 'lookup'] }),
  );
  assert.throws(() =>
    generateFaultMatrix(config, inventory, {
      tools: ['reserve_slot'],
      faults: ['stale_read'],
    }),
  );
  const conflict = structuredClone(config);
  conflict.scenarios.push({
    ...conflict.scenarios[0],
    id: 'conflicting',
    checks: [
      { id: 'different', label: 'Different', type: 'unchanged', path: '' },
    ],
  });
  assert.throws(
    () => generateFaultMatrix(conflict, inventory),
    /conflicting checks/,
  );
  const matrix = generateFaultMatrix(config, inventory);
  matrix.suites[0]!.id = '../private';
  assert.throws(() => parseWorkflowMatrix(matrix));
  const long = 'a'.repeat(99);
  const names = generateFaultMatrix(config, [
    { name: `${long}b`, kind: 'write' },
    { name: `${long}c`, kind: 'write' },
  ]);
  assert.notEqual(names.suites[0]!.id, names.suites[1]!.id);
  assert.ok(names.suites.every((suite) => suite.id.length <= 100));
});

test('CLI generates a runnable matrix, detects a regression, and protects destinations before importing code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dojo-matrix-'));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  try {
    await createStarter(join(dir, 'dojo'), false);
    const result = run('matrix', '--out', 'matrix.json');
    assert.equal(result.status, 0, result.stderr);
    const matrix = parseWorkflowMatrix(
      JSON.parse(await readFile(join(dir, 'matrix.json'), 'utf8')),
    );
    assert.equal(matrix.suites[0]!.workflow.scenarios.length, 6);
    const good = run(
      'test-matrix',
      'matrix.json',
      '--trials',
      '2',
      '--out',
      'good',
    );
    assert.equal(good.status, 0, good.stdout + good.stderr);
    const index = JSON.parse(
      await readFile(join(dir, 'good/index.json'), 'utf8'),
    );
    assert.equal(index.completed, 1);
    const goodBatch = JSON.parse(
      await readFile(join(dir, 'good', index.suites[0].report), 'utf8'),
    );
    assert.equal(parseWorkflowReports(goodBatch).length, 13);
    const source = await readFile(join(dir, 'dojo/adapter.mjs'), 'utf8');
    await writeFile(
      join(dir, 'dojo/adapter.mjs'),
      source.replace('operationKey,\n', 'operationKey: String(attempt),\n'),
    );
    const bad = run(
      'test-matrix',
      'matrix.json',
      '--trials',
      '2',
      '--out',
      'bad',
    );
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    const badBatch = JSON.parse(
      await readFile(join(dir, 'bad', index.suites[0].report), 'utf8'),
    );
    assert.equal(
      compareWorkflowBatches(goodBatch, badBatch).status,
      'regressed',
    );
    await writeFile(
      join(dir, 'marker.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync('invoked', 'yes'); export const tools = {};`,
    );
    for (const command of [['test'], ['test-matrix', 'matrix.json']]) {
      assert.equal(
        run(
          ...command,
          '--adapter',
          'marker.mjs',
          '--commit',
          'invalid',
          '--out',
          'invalid-commit',
        ).status,
        2,
      );
      await assert.rejects(readFile(join(dir, 'invoked')));
    }
    assert.equal(
      run('matrix', '--adapter', 'marker.mjs', '--out', 'matrix.json').status,
      2,
    );
    assert.equal(
      run(
        'test-matrix',
        'matrix.json',
        '--adapter',
        'marker.mjs',
        '--out',
        'good',
      ).status,
      2,
    );
    await assert.rejects(stat(join(dir, 'invoked')));
    await writeFile(join(dir, 'invalid-config.json'), '{}');
    assert.equal(
      run(
        'matrix',
        '--config',
        'invalid-config.json',
        '--adapter',
        'marker.mjs',
        '--out',
        'invalid-matrix.json',
      ).status,
      2,
    );
    await assert.rejects(stat(join(dir, 'invoked')));
    assert.equal(
      run('test-matrix', 'matrix.json', '--trials', '0', '--out', 'invalid')
        .status,
      2,
    );
    await assert.rejects(stat(join(dir, 'invalid')));
    assert.equal(
      run('matrix', '--tools', 'missing', '--out', 'missing.json').status,
      2,
    );
    await assert.rejects(stat(join(dir, 'missing.json')));
    const generatorOnly = `export const tools = { reserve_slot: { kind: 'write', execute() { throw Error('must not run'); } } }; export function createAgent() { throw Error('must not run'); }`;
    await writeFile(join(dir, 'no-run.mjs'), generatorOnly);
    assert.equal(
      run('matrix', '--adapter', 'no-run.mjs', '--out', 'unexecuted.json')
        .status,
      0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('later matrix errors preserve completed evidence without leaking adapter diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dojo-matrix-error-'));
  try {
    const matrix = generateFaultMatrix(
      {
        schemaVersion: 'workflow/1',
        id: 'demo',
        title: 'Demo',
        task: 'Read',
        initialState: {},
        checks: [
          { id: 'state', label: 'Unchanged', type: 'unchanged', path: '' },
        ],
      },
      ['a', 'b', 'c'].map((name) => ({ name, kind: 'read' })),
    );
    const adapter = join(dir, 'adapter.mjs');
    await writeFile(
      adapter,
      `const read = {kind:'read', execute:()=>({ok:true,data:null})}; export const tools = {a:read,b:read,c:read}; let count=0; export function createAgent() { if (++count === 5) throw Error('private-diagnostic'); return {id:'reader',version:'1',async run({call}) {await call('a',{}); return {status:'completed',message:'Read'};}}; }`,
    );
    const output = join(dir, 'reports');
    const result = await testFaultMatrix(matrix, adapter, output, 1);
    assert.equal(result.exitCode, 3);
    assert.equal(result.completed, 1);
    assert.deepEqual(
      result.suites.map((suite) => suite.status),
      ['passed', 'error', 'not_run'],
    );
    const index = await readFile(join(output, 'index.json'), 'utf8');
    assert.doesNotMatch(index, /private-diagnostic/);
    assert.equal(
      parseWorkflowReports(
        JSON.parse(
          await readFile(join(output, result.suites[0]!.report), 'utf8'),
        ),
      ).length,
      4,
    );
    assert.deepEqual(
      (await readdir(output)).sort(),
      ['index.json', result.suites[0]!.report].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('matrix execution records incomplete coverage and never treats absent suites as passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dojo-matrix-partial-'));
  try {
    const blueprint = {
      schemaVersion: 'workflow/1',
      id: 'example',
      title: 'Example',
      task: 'Do work',
      initialState: {},
      checks: [{ id: 'same', label: 'Same', type: 'unchanged', path: '' }],
    };
    const matrix = generateFaultMatrix(blueprint, [
      { name: 'a', kind: 'read' },
      { name: 'b', kind: 'read' },
    ]);
    const adapter = join(dir, 'adapter.mjs');
    await writeFile(
      adapter,
      `export const tools = { a: { kind:'read', execute: () => ({ok:true,data:null}) }, b: { kind:'read', execute: () => ({ok:true,data:null}) } }; export function createAgent() { return { id:'idle',version:'1',async run() { return {status:'completed',message:'No calls'}; } }; }`,
    );
    const result = await testFaultMatrix(
      matrix,
      adapter,
      join(dir, 'reports'),
      1,
    );
    assert.equal(result.exitCode, 3);
    assert.deepEqual(
      result.suites.map((suite) => suite.status),
      ['incomplete', 'incomplete'],
    );
    assert.equal(result.completed, 2);
    assert.equal((await readdir(join(dir, 'reports'))).length, 3);
    const brokenControl = structuredClone(matrix);
    brokenControl.suites[0]!.workflow.checks = [
      {
        id: 'missing',
        label: 'Missing',
        type: 'equals',
        source: 'state',
        path: '/missing',
        expected: true,
      },
    ];
    const blocked = await testFaultMatrix(
      brokenControl,
      adapter,
      join(dir, 'blocked'),
      1,
    );
    assert.deepEqual(
      blocked.suites.map((suite) => suite.status),
      ['incomplete', 'not_run'],
    );
    assert.equal(blocked.exitCode, 3);
    const cancelled = new AbortController();
    cancelled.abort();
    const stopped = await testFaultMatrix(
      matrix,
      adapter,
      join(dir, 'cancelled'),
      1,
      cancelled.signal,
    );
    assert.equal(stopped.exitCode, 3);
    assert.equal(stopped.completed, 0);
    assert.deepEqual(await readdir(join(dir, 'cancelled')), ['index.json']);
    matrix.suites[1]!.kind = 'write';
    await assert.rejects(
      testFaultMatrix(matrix, adapter, join(dir, 'mismatch'), 1),
      /do not match/,
    );
    await assert.rejects(stat(join(dir, 'mismatch')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
