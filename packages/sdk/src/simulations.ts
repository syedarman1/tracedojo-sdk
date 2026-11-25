// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { readdirSync, readFileSync } from 'node:fs';
import {
  stableJson,
  type Json,
  type State,
  type ToolResult,
  type WorkflowCompletion,
} from './schema.js';
import type { SimulatedTool, WorkflowAgent } from './index.js';
import {
  parseSimulation,
  type CollectionRef,
  type SimulationSpec,
  type Step,
  type ToolDefinition,
} from './simulation-schema.js';
export { parseSimulation, type SimulationSpec } from './simulation-schema.js';

/**
 * Interpreter for simulation/1 specs. Semantics are documented in
 * docs/SIMULATIONS.md and pinned by the vectors under simulations/vectors so
 * other SDKs can implement them identically.
 */

const MAX_STEPS = 1000;
type Obj = Record<string, Json>;
type Scope = Record<string, Json>;
type Outcome =
  | { type: 'return'; value: Json }
  | { type: 'error'; name: string; scope: Scope };

class SimulationStateError extends Error {}

function put(target: Obj, key: string, value: Json) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
function own(value: Json | undefined, key: string): Json | undefined {
  if (value && typeof value === 'object' && Object.hasOwn(value, key))
    return (value as Obj)[key];
  return undefined;
}
const isObject = (value: Json | undefined): value is Obj =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Truthiness shared by every SDK: null, false, 0 and "" are false. */
export const truthy = (value: Json | undefined) =>
  !(value === null || value === undefined || value === false || value === 0 || value === '');
function integer(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('Simulation arithmetic accepts integers only.');
  return value;
}
function compare(a: Json | undefined, b: Json | undefined): number | undefined {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}
const equal = (a: Json | undefined, b: Json | undefined) =>
  stableJson(a ?? null) === stableJson(b ?? null);

export function lookup(scope: Scope, path: string): Json {
  let current: Json | undefined = scope;
  for (const part of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else current = own(current, part);
    if (current === undefined) return null;
  }
  return current;
}

function matchesFilters(item: Json, filters: Json): boolean {
  if (!Array.isArray(filters)) throw new Error('$filters takes a list of filters.');
  return filters.every((filter) => {
    if (!isObject(filter) || typeof filter.column !== 'string' || typeof filter.op !== 'string')
      throw new Error('Each filter needs column, op and value.');
    const actual = own(item, filter.column) ?? null;
    const expected = own(filter, 'value') ?? null;
    const order = compare(actual, expected);
    switch (filter.op) {
      case 'eq':
        return equal(actual, expected);
      case 'neq':
        return !equal(actual, expected);
      case 'gt':
        return order !== undefined && order > 0;
      case 'gte':
        return order !== undefined && order >= 0;
      case 'lt':
        return order !== undefined && order < 0;
      case 'lte':
        return order !== undefined && order <= 0;
      case 'in':
        return Array.isArray(expected) && expected.some((v) => equal(actual, v));
      case 'is':
        return actual === expected;
      default:
        throw new Error(`Unknown filter op "${filter.op}".`);
    }
  });
}

interface Run {
  spec: SimulationSpec;
  state: State;
  steps: number;
}

function sim(run: Run): { seq: Record<string, number>; idempotency: Obj[] } {
  if (!isObject(run.state._sim)) put(run.state, '_sim', { seq: {}, idempotency: [] });
  return run.state._sim as unknown as { seq: Record<string, number>; idempotency: Obj[] };
}

/** Resolve a static or {"$": path} collection reference to a declared collection name. */
function collectionName(run: Run, ref: CollectionRef, scope: Scope): string {
  if (typeof ref === 'string') return ref;
  const name = lookup(scope, ref.$);
  if (typeof name !== 'string' || !Object.hasOwn(run.spec.collections, name))
    throw new Error(`"${ref.$}" does not name a declared collection; guard it with require first.`);
  return name;
}

function collection(run: Run, name: string): Json[] {
  const value = own(run.state, name);
  if (!Array.isArray(value))
    throw new SimulationStateError(`State has no "${name}" collection.`);
  return value;
}

function tick(run: Run) {
  if (++run.steps > MAX_STEPS)
    throw new Error(`Simulation exceeded the step limit of ${MAX_STEPS}.`);
}

