// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercise the published file layout and npm bin, without workspace resolution.
const repository = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'tracedojo-installed-'));
function run(cwd, args, expected = 0) {
  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result;
}
try {
  run(repository, [
    'pack',
    '--workspace',
    '@tracedojo/sdk',
    '--pack-destination',
    temp,
  ]);
  const { version } = JSON.parse(
    await readFile(join(repository, 'packages/sdk/package.json'), 'utf8'),
  );
  const archive = `tracedojo-sdk-${version}.tgz`;
  const project = join(temp, 'customer app');
  await mkdir(join(project, 'vendor'), { recursive: true });
  await cp(join(temp, archive), join(project, 'vendor', archive));
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: 'sdk-consumer', private: true, type: 'module' }),
  );
  run(project, [
    'install',
    '--save-dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `./vendor/${archive}`,
  ]);
  run(project, ['exec', '--no', '--', 'tracedojo', 'init', '--ci']);

  // A fresh checkout has no links to the original repo or its node_modules.
  const runner = join(temp, 'ci-runner');
  await mkdir(runner);
  for (const file of [
    'package.json',
    'package-lock.json',
    'vendor',
    'dojo',
    '.github',
  ])
    await cp(join(project, file), join(runner, file), { recursive: true });
  run(runner, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  const cli = ['exec', '--no', '--', 'tracedojo'];
  run(runner, [
    ...cli,
    'test',
    '--trials',
    '3',
    '--out',
    '.tracedojo/passed.json',
    '--summary',
    '.tracedojo/passed.md',
    '--commit',
    'a'.repeat(40),
  ]);
  const batch = JSON.parse(
    await readFile(join(runner, '.tracedojo/passed.json'), 'utf8'),
  );
  assert.equal(batch.runs.length, 15);
  assert.equal(batch.baseline.status, 'passed');
  assert.ok(batch.runs.every((r) => r.status === 'passed'));
  const trendCheck = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { workflowTrends } from '@tracedojo/sdk/trends';
    const batch = JSON.parse(await readFile('.tracedojo/passed.json', 'utf8'));
    const result = workflowTrends([batch.baseline, ...batch.runs]);
    assert.equal(result.series.length, 5);
    assert.ok(result.series.every(s => s.points[0].passRate === 100 && s.points[0].planned === 3));
  `,
    ],
    { cwd: runner, encoding: 'utf8' },
  );
  assert.equal(trendCheck.status, 0, trendCheck.stderr);
  const adapter = join(runner, 'dojo/adapter.mjs');
  const source = await readFile(adapter, 'utf8');
  await writeFile(
    adapter,
    source.replace('operationKey,\n', 'operationKey: String(attempt),\n'),
  );
  run(
    runner,
    [
      ...cli,
      'test',
      '--out',
      '.tracedojo/failed.json',
      '--summary',
      '.tracedojo/failed.md',
    ],
    1,
  );
  assert.match(
    await readFile(join(runner, '.tracedojo/failed.md'), 'utf8'),
    /Exactly one booking/,
  );
  await writeFile(adapter, source);
  run(runner, [...cli, 'test']);
  // Run the exact integration example a reader copies from the guide.
  const guide = await readFile(join(repository, 'docs/WORKFLOWS.md'), 'utf8');
  const example = guide.match(/```js\n([\s\S]*?)\n```/)?.[1];
  assert.ok(
    example,
    'The integration guide must include its runnable example.',
  );
  const manifest = JSON.parse(
    await readFile(join(repository, 'package.json'), 'utf8'),
  );
  run(runner, [
    'install',
    '--save-dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `@langchain/core@${manifest.devDependencies['@langchain/core']}`,
    `zod@${manifest.dependencies.zod}`,
  ]);
  await writeFile(join(runner, 'dojo/langchain-adapter.mjs'), example);
  run(runner, [...cli, 'test', '--adapter', 'dojo/langchain-adapter.mjs']);
  console.log(
    'Installed SDK verified: fresh npm project → clean CI install → 15 passing trials → detected duplicate booking → restored fix → documented LangChain adapter.',
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
