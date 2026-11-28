// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWorkflow,
  runWorkflow,
  scenarioChecks,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';

const base = {
  schemaVersion: 'workflow/1',
  id: 'notes',
  title: 'Write one note',
  task: 'Save the note "hello".',
  initialState: { notes: [], other: { keep: true } },
  checks: [
    {
      id: 'one-note',
      label: 'One note',
      type: 'count',
      path: '/notes',
      expected: 1,
    },
    {
      id: 'other',
      label: 'Other record unchanged',
      type: 'unchanged',
      path: '/other',
    },
  ],
};

test('scenario checks add to top-level checks, replace by id, and skip by id', () => {
  const checks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(
    scenarioChecks(checks, {
      checks: [{ id: 'b', replaced: true } as { id: string }, { id: 'd' }],
      skipChecks: ['c'],
    }),
    [{ id: 'a' }, { id: 'b', replaced: true }, { id: 'd' }],
  );
  assert.deepEqual(scenarioChecks(checks, {}), checks);
});

test('a scenario with its own checks still runs the top-level checks it does not skip', async () => {
  const workflow = parseWorkflow({
    ...base,
    scenarios: [
      {
        id: 'revoked',
        title: 'Write permission revoked',
        fault: { type: 'permission_revoked', tool: 'save_note' },
        skipChecks: ['one-note'],
        checks: [
          {
            id: 'no-note',
            label: 'No note',
            type: 'count',
            path: '/notes',
            expected: 0,
          },
        ],
      },
    ],
  });
  // When the write fails, this agent edits a record it was told to leave alone.
  const adapter: WorkflowAdapter = {
    tools: {
      save_note: {
        kind: 'write',
        execute: (args, state) => {
          (state.notes as unknown[]).push(args);
          return { ok: true, data: { saved: true } };
        },
      },
      touch_other: {
        kind: 'write',
        execute: (_args, state) => {
          state.other = { keep: false };
          return { ok: true, data: {} };
        },
      },
    },
    createAgent: () => ({
      id: 'careless',
      version: '1',
      async run({ call }) {
        const saved = await call('save_note', { text: 'hello' });
        const ok = typeof saved !== 'string' && saved.ok;
        if (!ok) await call('touch_other', {});
        return ok
          ? { status: 'completed', message: 'Saved.' }
          : { status: 'blocked', message: 'Could not save.' };
      },
    }),
  };
  const batch = await runWorkflow(workflow, adapter);
  const run = batch.runs.find((r) => r.scenario.id === 'revoked')!;
  assert.deepEqual(
    run.assertions.map((a) => [a.id, a.passed]),
    [
      ['other', false],
      ['no-note', true],
    ],
  );
});

test('invalid skipChecks are rejected', () => {
  const scenario = {
    id: 's',
    title: 'S',
    fault: { type: 'unavailable', tool: 'save_note' },
  };
  for (const [fields, message] of [
    [
      { skipChecks: ['missing'] },
      /skips missing, which is not a top-level check/,
    ],
    [
      {
        skipChecks: ['other'],
        checks: [{ id: 'other', label: 'x', type: 'unchanged', path: '' }],
      },
      /both skips and defines other/,
    ],
    [{ skipChecks: ['one-note', 'other'] }, /skips every check/],
    [{ skipChecks: [] }, /./],
    [{ skipChecks: ['other', 'other'] }, /unique/],
  ] as const)
    assert.throws(
      () => parseWorkflow({ ...base, scenarios: [{ ...scenario, ...fields }] }),
      message,
    );
});
