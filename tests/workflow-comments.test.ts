import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const comment = require('../packages/sdk/templates/comment.cjs') as (
  options: object,
) => Promise<void>;
function fixture() {
  const head = 'b'.repeat(40),
    base = 'a'.repeat(40);
  const context = {
    repo: { owner: 'owner', repo: 'repo' },
    payload: {
      workflow_run: {
        id: 100,
        run_attempt: 1,
        workflow_id: 10,
        event: 'pull_request',
        head_sha: head,
        head_repository: { full_name: 'owner/repo' },
        conclusion: 'success',
      },
    },
  };
  const pr = {
    number: 7,
    state: 'open',
    head: { sha: head, repo: { full_name: 'owner/repo' } },
    base: { sha: base, repo: { full_name: 'owner/repo' } },
  };
  const state = {
    report: {
      schemaVersion: 'workflow-comparison/1',
      status: 'no_regressions',
      source: { baseSha: base, headSha: head },
      scenarios: [
        {
          id: 'lost-confirmation',
          title: 'Timeout',
          trials: 3,
          baseFailures: 1,
          candidateFailures: 1,
          regressedChecks: [] as string[],
          status: 'unchanged',
        },
      ],
    },
    latest: [{ id: 100, run_attempt: 1 }],
    comments: [] as {
      id: number;
      body: string;
      user: { login: string; type: string };
    }[],
    writes: [] as { type: string; body: string; id: number }[],
  };
  const github = {
    rest: {
      actions: {
        listWorkflowRuns: async () => ({
          data: { workflow_runs: state.latest },
        }),
      },
      repos: { listPullRequestsAssociatedWithCommit: 'prs' },
      pulls: { get: async () => ({ data: structuredClone(pr) }) },
      issues: {
        listComments: 'comments',
        createComment: async ({
          body,
          issue_number,
        }: {
          body: string;
          issue_number: number;
        }) => {
          state.writes.push({ type: 'create', body, id: issue_number });
          state.comments.push({
            id: 42,
            body,
            user: { login: 'github-actions[bot]', type: 'Bot' },
          });
        },
        updateComment: async ({
          body,
          comment_id,
        }: {
          body: string;
          comment_id: number;
        }) => {
          state.writes.push({ type: 'update', body, id: comment_id });
          state.comments.find((item) => item.id === comment_id)!.body = body;
        },
      },
    },
    paginate: async (endpoint: string) =>
      endpoint === 'prs' ? [{ number: 7 }] : state.comments,
  };
  const options = {
    github,
    context,
    core: { info: () => {} },
    read: (): unknown => state.report,
  };
  return { options, state, pr };
}

test('PR commenter creates once, updates its own bot comment and escapes untrusted labels', async () => {
  const { options, state } = fixture();
  state.report.scenarios[0]!.title =
    '@everyone <script> | [click](https://example.com)';
  await comment(options);
  assert.equal(state.writes[0]!.type, 'create');
  assert.equal(state.writes[0]!.id, 7);
  assert.doesNotMatch(state.writes[0]!.body, /@everyone|<script>|\[click\]/);
  assert.match(state.writes[0]!.body, /Known failures may remain/);
  state.report.status = 'regressed';
  state.report.scenarios[0]!.candidateFailures = 2;
  state.report.scenarios[0]!.status = 'regressed';
  options.context.payload.workflow_run.conclusion = 'failure';
  await comment(options);
  assert.equal(state.writes[1]!.type, 'update');
  assert.equal(state.writes[1]!.id, 42);
  assert.match(state.writes[1]!.body, /1 scenario\(s\) regressed/);
});

test('commenter ignores stale heads, bases, runs, reruns and closed PRs', async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => {
      f.pr.head.sha = 'c'.repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.pr.base.sha = 'c'.repeat(40);
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.latest.push({ id: 101, run_attempt: 1 });
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.latest[0]!.run_attempt = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.pr.state = 'closed';
    },
    (f: ReturnType<typeof fixture>) => {
      f.pr.head.repo.full_name = 'different/repo';
    },
  ]) {
    const f = fixture();
    alter(f);
    await comment(f.options);
    assert.equal(f.state.writes.length, 0);
  }
  const f = fixture();
  f.state.comments.push({
    id: 42,
    body: '<!-- tracedojo:10 -->\n<!-- tracedojo-run:101:1 -->',
    user: { login: 'github-actions[bot]', type: 'Bot' },
  });
  await comment(f.options);
  assert.equal(f.state.writes.length, 0);
});

test('missing or inconsistent comparison and failed CI never publish a green comment', async () => {
  for (const read of [
    () => {
      throw new Error('missing');
    },
    () => ({}),
    () => ({ ...fixture().state.report, scenarios: [null] }),
    () => ({ ...fixture().state.report, status: 'regressed' }),
  ]) {
    const f = fixture();
    await comment({ ...f.options, read });
    assert.match(f.state.writes[0]!.body, /Comparison incomplete/);
  }
  const f = fixture();
  f.options.context.payload.workflow_run.conclusion = 'failure';
  await comment(f.options);
  assert.match(f.state.writes[0]!.body, /Comparison incomplete/);
});

test('fork results use API-associated PR identity and never edit a human marker', async () => {
  const f = fixture();
  f.pr.head.repo.full_name = 'contributor/fork';
  f.options.context.payload.workflow_run.head_repository.full_name =
    'contributor/fork';
  f.state.comments.push({
    id: 9,
    body: '<!-- tracedojo:10 -->',
    user: { login: 'human', type: 'User' },
  });
  await comment(f.options);
  assert.equal(f.state.writes[0]!.type, 'create');
  assert.equal(f.state.comments[0]!.body, '<!-- tracedojo:10 -->');
});

test('repository runs the same trusted commenter shipped with the SDK', async () => {
  assert.equal(
    await readFile('.github/tracedojo/comment.cjs', 'utf8'),
    await readFile('packages/sdk/templates/comment.cjs', 'utf8'),
  );
  const workflow = await readFile(
    'packages/sdk/templates/ci-comment.yml',
    'utf8',
  );
  assert.match(
    workflow,
    /ref: \$\{\{ github.event.repository.default_branch \}\}/,
  );
  assert.doesNotMatch(workflow, /npm ci|pull_request_target|head.sha/);
  const execution = await readFile('packages/sdk/templates/ci.yml', 'utf8');
  assert.doesNotMatch(execution, /pull-requests: write/);
  assert.match(execution, /head_sha: context.payload.pull_request.base.sha/);
});
