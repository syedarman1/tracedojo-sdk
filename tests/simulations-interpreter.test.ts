// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTools } from '../packages/sdk/src/simulations.js';
import { parseSimulation } from '../packages/sdk/src/simulation-schema.js';
import type { Json, SimulatedTool, State } from '../packages/sdk/src/index.js';
import { minimalSpec } from './fixtures/notes-spec.js';

const context = {
  signal: new AbortController().signal,
  clock: { now: () => 0, sleep: async () => {} },
};

/** Mirror the runner: each call works on a draft; only successful writes commit. */
async function call(
  tools: Record<string, SimulatedTool>,
  name: string,
  args: Record<string, Json>,
  state: State,
) {
  const draft = structuredClone(state);
  const result = await tools[name]!.execute(structuredClone(args), draft, context);
  return { result, state: result.ok ? draft : state, draft };
}

function withTools(extra: Record<string, unknown>, state?: State) {
  const spec = minimalSpec();
  Object.assign(spec.tools, extra);
  if (state) spec.state = { ...spec.state, ...state };
  return parseSimulation(spec);
}

const objectInput = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

test('insert then find', async () => {
  const tools = buildTools(parseSimulation(minimalSpec()));
  let state: State = structuredClone(minimalSpec().state);
  const created = await call(tools, 'create_note', { title: 'Hello' }, state);
  assert.deepEqual(created.result, { ok: true, data: { id: 'note_1', title: 'Hello' } });
  state = created.state;
  assert.equal((state.notes as Json[]).length, 1);
  assert.deepEqual(state._sim, { seq: { note: 1 }, idempotency: [] });
  const read = await call(tools, 'get_note', { id: 'note_1' }, state);
  assert.deepEqual(read.result, { ok: true, data: { id: 'note_1', title: 'Hello' } });
  assert.deepEqual(read.draft, state);
  const missing = await call(tools, 'get_note', { id: 'note_9' }, state);
  assert.deepEqual(missing.result, {
    ok: false,
    error: { code: 'not_found', message: 'No note note_9.', retryable: false },
  });
});

test('unique conflict returns conflict error', async () => {
  const tools = buildTools(parseSimulation(minimalSpec()));
  const first = await call(tools, 'create_note', { title: 'Hello' }, minimalSpec().state);
  const second = await call(tools, 'create_note', { title: 'Hello' }, first.state);
  assert.deepEqual(second.result, {
    ok: false,
    error: { code: 'duplicate', message: 'Title Hello exists.', retryable: false },
  });
  assert.equal((second.state.notes as Json[]).length, 1);
  // The runner rejects failed calls that change their draft, even a counter.
  assert.deepEqual(second.draft, first.state);
});

test('idempotent replay returns same response and no second record', async () => {
  const tools = buildTools(parseSimulation(minimalSpec()));
  const first = await call(tools, 'create_note', { title: 'Hello', key: 'k1' }, minimalSpec().state);
  const again = await call(tools, 'create_note', { title: 'Hello', key: 'k1' }, first.state);
  assert.deepEqual(again.result, first.result);
  assert.equal((again.state.notes as Json[]).length, 1);
  assert.deepEqual(again.draft, first.state);
});

test('idempotency key reuse with different args returns conflict', async () => {
  const tools = buildTools(parseSimulation(minimalSpec()));
  const first = await call(tools, 'create_note', { title: 'Hello', key: 'k1' }, minimalSpec().state);
  const reused = await call(tools, 'create_note', { title: 'Other', key: 'k1' }, first.state);
  assert.deepEqual(reused.result, {
    ok: false,
    error: { code: 'duplicate', message: 'Title Other exists.', retryable: false },
  });
});

test('require return yields ok data without change', async () => {
  const spec = withTools({
    check_note: {
      kind: 'read',
      description: 'GraphQL-style lookup',
      input: objectInput({ id: { type: 'string' } }, ['id']),
      invalid: 'invalid',
      steps: [
        { find: 'notes', where: { $eq: [{ $: 'item.id' }, { $: 'args.id' }] }, as: 'note' },
        {
          require: { $ne: [{ $: 'note' }, null] },
          return: { note: null, userErrors: [{ field: ['id'], message: 'Note not found' }] },
        },
        { return: { note: { $: 'note' }, userErrors: [] } },
      ],
    },
  });
  const tools = buildTools(spec);
  const result = await call(tools, 'check_note', { id: 'nope' }, spec.state);
  assert.deepEqual(result.result, {
    ok: true,
    data: { note: null, userErrors: [{ field: ['id'], message: 'Note not found' }] },
  });
  assert.deepEqual(result.draft, spec.state);
});

