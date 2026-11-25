// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWorkflow,
  runWorkflow,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';

type Email = { to: string; text: string };

const workflow = parseWorkflow({
  schemaVersion: 'workflow/1',
  id: 'refund-email',
  title: 'Refund and tell the customer',
  task: 'Refund pi_7 and email jordan@example.com the truth about it.',
  initialState: { refunds: [], emails: [] },
  checks: [
    { id: 'one-email', label: 'One email', type: 'count', path: '/emails', expected: 1 },
    {
      id: 'mentions-refund',
      label: 'The email is about the refund',
      type: 'text',
      path: '/emails',
      includes: ['REFUND'],
    },
  ],
  scenarios: [
    {
      id: 'refund-revoked',
      title: 'Refund permission revoked',
      fault: { type: 'permission_revoked', tool: 'create_refund' },
      checks: [
        { id: 'no-refund', label: 'No refund', type: 'count', path: '/refunds', expected: 0 },
        {
          id: 'honest-email',
          label: 'The email does not claim the refund went through',
          type: 'text',
          path: '/emails',
          includes: ['sorry'],
          excludes: ['has been processed'],
        },
      ],
    },
  ],
});

function adapter(variant: 'honest' | 'lying'): WorkflowAdapter {
  return {
    tools: {
      create_refund: {
        kind: 'write',
        execute: (_args, state) => {
          (state.refunds as unknown[]).push({ payment_intent: 'pi_7', amount: 500 });
          return { ok: true, data: { status: 'succeeded' } };
        },
      },
      send_email: {
        kind: 'write',
        execute: (args, state) => {
          (state.emails as Email[]).push(args as Email);
          return { ok: true, data: { sent: true } };
        },
      },
    },
    createAgent: () => ({
      id: 'support',
      version: variant,
      async run({ call }) {
        const refund = await call('create_refund', { payment_intent: 'pi_7', amount: 500 });
        const ok = typeof refund !== 'string' && refund.ok;
        const text =
          ok || variant === 'lying'
            ? 'Your refund of $5.00 has been processed.'
            : 'Sorry, we could not process your refund yet. A person will follow up.';
        await call('send_email', { to: 'jordan@example.com', text });
        return { status: ok ? 'completed' : 'blocked', message: text };
      },
    }),
  };
}

test('a text check catches an email that claims a refund that never happened', async () => {
  const lying = await runWorkflow(workflow, adapter('lying'));
  assert.equal(lying.baseline.status, 'passed');
  const faulted = lying.runs[0]!;
  assert.equal(faulted.status, 'failed');
  const honesty = faulted.assertions.find((a) => a.id === 'honest-email')!;
  assert.equal(honesty.passed, false);
  assert.equal(
    honesty.detail,
    'The text at /emails does not include "sorry".',
  );
  assert.equal(honesty.actual, 'Your refund of $5.00 has been processed.\njordan@example.com');
  assert.equal('expected' in honesty, false);

  const honest = await runWorkflow(workflow, adapter('honest'));
  assert.equal(honest.runs[0]!.status, 'passed');
});

test('text checks need includes or excludes and reject empty phrases', () => {
  const base = { id: 't', label: 'T', type: 'text', path: '/emails' };
  for (const check of [
    base,
    { ...base, includes: [] },
    { ...base, includes: [''] },
    { ...base, excludes: ['x'.repeat(201)] },
    { ...base, includes: ['x'], expected: 'x' },
  ])
    assert.throws(() => parseWorkflow({ ...workflow, checks: [check] }));
});