/** Deterministic clock: spec.epoch plus every $seq counter so far. */
function now(run: Run): number {
  const seq = isObject(run.state._sim) ? (run.state._sim.seq as Obj) : {};
  return run.spec.epoch + Object.values(seq ?? {}).reduce<number>((a, b) => a + integer(b), 0);
}

export function evaluate(expr: Json, scope: Scope, run: Run): Json {
  tick(run);
  if (Array.isArray(expr)) return expr.map((e) => evaluate(e, scope, run));
  if (!isObject(expr)) return expr;
  const keys = Object.keys(expr);
  const op = keys.length === 1 && keys[0]!.startsWith('$') ? keys[0]! : undefined;
  if (!op) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(expr)) put(out, k, evaluate(v, scope, run));
    return out;
  }
  const arg = expr[op]!;
  const list = () => (arg as Json[]).map((e) => evaluate(e, scope, run));
  switch (op) {
    case '$':
      return structuredClone(lookup(scope, arg as string));
    case '$literal':
      return structuredClone(arg);
    case '$add':
      return list().map(integer).reduce((a, b) => a + b);
    case '$sub':
      return list().map(integer).reduce((a, b) => a - b);
    case '$mul':
      return list().map(integer).reduce((a, b) => a * b);
    case '$div':
    case '$mod': {
      const [a, b] = list().map(integer);
      if (b === 0) throw new Error(`${op} by zero.`);
      // Floor division and modulo, matching Python's // and %.
      return op === '$div' ? Math.floor(a! / b!) : a! - b! * Math.floor(a! / b!);
    }
    case '$min':
      return Math.min(...list().map(integer));
    case '$max':
      return Math.max(...list().map(integer));
    case '$eq': {
      const [a, b] = list();
      return equal(a, b);
    }
    case '$ne': {
      const [a, b] = list();
      return !equal(a, b);
    }
    case '$lt':
    case '$lte':
    case '$gt':
    case '$gte': {
      const [a, b] = list();
      const order = compare(a, b);
      if (order === undefined) return false;
      return op === '$lt' ? order < 0 : op === '$lte' ? order <= 0 : op === '$gt' ? order > 0 : order >= 0;
    }
    case '$and':
      for (const e of arg as Json[]) if (!truthy(evaluate(e, scope, run))) return false;
      return true;
    case '$or':
      for (const e of arg as Json[]) if (truthy(evaluate(e, scope, run))) return true;
      return false;
    case '$not':
      return !truthy(evaluate(arg, scope, run));
    case '$if': {
      const [cond, then, otherwise] = arg as Json[];
      return truthy(evaluate(cond!, scope, run))
        ? evaluate(then!, scope, run)
        : evaluate(otherwise!, scope, run);
    }
    case '$coalesce':
      for (const e of arg as Json[]) {
        const value = evaluate(e, scope, run);
        if (value !== null) return value;
      }
      return null;
    case '$len': {
      const value = evaluate(arg, scope, run);
      if (!Array.isArray(value)) throw new Error('$len takes an array.');
      return value.length;
    }
    case '$in': {
      const [value, options] = list();
      return Array.isArray(options) && options.some((o) => equal(o, value));
    }
    case '$pick': {
      const [source, fields] = list();
      if (!Array.isArray(fields)) throw new Error('$pick takes a list of keys.');
      const out: Obj = {};
      for (const field of fields) {
        const value = typeof field === 'string' ? own(source, field) : undefined;
        if (value !== undefined) put(out, field as string, value);
      }
      return out;
    }
    case '$merge': {
      const out: Obj = {};
      for (const part of list()) {
        if (part === null) continue;
        if (!isObject(part)) throw new Error('$merge takes objects.');
        for (const [k, v] of Object.entries(part)) put(out, k, v);
      }
      return out;
    }
    case '$map': {
      const [source, mapper] = arg as Json[];
      const items = evaluate(source!, scope, run);
      if (!Array.isArray(items)) throw new Error('$map takes an array.');
      return items.map((item) => evaluate(mapper!, { ...scope, item }, run));
    }
    case '$filter': {
      const [source, test] = arg as Json[];
      const items = evaluate(source!, scope, run);
      if (!Array.isArray(items)) throw new Error('$filter takes an array.');
      return items.filter((item) => truthy(evaluate(test!, { ...scope, item }, run)));
    }
    case '$concat': {
      const parts = list();
      if (parts.every(Array.isArray)) return (parts as Json[][]).flat(1);
      return parts
        .map((p) => {
          if (typeof p === 'string') return p;
          if (typeof p === 'number') return String(integer(p));
          throw new Error('$concat takes strings, integers, or arrays.');
        })
        .join('');
    }
    case '$pad': {
      const [value, width] = list().map(integer);
      return String(value).padStart(width!, '0');
    }
    case '$lower': {
      const value = evaluate(arg, scope, run);
      if (typeof value !== 'string') throw new Error('$lower takes a string.');
      return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
    }
    case '$type': {
      const value = evaluate(arg, scope, run);
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      if (typeof value === 'number') return Number.isSafeInteger(value) ? 'integer' : 'number';
      return typeof value;
    }
    case '$keys': {
      const value = evaluate(arg, scope, run);
      if (!isObject(value)) throw new Error('$keys takes an object.');
      return Object.keys(value);
    }
    case '$seq': {
      const counters = sim(run).seq;
      const name = arg as string;
      const next = (Object.hasOwn(counters, name) ? counters[name]! : 0) + 1;
      Object.defineProperty(counters, name, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return next;
    }
    case '$time':
      return now(run);
    case '$isotime':
      // RFC 3339 in UTC with whole seconds, e.g. 2024-11-15T06:33:21Z.
      return new Date(now(run) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    case '$filters': {
      const [item, filters] = list();
      return matchesFilters(item!, filters!);
    }
    default:
      throw new Error(`Unknown operator ${op}.`);
  }
}

function render(template: string, scope: Scope): string {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, path: string) => {
    const value = lookup(scope, path);
    return value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function uniqueConflict(run: Run, name: string, value: Obj, ignore?: Obj): boolean {
  const def = run.spec.collections[name]!;
  return def.unique.some((fields) =>
    collection(run, name).some(
      (existing) =>
        existing !== ignore &&
        fields.every((f) => {
          const v = own(value, f);
          return v !== undefined && v !== null && equal(own(existing, f), v);
        }),
    ),
  );
}

function runSteps(steps: Step[], scope: Scope, run: Run): Outcome | undefined {
  for (const step of steps) {
    tick(run);
    if ('let' in step) {
      for (const [k, v] of Object.entries(step.let)) put(scope, k, evaluate(v, scope, run));
    } else if ('require' in step) {
      if (!truthy(evaluate(step.require, scope, run)))
        return 'error' in step
          ? { type: 'error', name: step.error, scope }
          : { type: 'return', value: evaluate(step.return, scope, run) };
    } else if ('find' in step) {
      const found = collection(run, collectionName(run, step.find, scope)).find((item) =>
        truthy(evaluate(step.where, { ...scope, item }, run)),
      );
      if (found === undefined && step.missing)
        return { type: 'error', name: step.missing, scope };
      // A live reference into the draft, so a later update step changes state.
      put(scope, step.as, found ?? null);
    } else if ('filter' in step) {
      let found = collection(run, collectionName(run, step.filter, scope)).filter((item) =>
        truthy(evaluate(step.where, { ...scope, item }, run)),
      );
      if (step.order) {
        const { by, desc } = step.order;
        found = found
          .map((item, index) => ({ item, index }))
          .sort((a, b) => {
            const order = compare(own(a.item, by), own(b.item, by)) ?? 0;
            return (desc ? -order : order) || a.index - b.index;
          })
          .map(({ item }) => item);
      }
      if (step.limit !== undefined) {
        const limit = evaluate(step.limit, scope, run);
        if (limit !== null) found = found.slice(0, Math.max(0, integer(limit)));
      }
      put(scope, step.as, structuredClone(found));
    } else if ('insert' in step) {
      const name = collectionName(run, step.insert, scope);
      const value = evaluate(step.value, scope, run);
      if (!isObject(value)) throw new Error('insert takes an object.');
      if (uniqueConflict(run, name, value))
        return { type: 'error', name: run.spec.collections[name]!.conflict!, scope };
      const items = collection(run, name);
      items.push(value);
      if (step.as) put(scope, step.as, value);
    } else if ('update' in step) {
      const target = own(scope, step.update);
      if (!isObject(target)) throw new Error(`update target "${step.update}" is not an object.`);
      const changes = Object.entries(step.set).map(
        ([k, v]) => [k, evaluate(v, { ...scope, item: target }, run)] as const,
      );
      for (const [k, v] of changes) put(target, k, v);
    } else if ('updateWhere' in step) {
      let count = 0;
      for (const item of collection(run, collectionName(run, step.updateWhere, scope))) {
        if (!isObject(item) || !truthy(evaluate(step.where, { ...scope, item }, run))) continue;
        const changes = Object.entries(step.set).map(
          ([k, v]) => [k, evaluate(v, { ...scope, item }, run)] as const,
        );
        for (const [k, v] of changes) put(item, k, v);
        count++;
      }
      if (step.as) put(scope, step.as, count);
    } else if ('deleteWhere' in step) {
      const name = collectionName(run, step.deleteWhere, scope);
      const items = collection(run, name);
      const kept = items.filter((item) => !truthy(evaluate(step.where, { ...scope, item }, run)));
      put(run.state, name, kept);
      if (step.as) put(scope, step.as, items.length - kept.length);
    } else if ('if' in step) {
      const outcome = runSteps(
        truthy(evaluate(step.if, scope, run)) ? step.then : (step.else ?? []),
        scope,
        run,
      );
      if (outcome) return outcome;
    } else if ('each' in step) {
      const items = evaluate(step.each, scope, run);
      if (!Array.isArray(items)) throw new Error('each takes an array.');
      for (const item of items) {
        put(scope, step.as, item);
        const outcome = runSteps(step.do, scope, run);
        if (outcome) return outcome;
      }
    } else if ('fail' in step) {
      return { type: 'error', name: step.fail, scope };
    } else if ('return' in step) {
      return { type: 'return', value: evaluate(step.return, scope, run) };
    }
  }
  return undefined;
}

type InputSchema = ToolDefinition['input'];
type AnyInput = InputSchema | { type: string; [key: string]: unknown };

export interface InvalidInput {
  field: string;
  reason: 'missing' | 'unknown' | 'type';
}
/** Return the first invalid field and why, or undefined. */
export function invalidField(
  schema: AnyInput,
  value: Json | undefined,
  path = '',
): InvalidInput | undefined {
  const here: InvalidInput = { field: path || '(root)', reason: 'type' };
  const s = schema as Record<string, unknown> & { type: string };
  switch (s.type) {
    case 'any':
      return value === undefined ? here : undefined;
    case 'object': {
      if (!isObject(value)) return here;
      const properties = s.properties as Record<string, AnyInput>;
      for (const key of Object.keys(value))
        if (!Object.hasOwn(properties, key))
          return { field: path ? `${path}.${key}` : key, reason: 'unknown' };
      for (const key of (s.required as string[] | undefined) ?? [])
        if (!Object.hasOwn(value, key))
          return { field: path ? `${path}.${key}` : key, reason: 'missing' };
      for (const [key, child] of Object.entries(properties))
        if (Object.hasOwn(value, key)) {
          const bad = invalidField(child, value[key], path ? `${path}.${key}` : key);
          if (bad) return bad;
        }
      return undefined;
    }
    case 'string': {
      if (typeof value !== 'string') return here;
      const length = Array.from(value).length;
      if (Array.isArray(s.enum) && !s.enum.includes(value)) return here;
      if (typeof s.minLength === 'number' && length < s.minLength) return here;
      if (typeof s.maxLength === 'number' && length > s.maxLength) return here;
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) return here;
      return undefined;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return here;
      if (s.type === 'integer' && !Number.isSafeInteger(value)) return here;
      if (Array.isArray(s.enum) && !s.enum.includes(value)) return here;
      if (typeof s.minimum === 'number' && value < s.minimum) return here;
      if (typeof s.maximum === 'number' && value > s.maximum) return here;
      return undefined;
    }
    case 'boolean':
      return typeof value === 'boolean' ? undefined : here;
    case 'array': {
      if (!Array.isArray(value)) return here;
      if (typeof s.minItems === 'number' && value.length < s.minItems) return here;
      if (typeof s.maxItems === 'number' && value.length > s.maxItems) return here;
      for (let i = 0; i < value.length; i++) {
        const bad = invalidField(s.items as AnyInput, value[i], `${path}.${i}`.replace(/^\./, ''));
        if (bad) return bad;
      }
      return undefined;
    }
    default:
      return here;
  }
}

function errorResult(spec: SimulationSpec, name: string, scope: Scope): ToolResult {
  const def = spec.errors[name]!;
  const message = render(def.message, scope).trim() || def.code;
  return {
    ok: false,
    error: { code: def.code, message: message.slice(0, 2000), retryable: def.retryable },
  };
}

/**
 * Run a tool on a private copy of state and copy it back only on success: the
 * runner requires failed calls to leave their draft untouched.
 */
function executeTool(spec: SimulationSpec, toolName: string, args: Obj, state: State): ToolResult {
  const work = structuredClone(state);
  const result = executeOn(spec, toolName, args, work);
  if (result.ok) {
    for (const key of Object.keys(state)) if (!Object.hasOwn(work, key)) delete state[key];
    for (const [key, value] of Object.entries(work)) put(state, key, value);
  }
  return result;
}

function executeOn(spec: SimulationSpec, toolName: string, args: Obj, state: State): ToolResult {
  const tool = spec.tools[toolName]!;
  const run: Run = { spec, state, steps: 0 };
  const scope: Scope = {};
  put(scope, 'args', args);
  const bad = invalidField(tool.input, args);
  if (bad) {
    put(scope, 'field', bad.field);
    put(scope, 'reason', bad.reason);
    put(scope, 'value', lookup(scope, `args.${bad.field}`));
    return errorResult(
      spec,
      typeof tool.invalid === 'string' ? tool.invalid : tool.invalid[bad.reason],
      scope,
    );
  }
  try {
    const key = tool.idempotency ? own(args, tool.idempotency.arg) : undefined;
    let request: string | undefined;
    if (typeof key === 'string') {
      const rest: Obj = {};
      for (const [k, v] of Object.entries(args)) if (k !== tool.idempotency!.arg) put(rest, k, v);
      request = stableJson([toolName, rest]);
      const stored = isObject(state._sim) && Array.isArray(state._sim.idempotency)
        ? state._sim.idempotency.find((entry) => own(entry, 'key') === key)
        : undefined;
      if (stored !== undefined) {
        if (own(stored, 'request') !== request)
        {
          const conflict = tool.idempotency!.conflict;
          if (typeof conflict === 'string') return errorResult(spec, conflict, scope);
          return { ok: true, data: evaluate(conflict.return, scope, run) };
        }
        return { ok: true, data: structuredClone(own(stored, 'response') ?? null) };
      }
    }
    const outcome = runSteps(tool.steps, scope, run);
    if (!outcome) throw new Error(`Tool "${toolName}" ended without return.`);
    if (outcome.type === 'error') return errorResult(spec, outcome.name, outcome.scope);
    const data = structuredClone(outcome.value);
    if (request !== undefined)
      sim(run).idempotency.push({ key: key as string, request, response: structuredClone(data) });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SimulationStateError)
      return {
        ok: false,
        error: { code: 'SIMULATION_STATE', message: error.message, retryable: false },
      };
    throw error;
  }
}

