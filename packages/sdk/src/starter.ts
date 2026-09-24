// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { worldFiles } from './worlds.js';

export async function createStarter(
  directory: string,
  ci: boolean,
  template = 'calendar',
  virtualTime = false,
) {
  const files = await worldFiles(template);
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  files['README.md'] =
    '# Install the SDK first\n\n' +
    'Running `npx tracedojo init` creates files but does not install a project dependency. ' +
    'From your repository root, run `npm init -y` only if you do not already have a package.json, then:\n\n' +
    `\`\`\`sh\nnpm install --save-dev --save-exact @tracedojo/sdk@${version}\n\`\`\`\n\n` +
    'The test commands below use that local installation. Commit package.json and package-lock.json for reproducible CI.\n\n' +
    files['README.md'];
  if (ci) {
    files['README.md'] +=
      '\n## First CI run\n\nThe generated push filter uses `main`. Change it in `.github/workflows/tracedojo.yml` if your default branch differs. The first adoption PR can report an incomplete comparison because no baseline exists yet. Merge the generated workflows and comment script to the default branch, then verify its baseline run succeeds before requiring `agent-checks` in branch protection. Subsequent PRs need a report for their exact base commit; rerun that base workflow if its artifact is missing or expired.\n';
  }
  files['README.md'] +=
    '\n## View your reports\n\nAt https://tracedojo.com, sign in, create a project, and open Workflows → Preview report to inspect JSON in your browser. Preview does not save it. To save reports, create an upload token in project settings and follow the upload instructions in https://github.com/syedarman1/TraceDojo/blob/main/docs/WORKFLOWS.md#inspect-and-save-reports. That guide also covers running the dashboard locally without an account. Never commit upload tokens or private reports.\n';
  if (virtualTime) {
    const workflow = JSON.parse(files['workflow.json']!);
    workflow.clock = { mode: 'virtual', startMs: 0, maxTimeMs: 60000 };
    files['workflow.json'] = JSON.stringify(workflow, null, 2) + '\n';
    files['reference.mjs'] = files['adapter.mjs']!;
    files['adapter.mjs'] = await readFile(
      new URL('../templates/clock-adapter.mjs', import.meta.url),
      'utf8',
    );
    files['README.md'] =
      files['README.md']!.replace(
        'In `adapter.mjs`',
        'In `reference.mjs`',
      ).replace('in the reference agent', 'in `reference.mjs`') +
      '\n## Virtual time\n\nThe original tool/agent implementation is in `reference.mjs`. `adapter.mjs` wraps it with 25 ms of simulated service delay and 1000 ms of retry backoff. Run the same test command above. Each trial starts at virtual time zero. Reports include `clock.startMs`, `clock.endMs`, and event `timeMs`; `metrics.durationMs` remains actual runtime. Change the synthetic tool behavior and retry key in `reference.mjs`.\n\nUse the supplied `clock.now()` and `await clock.sleep(ms)` in custom logic. Date.now(), native timers, and external services are not virtualized. Whole tool transactions remain serialized. The clock has a per-trial time budget and a 1000-sleep cap; the real wall-clock deadline remains active.\n';
  }
  const configPath = relative(
    process.cwd(),
    resolve(directory, 'workflow.json'),
  );
  if (
    ci &&
    (isAbsolute(configPath) ||
      configPath.startsWith(`..${sep}`) ||
      !/^[a-zA-Z0-9_./ -]+$/.test(configPath))
  )
    throw new Error(
      'With --ci, choose a folder inside this repository using letters, numbers, spaces, dashes, or underscores.',
    );
  const created: string[] = [];
  const ciFile = resolve('.github/workflows/tracedojo.yml');
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const file of [...Object.keys(files), 'LICENSE', 'NOTICE']) {
      const destination = resolve(directory, file);
      await writeFile(
        destination,
        files[file] ??
          (await readFile(
            new URL(
              file === 'LICENSE' || file === 'NOTICE'
                ? `../${file}`
                : `../templates/${file}`,
              import.meta.url,
            ),
          )),
        { flag: 'wx', mode: 0o600 },
      );
      created.push(destination);
    }
    if (ci) {
      const template = await readFile(
        new URL('../templates/ci.yml', import.meta.url),
        'utf8',
      );
      await mkdir(dirname(ciFile), { recursive: true });
      await writeFile(
        ciFile,
        template
          .replace(
            'TRACEDOJO_CONFIG_TEMPLATE',
            JSON.stringify(configPath.split(sep).join('/')),
          )
          .replace(
            'TRACEDOJO_ADAPTER_TEMPLATE',
            JSON.stringify(
              relative(process.cwd(), resolve(directory, 'adapter.mjs'))
                .split(sep)
                .join('/'),
            ),
          ),
        { flag: 'wx', mode: 0o600 },
      );
      created.push(ciFile);
      for (const [source, path] of [
        ['ci-comment.yml', '.github/workflows/tracedojo-comment.yml'],
        ['comment.cjs', '.github/tracedojo/comment.cjs'],
      ]) {
        const destination = resolve(path!);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(
          destination,
          await readFile(new URL(`../templates/${source}`, import.meta.url)),
          { flag: 'wx', mode: 0o600 },
        );
        created.push(destination);
      }
    }
  } catch (error) {
    // Only remove files created by this attempt. Never replace an existing setup.
    for (const file of created.reverse()) await unlink(file);
    await rmdir(directory);
    throw error;
  }
}
