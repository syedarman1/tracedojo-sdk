// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// Runs the built JavaScript SDK for the Python parity tests. Reads one JSON request
// on stdin and writes one JSON response on stdout.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const dist = new URL('../../../sdk/dist/', import.meta.url);
const sdk = await import(new URL('index.js', dist).href);
const { compareWorkflowBatches, comparisonSummary } = await import(new URL('compare.js', dist).href);
const { parseWorkflowReports } = await import(new URL('reports.js', dist).href);
const { sanitizeJson, sanitizeWorkflowBatch } = await import(new URL('privacy.js', dist).href);
const { workflowSummary } = await import(new URL('summary.js', dist).href);

const request = JSON.parse(readFileSync(0, 'utf8'));
const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error?.constructor?.name ?? 'Error', message: error?.issues ? 'schema' : String(error?.message) };
  }
};

let response;
switch (request.op) {
  case 'run': {
    const fixture = await import(new URL(`./fixtures/${request.fixture}.mjs`, import.meta.url).href);
    response = await sdk.runWorkflow(request.workflow, fixture.makeAdapter(request.variant), {
      trials: request.trials ?? 1,
      ...(request.commitSha ? { commitSha: request.commitSha } : {}),
    });
    break;
  }
  case 'validate-batch':
    response = request.values.map((v) => attempt(() => sdk.workflowBatchSchema.parse(v)));
    break;
  case 'validate-report':
    response = request.values.map((v) => attempt(() => sdk.workflowReportSchema.parse(v)));
    break;
  case 'parse-workflow':
    response = request.values.map((v) => attempt(() => sdk.parseWorkflow(v)));
    break;
  case 'compare':
    response = request.pairs.map(([base, candidate]) => {
      const result = compareWorkflowBatches(base ?? undefined, candidate ?? undefined);
      return { result, summary: comparisonSummary(result) };
    });
    break;
  case 'parse-reports':
    response = parseWorkflowReports(request.value);
    break;
  case 'stable':
    response = request.values.map((v) => {
      const json = sdk.stableJson(v);
      return { json, sha: createHash('sha256').update(json).digest('hex'), stringify: JSON.stringify(v, null, 2) };
    });
    break;
  case 'sanitize':
    response = request.values.map((v) => attempt(() => sanitizeJson(v)));
    break;
  case 'sanitize-batch':
    response = sanitizeWorkflowBatch(request.value);
    break;
  case 'summary':
    response = { summary: workflowSummary(request.value), exitCode: sdk.workflowExitCode(request.value) };
    break;
  case 'evaluate':
    response = sdk.evaluateChecks(request.definitions, request.initial, request.final, request.completion ?? undefined, request.events);
    break;
  default:
    throw new Error(`Unknown op ${request.op}`);
}
process.stdout.write(JSON.stringify(response));
