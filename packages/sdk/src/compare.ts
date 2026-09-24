// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import {
  boundedJson,
  stableJson,
  workflowBatchSchema,
  type WorkflowReport,
} from './schema.js';

export interface ScenarioComparison {
  id: string;
  title: string;
  trials: number;
  baseFailures: number;
  candidateFailures: number;
  regressedChecks: string[];
  status: 'regressed' | 'improved' | 'unchanged';
}
export interface WorkflowComparison {
  schemaVersion: 'workflow-comparison/1';
  status: 'no_regressions' | 'regressed' | 'incomparable';
  reason: string;
  scenarios: ScenarioComparison[];
}

export function incompleteComparison(reason: string): WorkflowComparison {
  return {
    schemaVersion: 'workflow-comparison/1',
    status: 'incomparable',
    reason,
    scenarios: [],
  };
}

function group(runs: WorkflowReport[]) {
  const groups = new Map<string, WorkflowReport[]>();
  for (const run of runs)
    groups.set(run.scenario.id, [...(groups.get(run.scenario.id) ?? []), run]);
  return groups;
}

function conditions(run: WorkflowReport) {
  return stableJson({
    workflow: run.workflow,
    initialState: run.initialState,
    scenario: run.scenario,
    definitions: run.definitions,
    clock: run.clock
      ? {
          mode: run.clock.mode,
          startMs: run.clock.startMs,
          maxTimeMs: run.clock.maxTimeMs,
        }
      : null,
  });
}

function failureCounts(runs: WorkflowReport[]) {
  const counts = new Map<string, number>();
  for (const run of runs) {
    for (const check of run.assertions)
      if (!check.passed) counts.set(check.id, (counts.get(check.id) ?? 0) + 1);
    if (run.issue)
      counts.set(
        `execution:${run.issue}`,
        (counts.get(`execution:${run.issue}`) ?? 0) + 1,
      );
  }
  return counts;
}

/** Compare matched observations, never treat missing or changed evidence as a pass. */
export function compareWorkflowBatches(
  baseInput: unknown,
  candidateInput: unknown,
): WorkflowComparison {
  if (baseInput === undefined || candidateInput === undefined)
    return incompleteComparison(
      'A baseline or candidate report is missing. Run both before gating regressions.',
    );
  boundedJson(baseInput);
  boundedJson(candidateInput);
  const base = workflowBatchSchema.parse(baseInput);
  const candidate = workflowBatchSchema.parse(candidateInput);
  if (
    base.baseline.suiteFingerprint !== candidate.baseline.suiteFingerprint ||
    base.baseline.agent.id !== candidate.baseline.agent.id ||
    conditions(base.baseline) !== conditions(candidate.baseline)
  )
    return incompleteComparison(
      'Test conditions or agent identity changed. Review the suite and establish a matching baseline.',
    );
  if (base.baseline.status !== 'passed')
    return incompleteComparison(
      'The baseline no-fault control did not pass. Establish a working baseline first.',
    );
  if (candidate.baseline.status === 'failed')
    return {
      schemaVersion: 'workflow-comparison/1',
      status: 'regressed',
      reason:
        'The candidate no-fault control regressed; its fault trials were skipped.',
      scenarios: [
        {
          id: 'baseline',
          title: 'No-fault control',
          trials: 1,
          baseFailures: 0,
          candidateFailures: 1,
          regressedChecks: [...failureCounts([candidate.baseline]).keys()],
          status: 'regressed',
        },
      ],
    };
  const complete = (batch: typeof base) =>
    !batch.skippedReason &&
    batch.runs.length === batch.planned &&
    batch.baseline.status === 'passed' &&
    batch.runs.every(
      (run) => ['passed', 'failed'].includes(run.status) && run.fault.triggered,
    );
  if (!complete(base) || !complete(candidate))
    return incompleteComparison(
      'Trials are missing, interrupted, or did not reach their configured fault. Recovery is untested.',
    );
  const left = group(base.runs);
  const right = group(candidate.runs);
  if (
    base.planned !== candidate.planned ||
    left.size !== right.size ||
    [...left].some(([id, runs]) => right.get(id)?.length !== runs.length)
  )
    return incompleteComparison(
      'Scenario sets or trial counts differ. Run matching scenarios with equal trial counts.',
    );
  const scenarios: ScenarioComparison[] = [];
  for (const [id, before] of left) {
    const after = right.get(id)!;
    if (
      [...before, ...after].some(
        (run) => conditions(run) !== conditions(before[0]!),
      )
    )
      return incompleteComparison(
        'Recorded scenario conditions differ despite the suite fingerprint. Review the evidence.',
      );
    const a = failureCounts(before);
    const b = failureCounts(after);
    const regressedChecks = [...b]
      .filter(([key, count]) => count > (a.get(key) ?? 0))
      .map(([key]) => key);
    const baseFailures = before.filter((run) => run.status === 'failed').length;
    const candidateFailures = after.filter(
      (run) => run.status === 'failed',
    ).length;
    const regressed =
      candidateFailures > baseFailures || regressedChecks.length > 0;
    const improved =
      candidateFailures < baseFailures ||
      [...a].some(([key, count]) => count > (b.get(key) ?? 0));
    scenarios.push({
      id,
      title: before[0]!.scenario.title,
      trials: before.length,
      baseFailures,
      candidateFailures,
      regressedChecks,
      status: regressed ? 'regressed' : improved ? 'improved' : 'unchanged',
    });
  }
  const regressions = scenarios.filter((s) => s.status === 'regressed').length;
  return {
    schemaVersion: 'workflow-comparison/1',
    status: regressions ? 'regressed' : 'no_regressions',
    reason: regressions
      ? `${regressions} scenario(s) regressed against the baseline.`
      : 'No new failures in matched trials. Existing failures may remain.',
    scenarios,
  };
}

export function comparisonExitCode(result: WorkflowComparison): 0 | 1 | 3 {
  return result.status === 'incomparable'
    ? 3
    : result.status === 'regressed'
      ? 1
      : 0;
}

const escape = (value: string) =>
  value.replace(/[&<>|`*_[\]\\\r\n@]/g, (char) =>
    char === '\r' || char === '\n' ? ' ' : `&#${char.charCodeAt(0)};`,
  );
export function comparisonSummary(result: WorkflowComparison): string {
  return [
    `## TraceDojo: ${result.status === 'regressed' ? 'Regressions found' : result.status === 'incomparable' ? 'Comparison incomplete' : 'No regressions'}`,
    '',
    escape(result.reason),
    '',
    '| Scenario | Baseline failures | Candidate failures | Trials | Change |',
    '| --- | ---: | ---: | ---: | --- |',
    ...result.scenarios.map(
      (s) =>
        `| ${escape(s.title)} | ${s.baseFailures} | ${s.candidateFailures} | ${s.trials} | ${s.status} |`,
    ),
    '',
    ...result.scenarios
      .filter((s) => s.regressedChecks.length)
      .map(
        (s) =>
          `- ${escape(s.title)}: increased failures for ${s.regressedChecks.map(escape).join(', ')}.`,
      ),
    '',
    'Counts describe these observations, not statistical significance or a guarantee of reliability. Tool implementation equivalence requires review.',
    '',
  ].join('\n');
}
