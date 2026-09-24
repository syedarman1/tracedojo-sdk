// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  boundedJson,
  completionSchema,
  commitShaSchema,
  evaluateChecks,
  parseWorkflow,
  resultSchema,
  stableJson,
  workflowBatchSchema,
  workflowReportSchema,
  type Json,
  type State,
  type ToolResult,
  type Workflow,
  type WorkflowBatch,
  type WorkflowCompletion,
  type WorkflowEvent,
  type WorkflowReport,
} from './schema.js';
export * from './schema.js';
import { TrialClock, type WorkflowClock } from './clock.js';
export type { WorkflowClock } from './clock.js';

export interface SimulatedTool {
  kind: 'read' | 'write';
  /** An isolated in-memory transaction. Only successful writes commit the draft. */
  execute(
    args: Record<string, Json>,
    state: State,
    context: { signal: AbortSignal; clock: WorkflowClock },
  ): ToolResult | Promise<ToolResult>;
}
export interface WorkflowContext {
  clock: WorkflowClock;
  task: string;
  signal: AbortSignal;
  call(tool: string, args: Record<string, Json>): Promise<ToolResult | string>;
  /** Record bounded, evaluator-only model telemetry. Never include credentials or private reasoning. */
  recordModel(observation: Pick<WorkflowEvent, 'detail' | 'payload'>): void;
}
export interface WorkflowAgent {
  id: string;
  version: string;
  run(context: WorkflowContext): Promise<WorkflowCompletion>;
}
export interface WorkflowAdapter {
  tools: Record<string, SimulatedTool>;
  createAgent(): WorkflowAgent;
}

const metadata = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
  version: z.string().trim().min(1).max(2000),
});
const failure = (
  code: string,
  message: string,
  retryable = false,
): ToolResult => ({ ok: false, error: { code, message, retryable } });
class Stop extends Error {
  constructor(readonly reason: NonNullable<WorkflowReport['issue']>) {
    super(reason);
  }
}

