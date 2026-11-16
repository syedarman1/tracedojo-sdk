// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createStarter } from '../packages/sdk/src/starter.js';
import {
  starterWorlds,
  faultWorlds,
  simulationWorlds,
  templateWorlds,
} from '../packages/sdk/src/worlds.js';
import {
  runWorkflow,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';
import { workflowBatchSchema } from '../packages/sdk/src/schema.js';

test('ten starters pass reached faults and catch unsafe retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dojo-worlds-'));
  try {
    const domainWorlds = starterWorlds.filter(
      (world) => !faultWorlds.some((fault) => fault.id === world.id),
    );
    assert.equal(domainWorlds.length, 10);
    for (const world of domainWorlds) {
      const dir = join(root, world.id);
      await createStarter(dir, false, world.id);
      const input = JSON.parse(
        await readFile(join(dir, 'workflow.json'), 'utf8'),
      );
      const adapter: WorkflowAdapter = await import(
        pathToFileURL(join(dir, 'adapter.mjs')).href
      );
      const batch = workflowBatchSchema.parse(
        await runWorkflow(input, adapter, { trials: 2 }),
      );
      assert.equal(batch.baseline.status, 'passed', world.id);
      assert.equal(batch.runs.length, 10);
      assert.ok(
        batch.runs.every((r) => r.status === 'passed' && r.fault.triggered),
        world.id,
      );
      const source = await readFile(join(dir, 'adapter.mjs'), 'utf8');
      const broken =
        world.id === 'calendar'
          ? source.replace(
              'operationKey,\n',
              'operationKey: String(attempt),\n',
            )
          : source.replace(
              "operationKey: 'one-operation'",
              'operationKey: String(attempt)',
            );
      assert.notEqual(broken, source);
      await writeFile(join(dir, 'broken.mjs'), broken);
      const unsafe: WorkflowAdapter = await import(
        pathToFileURL(join(dir, 'broken.mjs')).href
      );
      const failed = await runWorkflow(input, unsafe);
      assert.equal(failed.baseline.status, 'passed', world.id);
      assert.equal(failed.runs[0]!.status, 'failed', world.id);
      assert.equal(failed.runs[0]!.metrics.mutations, 2, world.id);
      const tool = Object.values(adapter.tools)[0]!;
      const state = structuredClone(input.initialState);
      assert.equal(
        (
          await tool.execute({ operationKey: '__proto__' }, state, {
            signal: new AbortController().signal,
            clock: { now: () => 0, sleep: async () => {} },
          })
        ).ok,
        false,
      );
      assert.deepEqual(state, input.initialState);
      await assert.rejects(createStarter(dir, false, world.id));
      assert.equal(await readFile(join(dir, 'adapter.mjs'), 'utf8'), source);
    }
    await assert.rejects(
      createStarter(join(root, 'invalid'), false, '../private'),
      /Unknown template/,
    );
    await assert.rejects(readFile(join(root, 'invalid/workflow.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('simulation templates run from init output and expose their bug', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dojo-sims-'));
  const library = pathToFileURL(
    join(process.cwd(), 'packages/sdk/src/simulations.ts'),
  ).href;
  try {
    assert.ok(simulationWorlds.length >= 10);
    assert.ok(simulationWorlds.every((w) => templateWorlds.includes(w)));
    for (const world of simulationWorlds) {
      const dir = join(root, world.id);
      await createStarter(dir, false, world.id);
      const input = JSON.parse(
        await readFile(join(dir, 'workflow.json'), 'utf8'),
      );
      const readme = await readFile(join(dir, 'README.md'), 'utf8');
      assert.match(readme, /createAgent\('broken'\)/, world.id);
      const source = await readFile(join(dir, 'adapter.mjs'), 'utf8');
      assert.match(source, /from '@tracedojo\/sdk\/simulations'/);
      const local = source.replace('@tracedojo/sdk/simulations', library);
      await writeFile(join(dir, 'local.mjs'), local);
      const adapter: WorkflowAdapter = await import(
        pathToFileURL(join(dir, 'local.mjs')).href
      );
      const batch = workflowBatchSchema.parse(
        await runWorkflow(input, adapter),
      );
      assert.equal(batch.baseline.status, 'passed', world.id);
      assert.equal(batch.runs.length, 8, world.id);
      assert.ok(
        batch.runs.every((r) => r.status === 'passed' && r.fault.triggered),
        world.id,
      );
      await writeFile(
        join(dir, 'broken.mjs'),
        local.replace("createAgent('fixed')", "createAgent('broken')"),
      );
      const broken: WorkflowAdapter = await import(
        pathToFileURL(join(dir, 'broken.mjs')).href
      );
      const failed = await runWorkflow(input, broken);
      assert.equal(failed.baseline.status, 'passed', world.id);
      assert.ok(
        failed.runs.some(
          (r) => r.scenario.id === 'lost-confirmation' && r.status === 'failed',
        ),
        world.id,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
