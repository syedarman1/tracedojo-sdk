// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { randomUUID } from 'node:crypto';
import {
  boundedJson,
  evaluateChecks,
  isModelFault,
  stableJson,
  workflowReportSchema,
  type Json,
  type State,
  type WorkflowCompletion,
  type WorkflowEvent,
  type WorkflowFault,
  type WorkflowReport,
  scenarioChecks,
} from '../schema.js';
import type { ProxyConfig } from './config.js';
import {
  errorResult,
  injectedResult,
  malformedResult,
  succeeded,
  type ToolOutcome,
} from './mcp.js';

export type Issue = NonNullable<WorkflowReport['issue']>;
export class Stop extends Error {
  constructor(readonly reason: Issue) {
    super(reason);
  }
}

const EVIDENCE_PAYLOAD_BYTES = 16000;
/** Keep evidence bounded: large tool payloads are summarized, not dropped silently. */
export function evidence(value: unknown): Json {
  const json = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(json);
  if (bytes <= EVIDENCE_PAYLOAD_BYTES) {
    try {
      boundedJson(value, EVIDENCE_PAYLOAD_BYTES);
      return JSON.parse(json) as Json;
    } catch {
      // Fall through to a summary.
    }
  }
  return { truncated: true, bytes, preview: json.slice(0, 2000) };
}

export interface ProxyTrialOptions {
  config: ProxyConfig;
  scenario: {
    id: string;
    title: string;
    fault: WorkflowFault;
    checks?: ProxyConfig['checks'];
  };
  initialState: State;
  probe: () => Promise<State>;
  onFatal: (stop: Stop) => void;
}

/** One trial's evidence and tool fault engine. Mirrors runWorkflow's semantics. */
export class ProxyTrial {
  readonly events: WorkflowEvent[] = [];
  readonly start = performance.now();
  state: State;
  closed = false;
  fatal: Stop | undefined;
  modelCalls = 0;
  /** Tool calls admitted but not yet answered. */
  pending = 0;
  occurrences = 0;
  triggerCount = 0;
  #calls = 0;
  #mutations = 0;
  #evidenceBytes = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #revoked = new Set<string>();
  #patterns = new Map<string, number>();
  #snapshots = new Map<string, { result: ToolOutcome; callId: string }>();
  #observedKinds = new Map<string, 'read' | 'write'>();
  #closing = new AbortController();
  /** Aborts when the trial closes, releasing held model connections. */
  readonly closedSignal = this.#closing.signal;
  constructor(readonly options: ProxyTrialOptions) {
    this.state = structuredClone(options.initialState);
    this.emit({
      kind: 'request',
      visibility: 'agent',
      detail: options.config.task,
    });
  }
  get fault() {
    return this.options.scenario.fault;
  }

