// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadSimulation, simulationIds } from '../packages/sdk/src/simulations.js';
import { runWorkflow, stableJson, type Json, type State } from '../packages/sdk/src/index.js';

const SCENARIOS = [
  'lost-confirmation',
  'request-timeout',
  'unavailable',
  'malformed',
  'permission-revoked',
  'duplicate-delivery',
  'stale-read',
  'prompt-injection',
];
const context = {
  signal: new AbortController().signal,
  clock: { now: () => 0, sleep: async () => {} },
};
function at(value: Json | undefined, pointer: string): Json | undefined {
  if (pointer === '') return value;
  return pointer
    .slice(1)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<Json | undefined>(
      (current, key) =>
        current && typeof current === 'object' && Object.hasOwn(current, key)
          ? (current as Record<string, Json>)[key]
          : undefined,
      value,
    );
}

test('ships simulations', () => {
  assert.ok(simulationIds.includes('stripe'));
});

for (const id of simulationIds) {
  test(`${id}: vectors match exactly`, async () => {
    const sim = loadSimulation(id);
    const vectors = JSON.parse(
      readFileSync(new URL(`../packages/sdk/simulations/vectors/${id}.json`, import.meta.url), 'utf8'),
    );
    assert.equal(vectors.schemaVersion, 'simulation-vectors/1');
    assert.equal(vectors.simulation, id);
    assert.ok(vectors.cases.length >= 5, 'cover happy path, errors, and idempotency');
    for (const c of vectors.cases) {
      let state: State = structuredClone(c.state ?? sim.spec.state);
      for (const [i, call] of c.calls.entries()) {
        const draft = structuredClone(state);
        const result = await sim.tools[call.tool]!.execute(structuredClone(call.args), draft, context);
        assert.equal(stableJson(result), stableJson(call.expect), `${c.name}, call ${i + 1}`);
        if (sim.spec.tools[call.tool]!.kind === 'read' || !result.ok)
          assert.equal(stableJson(draft), stableJson(state), `${c.name}, call ${i + 1} changed state`);
        if (result.ok) state = draft;
      }
      for (const [pointer, expected] of Object.entries(c.stateAfter ?? {}))
        assert.equal(stableJson(at(state, pointer) ?? null), stableJson(expected), `${c.name}: ${pointer}`);
    }
  });

  test(`${id}: fixed agent passes every fault; broken agent fails ${id}'s bug scenario`, async () => {
    const sim = loadSimulation(id);
    const workflow = sim.workflow();
    assert.deepEqual(
      (workflow.scenarios as { id: string }[]).map((s) => s.id),
      SCENARIOS,
    );
    const fixed = await runWorkflow(workflow, {
      tools: sim.tools,
      createAgent: () => sim.createAgent('fixed'),
    }, { trials: 2 });
    assert.equal(fixed.baseline.status, 'passed');
    assert.equal(fixed.runs.length, SCENARIOS.length * 2);
    for (const run of fixed.runs) {
      assert.ok(run.fault.triggered, `${run.scenario.id} triggered`);
      assert.equal(
        run.status,
        'passed',
        `${run.scenario.id}: ${run.assertions.filter((a) => !a.passed).map((a) => a.id).join(', ')}`,
      );
    }
    const broken = await runWorkflow(workflow, {
      tools: sim.tools,
      createAgent: () => sim.createAgent('broken'),
    });
    assert.equal(broken.baseline.status, 'passed', 'broken agent passes the no-fault control');
    // Every scenario must still trigger for the broken agent, or the run stops early.
    assert.equal(broken.skippedReason, undefined, 'broken agent completes every scenario');
    assert.equal(broken.runs.length, SCENARIOS.length);
    for (const run of broken.runs) assert.ok(run.fault.triggered, `broken ${run.scenario.id} triggered`);
    const bug = broken.runs.find((r) => r.scenario.id === sim.spec.agent.bugScenario);
    assert.equal(bug?.status, 'failed', `broken agent fails ${sim.spec.agent.bugScenario}`);
  });
}

test('an agent that never re-reads still gets every later scenario tested', async () => {
  const spec = JSON.parse(
    readFileSync(new URL('../packages/sdk/simulations/stripe.json', import.meta.url), 'utf8'),
  );
  // A common agent: refund, then trust the response without a verify read.
  spec.agent.fixed.steps.pop();
  const sim = loadSimulation(spec);
  const batch = await runWorkflow(sim.workflow(), {
    tools: sim.tools,
    createAgent: () => sim.createAgent('fixed'),
  });
  assert.equal(batch.baseline.status, 'passed');
  assert.equal(batch.skippedReason, undefined);
  assert.deepEqual(batch.runs.map((r) => r.scenario.id), SCENARIOS);
  const stale = batch.runs.find((r) => r.scenario.id === 'stale-read')!;
  assert.equal(stale.status, 'inconclusive');
  assert.equal(stale.fault.triggered, false);
  const injection = batch.runs.find((r) => r.scenario.id === 'prompt-injection')!;
  assert.ok(injection.fault.triggered, 'prompt injection still runs');
});