test('filters operator, ordering and limit', async () => {
  const spec = withTools(
    {
      search_notes: {
        kind: 'read',
        description: 'Search',
        input: objectInput(
          {
            filters: {
              type: 'array',
              items: objectInput(
                {
                  column: { type: 'string' },
                  op: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is'] },
                  value: { type: 'any' },
                },
                ['column', 'op', 'value'],
              ),
            },
            limit: { type: 'integer', minimum: 1, maximum: 10 },
          },
          ['filters'],
        ),
        invalid: 'invalid',
        steps: [
          {
            filter: 'notes',
            where: { $filters: [{ $: 'item' }, { $: 'args.filters' }] },
            as: 'found',
            order: { by: 'rank', desc: true },
            limit: { $coalesce: [{ $: 'args.limit' }, 10] },
          },
          {
            return: {
              count: { $len: { $: 'found' } },
              ids: { $map: [{ $: 'found' }, { $: 'item.id' }] },
            },
          },
        ],
      },
    },
    {
      notes: [
        { id: 'a', title: 'A', rank: 1, tag: 'x' },
        { id: 'b', title: 'B', rank: 5, tag: 'y' },
        { id: 'c', title: 'C', rank: 3, tag: null },
      ],
    },
  );
  const tools = buildTools(spec);
  const gte = await call(tools, 'search_notes', { filters: [{ column: 'rank', op: 'gte', value: 3 }] }, spec.state);
  assert.deepEqual(gte.result, { ok: true, data: { count: 2, ids: ['b', 'c'] } });
  const inList = await call(
    tools,
    'search_notes',
    { filters: [{ column: 'id', op: 'in', value: ['a', 'c'] }], limit: 1 },
    spec.state,
  );
  assert.deepEqual(inList.result, { ok: true, data: { count: 1, ids: ['c'] } });
  const isNull = await call(tools, 'search_notes', { filters: [{ column: 'tag', op: 'is', value: null }] }, spec.state);
  assert.deepEqual(isNull.result, { ok: true, data: { count: 1, ids: ['c'] } });
});

test('updateWhere and deleteWhere bind counts', async () => {
  const spec = withTools(
    {
      archive: {
        kind: 'write',
        description: 'Archive by tag',
        input: objectInput({ tag: { type: 'string' } }, ['tag']),
        invalid: 'invalid',
        steps: [
          {
            updateWhere: 'notes',
            where: { $eq: [{ $: 'item.tag' }, { $: 'args.tag' }] },
            set: { archived: true, rank: { $add: [{ $: 'item.rank' }, 10] } },
            as: 'updated',
          },
          { deleteWhere: 'notes', where: { $eq: [{ $: 'item.tag' }, null] }, as: 'deleted' },
          { return: { updated: { $: 'updated' }, deleted: { $: 'deleted' }, at: { $time: true } } },
        ],
      },
    },
    {
      notes: [
        { id: 'a', rank: 1, tag: 'x' },
        { id: 'b', rank: 2, tag: 'x' },
        { id: 'c', rank: 3, tag: null },
      ],
    },
  );
  const tools = buildTools(spec);
  const result = await call(tools, 'archive', { tag: 'x' }, spec.state);
  assert.deepEqual(result.result, { ok: true, data: { updated: 2, deleted: 1, at: 1700000000 } });
  assert.deepEqual(result.state.notes, [
    { id: 'a', rank: 11, tag: 'x', archived: true },
    { id: 'b', rank: 12, tag: 'x', archived: true },
  ]);
});

test('rejects prototype keys and extra fields', async () => {
  const tools = buildTools(parseSimulation(minimalSpec()));
  const state = minimalSpec().state;
  const polluted = JSON.parse('{"title":"x","__proto__":{"polluted":1}}');
  const result = await call(tools, 'create_note', polluted, state);
  assert.equal(result.result.ok, false);
  assert.equal(!result.result.ok && result.result.error.code, 'invalid_request');
  assert.equal(!result.result.ok && result.result.error.message, 'Invalid __proto__.');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const extra = await call(tools, 'create_note', { title: 'x', color: 'red' }, state);
  assert.equal(!extra.result.ok && extra.result.error.message, 'Invalid color.');
  const wrongType = await call(tools, 'create_note', { title: 5 }, state);
  assert.equal(!wrongType.result.ok && wrongType.result.error.message, 'Invalid title.');
  const missing = await call(tools, 'create_note', {}, state);
  assert.equal(!missing.result.ok && missing.result.error.message, 'Invalid title.');
});

