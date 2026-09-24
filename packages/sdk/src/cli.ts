#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { parseArgs } from 'node:util';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runWorkflow, type WorkflowAdapter } from './index.js';
import {
  boundedJson,
  parseWorkflow,
  workflowExitCode,
  commitShaSchema,
} from './schema.js';
import { sanitizeWorkflowBatch } from './privacy.js';
import { importLangSmithTrace } from './langsmith.js';
import { uploadWorkflowReports } from './upload.js';
import { createStarter } from './starter.js';
import { workflowSummary } from './summary.js';
import { runDemo } from './demo.js';
import { starterWorlds } from './worlds.js';
import { createLangSmithStarter } from './langsmith-starter.js';
import { writeFaultMatrix, testFaultMatrix } from './matrix-cli.js';
import type { MatrixOptions } from './matrix.js';
import {
  compareWorkflowBatches,
  comparisonExitCode,
  comparisonSummary,
} from './compare.js';

const help = `TraceDojo — test your agent against controlled tool failures

  tracedojo demo
  tracedojo init --out dojo --ci
  tracedojo templates
  tracedojo init --template refunds --out dojo
  tracedojo init --virtual-time --out dojo
  tracedojo test
  tracedojo matrix --out dojo/matrix.json
  tracedojo matrix --tools reserve_slot --faults timeout_after,duplicate_delivery --out dojo/matrix.json
  tracedojo test-matrix dojo/matrix.json --adapter dojo/adapter.mjs --out matrix-reports
  tracedojo test --config dojo/workflow.json --adapter dojo/adapter.mjs --out dojo-report.json
  tracedojo compare --base main-report.json --candidate pr-report.json --out comparison.json --summary comparison.md
  tracedojo import-langsmith trace.json --out imported-dojo
  tracedojo import-langsmith trace.json --draft-only --out trace-draft.json
  tracedojo upload dojo-report.json --url https://tracedojo.com --project PROJECT_UUID

Uploads use TRACEDOJO_UPLOAD_TOKEN from your environment; credentials stay local.

test runs a no-fault control followed by every configured scenario.
  --trials 1–20 independent attempts per scenario (default 1)
  --out    New JSON file; existing evidence is never overwritten
           Default: .tracedojo/reports/<unique-id>.json
  --summary  Optional new Markdown summary file for CI
  --commit   Full lowercase Git SHA to label test/test-matrix reports for trends

matrix reads declared tool kinds and generates editable suites without running an agent.
  --config  Task, starting state, checks, and optional existing scenarios
  --tools   Optional comma-separated tool names (default: every declared tool)
  --faults  Optional comma-separated fault types; stale_read is opt-in
test-matrix saves a normal report per suite plus index.json in a NEW directory.
Review generated scenarios and expected outcomes before running paid model adapters.

init --ci creates test/comment workflows and a trusted comment script under .github/.
Existing files are never overwritten. Merge this setup to the default branch first.
Install the SDK in your npm project and commit its lockfile before enabling CI.

The adapter is trusted local JavaScript (.mjs/.js). It can access your environment
and network. Simulated tools may be async and must operate only on their state
draft. Deadlines are cooperative, not process isolation. Model API calls in your
adapter may incur provider charges; the shipped reference agent uses no API.

LangSmith imports create a runnable playback scaffold with TODOs and observed signatures.
Use --draft-only for a JSON review draft. Recorded outputs do not establish correctness.
Review the task, starting state, tool implementations, and outcome checks.

Exit codes: 0 pass, 1 failed checks, 2 invalid input, 3 incomplete/inconclusive.
demo exits 0 when it reproduces both the expected failure and the passing fix.
`;

