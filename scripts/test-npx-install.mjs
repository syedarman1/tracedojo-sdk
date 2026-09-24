// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(tmpdir(), 'tracedojo-npx-'));
function run(command, args, cwd, extraEnv = {}, expected = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, expected, output);
        resolve(output);
      } catch (error) {
        reject(error);
      }
    });
  });
}

// A throwaway registry serves the exact archives to npx. This tests cold package
// resolution without publishing anything or relying on workspace symlinks.
const manifests = new Map();
const archives = new Map();
const requests = new Set();
let origin;
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(
      new URL(request.url, origin).pathname,
    ).slice(1);
    requests.add(path);
    if (archives.has(path)) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end(archives.get(path));
    } else if (manifests.has(path)) {
      const manifest = manifests.get(path);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          name: manifest.name,
          'dist-tags': { latest: manifest.version },
          versions: {
            [manifest.version]: {
              ...manifest,
              dist: {
                tarball: `${origin}/${path === 'tracedojo' ? 'launcher' : 'sdk'}.tgz`,
              },
            },
          },
        }),
      );
    } else if (path === 'zod' || /^zod\/-\/zod-[\d.]+\.tgz$/.test(path)) {
      const upstream = await fetch(`https://registry.npmjs.org/${path}`, {
        signal: AbortSignal.timeout(15000),
      });
      response.writeHead(upstream.status, {
        'Content-Type':
          path === 'zod' ? 'application/json' : 'application/octet-stream',
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  } catch {
    response.writeHead(500);
    response.end('{}');
  }
});

