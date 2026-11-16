// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSimulation } from '../packages/sdk/src/simulation-schema.js';
import { minimalSpec } from './fixtures/notes-spec.js';

test('accepts minimal spec', () => {
  const spec = parseSimulation(minimalSpec());
  assert.equal(spec.id, 'notes');
  assert.equal(spec.tools.create_note!.kind, 'write');
});

test('rejects dangling references', () => {
  const unknownError = minimalSpec();
  unknownError.tools.get_note.steps[0].missing = 'nope';
  assert.throws(() => parseSimulation(unknownError), /Unknown error "nope"/);

  const unknownTool = minimalSpec();
  unknownTool.workflow.scenarios[0].fault.tool = 'delete_note';
  assert.throws(() => parseSimulation(unknownTool), /unknown tool "delete_note"/);

  const unknownOperator = minimalSpec();
  unknownOperator.tools.get_note.steps[1].return = { $foo: 1 };
  assert.throws(() => parseSimulation(unknownOperator), /Unknown operator "\$foo"/);

  const unknownCollection = minimalSpec();
  unknownCollection.tools.get_note.steps[0].find = 'pages';
  assert.throws(() => parseSimulation(unknownCollection), /Unknown collection "pages"/);

  const unknownBinding = minimalSpec();
  unknownBinding.tools.get_note.steps[1].return = { $: 'page.id' };
  assert.throws(() => parseSimulation(unknownBinding), /Unknown name "page"/);

  const agentTool = minimalSpec();
  agentTool.agent.fixed.steps[0].call = 'delete_note';
  assert.throws(() => parseSimulation(agentTool), /unknown tool "delete_note"/);

  const bugScenario = minimalSpec();
  bugScenario.agent.bugScenario = 'nope';
  assert.throws(() => parseSimulation(bugScenario), /bugScenario/);
});

test('read tools cannot write', () => {
  const seq = minimalSpec();
  seq.tools.get_note.steps[1].return = { $seq: 'note' };
  assert.throws(() => parseSimulation(seq), /Read tool "get_note" cannot/);

  const insert = minimalSpec();
  insert.tools.get_note.steps.unshift({ insert: 'notes', value: {} });
  assert.throws(() => parseSimulation(insert), /Read tool "get_note" cannot/);
});

test('fault kinds must match tool kinds', () => {
  const stale = minimalSpec();
  stale.workflow.scenarios[0].fault = { type: 'stale_read', tool: 'create_note' };
  assert.throws(() => parseSimulation(stale), /stale_read needs a read tool/);

  const duplicate = minimalSpec();
  duplicate.workflow.scenarios[0].fault = {
    type: 'duplicate_delivery',
    tool: 'get_note',
  };
  assert.throws(() => parseSimulation(duplicate), /needs a write tool/);

  const model = minimalSpec();
  model.workflow.scenarios[0].fault = { type: 'rate_limited', target: 'model' };
  assert.throws(() => parseSimulation(model), /Model faults/);
});

test('idempotency arg must be an input property', () => {
  const spec = minimalSpec();
  spec.tools.create_note.idempotency.arg = 'token';
  assert.throws(() => parseSimulation(spec), /idempotency arg "token"/);
});

test('rejects workflow initialState and unsafe names', () => {
  const extra = minimalSpec();
  extra.workflow.initialState = {};
  assert.throws(() => parseSimulation(extra));

  const proto = minimalSpec();
  proto.collections = JSON.parse('{"__proto__": {"unique": []}}');
  assert.throws(() => parseSimulation(proto));
});
