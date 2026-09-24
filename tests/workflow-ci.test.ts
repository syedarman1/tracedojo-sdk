// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const yaml = await readFile('packages/sdk/templates/ci.yml', 'utf8');
function block(name: string, field: string) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0);
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith('      - ')) end++;
  const section = lines.slice(start, end);
  const index = section.findIndex((line) => line.trim() === `${field}: |`);
  assert.ok(index >= 0);
  const indent = section[index]!.indexOf(field) + 2;
  return section
    .slice(index + 1)
    .map((line) => line.slice(indent))
    .join('\n');
}

test('actual CI shell captures exits and refuses stale evidence after an invalid or incomplete test', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dojo-ci-shell-'));
  try {
    await mkdir(join(dir, 'bin'));
    await writeFile(
      join(dir, 'bin/npx'),
      '#!/bin/sh\nprintf invoked >> "$DOJO_MARKER"\nexit "$DOJO_FAKE_EXIT"\n',
      { mode: 0o700 },
    );
    for (const code of [0, 1, 2, 3]) {
      const marker = join(dir, `marker-${code}`);
      const output = join(dir, `output-${code}`);
      const env = {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        DOJO_MARKER: marker,
        DOJO_FAKE_EXIT: String(code),
        DOJO_TEST_EXIT: String(code),
      };
      const candidate = spawnSync(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-eo',
          'pipefail',
          '-c',
          block('Record candidate behavior', 'run'),
        ],
        { cwd: dir, env, encoding: 'utf8' },
      );
      assert.equal(candidate.status, code);
      assert.equal(
        (await readFile(output, 'utf8')).trim(),
        `exit-code=${code}`,
      );
      await rm(marker);
      const gate = spawnSync(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-eo',
          'pipefail',
          '-c',
          block('Gate new regressions', 'run'),
        ],
        { cwd: dir, env, encoding: 'utf8' },
      );
      assert.equal(gate.status, code <= 1 ? code : 3);
      if (code <= 1) assert.equal(await readFile(marker, 'utf8'), 'invoked');
      else await assert.rejects(readFile(marker));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('actual baseline lookup selects the latest trusted base-commit run, never PR evidence', async () => {
  const script = new Function(
    'github',
    'context',
    'core',
    `return (async () => { ${block('Find evidence for the exact base commit', 'script')} })();`,
  );
  const outputs: Record<string, unknown> = {};
  let requests = 0;
  const run = (id: number, event: string, repo = 'owner/repo') => ({
    id,
    event,
    head_repository: { full_name: repo },
  });
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: { workflow_id: 12 } }),
        listWorkflowRuns: async (args: Record<string, unknown>) => {
          requests++;
          assert.equal(args.head_sha, 'a'.repeat(40));
          assert.equal(args.branch, 'main');
          assert.equal(args.workflow_id, 12);
          return {
            data: {
              workflow_runs: [
                run(22, 'pull_request'),
                run(21, 'push', 'fork/repo'),
                run(20, 'workflow_dispatch'),
                run(19, 'push'),
              ],
            },
          };
        },
      },
    },
  };
  await script(
    github,
    {
      repo: { owner: 'owner', repo: 'repo' },
      runId: 99,
      payload: { pull_request: { base: { ref: 'main', sha: 'a'.repeat(40) } } },
    },
    {
      setOutput: (key: string, value: unknown) => {
        outputs[key] = value;
      },
      notice: () => {},
    },
  );
  assert.equal(requests, 1);
  assert.equal(outputs['run-id'], 20);
});