try {
  for (const directory of ['sdk', 'npx']) {
    const manifest = JSON.parse(
      await readFile(
        join(repository, `packages/${directory}/package.json`),
        'utf8',
      ),
    );
    manifests.set(manifest.name, manifest);
    await run(
      'npm',
      ['pack', '--workspace', manifest.name, '--pack-destination', temp],
      repository,
    );
    const archive = join(
      temp,
      `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`,
    );
    archives.set(
      directory === 'sdk' ? 'sdk.tgz' : 'launcher.tgz',
      await readFile(archive),
    );
    const contents = await run('tar', ['-tzf', archive], repository);
    assert.match(contents, /package\/LICENSE/);
    assert.match(contents, /package\/NOTICE/);
    assert.match(contents, /package\/README.md/);
    assert.doesNotMatch(contents, /apps\/|\.env|private-traces|local-runs/);
    const license = await run(
      'tar',
      ['-xOf', archive, 'package/LICENSE'],
      repository,
    );
    assert.match(license, /Apache License/);
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const project = join(temp, 'empty-project');
  await mkdir(project);
  const userConfig = join(temp, 'empty.npmrc');
  await writeFile(userConfig, '');
  const env = {
    npm_config_cache: join(temp, 'empty-cache'),
    npm_config_registry: origin,
    npm_config_userconfig: userConfig,
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
  };
  await run(
    'npx',
    ['--yes', 'tracedojo', 'init', '--ci', '--virtual-time'],
    project,
    env,
  );
  assert.match(
    await readFile(
      join(project, '.github/workflows/tracedojo-comment.yml'),
      'utf8',
    ),
    /workflow_run/,
  );
  assert.match(
    await readFile(join(project, '.github/tracedojo/comment.cjs'), 'utf8'),
    /module.exports/,
  );
  assert.match(
    await readFile(join(project, 'dojo/LICENSE'), 'utf8'),
    /Apache License/,
  );
  const starterReadme = await readFile(join(project, 'dojo/README.md'), 'utf8');
  assert.match(starterReadme, /https:\/\/tracedojo\.com\/docs/);
  assert.doesNotMatch(starterReadme, /github\.com\/syedarman1\/TraceDojo/);
  assert.ok(requests.has('tracedojo') && requests.has('@tracedojo/sdk'));
  assert.ok(requests.has('launcher.tgz') && requests.has('sdk.tgz'));
  await run(
    'npx',
    [
      '--yes',
      'tracedojo',
      'test',
      '--out',
      'clock-report.json',
      '--commit',
      'a'.repeat(40),
    ],
    project,
    env,
  );
  const clockReport = JSON.parse(
    await readFile(join(project, 'clock-report.json'), 'utf8'),
  );
  assert.equal(clockReport.baseline.clock.endMs, 25);
  assert.equal(clockReport.baseline.execution.commitSha, 'a'.repeat(40));
  assert.ok(
    clockReport.runs.every(
      (run) => run.execution.id === clockReport.baseline.execution.id,
    ),
  );
  assert.match(
    await readFile(join(project, '.github/workflows/tracedojo.yml'), 'utf8'),
    /DOJO_COMMIT_SHA: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/,
  );
  assert.deepEqual(
    clockReport.runs.map((run) => run.clock.endMs),
    [1050, 1025, 1025, 1050, 0],
  );
  assert.ok(clockReport.runs.every((run) => run.status === 'passed'));
  await run(
    'npx',
    ['--yes', 'tracedojo', 'matrix', '--out', 'matrix.json'],
    project,
    env,
  );
  await run(
    'npx',
    [
      '--yes',
      'tracedojo',
      'test-matrix',
      'matrix.json',
      '--out',
      'matrix-reports',
      '--commit',
      'b'.repeat(40),
    ],
    project,
    env,
  );
  const matrixIndex = JSON.parse(
    await readFile(join(project, 'matrix-reports/index.json'), 'utf8'),
  );
  assert.equal(matrixIndex.status, 'passed');
  assert.equal(matrixIndex.completed, 1);
  const matrixReport = JSON.parse(
    await readFile(
      join(project, 'matrix-reports', matrixIndex.suites[0].report),
      'utf8',
    ),
  );
  assert.equal(matrixReport.runs.length, 6);
  assert.equal(matrixReport.baseline.execution.commitSha, 'b'.repeat(40));
  assert.ok(
    matrixReport.runs.every(
      (run) => run.execution.commitSha === 'b'.repeat(40),
    ),
  );
  assert.ok(
    matrixReport.runs.every(
      (run) => run.status === 'passed' && run.fault.triggered,
    ),
  );
  assert.ok(
    matrixReport.runs.some(
      (run) => run.scenario.fault.type === 'duplicate_delivery',
    ),
  );
  await run('npx', ['--yes', 'tracedojo', 'templates'], project, env);
  for (const [template, safeCode, unsafeCode] of [
    [
      'prompt-injection',
      'trustToolInstructions = false',
      'trustToolInstructions = true',
    ],
    ['duplicate-delivery', 'deduplicate = true', 'deduplicate = false'],
    ['stale-read', 'verifyVersion = true', 'verifyVersion = false'],
  ]) {
    await run(
      'npx',
      ['--yes', 'tracedojo', 'init', '--template', template, '--out', template],
      project,
      env,
    );
    const args = [
      '--yes',
      'tracedojo',
      'test',
      '--config',
      `${template}/workflow.json`,
      '--adapter',
      `${template}/adapter.mjs`,
    ];
    await run('npx', [...args, '--out', `${template}-safe.json`], project, env);
    const file = join(project, template, 'adapter.mjs');
    const source = await readFile(file, 'utf8');
    assert.ok(source.includes(safeCode));
    await writeFile(file, source.replace(safeCode, unsafeCode));
    await run(
      'npx',
      [...args, '--out', `${template}-unsafe.json`],
      project,
      env,
      1,
    );
    const batch = JSON.parse(
      await readFile(join(project, `${template}-unsafe.json`), 'utf8'),
    );
    assert.equal(batch.baseline.status, 'passed');
    assert.equal(batch.runs[0].status, 'failed');
    assert.equal(batch.runs[0].fault.triggered, true);
  }
  await run(
    'npx',
    ['--yes', 'tracedojo', 'init', '--template', 'refunds', '--out', 'refunds'],
    project,
    env,
  );
  await run(
    'npx',
    [
      '--yes',
      'tracedojo',
      'test',
      '--config',
      'refunds/workflow.json',
      '--adapter',
      'refunds/adapter.mjs',
    ],
    project,
    env,
  );
  const demoOutput = await run(
    'npx',
    ['--yes', 'tracedojo', 'demo', '--out', 'demo-evidence'],
    project,
    env,
  );
  assert.match(demoOutput, /https:\/\/tracedojo\.com\/docs/);
  assert.doesNotMatch(demoOutput, /github\.com\/syedarman1\/TraceDojo/);
  const beforeText = await readFile(
    join(project, 'demo-evidence/before.json'),
    'utf8',
  );
  await run(
    'npx',
    [
      '--yes',
      'tracedojo',
      'compare',
      '--base',
      'demo-evidence/after.json',
      '--candidate',
      'demo-evidence/before.json',
      '--out',
      'regression.json',
    ],
    project,
    env,
    1,
  );
  await run(
    'npx',
    [
      '--yes',
      'tracedojo',
      'compare',
      '--base',
      'demo-evidence/before.json',
      '--candidate',
      'demo-evidence/after.json',
      '--out',
      'improvement.json',
    ],
    project,
    env,
  );
  await run(
    'npx',
    [
      '--yes',
      'tracedojo',
      'compare',
      '--base',
      'missing.json',
      '--candidate',
      'demo-evidence/after.json',
      '--out',
      'incomplete.json',
    ],
    project,
    env,
    3,
  );
  await writeFile(
    join(project, 'trace.json'),
    JSON.stringify({
      id: 'root',
      name: 'Example agent',
      run_type: 'chain',
      inputs: { task: 'Look up an order' },
      child_runs: [
        {
          id: 'lookup',
          parent_run_id: 'root',
          name: 'lookup_order',
          run_type: 'tool',
          inputs: { id: 'order_7' },
          outputs: { status: 'paid' },
        },
      ],
    }),
  );
  await run(
    'npx',
    [
      '--yes',
      'tracedojo',
      'import-langsmith',
      'trace.json',
      '--out',
      'imported',
    ],
    project,
    env,
  );
  await run(
    'npx',
    [
      '--yes',
      'tracedojo',
      'test',
      '--config',
      'imported/workflow.json',
      '--adapter',
      'imported/adapter.mjs',
      '--out',
      'imported-report.json',
    ],
    project,
    env,
    1,
  );
  const imported = JSON.parse(
    await readFile(join(project, 'imported-report.json'), 'utf8'),
  );
  assert.equal(imported.baseline.status, 'passed');
  assert.equal(imported.runs[0].status, 'failed');
  assert.equal(imported.runs[0].fault.triggered, true);
  const before = JSON.parse(beforeText);
  const after = JSON.parse(
    await readFile(join(project, 'demo-evidence/after.json'), 'utf8'),
  );
  assert.equal(before.baseline.status, 'passed');
  assert.equal(after.baseline.status, 'passed');
  assert.equal(before.runs[0].status, 'failed');
  assert.equal(before.runs[0].finalState.bookings.length, 2);
  assert.equal(after.runs[0].status, 'passed');
  assert.equal(after.runs[0].finalState.bookings.length, 1);
  assert.equal(before.runs[0].suiteFingerprint, after.runs[0].suiteFingerprint);
  await run(
    'npx',
    ['--yes', 'tracedojo', 'demo', '--out', 'demo-evidence'],
    project,
    env,
    2,
  );
  assert.equal(
    await readFile(join(project, 'demo-evidence/before.json'), 'utf8'),
    beforeText,
  );
  console.log(
    'Cold npx verified with packed release artifacts: empty directory/cache → init → test → failure/fix demo. Public registry publishing is a separate step.',
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