/** Turn a validated spec into tools for runWorkflow. */
export function buildTools(spec: SimulationSpec): Record<string, SimulatedTool> {
  const tools: Record<string, SimulatedTool> = {};
  for (const [name, tool] of Object.entries(spec.tools))
    tools[name] = {
      kind: tool.kind,
      execute: (args, state) => executeTool(spec, name, args, state),
    };
  return tools;
}

// ---- Scripted reference agents ----

type ScriptScope = { attempt: number; saved: Obj };

/** Resolve {{attempt}} and {{saved.name.path}} templates in script values. */
function resolveTemplate(value: Json | undefined, scope: ScriptScope): Json {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const whole = /^\{\{([a-zA-Z0-9_.]+)\}\}$/.exec(value);
    if (whole) return structuredClone(lookup(scope as unknown as Scope, whole[1]!));
    return render(value, scope as unknown as Scope);
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, scope));
  if (isObject(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) put(out, k, resolveTemplate(v, scope));
    return out;
  }
  return value;
}

function pointerGet(value: Json, pointer: string): Json | undefined {
  if (pointer === '') return value;
  let current: Json | undefined = value;
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else current = own(current, part);
    if (current === undefined) return undefined;
  }
  return current;
}

function scriptAgent(spec: SimulationSpec, variant: 'fixed' | 'broken'): WorkflowAgent {
  const script = spec.agent[variant];
  return {
    id: `${spec.id}-reference`,
    version: `${variant}-1`,
    async run({ call, signal }): Promise<WorkflowCompletion> {
      const saved: Obj = {};
      for (const step of script.steps) {
        let done = false;
        for (let attempt = 1; attempt <= step.attempts && !done; attempt++) {
          signal.throwIfAborted();
          const scope = { attempt, saved };
          if (attempt > 1 && step.beforeRetry) {
            const lookupResult = await call(
              step.beforeRetry.call,
              resolveTemplate(step.beforeRetry.args, scope) as Obj,
            );
            if (typeof lookupResult !== 'string' && lookupResult.ok) {
              const found = pointerGet(lookupResult.data, step.beforeRetry.find.path);
              // A single resource (GET /thing/:id) is matched like a one-item list.
              const items = isObject(found) ? [found] : found;
              const where = resolveTemplate(step.beforeRetry.find.where, scope) as Obj;
              const match = Array.isArray(items)
                ? items.find((item) =>
                    // A key starting with "/" is a JSON pointer into the item.
                    Object.entries(where).every(([k, v]) =>
                      equal(k.startsWith('/') ? pointerGet(item, k) : own(item, k), v),
                    ),
                  )
                : undefined;
              if (match !== undefined) {
                if (step.save) put(saved, step.save, match);
                done = true;
                break;
              }
            }
          }
          const result = await call(step.call, resolveTemplate(step.args, scope) as Obj);
          if (typeof result === 'string') continue;
          if (!result.ok) {
            if (result.error.retryable) continue;
            return { status: 'blocked', message: result.error.message };
          }
          if (
            step.until &&
            !equal(pointerGet(result.data, step.until.path), resolveTemplate(step.until.equals, scope))
          )
            continue;
          if (step.save) put(saved, step.save, result.data);
          done = true;
        }
        if (!done) return { status: 'blocked', message: `Could not confirm ${step.call}.` };
      }
      return {
        status: 'completed',
        message: script.message,
        ...(script.output !== undefined
          ? { output: resolveTemplate(script.output, { attempt: 0, saved }) }
          : {}),
      };
    },
  };
}

