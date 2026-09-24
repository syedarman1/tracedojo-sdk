import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  runWorkflow,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';
import { workflowSummary } from '../packages/sdk/src/summary.js';

const config = JSON.parse(
  await readFile('packages/sdk/templates/workflow.json', 'utf8'),
);
const starter: WorkflowAdapter = await import(
  new URL('../packages/sdk/templates/adapter.mjs', import.meta.url).href
);

test('starter CI handles paths with spaces and never replaces an existing workflow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dojo-setup-'));
  const cli = resolve('packages/sdk/dist/cli.js');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run('init', '--out', 'test fixtures', '--ci').status, 0);
    const ciPath = join(dir, '.github/workflows/tracedojo.yml');
    const ci = await readFile(ciPath, 'utf8');
    assert.match(ci, /DOJO_CONFIG: "test fixtures\/workflow.json"/);
    assert.match(ci, /--config "\$DOJO_CONFIG"/);
    assert.match(ci, /if: always\(\)/);
    assert.equal(run('init', '--out', 'second', '--ci').status, 2);
    assert.equal(await readFile(ciPath, 'utf8'), ci);
    await assert.rejects(readFile(join(dir, 'second/workflow.json')));
    assert.equal(run('init', '--out', '../outside', '--ci').status, 2);
    assert.equal(run('init', '--out', '${{ dangerous }}', '--ci').status, 2);
    assert.equal(run('init').status, 0);
    assert.equal(run('test').status, 0);
    assert.equal(run('test').status, 0);
    assert.equal((await readdir(join(dir, '.tracedojo/reports'))).length, 2);
    await mkdir(join(dir, 'existing'));
    await writeFile(join(dir, 'existing/summary.md'), 'preserve this');
    await writeFile(
      join(dir, 'dojo/adapter.mjs'),
      'throw new Error("must-not-execute")',
    );
    const collision = run(
      'test',
      '--out',
      'unused.json',
      '--summary',
      'existing/summary.md',
    );
    assert.equal(collision.status, 2);
    assert.doesNotMatch(collision.stderr, /Could not load|must-not-execute/);
    assert.equal(
      await readFile(join(dir, 'existing/summary.md'), 'utf8'),
      'preserve this',
    );
    await assert.rejects(readFile(join(dir, 'unused.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CI summary distinguishes repeated trials, unreached faults and failed controls', async () => {
  const passed = await runWorkflow(config, starter, { trials: 3 });
  const summary = workflowSummary(passed);
  assert.match(summary, /15\/15/);
  assert.match(
    summary,
    /Booking succeeds, confirmation is lost \| 3 \| 0 \| 0 \| 3\/3/,
  );
  const unreachable = structuredClone(config);
  unreachable.scenarios[0].fault.occurrence = 99;
  const incomplete = workflowSummary(await runWorkflow(unreachable, starter));
  assert.match(incomplete, /TraceDojo: Incomplete/);
  assert.match(incomplete, /fault was not reached/);
  const broken = structuredClone(config);
  broken.checks[0].expected = 2;
  const blocked = workflowSummary(await runWorkflow(broken, starter));
  assert.match(blocked, /No-fault control: \*\*failed\*\*/);
  assert.match(blocked, /0\/5/);
  assert.match(blocked, /Exactly one booking/);
});

test('CI setup rolls back all its new files when a comment workflow or script already exists', async () => {
  for (const collision of [
    '.github/workflows/tracedojo-comment.yml',
    '.github/tracedojo/comment.cjs',
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'dojo-ci-collision-'));
    try {
      const path = join(dir, collision);
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, 'existing user file');
      const result = spawnSync(
        process.execPath,
        [resolve('packages/sdk/dist/cli.js'), 'init', '--ci'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(result.status, 2);
      assert.equal(await readFile(path, 'utf8'), 'existing user file');
      await assert.rejects(readFile(join(dir, 'dojo/workflow.json')));
      await assert.rejects(
        readFile(join(dir, '.github/workflows/tracedojo.yml')),
      );
      if (collision.endsWith('comment.cjs'))
        await assert.rejects(
          readFile(join(dir, '.github/workflows/tracedojo-comment.yml')),
        );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('CI summary treats Markdown and HTML in report labels as text', async () => {
  const input = structuredClone(config);
  input.title =
    '<script>alert(1)</script> | [link](https://bad.test)\n# heading';
  const summary = workflowSummary(await runWorkflow(input, starter));
  assert.doesNotMatch(summary, /<script>|\[link\]|\n# heading/);
  assert.match(summary, /&#60;script&#62;/);
});
