// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { worldFiles } from '../packages/sdk/src/worlds.js';

// Inside the repository, so the generated adapter resolves @tracedojo/sdk.
const scratch = () => mkdtemp(resolve('.tracedojo-combined-'));
const cli = resolve('packages/sdk/dist/cli.js');

test('init --template stripe+slack runs with tracedojo test and catches both double writes', async () => {
  const dir = await scratch();
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  try {
    assert.equal(run('init', '--template', 'stripe+slack', '--out', 'dojo').status, 0);
    const fixed = run('test', '--out', 'fixed.json');
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    const report = JSON.parse(await readFile(join(dir, 'fixed.json'), 'utf8'));
    // Every scenario faults a write the reference agent makes, so all trigger.
    assert.ok(report.runs.length >= 8 && report.runs.length <= 10);
    for (const r of report.runs) assert.ok(r.fault.triggered, r.scenario.id);

    const adapter = join(dir, 'dojo/adapter.mjs');
    const source = await readFile(adapter, 'utf8');
    await writeFile(adapter, source.replace("const variant = 'fixed';", "const variant = 'broken';"));
    const broken = run('test', '--out', 'broken.json');
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    assert.match(broken.stdout, /Exactly one refund exists: expected 1, observed 2\./);
    assert.match(broken.stdout, /Exactly one new message \(3 in total\): expected 3, observed 4\./);

    // A scenario whose fault the agent never reaches says why it is inconclusive.
    await writeFile(adapter, source);
    const config = join(dir, 'dojo/workflow.json');
    const workflow = JSON.parse(await readFile(config, 'utf8'));
    const slack = workflow.scenarios.find((s: { id: string }) => s.id === 'slack-lost-confirmation');
    slack.fault.occurrence = 5; // the agent posts once, so the fifth call never happens
    await writeFile(config, JSON.stringify(workflow, null, 2));
    const partial = run('test', '--out', 'partial.json');
    assert.equal(partial.status, 3, partial.stdout + partial.stderr);
    assert.match(partial.stdout, /The agent never made call 5 to slack_chat_postMessage, so this fault was not tested\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('combined templates reject unknown, repeated, or more than two simulations', async () => {
  await assert.rejects(worldFiles('stripe+nope'), /Combine two different simulations/);
  await assert.rejects(worldFiles('stripe+stripe'), /Combine two different simulations/);
  await assert.rejects(worldFiles('stripe+slack+github'), /Combine two different simulations/);
  const files = await worldFiles('github+jira');
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'adapter.mjs', 'workflow.json']);
});