  emit(event: Omit<WorkflowEvent, 'id' | 'sequence'>) {
    boundedJson(event, 100000);
    this.#evidenceBytes += Buffer.byteLength(JSON.stringify(event));
    if (this.events.length >= 990 || this.#evidenceBytes > 600000)
      throw this.fail(new Stop('evidence_limit'));
    this.events.push(
      structuredClone({
        ...event,
        id: `evt_${this.events.length + 1}`,
        sequence: this.events.length + 1,
      }),
    );
  }

  close() {
    this.closed = true;
    this.#closing.abort();
  }

  /** Record the first fatal condition and stop the agent. */
  fail(stop: Stop): Stop {
    if (!this.fatal) {
      this.fatal = stop;
      this.options.onFatal(stop);
    }
    return this.fatal;
  }

  guard() {
    if (this.fatal) throw this.fatal;
    if (this.closed) throw new Stop('cancelled');
  }

  inject(detail: { tool?: string; callId: string }, extra: State = {}) {
    this.emit({
      kind: 'fault',
      visibility: 'evaluator',
      ...(detail.tool ? { tool: detail.tool } : {}),
      callId: detail.callId,
      detail: `Injected ${this.fault.type}.`,
      payload: {
        ...extra,
        occurrence: this.occurrences,
        triggerCount: this.triggerCount + 1,
      },
    });
    this.triggerCount++;
  }

  /** Select the occurrence window for a matching request. */
  selects(matches: boolean): boolean {
    if (!matches || this.fault.type === 'none') return false;
    this.occurrences++;
    return (
      this.occurrences >= this.fault.occurrence &&
      this.occurrences < this.fault.occurrence + this.fault.repeat
    );
  }

  observeKind(tool: string, readOnly: boolean) {
    this.#observedKinds.set(tool, readOnly ? 'read' : 'write');
  }
  kindOf(tool: string): 'read' | 'write' {
    return (
      this.options.config.tools?.[tool] ??
      this.#observedKinds.get(tool) ??
      'write'
    );
  }

  /** Probe real state and attribute any change since the last observation. */
  async sync(tool?: string, callId?: string) {
    let next: State;
    try {
      next = await this.options.probe();
    } catch {
      throw this.fail(new Stop('tool_contract'));
    }
    if (stableJson(next) === stableJson(this.state)) return;
    if (++this.#mutations > 110) throw this.fail(new Stop('evidence_limit'));
    this.emit({
      kind: 'mutation',
      visibility: 'evaluator',
      ...(tool ? { tool, callId } : {}),
      detail: tool
        ? 'Observed after the tool call. Hidden from the agent.'
        : 'State changed outside proxied tool calls.',
      payload: { before: this.state, after: next },
    });
    this.state = next;
    // A read that changes state makes the evidence unattributable.
    if (tool && this.kindOf(tool) === 'read')
      throw this.fail(new Stop('tool_contract'));
  }

  /** Serialize whole tool transactions so each state change has one cause. */
  callTool(
    tool: string,
    args: { [key: string]: Json },
    forward: (args: { [key: string]: Json }) => Promise<ToolOutcome>,
  ): Promise<ToolOutcome> {
    const previous = this.#tail;
    this.pending++;
    const promise = (async () => {
      await previous;
      try {
        return await this.#execute(tool, args, forward);
      } catch (error) {
        throw this.fail(error instanceof Stop ? error : new Stop('tool_contract'));
      } finally {
        this.pending--;
      }
    })();
    this.#tail = promise.catch(() => undefined);
    return promise;
  }

  /** Resolve when every admitted tool call has finished. */
  drain(): Promise<unknown> {
    return this.#tail;
  }

  async #execute(
    tool: string,
    input: { [key: string]: Json },
    forward: (args: { [key: string]: Json }) => Promise<ToolOutcome>,
  ): Promise<ToolOutcome> {
    this.guard();
    const { limits } = this.options.config;
    if (this.#calls >= limits.maxToolCalls) throw new Stop('call_limit');
    const args = structuredClone(input);
    const key = stableJson([tool, args]);
    const count = (this.#patterns.get(key) ?? 0) + 1;
    if (count > limits.maxRepeatedCalls) throw new Stop('repeated_calls');
    this.#patterns.set(key, count);
    const callId = `call_${++this.#calls}`;
    this.emit({
      kind: 'tool_call',
      visibility: 'agent',
      tool,
      callId,
      detail: `Call ${this.#calls}`,
      payload: evidence(args),
    });
    const fault = this.fault;
    const toolFault = fault.type !== 'none' && !isModelFault(fault) ? fault : undefined;
    const target = this.selects(toolFault?.tool === tool);
    await this.sync();
    let response: ToolOutcome;
    if (
      target &&
      (fault.type === 'timeout_before' || fault.type === 'unavailable')
    ) {
      this.inject({ tool, callId });
      response =
        fault.type === 'timeout_before'
          ? errorResult(
              'TIMEOUT',
              'The request timed out. Its outcome could not be confirmed.',
            )
          : errorResult(
              'SERVICE_UNAVAILABLE',
              'The service is temporarily unavailable.',
            );
    } else {
      if (target && fault.type === 'permission_revoked') {
        this.#revoked.add(tool);
        this.inject({ tool, callId });
      }
      if (this.#revoked.has(tool))
        response = errorResult(
          'PERMISSION_DENIED',
          'Write access to this tool has been revoked.',
        );
      else {
        const deliver = async (delivery: number): Promise<ToolOutcome> => {
          this.guard();
          if (target && fault.type === 'duplicate_delivery')
            this.emit({
              kind: 'delivery',
              visibility: 'evaluator',
              tool,
              callId,
              detail: `Write delivery ${delivery} sent to the MCP server.`,
              payload: { delivery, args: evidence(args) },
            });
          const outcome = await forward(structuredClone(args));
          this.guard();
          await this.sync(tool, callId);
          return outcome;
        };
        const original = await deliver(1);
        if (target && fault.type === 'duplicate_delivery') {
          this.emit({
            kind: 'tool_result',
            visibility: 'evaluator',
            tool,
            callId,
            detail:
              'First delivery response; this is the response returned to the agent.',
            payload: evidence(original),
          });
          this.inject({ tool, callId });
          const duplicate = await deliver(2);
          this.emit({
            kind: 'tool_result',
            visibility: 'evaluator',
            tool,
            callId,
            detail: 'Duplicate delivery response, hidden from the agent.',
            payload: evidence(duplicate),
          });
        }
        response = original;
        if (
          toolFault?.tool === tool &&
          fault.type === 'stale_read' &&
          succeeded(original)
        ) {
          const snapshot = this.#snapshots.get(key);
          if (
            target &&
            snapshot &&
            stableJson(snapshot.result) !== stableJson(original)
          ) {
            this.emit({
              kind: 'tool_result',
              visibility: 'evaluator',
              tool,
              callId,
              detail: 'Fresh read response, hidden from the agent.',
              payload: evidence(original),
            });
            this.inject({ tool, callId }, { sourceCallId: snapshot.callId });
            response = structuredClone(snapshot.result);
          }
          if (!snapshot)
            this.#snapshots.set(key, {
              result: structuredClone(original),
              callId,
            });
        }
        if (
          target &&
          ((fault.type === 'timeout_after' && succeeded(original)) ||
            (fault.type === 'prompt_injection' && succeeded(original)) ||
            fault.type === 'malformed')
        ) {
          this.emit({
            kind: 'tool_result',
            visibility: 'evaluator',
            tool,
            callId,
            detail: 'Original tool response, hidden from the agent.',
            payload: evidence(original),
          });
          this.inject({ tool, callId });
          response =
            fault.type === 'timeout_after'
              ? errorResult(
                  'TIMEOUT',
                  'The request timed out. Its outcome could not be confirmed.',
                )
              : fault.type === 'prompt_injection'
                ? injectedResult(fault.replacement)
                : malformedResult(original);
        }
      }
    }
    this.emit({
      kind: 'tool_result',
      visibility: 'agent',
      tool,
      callId,
      detail: 'Response delivered to the agent.',
      payload: evidence(response),
    });
    return response;
  }

  /** Close the trial and build a report that the shared schema validates. */
  finish(
    meta: {
      fingerprint: string;
      execution: NonNullable<WorkflowReport['execution']>;
    },
    outcome: { completion?: WorkflowCompletion; issue?: Issue },
  ): WorkflowReport {
    this.close();
    const config = this.options.config;
    const issue = this.fatal?.reason ?? outcome.issue;
    const completion = issue ? undefined : outcome.completion;
    if (completion)
      this.emit({
        kind: 'completion',
        visibility: 'agent',
        detail: completion.message,
        payload: completion,
      });
    else if (issue)
      this.events.push({
        id: `evt_${this.events.length + 1}`,
        sequence: this.events.length + 1,
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
    const scenario = this.options.scenario;
    const definitions = scenarioChecks(config.checks, scenario);
    const assertions = evaluateChecks(
      definitions,
      this.options.initialState,
      this.state,
      completion,
      this.events,
    );
    const status =
      issue === 'cancelled' || issue === 'timed_out'
        ? issue
        : issue === 'call_limit' || issue === 'repeated_calls'
          ? 'failed'
          : issue || (scenario.fault.type !== 'none' && this.triggerCount === 0)
            ? 'inconclusive'
            : assertions.every((c) => c.passed)
              ? 'passed'
              : 'failed';
    return workflowReportSchema.parse({
      schemaVersion: '1',
      reportType: 'workflow',
      id: `run_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      execution: meta.execution,
      workflow: { id: config.id, title: config.title, task: config.task },
      suiteFingerprint: meta.fingerprint,
      agent: { id: config.agent.id, version: config.agent.version },
      scenario: { id: scenario.id, title: scenario.title, fault: scenario.fault },
      status,
      ...(issue ? { issue } : {}),
      fault: { triggered: this.triggerCount > 0, triggerCount: this.triggerCount },
      initialState: this.options.initialState,
      finalState: this.state,
      definitions,
      assertions,
      ...(completion ? { completion } : {}),
      events: this.events,
      metrics: {
        toolCalls: this.events.filter((e) => e.kind === 'tool_call').length,
        mutations: this.events.filter((e) => e.kind === 'mutation').length,
        durationMs: Math.round((performance.now() - this.start) * 100) / 100,
      },
    });
  }
}
