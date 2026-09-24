import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createStarter } from '../packages/sdk/src/starter.js';
import { starterWorlds, faultWorlds } from '../packages/sdk/src/worlds.js';
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