// ---- Loading ----

export interface Simulation {
  spec: SimulationSpec;
  tools: Record<string, SimulatedTool>;
  /** The simulation's workflow/1 document, with initialState from the spec. */
  workflow(): Record<string, Json>;
  /** The scripted reference agent: 'fixed' passes every scenario; 'broken' fails agent.bugScenario. */
  createAgent(variant?: 'fixed' | 'broken'): WorkflowAgent;
  /**
   * Tool definitions to hand a model: name, description and a plain JSON Schema
   * for the arguments, in the shape OpenAI, Anthropic and most local servers accept.
   */
  toolDefinitions(): ModelToolDefinition[];
}

/** A simulated tool described for a model's tool-calling API. */
export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, Json>;
}

/** simulation/1 input schemas are JSON Schema except `any`, which is the empty schema. */
function jsonSchema(schema: AnyInput): Record<string, Json> {
  if (schema.type === 'any') return {};
  const out = { ...schema } as Record<string, Json>;
  if (schema.type === 'array') out.items = jsonSchema(schema.items as AnyInput);
  if (schema.type === 'object')
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, AnyInput>).map(([key, value]) => [
        key,
        jsonSchema(value),
      ]),
    );
  return out;
}

const directory = new URL('../simulations/', import.meta.url);

/** Ids of the simulations shipped with this package. */
export const simulationIds: string[] = readdirSync(directory)
  .filter((file) => file.endsWith('.json') && file !== 'simulation.schema.json')
  .map((file) => file.slice(0, -5))
  .sort();

/** Load a shipped simulation by id, or validate and load your own spec object. */
export function loadSimulation(idOrSpec: string | unknown): Simulation {
  let input = idOrSpec;
  if (typeof idOrSpec === 'string') {
    if (!simulationIds.includes(idOrSpec))
      throw new Error(`Unknown simulation. Choose: ${simulationIds.join(', ')}.`);
    input = JSON.parse(readFileSync(new URL(`${idOrSpec}.json`, directory), 'utf8'));
  }
  const spec = parseSimulation(input);
  return {
    spec,
    tools: buildTools(spec),
    workflow: () =>
      structuredClone({ ...spec.workflow, initialState: spec.state }) as Record<string, Json>,
    createAgent: (variant = 'fixed') => scriptAgent(spec, variant),
    toolDefinitions: () =>
      Object.entries(spec.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        parameters: jsonSchema(tool.input),
      })),
  };
}
