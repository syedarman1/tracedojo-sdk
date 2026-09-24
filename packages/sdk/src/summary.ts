// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { workflowExitCode, type WorkflowBatch } from './schema.js';

// Report labels are user data, including in Markdown rendered by CI providers.
function escape(value: string): string {
  return value.replace(/[&<>|`*_[\]\\\r\n]/g, (char) =>
    char === '\r' || char === '\n' ? ' ' : `&#${char.charCodeAt(0)};`,
  );
}

export function workflowSummary(batch: WorkflowBatch): string {
  const status = ['Passed', 'Failed', '', 'Incomplete'][
    workflowExitCode(batch)
  ];
  const lines = [
    `## TraceDojo: ${status}`,
    '',
    `${escape(batch.baseline.workflow.title)} · ${escape(batch.baseline.agent.id)} (${escape(batch.baseline.agent.version)})`,
    '',
    `No-fault control: **${batch.baseline.status}**. Fault trials recorded: **${batch.runs.length}/${batch.planned}**.`,
    '',
    '| Scenario | Passed | Failed | Incomplete | Fault reached |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  const scenarios = new Map<string, typeof batch.runs>();
  for (const run of batch.runs) {
    const group = scenarios.get(run.scenario.id) ?? [];
    group.push(run);
    scenarios.set(run.scenario.id, group);
  }
  for (const group of scenarios.values()) {
    const passed = group.filter((r) => r.status === 'passed').length;
    const failed = group.filter((r) => r.status === 'failed').length;
    const triggered = group.filter((r) => r.fault.triggered).length;
    lines.push(
      `| ${escape(group[0]!.scenario.title)} | ${passed} | ${failed} | ${group.length - passed - failed} | ${triggered}/${group.length} |`,
    );
  }
  if (batch.skippedReason) lines.push('', escape(batch.skippedReason));
  const problems = [batch.baseline, ...batch.runs].filter(
    (run) => run.status !== 'passed',
  );
  if (problems.length) lines.push('', '### Investigate', '');
  for (const run of problems.slice(0, 10)) {
    lines.push(
      `- ${escape(run.scenario.title)}: **${run.status}** (${run.id}).`,
    );
    if (run.issue) lines.push(`  - Execution issue: ${run.issue}.`);
    if (run.scenario.fault.type !== 'none' && !run.fault.triggered)
      lines.push(
        '  - The configured fault was not reached; recovery is untested.',
      );
    for (const check of run.assertions.filter((c) => !c.passed))
      lines.push(`  - ${escape(check.label)}: ${escape(check.detail)}`);
  }
  if (problems.length > 10)
    lines.push(
      `- ${problems.length - 10} more results need review in the JSON report.`,
    );
  lines.push(
    '',
    'Open the JSON report in TraceDojo to inspect tool calls, committed changes, and assertion evidence.',
    'Counts describe these trials only; they are not a guarantee of production reliability.',
    '',
  );
  return lines.join('\n');
}
