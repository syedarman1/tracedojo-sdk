// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { z } from 'zod';
import { boundedJson, isModelFault, workflowSchema, type Json } from './schema.js';

/**
 * simulation/1: a language-neutral, declarative description of a stateful
 * service. Everything here is JSON data so every TraceDojo SDK can run it.
 */
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const ident = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/)
  .refine((v) => !RESERVED.has(v), 'Reserved name.');
const RESERVED = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'args',
  'item',
  '_sim',
]);
const text = z.string().trim().min(1).max(2000);
const pointer = z
  .string()
  .max(500)
  .regex(/^(?:\/(?:[^~]|~[01])*)*$/);
const expr = z.json();
const safeKeys = <T extends z.ZodType>(value: T) =>
  z
    .record(z.string(), value)
    .refine(
      (r) => Object.keys(r).every((k) => !RESERVED_KEYS.has(k)),
      'Reserved key.',
    );
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** A declared collection, or {"$": path} naming one at runtime (guard it first). */
const collectionName = z.union([ident, z.strictObject({ $: z.string().min(1) })]);
export type CollectionRef = string | { $: string };

export const OPERATORS = [
  '$',
  '$literal',
  '$add',
  '$sub',
  '$mul',
  '$div',
  '$mod',
  '$min',
  '$max',
  '$eq',
  '$ne',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$and',
  '$or',
  '$not',
  '$if',
  '$coalesce',
  '$len',
  '$in',
  '$pick',
  '$merge',
  '$map',
  '$filter',
  '$concat',
  '$pad',
  '$lower',
  '$type',
  '$keys',
  '$seq',
  '$time',
  '$isotime',
  '$filters',
] as const;

type InputSchema =
  | {
      type: 'object';
      properties: Record<string, InputSchema>;
      required?: string[];
      additionalProperties: false;
    }
  | {
      type: 'string';
      enum?: string[];
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    }
  | {
      type: 'integer' | 'number';
      enum?: number[];
      minimum?: number;
      maximum?: number;
    }
  | { type: 'boolean' }
  | {
      type: 'array';
      items: InputSchema;
      minItems?: number;
      maxItems?: number;
    }
  | { type: 'any' };

const objectInput: z.ZodType<Extract<InputSchema, { type: 'object' }>> =
  z.lazy(() =>
    z.strictObject({
      type: z.literal('object'),
      properties: safeKeys(inputSchema),
      required: z.array(z.string()).optional(),
      additionalProperties: z.literal(false),
    }),
  );
export const inputSchema: z.ZodType<InputSchema> = z.lazy(() =>
  z.union([
    objectInput,
    z.strictObject({
      type: z.literal('string'),
      enum: z.array(z.string()).min(1).optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      // Anchored patterns built from a portable subset (no lookaround or backreferences).
      pattern: z
        .string()
        .regex(/^\^[^]*\$$/)
        .refine((p) => !/\(\?|\\[1-9]|\\k/.test(p), 'Unsupported pattern.')
        .optional(),
    }),
    z.strictObject({
      type: z.enum(['integer', 'number']),
      enum: z.array(z.number()).min(1).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    }),
    z.strictObject({ type: z.literal('boolean') }),
    z.strictObject({
      type: z.literal('array'),
      items: inputSchema,
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).max(1000).optional(),
    }),
    z.strictObject({ type: z.literal('any') }),
  ]),
);

export type Step =
  | { let: Record<string, Json> }
  | { require: Json; error: string }
  | { require: Json; return: Json }
  | { find: CollectionRef; where: Json; as: string; missing?: string }
  | {
      filter: CollectionRef;
      where: Json;
      as: string;
      limit?: Json;
      order?: { by: string; desc?: boolean };
    }
  | { insert: CollectionRef; value: Json; as?: string }
  | { update: string; set: Record<string, Json> }
  | { updateWhere: CollectionRef; where: Json; set: Record<string, Json>; as?: string }
  | { deleteWhere: CollectionRef; where: Json; as?: string }
  | { if: Json; then: Step[]; else?: Step[] }
  | { each: Json; as: string; do: Step[] }
  | { fail: string }
  | { return: Json };

