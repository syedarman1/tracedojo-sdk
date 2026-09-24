// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { z } from 'zod';
import { boundedJson, type Json } from './schema.js';
import { sanitizeJson } from './privacy.js';

const runSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  run_type: z.string().max(50),
  parent_run_id: z.string().max(100).nullable().optional(),
  trace_id: z.string().max(100).optional(),
  start_time: z.iso.datetime({ offset: true }).optional(),
  inputs: z.record(z.string(), z.json()).default({}),
  outputs: z.json().optional(),
  error: z.string().nullable().optional(),
  child_runs: z.array(z.unknown()).optional(),
});
type Run = z.infer<typeof runSchema>;
export interface LangSmithDraft {
  schemaVersion: 'workflow-draft/1';
  status: 'needs_review';
  source: {
    provider: 'langsmith';
    traceId: string;
    rootRunId: string;
    name: string;
  };
  taskCandidate: string;
  observedCalls: {
    id: string;
    name: string;
    inputs: Record<string, Json>;
    outputs?: Json;
    error?: string;
  }[];
  required: string[];
}

/** Accept a single nested run or a listRuns export containing one complete trace. */
export function importLangSmithTrace(input: unknown): LangSmithDraft {
  boundedJson(input);
  const runs: Run[] = [];
  const visit = (value: unknown) => {
    if (runs.length >= 500)
      throw new Error('Import at most 500 spans from one trace.');
    const run = runSchema.parse(value);
    runs.push(run);
    for (const child of run.child_runs ?? []) visit(child);
  };
  const entries = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && 'runs' in input
      ? (input as { runs: unknown }).runs
      : [input];
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Choose a LangSmith JSON export containing one trace.');
  entries.forEach(visit);
  const ids = new Set(runs.map((r) => r.id));
  if (ids.size !== runs.length)
    throw new Error(
      'The export contains duplicate spans. Export one complete trace.',
    );
  const roots = runs.filter((r) => !r.parent_run_id);
  if (roots.length !== 1)
    throw new Error('Export one complete trace with exactly one root run.');
  const root = roots[0]!;
  const traceId = root.trace_id ?? root.id;
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const run of runs) {
    if (run.trace_id && run.trace_id !== traceId)
      throw new Error('The export mixes different traces.');
    const visited = new Set<string>();
    let current = run;
    while (current.parent_run_id) {
      if (visited.has(current.id))
        throw new Error('The trace contains a parent cycle.');
      visited.add(current.id);
      const parent = byId.get(current.parent_run_id);
      if (!parent)
        throw new Error('The trace is incomplete: a parent span is missing.');
      current = parent;
    }
    if (current.id !== root.id)
      throw new Error('The export contains disconnected spans.');
  }
  const calls = runs.filter((r) => r.run_type === 'tool');
  // With missing timestamps, retain export order instead of ordering by opaque IDs.
  if (calls.every((call) => call.start_time))
    calls.sort((a, b) => Date.parse(a.start_time!) - Date.parse(b.start_time!));
  if (!calls.length)
    throw new Error(
      'No tool calls found. Export a complete agent trace including tool spans.',
    );
  const candidate = [
    root.inputs.task,
    root.inputs.input,
    root.inputs.question,
  ].find((v) => typeof v === 'string');
  const draft: LangSmithDraft = {
    schemaVersion: 'workflow-draft/1',
    status: 'needs_review',
    source: {
      provider: 'langsmith',
      traceId,
      rootRunId: root.id,
      name: root.name,
    },
    taskCandidate: typeof candidate === 'string' ? candidate : '',
    observedCalls: calls.map((r) => ({
      id: r.id,
      name: r.name,
      inputs: r.inputs,
      ...(r.outputs !== undefined ? { outputs: r.outputs } : {}),
      ...(r.error ? { error: r.error } : {}),
    })),
    required: [
      'Review the task and tool inputs; recorded outputs are observations, not expected outcomes.',
      'Supply starting state and isolated simulated tool implementations.',
      'Define outcome checks and choose which tool failure to inject.',
    ],
  };
  const sanitized = sanitizeJson(draft) as unknown as LangSmithDraft;
  if (
    new Set(calls.map((call) => call.name)).size !==
    new Set(sanitized.observedCalls.map((call) => call.name)).size
  )
    throw new Error(
      'Redaction would merge distinct tool names. Rename them before export.',
    );
  return sanitized;
}

/** Observed JSON shapes only; these do not prove a tool's complete API contract. */
function observedShape(values: Json[]): Json {
  if (!values.length) return {};
  const groups = new Map<string, Json[]>();
  for (const value of values) {
    const type =
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    groups.set(type, [...(groups.get(type) ?? []), value]);
  }
  if (groups.size > 1)
    return { anyOf: [...groups.values()].map(observedShape) };
  const type = [...groups.keys()][0]!;
  if (type === 'object') {
    const objects = values as Record<string, Json>[];
    const keys = [...new Set(objects.flatMap(Object.keys))].sort();
    return {
      type,
      properties: Object.fromEntries(
        keys.map((key) => [
          key,
          observedShape(
            objects
              .filter((obj) => Object.hasOwn(obj, key))
              .map((obj) => obj[key]!),
          ),
        ]),
      ),
      required: keys.filter((key) =>
        objects.every((obj) => Object.hasOwn(obj, key)),
      ),
    };
  }
  if (type === 'array')
    return { type, items: observedShape((values as Json[][]).flat()) };
  return { type };
}

export function inferToolSignatures(draft: LangSmithDraft) {
  return [...new Set(draft.observedCalls.map((call) => call.name))].map(
    (name, index) => {
      const calls = draft.observedCalls.filter((call) => call.name === name);
      return {
        name,
        alias: `tool_${index + 1}`,
        status: 'observed_only' as const,
        inputs: observedShape(calls.map((call) => call.inputs)),
        outputs: observedShape(
          calls
            .filter((call) => call.outputs !== undefined)
            .map((call) => call.outputs!),
        ),
        samples: calls.length,
      };
    },
  );
}
