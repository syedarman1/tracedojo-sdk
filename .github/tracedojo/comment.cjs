// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

// This runs only from the default branch, never from an artifact or PR checkout.
const escape = (value) =>
  value.replace(/[&<>|`*_[\]\\\r\n@]/g, (char) =>
    char === '\r' || char === '\n' ? ' ' : `&#${char.charCodeAt(0)};`,
  );
async function readComparison() {
  const fs = await import('node:fs/promises');
  const file = process.env.TRACEDOJO_COMPARISON;
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 50000)
    throw new Error('Invalid comparison artifact.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
function valid(value) {
  const count = (n) => Number.isInteger(n) && n >= 0 && n <= 200;
  if (
    !value ||
    value.schemaVersion !== 'workflow-comparison/1' ||
    !['no_regressions', 'regressed', 'incomparable'].includes(value.status) ||
    !Array.isArray(value.scenarios) ||
    value.scenarios.length > 10
  )
    return false;
  if (
    !/^[a-f0-9]{40}$/.test(value.source?.baseSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(value.source?.headSha ?? '')
  )
    return false;
  if (value.status === 'incomparable') return value.scenarios.length === 0;
  if (!value.scenarios.length) return false;
  for (const row of value.scenarios) {
    if (
      !row ||
      typeof row.title !== 'string' ||
      row.title.length > 2000 ||
      !count(row.trials) ||
      row.trials < 1 ||
      !count(row.baseFailures) ||
      !count(row.candidateFailures) ||
      Math.max(row.baseFailures, row.candidateFailures) > row.trials ||
      !['regressed', 'improved', 'unchanged'].includes(row.status) ||
      !Array.isArray(row.regressedChecks) ||
      row.regressedChecks.length > 55 ||
      row.regressedChecks.some((s) => typeof s !== 'string' || s.length > 100)
    )
      return false;
    if (
      (row.candidateFailures > row.baseFailures ||
        row.regressedChecks.length > 0) !==
      (row.status === 'regressed')
    )
      return false;
  }
  return (
    (value.status === 'regressed') ===
    value.scenarios.some((row) => row.status === 'regressed')
  );
}

module.exports = async function comment({
  github,
  context,
  core,
  read = readComparison,
}) {
  const run = context.payload.workflow_run;
  if (run.event !== 'pull_request') return;
  const repo = context.repo;
  const latest = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: run.workflow_id,
    event: 'pull_request',
    head_sha: run.head_sha,
    per_page: 100,
  });
  if (
    latest.data.workflow_runs.some(
      (item) =>
        item.id > run.id ||
        (item.id === run.id && item.run_attempt > run.run_attempt),
    )
  ) {
    core.info('A newer run exists; leaving its comment alone.');
    return;
  }
  const associated = await github.paginate(
    github.rest.repos.listPullRequestsAssociatedWithCommit,
    { ...repo, commit_sha: run.head_sha, per_page: 100 },
  );
  let result;
  try {
    const value = await read();
    if (valid(value)) result = value;
  } catch {
    /* Missing data must produce an incomplete comment, not a pass. */
  }
  const marker = `<!-- tracedojo:${run.workflow_id} -->`;
  for (const candidate of associated) {
    const { data: pr } = await github.rest.pulls.get({
      ...repo,
      pull_number: candidate.number,
    });
    if (
      pr.state !== 'open' ||
      pr.head.sha !== run.head_sha ||
      pr.base.repo.full_name !== `${repo.owner}/${repo.repo}` ||
      pr.head.repo?.full_name !== run.head_repository.full_name
    )
      continue;
    if (
      result &&
      (result.source.headSha !== pr.head.sha ||
        result.source.baseSha !== pr.base.sha)
    ) {
      core.info('The PR moved since this comparison. Skipping stale evidence.');
      continue;
    }
    const usable =
      result &&
      (result.status !== 'no_regressions' || run.conclusion === 'success');
    const regressions = usable
      ? result.scenarios.filter((row) => row.status === 'regressed').length
      : 0;
    const title =
      !usable || result.status === 'incomparable'
        ? 'Comparison incomplete'
        : regressions
          ? `${regressions} scenario(s) regressed vs base`
          : 'No new regressions vs base';
    const lines = [
      marker,
      `<!-- tracedojo-run:${run.id}:${run.run_attempt} -->`,
      `## TraceDojo: ${title}`,
      '',
      `Head: \`${pr.head.sha.slice(0, 7)}\` · Base: \`${pr.base.sha.slice(0, 7)}\``,
      '',
    ];
    if (usable && result.status !== 'incomparable') {
      lines.push(
        '| Scenario | Base failures | PR failures | Trials | Change |',
        '| --- | ---: | ---: | ---: | --- |',
      );
      for (const row of result.scenarios)
        lines.push(
          `| ${escape(row.title.slice(0, 200))} | ${row.baseFailures} | ${row.candidateFailures} | ${row.trials} | ${row.status} |`,
        );
      lines.push(
        '',
        'Known failures may remain. Counts describe observed trials, not a reliability guarantee.',
      );
    } else
      lines.push(
        'No passing regression verdict is available. Check for missing baseline evidence, changed conditions, interrupted trials, or a CI error.',
      );
    lines.push(
      '',
      `[View checks and evidence](https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id})`,
    );
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const existing = comments.find(
      (item) =>
        item.user?.login === 'github-actions[bot]' &&
        item.user?.type === 'Bot' &&
        item.body?.startsWith(marker),
    );
    if (existing) {
      const previous = existing.body.match(
        /<!-- tracedojo-run:(\d+):(\d+) -->/,
      );
      if (
        previous &&
        (+previous[1] > run.id ||
          (+previous[1] === run.id && +previous[2] > run.run_attempt))
      )
        continue;
    }
    // Recheck the moving PR before updating; artifact contents never select a PR.
    const { data: current } = await github.rest.pulls.get({
      ...repo,
      pull_number: pr.number,
    });
    if (
      current.state !== 'open' ||
      current.head.sha !== pr.head.sha ||
      current.base.sha !== pr.base.sha
    )
      continue;
    const body = lines.join('\n');
    if (existing)
      await github.rest.issues.updateComment({
        ...repo,
        comment_id: existing.id,
        body,
      });
    else
      await github.rest.issues.createComment({
        ...repo,
        issue_number: pr.number,
        body,
      });
  }
};