const steps: z.ZodType<Step[]> = z.lazy(() => z.array(step).min(1).max(100));
export const step: z.ZodType<Step> = z.lazy(() =>
  z.union([
    z.strictObject({ let: safeKeys(expr) }),
    z.strictObject({ require: expr, error: name }),
    z.strictObject({ require: expr, return: expr }),
    z.strictObject({
      find: collectionName,
      where: expr,
      as: ident,
      missing: name.optional(),
    }),
    z.strictObject({
      filter: collectionName,
      where: expr,
      as: ident,
      limit: expr.optional(),
      order: z
        .strictObject({ by: z.string().min(1), desc: z.boolean().optional() })
        .optional(),
    }),
    z.strictObject({ insert: collectionName, value: expr, as: ident.optional() }),
    z.strictObject({ update: ident, set: safeKeys(expr) }),
    z.strictObject({
      updateWhere: collectionName,
      where: expr,
      set: safeKeys(expr),
      as: ident.optional(),
    }),
    z.strictObject({ deleteWhere: collectionName, where: expr, as: ident.optional() }),
    z.strictObject({ if: expr, then: steps, else: steps.optional() }),
    z.strictObject({ each: expr, as: ident, do: steps }),
    z.strictObject({ fail: name }),
    z.strictObject({ return: expr }),
  ]),
);

const errorDefinition = z.strictObject({
  code: name,
  message: text,
  status: z.number().int().min(100).max(599),
  retryable: z.boolean(),
  verified: z.boolean(),
});

/** One error for every invalid input, or one per reason. */
const invalidErrors = z.union([
  name,
  z.strictObject({ missing: name, unknown: name, type: name }),
]);
const toolDefinition = z.strictObject({
  kind: z.enum(['read', 'write']),
  description: text,
  input: objectInput,
  invalid: invalidErrors,
  idempotency: z
    .strictObject({
      arg: z.string().min(1),
      /** An error name, or {"return": expr} for APIs that report conflicts as data (GraphQL userErrors). */
      conflict: z.union([name, z.strictObject({ return: expr })]),
    })
    .optional(),
  steps,
});

const scriptStep = z.strictObject({
  call: name,
  args: safeKeys(z.json()),
  save: ident.optional(),
  attempts: z.number().int().min(1).max(5).default(1),
  beforeRetry: z
    .strictObject({
      call: name,
      args: safeKeys(z.json()),
      find: z.strictObject({ path: pointer, where: safeKeys(z.json()) }),
    })
    .optional(),
  until: z.strictObject({ path: pointer, equals: z.json() }).optional(),
});
export const scriptSchema = z.strictObject({
  steps: z.array(scriptStep).min(1).max(20),
  output: z.json().optional(),
  message: text,
});
export type Script = z.infer<typeof scriptSchema>;

export const simulationSchema = z.strictObject({
  schemaVersion: z.literal('simulation/1'),
  id: name,
  title: text,
  api: z.strictObject({
    name: text,
    version: text,
    docs: z.url(),
  }),
  epoch: z.number().int().min(0).max(4_000_000_000),
  collections: safeKeys(
    z.strictObject({
      unique: z.array(z.array(z.string().min(1)).min(1)).default([]),
      conflict: name.optional(),
    }),
  ),
  state: safeKeys(z.json()),
  errors: safeKeys(errorDefinition),
  tools: safeKeys(toolDefinition),
  workflow: z.record(z.string(), z.json()),
  agent: z.strictObject({
    bug: text,
    bugScenario: name,
    fixed: scriptSchema,
    broken: scriptSchema,
  }),
});
export type SimulationSpec = z.infer<typeof simulationSchema>;
export type ToolDefinition = z.infer<typeof toolDefinition>;
export type ErrorDefinition = z.infer<typeof errorDefinition>;

const WRITE_STEPS = ['insert', 'update', 'updateWhere', 'deleteWhere'];

function fail(message: string): never {
  throw new Error(`Invalid simulation: ${message}`);
}

