// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { mkdir, open, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorkflow, type WorkflowAdapter } from './index.js';
import {
  generateFaultMatrix,
  parseMatrixDefinition,
  parseMatrixOptions,
  parseWorkflowMatrix,
  type MatrixOptions,
} from './matrix.js';
import { sanitizeWorkflowBatch } from './privacy.js';
import { workflowExitCode, commitShaSchema } from './schema.js';

async function loadAdapter(path: string): Promise<WorkflowAdapter> {
  try {
    return await import(pathToFileURL(path).href);
  } catch {
    throw new Error(
      'Could not load the trusted local adapter. Check its syntax and dependencies.',
    );
  }
}

export async function writeFaultMatrix(
  input: unknown,
  adapterPath: string,
  destination: string,
  options: MatrixOptions,
) {
  parseMatrixDefinition(input);
  parseMatrixOptions(options);
  await mkdir(dirname(destination), { recursive: true });
  const file = await open(destination, 'wx', 0o600);
  let saved = false;
  try {
    // Reserve the output before importing code. Generation never calls factories,
    // agents or tool handlers, but module initialization is still trusted code.
    const adapter = await loadAdapter(adapterPath);
    if (
      !adapter.tools ||
      typeof adapter.tools !== 'object' ||
      Array.isArray(adapter.tools)
    )
      throw new Error(
        'The adapter must export a tools object with read/write declarations.',
      );
    const matrix = generateFaultMatrix(
      input,
      Object.entries(adapter.tools).map(([name, tool]) => ({
        name,
        kind: tool?.kind,
      })),
      options,
    );
    const serialized = JSON.stringify(matrix, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 5_000_000)
      throw new Error(
        'Generated matrix exceeds 5 MB. Select fewer tools or reduce fixture data.',
      );
    await file.writeFile(serialized);
    saved = true;
    return matrix;
  } finally {
    await file.close();
    if (!saved) await unlink(destination);
  }
}

export async function testFaultMatrix(
  input: unknown,
  adapterPath: string,
  destination: string,
  trials: number,
  signal?: AbortSignal,
  commitSha?: string,
) {
  const matrix = parseWorkflowMatrix(input);
  if (commitSha !== undefined) commitShaSchema.parse(commitSha);
  if (!Number.isInteger(trials) || trials < 1 || trials > 20)
    throw new Error('--trials must be from 1 to 20.');
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { mode: 0o700 });
  const files = new Map<string, Awaited<ReturnType<typeof open>>>();
  const saved = new Set<string>();
  const rows = matrix.suites.map((suite) => ({
    suite: suite.id,
    tool: suite.tool,
    report: `report-${suite.id}.json`,
    status: 'not_run',
    exitCode: 3,
  }));
  let reason: string | undefined;
  try {
    for (const filename of ['index.json', ...rows.map((row) => row.report)])
      files.set(filename, await open(join(destination, filename), 'wx', 0o600));
    const adapter = await loadAdapter(adapterPath);
    // Validate all declarations before the first model call. A changed tool kind
    // requires regenerating/reviewing the matrix rather than silently changing it.
    if (
      typeof adapter.createAgent !== 'function' ||
      matrix.suites.some(
        (suite) =>
          !Object.hasOwn(adapter.tools ?? {}, suite.tool) ||
          adapter.tools[suite.tool]?.kind !== suite.kind ||
          typeof adapter.tools[suite.tool]?.execute !== 'function',
      )
    )
      throw new Error(
        'Matrix tools do not match the adapter. Review its declarations and regenerate the matrix.',
      );
    for (const [index, suite] of matrix.suites.entries()) {
      if (signal?.aborted) {
        reason = 'Cancelled before the next suite.';
        break;
      }
      try {
        const batch = sanitizeWorkflowBatch(
          await runWorkflow(suite.workflow, adapter, {
            trials,
            signal,
            commitSha,
          }),
        );
        const row = rows[index]!;
        await files
          .get(row.report)!
          .writeFile(JSON.stringify(batch, null, 2) + '\n');
        saved.add(row.report);
        row.exitCode = workflowExitCode(batch);
        row.status =
          row.exitCode === 0
            ? 'passed'
            : row.exitCode === 1
              ? 'failed'
              : 'incomplete';
        if (
          batch.baseline.status !== 'passed' ||
          batch.runs.some(
            (run) =>
              run.status === 'cancelled' ||
              run.status === 'timed_out' ||
              (run.status === 'inconclusive' && run.issue),
          )
        ) {
          reason =
            'Stopped after a failed control or interrupted suite; remaining suites were not run.';
          break;
        }
      } catch {
        rows[index]!.status = 'error';
        // Keep completed suites and describe missing evidence without printing
        // adapter errors, which may contain secrets or private model responses.
        reason =
          'A suite could not produce valid evidence; remaining suites were not run.';
        break;
      }
    }
    const exitCode = rows.some((row) => row.exitCode === 3)
      ? 3
      : rows.some((row) => row.exitCode === 1)
        ? 1
        : 0;
    const result = {
      schemaVersion: 'workflow-matrix-result/1',
      status:
        exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : 'incomplete',
      exitCode,
      planned: rows.length,
      completed: saved.size,
      suites: rows,
      ...(reason
        ? { reason }
        : exitCode === 3
          ? {
              reason:
                'Some fault scenarios were not reached. Incomplete coverage is not a passing result.',
            }
          : {}),
    };
    await files
      .get('index.json')!
      .writeFile(JSON.stringify(result, null, 2) + '\n');
    saved.add('index.json');
    return result;
  } finally {
    for (const [filename, file] of files) {
      await file.close();
      if (!saved.has(filename)) await unlink(join(destination, filename));
    }
    if (!saved.size) await rmdir(destination);
  }
}
