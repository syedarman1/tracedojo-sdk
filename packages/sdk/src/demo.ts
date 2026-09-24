// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runWorkflow, type WorkflowAdapter } from './index.js';
import { parseWorkflow } from './schema.js';
import { sanitizeWorkflowBatch } from './privacy.js';

/** Run a known failure and fix using the same engine and tools as customer tests. */
export async function runDemo(directory: string) {
  // Reserve a new directory before doing any work. Preserve earlier evidence.
  await mkdir(directory, { mode: 0o700 });
  const workflow = parseWorkflow(
    JSON.parse(
      await readFile(
        new URL('../templates/workflow.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  workflow.scenarios = workflow.scenarios.filter(
    (scenario) => scenario.id === 'lost-confirmation',
  );
  const template = new URL('../templates/adapter.mjs', import.meta.url);
  const reference: WorkflowAdapter = await import(template.href);
  const adapter = (stable: boolean): WorkflowAdapter => ({
    tools: reference.tools,
    createAgent() {
      const agent = reference.createAgent();
      let attempt = 0;
      return {
        ...agent,
        version: stable ? 'stable-key' : 'new-key-per-retry',
        run(context) {
          return agent.run({
            ...context,
            call: (tool, args) =>
              context.call(
                tool,
                stable
                  ? args
                  : { ...args, operationKey: `attempt_${++attempt}` },
              ),
          });
        },
      };
    },
  });
  const before = sanitizeWorkflowBatch(
    await runWorkflow(workflow, adapter(false)),
  );
  await writeFile(
    resolve(directory, 'before.json'),
    JSON.stringify(before, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const after = sanitizeWorkflowBatch(
    await runWorkflow(workflow, adapter(true)),
  );
  await writeFile(
    resolve(directory, 'after.json'),
    JSON.stringify(after, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  if (
    before.baseline.status !== 'passed' ||
    after.baseline.status !== 'passed' ||
    before.runs[0]?.status !== 'failed' ||
    after.runs[0]?.status !== 'passed'
  )
    throw new Error(
      'The demo did not reproduce its expected failure and fix. Inspect the saved reports.',
    );
  return { before, after };
}