/** Validate a simulation spec, including every cross-reference. */
export function parseSimulation(input: unknown): SimulationSpec {
  boundedJson(input, 1_000_000);
  const spec = simulationSchema.parse(input);
  if (Object.hasOwn(spec.state, '_sim'))
    fail('state must not define _sim; the interpreter owns it.');
  if (Object.keys(spec.tools).length < 1 || Object.keys(spec.tools).length > 50)
    fail('declare 1 to 50 tools.');
  const errorRef = (ref: string, where: string) => {
    if (!Object.hasOwn(spec.errors, ref))
      fail(`Unknown error "${ref}" in ${where}.`);
  };
  for (const [collection, def] of Object.entries(spec.collections)) {
    if (!Array.isArray(spec.state[collection]))
      fail(`state.${collection} must be an array.`);
    if (def.unique.length && !def.conflict)
      fail(`collection "${collection}" has unique keys but no conflict error.`);
    if (def.conflict) errorRef(def.conflict, `collection "${collection}"`);
  }
  const collectionRef = (ref: CollectionRef, where: string, bound?: Set<string>) => {
    if (typeof ref !== 'string') {
      const head = ref.$.split('.')[0]!;
      if (head !== 'args' && !bound?.has(head))
        fail(`Unknown name "${head}" in ${where}.`);
      return;
    }
    if (!Object.hasOwn(spec.collections, ref))
      fail(`Unknown collection "${ref}" in ${where}.`);
  };

  for (const [toolName, tool] of Object.entries(spec.tools)) {
    const deferred: (() => void)[] = [];
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(toolName))
      fail(`invalid tool name "${toolName}".`);
    const where = `tool "${toolName}"`;
    for (const ref of typeof tool.invalid === 'string'
      ? [tool.invalid]
      : Object.values(tool.invalid))
      errorRef(ref, where);
    if (tool.idempotency) {
      const conflict = tool.idempotency.conflict;
      if (typeof conflict === 'string') errorRef(conflict, where);
      else deferred.push(() => checkExpr(conflict.return, '/idempotency/conflict/return'));
      const prop = tool.input.properties[tool.idempotency.arg];
      if (!prop || prop.type !== 'string')
        fail(
          `idempotency arg "${tool.idempotency.arg}" must be a string input property of ${where}.`,
        );
      if (tool.kind !== 'write') fail(`${where}: only write tools take idempotency.`);
    }
    for (const required of tool.input.required ?? [])
      if (!Object.hasOwn(tool.input.properties, required))
        fail(`${where} requires undeclared input "${required}".`);

    const bound = new Set<string>();
    const collectBindings = (list: Step[]) => {
      for (const s of list) {
        if ('let' in s) for (const k of Object.keys(s.let)) bound.add(k);
        if ('as' in s && typeof s.as === 'string') bound.add(s.as);
        if ('then' in s) {
          collectBindings(s.then);
          if (s.else) collectBindings(s.else);
        }
        if ('do' in s) collectBindings(s.do);
      }
    };
    collectBindings(tool.steps);
    for (const b of bound)
      if (RESERVED.has(b)) fail(`${where} binds reserved name "${b}".`);

    const checkExpr = (value: Json, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((v, i) => checkExpr(v, `${path}/${i}`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      const keys = Object.keys(value);
      const ops = keys.filter((k) => k.startsWith('$'));
      if (ops.length === 0) {
        for (const [k, v] of Object.entries(value)) checkExpr(v, `${path}/${k}`);
        return;
      }
      if (ops.length !== 1 || keys.length !== 1)
        fail(`${where} at ${path}: an operator object has exactly one key.`);
      const op = ops[0]!;
      if (!(OPERATORS as readonly string[]).includes(op))
        fail(`Unknown operator "${op}" in ${where} at ${path}.`);
      const arg = (value as Record<string, Json>)[op]!;
      if (op === '$literal') return;
      if (op === '$') {
        if (typeof arg !== 'string' || !arg)
          fail(`${where} at ${path}: $ takes a dotted path.`);
        const head = arg.split('.')[0]!;
        if (head !== 'args' && head !== 'item' && !bound.has(head))
          fail(`Unknown name "${head}" in ${where} at ${path}.`);
        return;
      }
      if (op === '$seq') {
        if (tool.kind === 'read')
          fail(`Read tool "${toolName}" cannot use $seq.`);
        if (typeof arg !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(arg))
          fail(`${where} at ${path}: $seq takes a counter name.`);
        return;
      }
      if (op === '$time' || op === '$isotime') {
        if (arg !== true) fail(`${where} at ${path}: use {"${op}": true}.`);
        return;
      }
      const arity: Record<string, number> = {
        $eq: 2,
        $ne: 2,
        $lt: 2,
        $lte: 2,
        $gt: 2,
        $gte: 2,
        $if: 3,
        $in: 2,
        $pick: 2,
        $map: 2,
        $filter: 2,
        $pad: 2,
        $div: 2,
        $mod: 2,
        $filters: 2,
      };
      const unary = ['$not', '$len', '$lower', '$type', '$keys'];
      if (unary.includes(op)) return checkExpr(arg, `${path}/${op}`);
      if (!Array.isArray(arg))
        fail(`${where} at ${path}: ${op} takes an array.`);
      if (arity[op] !== undefined && arg.length !== arity[op])
        fail(`${where} at ${path}: ${op} takes ${arity[op]} arguments.`);
      if (arity[op] === undefined && arg.length < 1)
        fail(`${where} at ${path}: ${op} needs arguments.`);
      checkExpr(arg, `${path}/${op}`);
    };

    const checkSteps = (list: Step[], path: string): void => {
      list.forEach((s, i) => {
        const at = `${path}/${i}`;
        const kind = Object.keys(s).find((k) =>
          [
            'let',
            'require',
            'find',
            'filter',
            'insert',
            'update',
            'updateWhere',
            'deleteWhere',
            'if',
            'each',
            'fail',
            'return',
          ].includes(k),
        )!;
        if (tool.kind === 'read' && WRITE_STEPS.includes(kind))
          fail(`Read tool "${toolName}" cannot ${kind} (${at}).`);
        if ('let' in s)
          for (const [k, v] of Object.entries(s.let)) checkExpr(v, `${at}/let/${k}`);
        if ('require' in s) {
          checkExpr(s.require, `${at}/require`);
          if ('error' in s) errorRef(s.error, where);
          if ('return' in s) checkExpr(s.return, `${at}/return`);
        } else if ('return' in s) checkExpr(s.return, `${at}/return`);
        if ('find' in s) {
          collectionRef(s.find, where, bound);
          checkExpr(s.where, `${at}/where`);
          if (s.missing) errorRef(s.missing, where);
        }
        if ('filter' in s) {
          collectionRef(s.filter, where, bound);
          checkExpr(s.where, `${at}/where`);
          if (s.limit !== undefined) checkExpr(s.limit, `${at}/limit`);
        }
        if ('insert' in s) {
          collectionRef(s.insert, where, bound);
          checkExpr(s.value, `${at}/value`);
        }
        if ('update' in s) {
          if (!bound.has(s.update)) fail(`Unknown name "${s.update}" in ${where}.`);
          for (const [k, v] of Object.entries(s.set)) checkExpr(v, `${at}/set/${k}`);
        }
        if ('updateWhere' in s) {
          collectionRef(s.updateWhere, where, bound);
          checkExpr(s.where, `${at}/where`);
          for (const [k, v] of Object.entries(s.set)) checkExpr(v, `${at}/set/${k}`);
        }
        if ('deleteWhere' in s) {
          collectionRef(s.deleteWhere, where, bound);
          checkExpr(s.where, `${at}/where`);
        }
        if ('if' in s) {
          checkExpr(s.if, `${at}/if`);
          checkSteps(s.then, `${at}/then`);
          if (s.else) checkSteps(s.else, `${at}/else`);
        }
        if ('each' in s) {
          checkExpr(s.each, `${at}/each`);
          checkSteps(s.do, `${at}/do`);
        }
        if ('fail' in s) errorRef(s.fail, where);
      });
    };
    checkSteps(tool.steps, '/steps');
    for (const check of deferred) check();
  }

  const workflow = workflowSchema.parse({ ...spec.workflow, initialState: spec.state });
  if (Object.hasOwn(spec.workflow, 'initialState'))
    fail('workflow.initialState comes from state; remove it.');
  for (const scenario of workflow.scenarios) {
    const f = scenario.fault;
    if (isModelFault(f))
      fail(`Model faults need the proxy runner; scenario "${scenario.id}".`);
    if (f.type === 'none') continue;
    const tool = Object.hasOwn(spec.tools, f.tool) ? spec.tools[f.tool] : undefined;
    if (!tool) fail(`scenario "${scenario.id}" targets unknown tool "${f.tool}".`);
    if (f.type === 'stale_read' && tool.kind !== 'read')
      fail(`scenario "${scenario.id}": stale_read needs a read tool.`);
    if (
      (f.type === 'duplicate_delivery' || f.type === 'permission_revoked') &&
      tool.kind !== 'write'
    )
      fail(`scenario "${scenario.id}": ${f.type} needs a write tool.`);
  }
  for (const variant of ['fixed', 'broken'] as const)
    for (const s of spec.agent[variant].steps)
      for (const call of [s.call, s.beforeRetry?.call])
        if (call && !Object.hasOwn(spec.tools, call))
          fail(`agent.${variant} calls unknown tool "${call}".`);
  if (!workflow.scenarios.some((s) => s.id === spec.agent.bugScenario))
    fail(`agent.bugScenario "${spec.agent.bugScenario}" is not a scenario.`);
  return spec;
}