async function readJson(file: string) {
  if ((await stat(file)).size > 5_000_000)
    throw new Error('JSON exceeds the 5 MB limit.');
  const input: unknown = JSON.parse(await readFile(file, 'utf8'));
  boundedJson(input);
  return input;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      adapter: { type: 'string' },
      out: { type: 'string' },
      trials: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      url: { type: 'string' },
      project: { type: 'string' },
      ci: { type: 'boolean' },
      summary: { type: 'string' },
      template: { type: 'string' },
      'draft-only': { type: 'boolean' },
      base: { type: 'string' },
      candidate: { type: 'string' },
      'base-sha': { type: 'string' },
      'head-sha': { type: 'string' },
      'virtual-time': { type: 'boolean' },
      tools: { type: 'string' },
      faults: { type: 'string' },
      commit: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(help);
    return;
  }
  if (command === 'matrix' || command === 'test-matrix') {
    const allowed =
      command === 'matrix'
        ? ['config', 'adapter', 'out', 'tools', 'faults']
        : ['adapter', 'out', 'trials', 'commit'];
    if (
      positionals.length !== (command === 'matrix' ? 1 : 2) ||
      Object.keys(values).some((key) => !allowed.includes(key))
    )
      throw new Error('Unsupported matrix arguments. See --help.');
    const input = await readJson(
      resolve(
        command === 'matrix'
          ? (values.config ?? 'dojo/workflow.json')
          : positionals[1]!,
      ),
    );
    const adapter = resolve(values.adapter ?? 'dojo/adapter.mjs');
    if (!/\.(?:mjs|js)$/.test(adapter) || !(await stat(adapter)).isFile())
      throw new Error('Use a trusted local .mjs or .js adapter module.');
    if (command === 'matrix') {
      const destination = resolve(
        values.out ?? `.tracedojo/matrices/${randomUUID()}.json`,
      );
      const matrix = await writeFaultMatrix(input, adapter, destination, {
        ...(values.tools !== undefined
          ? { tools: values.tools.split(',').map((tool) => tool.trim()) }
          : {}),
        ...(values.faults !== undefined
          ? {
              faults: values.faults
                .split(',')
                .map((fault) => fault.trim()) as MatrixOptions['faults'],
            }
          : {}),
      });
      console.log(
        `Generated ${matrix.suites.length} tool suites, ${matrix.suites.reduce((count, suite) => count + suite.workflow.scenarios.length, 0)} scenarios. Generation does not invoke agents or tool handlers; importing the adapter still executes local code.`,
      );
      console.log(`Matrix: ${destination}`);
      console.log(
        'Review expectations before running test-matrix. Original scenarios are preserved in your source config; only exact-match check overrides carry into generated cases. Prompt injections need a reviewed payload; stale reads are opt-in and require history.',
      );
    } else {
      const destination = resolve(
        values.out ?? `.tracedojo/matrix-reports/${randomUUID()}`,
      );
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const result = await testFaultMatrix(
          input,
          adapter,
          destination,
          Number(values.trials ?? 1),
          controller.signal,
          values.commit,
        );
        for (const suite of result.suites)
          console.log(`${suite.tool}: ${suite.status}`);
        if (result.reason) console.log(result.reason);
        console.log(
          `Completed ${result.completed}/${result.planned} suites. Reports: ${destination}`,
        );
        process.exitCode = result.exitCode;
      } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
    }
    return;
  }
  if (command === 'upload') {
    if (
      positionals.length !== 2 ||
      Object.keys(values).some((key) => !['url', 'project'].includes(key))
    )
      throw new Error('upload takes one report file and --url/--project.');
    const receipt = await uploadWorkflowReports(
      await readJson(resolve(positionals[1]!)),
      {
        url: values.url ?? process.env.TRACEDOJO_URL ?? '',
        project: values.project ?? process.env.TRACEDOJO_PROJECT_ID ?? '',
        token: process.env.TRACEDOJO_UPLOAD_TOKEN ?? '',
      },
    );
    console.log(`Uploaded ${receipt.count} reports. ${receipt.url}`);
    return;
  }
  if (command === 'compare') {
    if (
      positionals.length !== 1 ||
      !values.base ||
      !values.candidate ||
      Object.keys(values).some(
        (key) =>
          ![
            'base',
            'candidate',
            'out',
            'summary',
            'base-sha',
            'head-sha',
          ].includes(key),
      )
    )
      throw new Error('compare requires --base and --candidate report files.');
    if (
      (values['base-sha'] || values['head-sha']) &&
      (!/^[a-f0-9]{40}$/.test(values['base-sha'] ?? '') ||
        !/^[a-f0-9]{40}$/.test(values['head-sha'] ?? ''))
    )
      throw new Error(
        'Provide both --base-sha and --head-sha as full commit hashes.',
      );
    const readOptional = async (file: string) => {
      try {
        return await readJson(resolve(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return undefined;
        throw error;
      }
    };
    const result = compareWorkflowBatches(
      await readOptional(values.base),
      await readOptional(values.candidate),
    );
    const destination = resolve(
      values.out ?? `.tracedojo/comparisons/${randomUUID()}.json`,
    );
    await mkdir(dirname(destination), { recursive: true });
    const output = await open(destination, 'wx', 0o600);
    let summary: Awaited<ReturnType<typeof open>> | undefined;
    let saved = false;
    try {
      if (values.summary) {
        await mkdir(dirname(resolve(values.summary)), { recursive: true });
        summary = await open(resolve(values.summary), 'wx', 0o600);
      }
      const source = values['base-sha']
        ? { baseSha: values['base-sha'], headSha: values['head-sha'] }
        : undefined;
      await output.writeFile(
        JSON.stringify({ ...result, ...(source ? { source } : {}) }, null, 2) +
          '\n',
      );
      if (summary) await summary.writeFile(comparisonSummary(result));
      saved = true;
      console.log(result.reason);
      process.exitCode = comparisonExitCode(result);
    } finally {
      await output.close();
      await summary?.close();
      if (!saved) {
        await unlink(destination);
        if (summary) await unlink(resolve(values.summary!));
      }
    }
    return;
  }
  const allowed =
    command === 'test'
      ? ['config', 'adapter', 'out', 'trials', 'summary', 'commit']
      : command === 'init'
        ? ['out', 'ci', 'template', 'virtual-time']
        : command === 'templates'
          ? []
          : command === 'import-langsmith'
            ? ['out', 'draft-only']
            : ['out'];
  if (
    Object.keys(values).some((key) => !allowed.includes(key)) ||
    positionals.length !== (command === 'import-langsmith' ? 2 : 1)
  )
    throw new Error('Unsupported arguments. See --help.');
  if (command === 'templates') {
    for (const world of starterWorlds)
      console.log(`${world.id.padEnd(16)} ${world.title}`);
    return;
  }
  if (command === 'init') {
    const directory = resolve(values.out ?? 'dojo');
    await createStarter(
      directory,
      values.ci ?? false,
      values.template,
      values['virtual-time'] ?? false,
    );
    console.log(
      `Created ${directory}. See its README.md to run the example and connect your agent.${values.ci ? '\nCreated test/comment workflows and .github/tracedojo/comment.cjs. Commit these files, your SDK dependency, and lockfile to the default branch before running PR checks.' : ''}`,
    );
    return;
  }
  if (command === 'demo') {
    const directory = resolve(values.out ?? `.tracedojo/demo-${randomUUID()}`);
    await mkdir(dirname(directory), { recursive: true });
    const { before, after } = await runDemo(directory);
    console.log(
      'A booking succeeded. Its confirmation timed out. The agent retried.',
    );
    console.log(
      `Before: ${before.runs[0]!.status} — ${before.runs[0]!.metrics.mutations} committed writes; duplicate booking.`,
    );
    console.log(
      `After:  ${after.runs[0]!.status} — ${after.runs[0]!.metrics.mutations} committed write; the retry reused the original booking.`,
    );
    console.log(
      'Both no-fault controls passed. Scripted example; no model calls.',
    );
    console.log(
      `Open before.json and after.json from ${directory} in a project at https://tracedojo.com (sign-in required), using Workflows → Preview report. Preview does not save reports.\nLocal dashboard and upload instructions: https://tracedojo.com/docs#inspect-and-save-reports`,
    );
    return;
  }
  if (!['test', 'import-langsmith'].includes(command))
    throw new Error('Unknown command. See --help.');
  if (!values.out && command === 'import-langsmith')
    throw new Error(
      'Choose a new --out directory (or file with --draft-only). Existing files are never overwritten.',
    );
  if (command === 'import-langsmith' && !values['draft-only']) {
    const result = await createLangSmithStarter(
      await readJson(resolve(positionals[1]!)),
      resolve(values.out!),
    );
    console.log(
      `Created a runnable playback scaffold: ${result.tools} tool stubs, ${result.calls} observed calls. See README.md for the test command and TODOs. This does not test your actual agent yet.`,
    );
    return;
  }
  let workflow;
  const trials = Number(values.trials ?? 1);
  if (command === 'test') {
    if (values.commit !== undefined) commitShaSchema.parse(values.commit);
    values.config ??= 'dojo/workflow.json';
    values.adapter ??= 'dojo/adapter.mjs';
    workflow = parseWorkflow(await readJson(resolve(values.config)));
    if (!Number.isInteger(trials) || trials < 1 || trials > 20)
      throw new Error('--trials must be from 1 to 20.');
    if (
      !/\.(?:mjs|js)$/.test(values.adapter) ||
      !(await stat(resolve(values.adapter))).isFile()
    )
      throw new Error('Use a trusted local .mjs or .js adapter module.');
  }
  const destination = resolve(
    values.out ?? `.tracedojo/reports/${randomUUID()}.json`,
  );
  await mkdir(dirname(destination), { recursive: true });
  const output = await open(destination, 'wx', 0o600);
  let saved = false;
  let summaryOutput: Awaited<ReturnType<typeof open>> | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    // Reserve every destination before invoking customer code or a paid model.
    if (values.summary) {
      await mkdir(dirname(resolve(values.summary)), { recursive: true });
      summaryOutput = await open(resolve(values.summary), 'wx', 0o600);
    }
    if (command === 'import-langsmith') {
      const draft = importLangSmithTrace(
        await readJson(resolve(positionals[1]!)),
      );
      await output.writeFile(JSON.stringify(draft, null, 2) + '\n');
      saved = true;
      console.log(
        `Saved a review draft with ${draft.observedCalls.length} observed tool calls. Supply starting state, tools, and checks before running.`,
      );
      return;
    }
    let adapter: WorkflowAdapter;
    try {
      adapter = await import(pathToFileURL(resolve(values.adapter!)).href);
    } catch {
      throw new Error(
        'Could not load the adapter. Check its syntax and installed dependencies.',
      );
    }
    const batch = sanitizeWorkflowBatch(
      await runWorkflow(workflow, adapter, {
        trials,
        signal: controller.signal,
        commitSha: values.commit,
      }),
    );
    await output.writeFile(JSON.stringify(batch, null, 2) + '\n');
    saved = true;
    if (summaryOutput) await summaryOutput.writeFile(workflowSummary(batch));
    console.log(`Control: ${batch.baseline.status}`);
    for (const run of batch.runs) {
      console.log(`${run.scenario.title}: ${run.status}`);
      for (const check of run.assertions.filter((c) => !c.passed))
        console.log(`  ${check.label}: ${check.detail}`);
    }
    if (batch.skippedReason) console.log(batch.skippedReason);
    console.log(
      `Completed ${batch.runs.length}/${batch.planned} fault trials. Report: ${destination}`,
    );
    process.exitCode = workflowExitCode(batch);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await output.close();
    await summaryOutput?.close();
    if (!saved) await unlink(destination);
    if (!saved && summaryOutput) await unlink(resolve(values.summary!));
  }
}

main().catch((error: unknown) => {
  // Schema validation errors can contain customer inputs; never print them.
  const safe =
    error instanceof Error && error.constructor === Error
      ? error.message
      : 'Invalid input or output. Check the file paths, JSON, and workflow contract.';
  console.error(safe);
  process.exitCode = 2;
});
