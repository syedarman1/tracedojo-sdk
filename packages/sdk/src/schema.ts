// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { z } from 'zod';

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type State = Record<string, Json>;
const time = z.number().int().min(0).max(8_000_000_100_000_000);
export const virtualClockSchema = z.strictObject({
  mode: z.literal('virtual'),
  startMs: z.number().int().min(0).max(8_000_000_000_000_000).default(0),
  maxTimeMs: z.number().int().min(1).max(86400000).default(60000),
});
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const text = z.string().trim().min(1).max(2000);
const object = z.record(z.string(), z.json());
const pointer = z
  .string()
  .max(500)
  .regex(/^(?:\/(?:[^~]|~[01])*)*$/);

/** Validate before recursive schemas, cloning, or hashing untrusted JSON. */
export function boundedJson(value: unknown, maxBytes = 5_000_000): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  function walk(item: unknown, depth: number) {
    if (++nodes > 100000 || depth > 30)
      throw new Error('JSON is too deeply nested or too large.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item))
      throw new Error('Expected finite, acyclic JSON data.');
    if (
      !Array.isArray(item) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw new Error('Expected plain JSON objects.');
    seen.add(item);
    for (const child of Object.values(item)) walk(child, depth + 1);
    seen.delete(item);
  }
  walk(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
    throw new Error('JSON exceeds the size limit.');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const workflowFaultSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z
    .strictObject({
      type: z.literal('prompt_injection'),
      tool: name,
      occurrence: z.number().int().min(1).max(100).default(1),
      repeat: z.number().int().min(1).max(10).default(1),
      replacement: z.json().refine((value) => {
        try {
          boundedJson(value, 16000);
          return true;
        } catch {
          return false;
        }
      }, 'Injected data exceeds the size or depth limit.'),
    })
    .refine(
      (f) => f.occurrence + f.repeat - 1 <= 100,
      'Invalid fault schedule.',
    ),
  z
    .strictObject({
      type: z.enum([
        'timeout_before',
        'timeout_after',
        'unavailable',
        'malformed',
        'permission_revoked',
        'duplicate_delivery',
        'stale_read',
      ]),
      tool: name,
      occurrence: z.number().int().min(1).max(100).default(1),
      repeat: z.number().int().min(1).max(10).default(1),
    })
    .refine(
      (f) =>
        f.occurrence + f.repeat - 1 <= 100 &&
        (f.type !== 'permission_revoked' || f.repeat === 1),
      'Invalid fault schedule.',
    ),
]);
export type WorkflowFault = z.infer<typeof workflowFaultSchema>;

export const checkSchema = z.discriminatedUnion('type', [
  z.strictObject({
    id: name,
    label: text,
    type: z.literal('forbidden_tool'),
    tool: name,
  }),
  z.strictObject({
    id: name,
    label: text,
    type: z.literal('equals'),
    source: z.enum(['state', 'completion']).default('state'),
    path: pointer,
    expected: z.json(),
  }),
  z.strictObject({
    id: name,
    label: text,
    type: z.literal('count'),
    path: pointer,
    expected: z.number().int().nonnegative(),
  }),
  z.strictObject({
    id: name,
    label: text,
    type: z.literal('unchanged'),
    path: pointer,
  }),
]);
export type WorkflowCheck = z.infer<typeof checkSchema>;
const checks = z
  .array(checkSchema)
  .min(1)
  .max(50)
  .refine(
    (items) => new Set(items.map((c) => c.id)).size === items.length,
    'Check IDs must be unique.',
  );
export const workflowSchema = z
  .strictObject({
    schemaVersion: z.literal('workflow/1'),
    id: name,
    title: text,
    task: z.string().trim().min(1).max(10000),
    initialState: object,
    clock: virtualClockSchema.optional(),
    checks,
    scenarios: z
      .array(
        z.strictObject({
          id: name,
          title: text,
          fault: workflowFaultSchema,
          checks: checks.optional(),
        }),
      )
      .min(1)
      .max(10),
    limits: z
      .strictObject({
        maxToolCalls: z.number().int().min(1).max(100).default(20),
        maxRepeatedCalls: z.number().int().min(1).max(100).default(5),
        timeoutMs: z.number().int().min(1).max(60000).default(5000),
      })
      .default({ maxToolCalls: 20, maxRepeatedCalls: 5, timeoutMs: 5000 }),
  })
  .refine(
    (w) =>
      new Set(w.scenarios.map((s) => s.id)).size === w.scenarios.length &&
      w.scenarios.every((s) => s.id !== 'baseline' && s.fault.type !== 'none'),
    'Scenario IDs must be unique and cannot use the reserved baseline.',
  );
export type Workflow = z.infer<typeof workflowSchema>;
export function parseWorkflow(input: unknown): Workflow {
  boundedJson(input, 500000);
  return workflowSchema.parse(input);
}

export const completionSchema = z.strictObject({
  status: z.enum(['completed', 'blocked']),
  message: z.string().max(10000),
  output: z.json().optional(),
});
export type WorkflowCompletion = z.infer<typeof completionSchema>;
export const resultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), data: z.json() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: name,
      message: text,
      retryable: z.boolean(),
    }),
  }),
]);
export type ToolResult = z.infer<typeof resultSchema>;
export const eventSchema = z.strictObject({
  timeMs: time.optional(),
  id: name,
  sequence: z.number().int().positive(),
  kind: z.enum([
    'request',
    'model',
    'tool_call',
    'tool_result',
    'delivery',
    'mutation',
    'fault',
    'completion',
    'error',
    'limit',
  ]),
  visibility: z.enum(['agent', 'evaluator']),
  detail: z.string().max(10000),
  callId: name.optional(),
  tool: name.optional(),
  payload: z.json().optional(),
});
export type WorkflowEvent = z.infer<typeof eventSchema>;
const checkResultSchema = z.strictObject({
  id: name,
  label: text,
  passed: z.boolean(),
  detail: text,
  before: z.json().optional(),
  actual: z.json().optional(),
  expected: z.json().optional(),
  evidenceIds: z.array(name),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

function at(value: unknown, path: string): { found: boolean; value?: Json } {
  let current = value;
  if (path !== '')
    for (const key of path
      .slice(1)
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (
        !current ||
        typeof current !== 'object' ||
        !Object.hasOwn(current, key)
      )
        return { found: false };
      current = (current as Record<string, unknown>)[key];
    }
  return current === undefined
    ? { found: false }
    : { found: true, value: current as Json };
}

export function evaluateChecks(
  definitions: WorkflowCheck[],
  initial: State,
  final: State,
  completion: WorkflowCompletion | undefined,
  events: WorkflowEvent[],
): CheckResult[] {
  return definitions.map((check) => {
    if (check.type === 'forbidden_tool') {
      const attempts = events.filter(
        (event) => event.kind === 'tool_call' && event.tool === check.tool,
      );
      return {
        id: check.id,
        label: check.label,
        passed: attempts.length === 0,
        detail:
          attempts.length === 0
            ? 'No forbidden tool call was attempted.'
            : 'The agent attempted a forbidden tool call.',
        actual: attempts.length,
        expected: 0,
        evidenceIds: attempts.map((event) => event.id),
      };
    }
    const prior = at(initial, check.path);
    const observed = at(
      check.type === 'equals' && check.source === 'completion'
        ? completion
        : final,
      check.path,
    );
    const expected = check.type === 'unchanged' ? prior.value : check.expected;
    const actual =
      check.type === 'count'
        ? Array.isArray(observed.value)
          ? observed.value.length
          : undefined
        : observed.value;
    const passed =
      observed.found &&
      actual !== undefined &&
      expected !== undefined &&
      stableJson(actual) === stableJson(expected);
    return {
      id: check.id,
      label: check.label,
      passed,
      detail: !observed.found
        ? `Missing value at ${check.path || '/'}.`
        : check.type === 'count' && !Array.isArray(observed.value)
          ? `Expected an array at ${check.path || '/'}.`
          : passed
            ? 'The observed outcome matches this check.'
            : 'The observed outcome does not match this check.',
      ...(prior.found ? { before: prior.value } : {}),
      ...(actual !== undefined ? { actual } : {}),
      ...(expected !== undefined ? { expected } : {}),
      evidenceIds: events
        .filter((e) =>
          check.type === 'equals' && check.source === 'completion'
            ? e.kind === 'completion'
            : e.kind === 'mutation',
        )
        .map((e) => e.id),
    };
  });
}

export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const executionSchema = z.strictObject({
  id: z.uuid(),
  commitSha: commitShaSchema.optional(),
  trialsPerScenario: z.number().int().min(1).max(20),
  scenarioIds: z
    .array(name)
    .min(1)
    .max(10)
    .refine(
      (ids) => new Set(ids).size === ids.length && !ids.includes('baseline'),
      'Invalid planned scenario IDs.',
    ),
});

export const workflowReportSchema = z
  .strictObject({
    schemaVersion: z.literal('1'),
    reportType: z.literal('workflow'),
    id: z.string().regex(/^run_[a-f0-9-]{36}$/),
    createdAt: z.iso.datetime(),
    execution: executionSchema.optional(),
    origin: z
      .strictObject({
        kind: z.literal('imported'),
        originalId: z.string().max(100),
      })
      .optional(),
    workflow: z.strictObject({
      id: name,
      title: text,
      task: z.string().max(10000),
    }),
    suiteFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    agent: z.strictObject({ id: name, version: text }),
    scenario: z.strictObject({
      id: name,
      title: text,
      fault: workflowFaultSchema,
    }),
    status: z.enum([
      'passed',
      'failed',
      'inconclusive',
      'cancelled',
      'timed_out',
    ]),
    issue: z
      .enum([
        'agent_error',
        'tool_contract',
        'call_limit',
        'repeated_calls',
        'cancelled',
        'timed_out',
        'unawaited_calls',
        'evidence_limit',
        'initialization',
        'clock_limit',
        'clock_contract',
      ])
      .optional(),
    fault: z.strictObject({
      triggered: z.boolean(),
      triggerCount: z.number().int().min(0).max(10),
    }),
    initialState: object,
    clock: virtualClockSchema.extend({ endMs: time }).optional(),
    finalState: object,
    definitions: checks,
    assertions: z.array(checkResultSchema).min(1).max(50),
    completion: completionSchema.optional(),
    events: z.array(eventSchema).min(1).max(1000),
    metrics: z.strictObject({
      toolCalls: z.number().int().min(0).max(100),
      mutations: z.number().int().min(0).max(110),
      durationMs: z.number().nonnegative(),
    }),
  })
  .superRefine((report, ctx) => {
    const validClock = report.clock
      ? report.clock.endMs >= report.clock.startMs &&
        report.clock.endMs - report.clock.startMs <= report.clock.maxTimeMs &&
        report.events[0]?.timeMs === report.clock.startMs &&
        report.events.at(-1)?.timeMs === report.clock.endMs &&
        report.events.every(
          (event, index) =>
            event.timeMs !== undefined &&
            event.timeMs >=
              (index
                ? report.events[index - 1]!.timeMs!
                : report.clock!.startMs) &&
            event.timeMs <= report.clock!.endMs,
        )
      : report.events.every((event) => event.timeMs === undefined);
    const faultEvents = report.events.filter((e) => e.kind === 'fault');
    const validEvents = report.events.every(
      (e, i) => e.sequence === i + 1 && e.id === `evt_${i + 1}`,
    );
    const assertions = evaluateChecks(
      report.definitions,
      report.initialState,
      report.finalState,
      report.completion,
      report.events,
    );
    const expectedStatus =
      report.issue === 'cancelled' || report.issue === 'timed_out'
        ? report.issue
        : report.issue === 'call_limit' || report.issue === 'repeated_calls'
          ? 'failed'
          : report.issue ||
              (report.scenario.fault.type !== 'none' && !report.fault.triggered)
            ? 'inconclusive'
            : assertions.every((a) => a.passed)
              ? 'passed'
              : 'failed';
    if (
      !validEvents ||
      (report.execution &&
        report.scenario.id !== 'baseline' &&
        !report.execution.scenarioIds.includes(report.scenario.id)) ||
      !validClock ||
      stableJson(assertions) !== stableJson(report.assertions) ||
      expectedStatus !== report.status ||
      report.fault.triggerCount !== faultEvents.length ||
      report.fault.triggered !== faultEvents.length > 0 ||
      (report.scenario.fault.type === 'none' && report.fault.triggered) ||
      report.metrics.toolCalls !==
        report.events.filter((e) => e.kind === 'tool_call').length ||
      report.metrics.mutations !==
        report.events.filter((e) => e.kind === 'mutation').length ||
      (!report.issue && !report.completion)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Report outcomes contradict their recorded evidence.',
      });
  });
export type WorkflowReport = z.infer<typeof workflowReportSchema>;
export const workflowBatchSchema = z
  .strictObject({
    schemaVersion: z.literal('workflow-batch/1'),
    baseline: workflowReportSchema,
    runs: z.array(workflowReportSchema).max(200),
    planned: z.number().int().min(1).max(200),
    skippedReason: text.optional(),
  })
  .superRefine((batch, ctx) => {
    if (
      batch.baseline.scenario.fault.type !== 'none' ||
      (batch.baseline.execution &&
        batch.planned !==
          batch.baseline.execution.scenarioIds.length *
            batch.baseline.execution.trialsPerScenario) ||
      batch.runs.length > batch.planned ||
      (batch.runs.length < batch.planned && !batch.skippedReason) ||
      (batch.baseline.status !== 'passed' && batch.runs.length > 0) ||
      batch.runs.some(
        (r) =>
          r.suiteFingerprint !== batch.baseline.suiteFingerprint ||
          stableJson(r.execution ?? null) !==
            stableJson(batch.baseline.execution ?? null) ||
          stableJson(r.agent) !== stableJson(batch.baseline.agent) ||
          stableJson(r.clock ? [r.clock.startMs, r.clock.maxTimeMs] : null) !==
            stableJson(
              batch.baseline.clock
                ? [batch.baseline.clock.startMs, batch.baseline.clock.maxTimeMs]
                : null,
            ) ||
          r.scenario.fault.type === 'none',
      ) ||
      new Set([batch.baseline.id, ...batch.runs.map((r) => r.id)]).size !==
        batch.runs.length + 1
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Batch evidence is inconsistent.',
      });
  });
export type WorkflowBatch = z.infer<typeof workflowBatchSchema>;
export function workflowExitCode(batch: WorkflowBatch): 0 | 1 | 3 {
  if (
    batch.skippedReason ||
    [batch.baseline, ...batch.runs].some((r) =>
      ['inconclusive', 'timed_out', 'cancelled'].includes(r.status),
    )
  )
    return 3;
  return [batch.baseline, ...batch.runs].some((r) => r.status === 'failed')
    ? 1
    : 0;
}