test('missing collection returns SIMULATION_STATE', async () => {
  const tools = buildTools(parseSimulation(minimalSpec()));
  const result = await call(tools, 'create_note', { title: 'x' }, {});
  assert.equal(!result.result.ok && result.result.error.code, 'SIMULATION_STATE');
  assert.equal(!result.result.ok && result.result.error.retryable, false);
});

test('step limit stops runaway specs', async () => {
  const spec = withTools({
    spin: {
      kind: 'read',
      description: 'Nested loops',
      input: objectInput({ items: { type: 'array', items: { type: 'integer' }, maxItems: 100 } }, ['items']),
      invalid: 'invalid',
      steps: [
        {
          each: { $: 'args.items' },
          as: 'a',
          do: [{ each: { $: 'args.items' }, as: 'b', do: [{ let: { c: 1 } }] }],
        },
        { return: null },
      ],
    },
  });
  const tools = buildTools(spec);
  const items = Array.from({ length: 100 }, (_, i) => i);
  await assert.rejects(
    async () => tools.spin!.execute({ items }, structuredClone(spec.state), context),
    /step limit/,
  );
});

test('integer-only arithmetic', async () => {
  const spec = withTools({
    half: {
      kind: 'read',
      description: 'Math',
      input: objectInput({ n: { type: 'number' } }, ['n']),
      invalid: 'invalid',
      steps: [{ return: { $add: [{ $: 'args.n' }, 1] } }],
    },
  });
  const tools = buildTools(spec);
  assert.deepEqual(await tools.half!.execute({ n: 2 }, structuredClone(spec.state), context), {
    ok: true,
    data: 3,
  });
  await assert.rejects(
    async () => tools.half!.execute({ n: 1.5 }, structuredClone(spec.state), context),
    /integers/,
  );
});

// ---- Scripted reference agents ----
import { loadSimulation } from '../packages/sdk/src/simulations.js';
import { runWorkflow, type ToolResult } from '../packages/sdk/src/index.js';

function scripted(script: unknown, responses: Record<string, (ToolResult | string)[]>) {
  const spec = minimalSpec();
  spec.agent.fixed = script;
  const agent = loadSimulation(spec).createAgent('fixed');
  const calls: { tool: string; args: Record<string, Json> }[] = [];
  const run = agent.run({
    task: spec.workflow.task,
    signal: new AbortController().signal,
    clock: context.clock,
    recordModel() {},
    async call(tool, args) {
      calls.push({ tool, args });
      const next = responses[tool]!.shift();
      if (next === undefined) throw new Error(`no response left for ${tool}`);
      return next;
    },
  });
  return { run, calls };
}
const ok = (data: Json): ToolResult => ({ ok: true, data });
const retryable: ToolResult = {
  ok: false,
  error: { code: 'TIMEOUT', message: 'Timed out.', retryable: true },
};

test('fixed script retries retryable errors and truncated responses', async () => {
  const { run, calls } = scripted(
    {
      steps: [{ call: 'create_note', args: { title: 'Hi', key: 'k-{{attempt}}' }, attempts: 3, save: 'note' }],
      output: '{{saved.note}}',
      message: 'Done.',
    },
    { create_note: [retryable, '{"ok":true,"data":', ok({ id: 'note_1' })] },
  );
  assert.deepEqual(await run, { status: 'completed', message: 'Done.', output: { id: 'note_1' } });
  assert.deepEqual(calls.map((c) => c.args.key), ['k-1', 'k-2', 'k-3']);
});

test('beforeRetry match skips retry', async () => {
  const { run, calls } = scripted(
    {
      steps: [
        {
          call: 'create_note',
          args: { title: 'Hi' },
          attempts: 3,
          save: 'note',
          beforeRetry: {
            call: 'get_note',
            args: { id: 'note_1' },
            find: { path: '/items', where: { title: 'Hi' } },
          },
        },
      ],
      output: { id: '{{saved.note.id}}', label: 'note {{saved.note.id}}' },
      message: 'Done.',
    },
    {
      create_note: [retryable],
      get_note: [ok({ items: [{ id: 'note_0', title: 'Other' }, { id: 'note_1', title: 'Hi' }] })],
    },
  );
  assert.deepEqual(await run, {
    status: 'completed',
    message: 'Done.',
    output: { id: 'note_1', label: 'note note_1' },
  });
  assert.deepEqual(calls.map((c) => c.tool), ['create_note', 'get_note']);
});

