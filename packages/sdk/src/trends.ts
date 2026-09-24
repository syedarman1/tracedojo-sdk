// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import {
  boundedJson,
  stableJson,
  workflowReportSchema,
  type WorkflowReport,
} from './schema.js';

export interface TrendPoint {
  commitSha: string;
  recordedAt: string;
  executions: number;
  planned: number;
  passed: number;
  failed: number;
  incomplete: number;
  passRate: number | null;
  reason?: string;
  reportIds: string[];
}
export interface ScenarioTrend {
  id: string;
  title: string;
  workflow: string;
  agentId: string;
  suiteFingerprint: string;
  points: TrendPoint[];
}
const clockProfile = (report: WorkflowReport) =>
  report.clock
    ? [report.clock.mode, report.clock.startMs, report.clock.maxTimeMs]
    : null;
const conditions = (report: WorkflowReport) =>
  stableJson([report.workflow, report.initialState, clockProfile(report)]);
const identity = (report: WorkflowReport) =>
  report.origin?.originalId ?? report.id;
const canonical = (report: WorkflowReport) => {
  const copy = { ...report };
  delete copy.origin;
  return stableJson({ ...copy, id: identity(report) });
};

/** Descriptive rates over supplied evidence only; never infer missing trials as passes. */
export function workflowTrends(input: unknown[]): {
  series: ScenarioTrend[];
  unlabelled: number;
} {
  if (!Array.isArray(input) || input.length > 10000)
    throw new Error('Trends support up to 10,000 loaded reports.');
  const unique = new Map<string, WorkflowReport>();
  const conflicts = new Set<string>();
  for (const value of input) {
    boundedJson(value);
    const report = workflowReportSchema.parse(value);
    const previous = unique.get(identity(report));
    if (previous && canonical(previous) !== canonical(report)) {
      if (previous.execution) conflicts.add(previous.execution.id);
      if (report.execution) conflicts.add(report.execution.id);
    } else unique.set(identity(report), report);
  }
  const reports = [...unique.values()];
  const labelled = reports.filter((report) => report.execution?.commitSha);
  const executionMetadata = new Map<string, Set<string>>();
  for (const report of reports) {
    if (!report.execution) continue;
    const id = report.execution!.id;
    const metadata = executionMetadata.get(id) ?? new Set<string>();
    metadata.add(
      stableJson([
        report.execution,
        report.agent,
        report.suiteFingerprint,
        conditions(report),
      ]),
    );
    executionMetadata.set(id, metadata);
    if (metadata.size > 1) conflicts.add(id);
  }
  const families = new Map<string, WorkflowReport[]>();
  for (const report of labelled) {
    const key = stableJson([report.suiteFingerprint, report.agent.id]);
    const family = families.get(key) ?? [];
    family.push(report);
    families.set(key, family);
  }
  const series: ScenarioTrend[] = [];
  for (const [familyId, family] of families) {
    const example = family[0]!;
    const familyConflict =
      new Set(family.map(conditions)).size > 1 ||
      new Set(
        family
          .filter((r) => r.scenario.id === 'baseline')
          .map((r) => stableJson(r.definitions)),
      ).size > 1;
    const scenarios = [
      ...new Set(family.flatMap((r) => r.execution!.scenarioIds)),
    ].sort();
    const executions = new Map<string, WorkflowReport[]>();
    for (const report of family) {
      const group = executions.get(report.execution!.id) ?? [];
      group.push(report);
      executions.set(report.execution!.id, group);
    }
    for (const scenarioId of scenarios) {
      const observed = family.filter((r) => r.scenario.id === scenarioId);
      const scenarioConflict =
        new Set(observed.map((r) => stableJson([r.scenario, r.definitions])))
          .size > 1;
      const commits = new Map<
        string,
        { point: TrendPoint; versions: Set<string> }
      >();
      for (const [executionId, group] of executions) {
        const first = group[0]!;
        const execution = first.execution!;
        if (!execution.scenarioIds.includes(scenarioId)) continue;
        const control = group.filter((r) => r.scenario.id === 'baseline');
        const trials = group.filter((r) => r.scenario.id === scenarioId);
        const planned = execution.trialsPerScenario;
        const invalid =
          familyConflict ||
          scenarioConflict ||
          conflicts.has(executionId) ||
          control.length > 1 ||
          control.some((r) => r.scenario.fault.type !== 'none') ||
          trials.length > planned;
        const complete =
          !invalid &&
          control.length === 1 &&
          control[0]!.scenario.fault.type === 'none' &&
          control[0]!.status === 'passed' &&
          trials.length === planned &&
          trials.every((r) => r.status === 'passed' || r.status === 'failed');
        const at = group
          .map((r) => r.createdAt)
          .sort()
          .at(-1)!;
        const entry = commits.get(execution.commitSha!) ?? {
          versions: new Set<string>(),
          point: {
            commitSha: execution.commitSha!,
            recordedAt: at,
            executions: 0,
            planned: 0,
            passed: 0,
            failed: 0,
            incomplete: 0,
            passRate: 0,
            reportIds: [],
          },
        };
        entry.versions.add(first.agent.version);
        const point = entry.point;
        point.executions++;
        point.planned += planned;
        point.recordedAt = point.recordedAt > at ? point.recordedAt : at;
        point.passed += trials.filter((r) => r.status === 'passed').length;
        point.failed += trials.filter((r) => r.status === 'failed').length;
        point.incomplete += Math.max(
          0,
          planned -
            trials.filter((r) => r.status === 'passed' || r.status === 'failed')
              .length,
        );
        point.reportIds.push(...trials.map((r) => r.id));
        if (!complete || entry.versions.size > 1) {
          point.passRate = null;
          point.reason =
            invalid || entry.versions.size > 1
              ? 'Conflicting evidence or test conditions.'
              : control.length !== 1
                ? 'No matching control is loaded.'
                : control[0]!.status !== 'passed'
                  ? 'The no-fault control did not pass.'
                  : 'Missing or interrupted trials.';
        }
        commits.set(execution.commitSha!, entry);
      }
      const points = [...commits.values()]
        .map(({ point }) => ({
          ...point,
          passRate:
            point.passRate === null
              ? null
              : (point.passed / point.planned) * 100,
        }))
        .sort(
          (a, b) =>
            a.recordedAt.localeCompare(b.recordedAt) ||
            a.commitSha.localeCompare(b.commitSha),
        );
      series.push({
        id: `${familyId}:${scenarioId}`,
        title: observed[0]?.scenario.title ?? scenarioId,
        workflow: example.workflow.title,
        agentId: example.agent.id,
        suiteFingerprint: example.suiteFingerprint,
        points,
      });
    }
  }
  return {
    series: series.sort((a, b) => a.id.localeCompare(b.id)),
    unlabelled: reports.length - labelled.length,
  };
}