async function trial(
  workflow: Workflow,
  adapter: WorkflowAdapter,
  agent: WorkflowAgent,
  scenario: Workflow['scenarios'][number],
  fingerprint: string,
  execution: NonNullable<WorkflowReport['execution']>,
  signal?: AbortSignal,
): Promise<WorkflowReport> {
  const start = performance.now();
  const initialState = structuredClone(workflow.initialState);
  let state = structuredClone(initialState);
  const events: WorkflowEvent[] = [];
  const controller = new AbortController();
  let issue: WorkflowReport['issue'];
  let completion: WorkflowCompletion | undefined;
  let closed = false;
  let pending = 0;
  let calls = 0;
  let admitted = 0;
  let occurrences = 0;
  let triggerCount = 0;
  let evidenceBytes = 0;
  let fatal: Stop | undefined;
  let rejectClock!: (error: Stop) => void;
  const clockFailure = new Promise<never>((_, reject) => {
    rejectClock = reject;
  });
  const clock = new TrialClock(workflow.clock, controller.signal, (reason) => {
    fatal ??= new Stop(reason);
    rejectClock(fatal);
  });
  const revoked = new Set<string>();
  const patterns = new Map<string, number>();
  const readSnapshots = new Map<
    string,
    { result: ToolResult; callId: string }
  >();
  const fault = scenario.fault;
  const emit = (event: Omit<WorkflowEvent, 'id' | 'sequence'>) => {
    boundedJson(event, 100000);
    evidenceBytes += Buffer.byteLength(JSON.stringify(event));
    if (events.length >= 990 || evidenceBytes > 600000)
      throw new Stop('evidence_limit');
    events.push(
      structuredClone({
        ...event,
        id: `evt_${events.length + 1}`,
        sequence: events.length + 1,
        ...(workflow.clock ? { timeMs: clock.api.now() } : {}),
      }),
    );
  };
  const inject = (tool: string, callId: string, extra: State = {}) => {
    emit({
      kind: 'fault',
      visibility: 'evaluator',
      tool,
      callId,
      detail: `Injected ${fault.type}.`,
      payload: {
        ...extra,
        occurrence: occurrences,
        triggerCount: triggerCount + 1,
      },
    });
    triggerCount++;
  };
  emit({ kind: 'request', visibility: 'agent', detail: workflow.task });
  const guard = () => {
    if (
      closed ||
      controller.signal.aborted ||
      performance.now() - start >= workflow.limits.timeoutMs
    )
      throw new Stop(signal?.aborted ? 'cancelled' : 'timed_out');
    if (fatal) throw fatal;
  };
  const execute = async (
    tool: string,
    input: Record<string, Json>,
  ): Promise<ToolResult | string> => {
    guard();
    if (calls >= workflow.limits.maxToolCalls) throw new Stop('call_limit');
    boundedJson(input, 16000);
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== 'object' ||
      typeof tool !== 'string'
    )
      throw new Stop('tool_contract');
    const args = structuredClone(input);
    const key = stableJson([tool, args]);
    const count = (patterns.get(key) ?? 0) + 1;
    if (count > workflow.limits.maxRepeatedCalls)
      throw new Stop('repeated_calls');
    patterns.set(key, count);
    const callId = `call_${++calls}`;
    emit({
      kind: 'tool_call',
      visibility: 'agent',
      tool,
      callId,
      detail: `Call ${calls}`,
      payload: args,
    });
    const definition = Object.hasOwn(adapter.tools, tool)
      ? adapter.tools[tool]
      : undefined;
    const matches = fault.type !== 'none' && tool === fault.tool;
    if (matches) occurrences++;
    const target =
      matches &&
      occurrences >= fault.occurrence &&
      occurrences < fault.occurrence + fault.repeat;
    let response: ToolResult | string;
    if (!definition)
      response = failure(
        'UNKNOWN_TOOL',
        'This tool is not registered in the simulated workflow.',
      );
    else if (
      target &&
      (fault.type === 'timeout_before' || fault.type === 'unavailable')
    ) {
      inject(tool, callId);
      response =
        fault.type === 'timeout_before'
          ? failure(
              'TIMEOUT',
              'The request timed out. Its outcome could not be confirmed.',
              true,
            )
          : failure(
              'SERVICE_UNAVAILABLE',
              'The service is temporarily unavailable.',
              true,
            );
    } else {
      if (target && fault.type === 'permission_revoked') {
        revoked.add(tool);
        inject(tool, callId);
      }
      if (revoked.has(tool))
        response = failure(
          'PERMISSION_DENIED',
          'Write access to this tool has been revoked.',
        );
      else {
        const deliver = async (delivery: number): Promise<ToolResult> => {
          guard();
          if (target && fault.type === 'duplicate_delivery')
            emit({
              kind: 'delivery',
              visibility: 'evaluator',
              tool,
              callId,
              detail: `Simulated write delivery ${delivery}.`,
              payload: { delivery, args },
            });
          const draft = structuredClone(state);
          try {
            const raw = await definition.execute(structuredClone(args), draft, {
              signal: controller.signal,
              clock: clock.api,
            });
            // A late result cannot commit after cancellation, a deadline, or completion.
            guard();
            boundedJson(raw, 16000);
            boundedJson(draft, 100000);
            const original = resultSchema.parse(raw);
            const changed = stableJson(state) !== stableJson(draft);
            if (changed && (definition.kind === 'read' || !original.ok))
              throw new Stop('tool_contract');
            if (changed) {
              // Reserve evidence before committing; an evidence overflow cannot hide a write.
              emit({
                kind: 'mutation',
                visibility: 'evaluator',
                tool,
                callId,
                detail:
                  'Committed in the simulated tool. Hidden from the agent.',
                payload: { before: state, after: draft },
              });
              state = structuredClone(draft);
            }
            return structuredClone(original);
          } catch (error) {
            if (fatal) throw fatal;
            guard();
            throw error instanceof Stop ? error : new Stop('tool_contract');
          }
        };
        const original = await deliver(1);
        if (target && fault.type === 'duplicate_delivery') {
          emit({
            kind: 'tool_result',
            visibility: 'evaluator',
            tool,
            callId,
            detail:
              'First delivery response; this is the response returned to the agent.',
            payload: original,
          });
          inject(tool, callId);
          const duplicate = await deliver(2);
          emit({
            kind: 'tool_result',
            visibility: 'evaluator',
            tool,
            callId,
            detail: 'Duplicate delivery response, hidden from the agent.',
            payload: duplicate,
          });
        }
        response = original;
        if (matches && fault.type === 'stale_read' && original.ok) {
          const snapshot = readSnapshots.get(key);
          if (
            target &&
            snapshot &&
            stableJson(snapshot.result) !== stableJson(original)
          ) {
            emit({
              kind: 'tool_result',
              visibility: 'evaluator',
              tool,
              callId,
              detail: 'Fresh read response, hidden from the agent.',
              payload: original,
            });
            inject(tool, callId, { sourceCallId: snapshot.callId });
            response = structuredClone(snapshot.result);
          }
          // Pin the first successful read of these inputs for this trial only.
          if (!snapshot)
            readSnapshots.set(key, {
              result: structuredClone(original),
              callId,
            });
        }
        if (
          target &&
          ((fault.type === 'timeout_after' && original.ok) ||
            (fault.type === 'prompt_injection' && original.ok) ||
            fault.type === 'malformed')
        ) {
          emit({
            kind: 'tool_result',
            visibility: 'evaluator',
            tool,
            callId,
            detail: 'Original tool response, hidden from the agent.',
            payload: original,
          });
          inject(tool, callId);
          response =
            fault.type === 'timeout_after'
              ? failure(
                  'TIMEOUT',
                  'The request timed out. Its outcome could not be confirmed.',
                  true,
                )
              : fault.type === 'prompt_injection'
                ? { ok: true, data: structuredClone(fault.replacement) }
                : '{"ok":true,"data":';
        }
      }
    }
    emit({
      kind: 'tool_result',
      visibility: 'agent',
      tool,
      callId,
      detail: 'Response delivered to the agent.',
      payload: response,
    });
    return structuredClone(response);
  };
  // Serialize whole transactions, including awaits. Each draft starts from the
  // previous committed state; overlapping agent calls cannot lose each other's writes.
  let tail: Promise<unknown> = Promise.resolve();
  const call: WorkflowContext['call'] = (tool, args) => {
    pending++;
    const previous = tail;
    const promise = (async () => {
      try {
        guard();
        if (++admitted > workflow.limits.maxToolCalls)
          throw new Stop('call_limit');
        boundedJson(args, 16000);
        const capturedArgs = structuredClone(args);
        await previous;
        const release = clock.hold();
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
        } finally {
          release();
        }
        return await execute(tool, capturedArgs);
      } catch (error) {
        fatal ??= error instanceof Stop ? error : new Stop('tool_contract');
        throw fatal;
      } finally {
        pending--;
      }
    })();
    // An agent may forget to await a call. Keep that a recorded protocol failure
    // instead of an unhandled rejection that terminates the caller's process.
    void promise.catch(() => undefined);
    tail = promise.catch(() => undefined);
    return promise;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let rejectAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw new Stop('cancelled');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Stop('timed_out'));
      }, workflow.limits.timeoutMs);
      rejectAbort = () => reject(new Stop('cancelled'));
      signal?.addEventListener('abort', rejectAbort, { once: true });
    });
    const raw = await Promise.race([
      Promise.resolve().then(() =>
        agent.run({
          task: workflow.task,
          signal: controller.signal,
          call,
          clock: clock.api,
          recordModel(observation) {
            guard();
            const parsed = z
              .strictObject({
                detail: z.string().max(2000),
                payload: z.json().optional(),
              })
              .parse(observation);
            emit({
              kind: 'model',
              visibility: 'evaluator',
              ...parsed,
            });
          },
        }),
      ),
      deadline,
      clockFailure,
    ]);
    guard();
    if (pending || clock.pending) throw new Stop('unawaited_calls');
    boundedJson(raw, 16000);
    completion = completionSchema.parse(raw);
    emit({
      kind: 'completion',
      visibility: 'agent',
      detail: completion.message,
      payload: completion,
    });
  } catch (error) {
    issue = error instanceof Stop ? error.reason : 'agent_error';
    events.push({
      id: `evt_${events.length + 1}`,
      sequence: events.length + 1,
      ...(workflow.clock ? { timeMs: clock.api.now() } : {}),
      kind: [
        'call_limit',
        'repeated_calls',
        'timed_out',
        'cancelled',
        'evidence_limit',
      ].includes(issue)
        ? 'limit'
        : 'error',
      visibility: 'evaluator',
      detail: `Run stopped: ${issue}. Partial evidence preserved.`,
    });
  } finally {
    closed = true;
    controller.abort();
    clock.close();
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (rejectAbort) signal?.removeEventListener('abort', rejectAbort);
  }
  const definitions = scenario.checks ?? workflow.checks;
  const assertions = evaluateChecks(
    definitions,
    initialState,
    state,
    completion,
    events,
  );
  const status =
    issue === 'cancelled' || issue === 'timed_out'
      ? issue
      : issue === 'call_limit' || issue === 'repeated_calls'
        ? 'failed'
        : issue || (fault.type !== 'none' && triggerCount === 0)
          ? 'inconclusive'
          : assertions.every((c) => c.passed)
            ? 'passed'
            : 'failed';
  return workflowReportSchema.parse({
    schemaVersion: '1',
    reportType: 'workflow',
    id: `run_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    execution,
    workflow: { id: workflow.id, title: workflow.title, task: workflow.task },
    suiteFingerprint: fingerprint,
    agent: metadata.parse({ id: agent.id, version: agent.version }),
    scenario: { id: scenario.id, title: scenario.title, fault },
    status,
    ...(issue ? { issue } : {}),
    fault: { triggered: triggerCount > 0, triggerCount },
    initialState,
    ...(clock.snapshot ? { clock: clock.snapshot } : {}),
    finalState: state,
    definitions,
    assertions,
    ...(completion ? { completion } : {}),
    events,
    metrics: {
      toolCalls: events.filter((e) => e.kind === 'tool_call').length,
      mutations: events.filter((e) => e.kind === 'mutation').length,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    },
  });
}

/** Run trusted local agent code against isolated, developer-defined simulated tools. */
export async function runWorkflow(
  input: unknown,
  adapter: WorkflowAdapter,
  options: { trials?: number; signal?: AbortSignal; commitSha?: string } = {},
): Promise<WorkflowBatch> {
  const workflow = parseWorkflow(input);
  const commitSha =
    options.commitSha === undefined
      ? undefined
      : commitShaSchema.parse(options.commitSha);
  const trials = z
    .number()
    .int()
    .min(1)
    .max(20)
    .parse(options.trials ?? 1);
  const execution = {
    id: randomUUID(),
    trialsPerScenario: trials,
    scenarioIds: workflow.scenarios.map((scenario) => scenario.id),
    ...(commitSha ? { commitSha } : {}),
  };
  if (
    !adapter ||
    typeof adapter.createAgent !== 'function' ||
    !adapter.tools ||
    Object.keys(adapter.tools).length < 1 ||
    Object.keys(adapter.tools).length > 50
  )
    throw new Error('Provide tools and a synchronous createAgent factory.');
  for (const [name, tool] of Object.entries(adapter.tools))
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name) ||
      !tool ||
      !['read', 'write'].includes(tool.kind) ||
      typeof tool.execute !== 'function'
    )
      throw new Error(
        'Every tool needs a valid name, read/write kind, and execute function.',
      );
  for (const scenario of workflow.scenarios) {
    const f = scenario.fault;
    if (
      f.type !== 'none' &&
      (!Object.hasOwn(adapter.tools, f.tool) ||
        ((f.type === 'permission_revoked' || f.type === 'duplicate_delivery') &&
          adapter.tools[f.tool]?.kind !== 'write') ||
        (f.type === 'stale_read' && adapter.tools[f.tool]?.kind !== 'read'))
    )
      throw new Error(
        'Every fault must target a registered tool; permission revocation and duplicate delivery require a write tool; stale reads require a read tool.',
      );
  }
  const fingerprint = createHash('sha256')
    .update(stableJson(workflow))
    .digest('hex');
  const seen = new WeakSet<object>();
  let identity: z.infer<typeof metadata> | undefined;
  const instantiate = () => {
    let agent: WorkflowAgent;
    try {
      agent = adapter.createAgent();
      if (agent instanceof Promise) {
        void agent.catch(() => undefined);
        throw new Error();
      }
      if (!agent || typeof agent.run !== 'function' || seen.has(agent))
        throw new Error();
      const next = metadata.parse({ id: agent.id, version: agent.version });
      if (identity && stableJson(next) !== stableJson(identity))
        throw new Error();
      identity = next;
      seen.add(agent);
      return agent;
    } catch {
      throw new Error(
        'createAgent must return a fresh agent with stable id/version and a run function.',
      );
    }
  };
  const baseline = await trial(
    workflow,
    adapter,
    instantiate(),
    { id: 'baseline', title: 'No-fault control', fault: { type: 'none' } },
    fingerprint,
    execution,
    options.signal,
  );
  const batch: WorkflowBatch = {
    schemaVersion: 'workflow-batch/1',
    baseline,
    runs: [],
    planned: workflow.scenarios.length * trials,
  };
  if (baseline.status !== 'passed')
    batch.skippedReason =
      'The no-fault control did not pass. Fault trials were skipped.';
  else
    outer: for (const scenario of workflow.scenarios)
      for (let i = 0; i < trials; i++) {
        if (options.signal?.aborted) {
          batch.skippedReason = 'Remaining trials were cancelled.';
          break outer;
        }
        let agent: WorkflowAgent;
        try {
          agent = instantiate();
        } catch {
          batch.skippedReason =
            'Agent initialization changed or failed. Completed evidence was preserved.';
          break outer;
        }
        const report = await trial(
          workflow,
          adapter,
          agent,
          scenario,
          fingerprint,
          execution,
          options.signal,
        );
        batch.runs.push(report);
        if (
          ['inconclusive', 'cancelled', 'timed_out'].includes(report.status)
        ) {
          batch.skippedReason =
            'Stopped after an interrupted or inconclusive trial. Completed evidence was preserved.';
          break outer;
        }
      }
  return workflowBatchSchema.parse(batch);
}