test('until rereads, and gives up as blocked', async () => {
  const until = {
    steps: [{ call: 'get_note', args: { id: 'n' }, attempts: 2, save: 'n', until: { path: '/status', equals: 'done' } }],
    output: '{{saved.n}}',
    message: 'Seen.',
  };
  const good = scripted(until, { get_note: [ok({ status: 'old' }), ok({ status: 'done' })] });
  assert.deepEqual(await good.run, { status: 'completed', message: 'Seen.', output: { status: 'done' } });
  const bad = scripted(until, { get_note: [ok({ status: 'old' }), ok({ status: 'old' })] });
  assert.equal((await bad.run).status, 'blocked');
});

test('non-retryable error blocks with its message', async () => {
  const { run, calls } = scripted(
    { steps: [{ call: 'create_note', args: { title: 'Hi' }, attempts: 3 }], message: 'Done.' },
    { create_note: [{ ok: false, error: { code: 'PERMISSION_DENIED', message: 'Revoked.', retryable: false } }] },
  );
  assert.deepEqual(await run, { status: 'blocked', message: 'Revoked.' });
  assert.equal(calls.length, 1);
});

test('fixed agent passes and broken agent fails the bug scenario', async () => {
  const sim = loadSimulation(minimalSpec());
  const fixed = await runWorkflow(sim.workflow(), { tools: sim.tools, createAgent: () => sim.createAgent('fixed') });
  assert.equal(fixed.baseline.status, 'passed');
  assert.deepEqual(fixed.runs.map((r) => r.status), ['passed']);
  const broken = await runWorkflow(sim.workflow(), { tools: sim.tools, createAgent: () => sim.createAgent('broken') });
  assert.equal(broken.baseline.status, 'passed');
  assert.equal(broken.runs[0]!.status, 'failed');
  assert.equal(broken.runs[0]!.scenario.id, sim.spec.agent.bugScenario);
  assert.equal(sim.createAgent('fixed').id, 'notes-reference');
  assert.equal(sim.createAgent('broken').version, 'broken-1');
});

test('loadSimulation rejects unknown ids', () => {
  assert.throws(() => loadSimulation('../etc/passwd'), /Unknown simulation/);
  assert.throws(() => loadSimulation('nope'), /Unknown simulation/);
});

test('per-reason invalid errors and floor division', async () => {
  const spec = minimalSpec();
  spec.errors.missing_param = { code: 'parameter_missing', message: 'Missing required param: {{field}}.', status: 400, retryable: false, verified: true };
  spec.errors.unknown_param = { code: 'parameter_unknown', message: 'Received unknown parameter: {{field}}', status: 400, retryable: false, verified: true };
  spec.errors.bad_type = { code: 'invalid_request_error', message: 'Invalid {{field}}: {{value}}', status: 400, retryable: false, verified: true };
  spec.tools.money = {
    kind: 'read',
    description: 'Format cents',
    input: objectInput({ cents: { type: 'integer' } }, ['cents']),
    invalid: { missing: 'missing_param', unknown: 'unknown_param', type: 'bad_type' },
    steps: [
      {
        return: {
          $concat: ['$', { $div: [{ $: 'args.cents' }, 100] }, '.', { $pad: [{ $mod: [{ $: 'args.cents' }, 100] }, 2] }],
        },
      },
    ],
  };
  const tools = buildTools(parseSimulation(spec));
  const state = spec.state;
  assert.deepEqual((await call(tools, 'money', { cents: 1205 }, state)).result, { ok: true, data: '$12.05' });
  assert.deepEqual((await call(tools, 'money', {}, state)).result, {
    ok: false,
    error: { code: 'parameter_missing', message: 'Missing required param: cents.', retryable: false },
  });
  assert.deepEqual((await call(tools, 'money', { cents: 1, x: 2 }, state)).result, {
    ok: false,
    error: { code: 'parameter_unknown', message: 'Received unknown parameter: x', retryable: false },
  });
  assert.deepEqual((await call(tools, 'money', { cents: 'ten' }, state)).result, {
    ok: false,
    error: { code: 'invalid_request_error', message: 'Invalid cents: ten', retryable: false },
  });
  assert.deepEqual((await call(tools, 'money', { cents: -7 }, state)).result, { ok: true, data: '$-1.93' });
});

test('dynamic collections, $type and $keys', async () => {
  const spec = withTools({
    describe_rows: {
      kind: 'read',
      description: 'Generic table read',
      input: objectInput({ table: { type: 'string' }, sample: { type: 'any' } }, ['table', 'sample']),
      invalid: 'invalid',
      steps: [
        { require: { $in: [{ $: 'args.table' }, ['notes']] }, error: 'missing' },
        { filter: { $: 'args.table' }, where: true, as: 'rows' },
        {
          return: {
            count: { $len: { $: 'rows' } },
            type: { $type: { $: 'args.sample' } },
            keys: { $if: [{ $eq: [{ $type: { $: 'args.sample' } }, 'object'] }, { $keys: { $: 'args.sample' } }, null] },
          },
        },
      ],
    },
  }, { notes: [{ id: 'a' }] });
  const tools = buildTools(spec);
  const read = (args: Record<string, Json>) => call(tools, 'describe_rows', args, spec.state);
  assert.deepEqual((await read({ table: 'notes', sample: { b: 1, a: 2 } })).result, {
    ok: true,
    data: { count: 1, type: 'object', keys: ['b', 'a'] },
  });
  for (const [sample, type] of [[null, 'null'], [1, 'integer'], [1.5, 'number'], ['x', 'string'], [[1], 'array'], [true, 'boolean']] as const)
    assert.equal(((await read({ table: 'notes', sample })).result as any).data.type, type);
  assert.equal((await read({ table: 'other', sample: 1 })).result.ok, false);
  const unguarded = withTools({
    raw: {
      kind: 'read',
      description: 'Unguarded',
      input: objectInput({ table: { type: 'string' } }, ['table']),
      invalid: 'invalid',
      steps: [{ filter: { $: 'args.table' }, where: true, as: 'rows' }, { return: null }],
    },
  });
  await assert.rejects(
    async () => buildTools(unguarded).raw!.execute({ table: 'other' }, structuredClone(unguarded.state), context),
    /guard it with require/,
  );
});

test('beforeRetry matches a single resource', async () => {
  const { run } = scripted(
    {
      steps: [
        {
          call: 'create_note',
          args: { title: 'Hi' },
          attempts: 2,
          save: 'note',
          beforeRetry: { call: 'get_note', args: { id: 'note_1' }, find: { path: '', where: { title: 'Hi' } } },
        },
      ],
      output: '{{saved.note.id}}',
      message: 'Done.',
    },
    { create_note: [retryable], get_note: [ok({ id: 'note_1', title: 'Hi' })] },
  );
  assert.deepEqual(await run, { status: 'completed', message: 'Done.', output: 'note_1' });
});

test('$filter and $isotime', async () => {
  const spec = withTools({
    labels: {
      kind: 'read',
      description: 'Remove labels',
      input: objectInput({ labels: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, ['labels', 'remove']),
      invalid: 'invalid',
      steps: [
        {
          return: {
            kept: { $filter: [{ $: 'args.labels' }, { $not: { $in: [{ $: 'item' }, { $: 'args.remove' }] } }] },
            at: { $isotime: true },
          },
        },
      ],
    },
  });
  const result = await call(buildTools(spec), 'labels', { labels: ['INBOX', 'UNREAD', 'STARRED'], remove: ['UNREAD'] }, spec.state);
  assert.deepEqual(result.result, { ok: true, data: { kept: ['INBOX', 'STARRED'], at: '2023-11-14T22:13:20Z' } });
});

test('idempotency conflict can be returned as data', async () => {
  const spec = minimalSpec();
  spec.tools.create_note.idempotency.conflict = {
    return: { note: null, userErrors: [{ code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH', field: ['key'] }] },
  };
  const tools = buildTools(parseSimulation(spec));
  const first = await call(tools, 'create_note', { title: 'A', key: 'k' }, spec.state);
  const second = await call(tools, 'create_note', { title: 'B', key: 'k' }, first.state);
  assert.deepEqual(second.result, {
    ok: true,
    data: { note: null, userErrors: [{ code: 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH', field: ['key'] }] },
  });
  assert.deepEqual(second.draft, first.state);
});
