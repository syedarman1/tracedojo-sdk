// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
// Runs the built JavaScript SDK for the Python parity tests. Reads one JSON request
// on stdin and writes one JSON response on stdout.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = new URL('../../../sdk/dist/', import.meta.url);
const sdk = await import(new URL('index.js', dist).href);
const { compareWorkflowBatches, comparisonSummary } = await import(new URL('compare.js', dist).href);
const { parseWorkflowReports } = await import(new URL('reports.js', dist).href);
const { sanitizeJson, sanitizeWorkflowBatch } = await import(new URL('privacy.js', dist).href);
const { workflowSummary } = await import(new URL('summary.js', dist).href);

// A stand-in for OpenAI's streaming chat API, as in tests/workflow-proxy.test.ts.
async function fakeModel() {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        'data: {"choices":[{"delta":{"content":"Book"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" it"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      let index = 0;
      const tick = () => {
        if (index < events.length) {
          response.write(events[index++]);
          setTimeout(tick, 5);
        } else response.end();
      };
      tick();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

// Real model-layer fault reports from the proxy runner and the repository's proxy fixtures.
async function proxyModelBatch({ scenarios, retries, version }) {
  const { runProxy } = await import(new URL('proxy/run.js', dist).href);
  const fixtures = fileURLToPath(new URL('../../../../tests/fixtures/proxy/', import.meta.url));
  const cli = fileURLToPath(new URL('cli.js', dist));
  const dir = await mkdtemp(join(tmpdir(), 'dojo-py-parity-'));
  const model = await fakeModel();
  const stateFile = join(dir, 'state.json');
  try {
    const config = {
      schemaVersion: 'proxy/1',
      id: 'booking-proxy',
      title: 'Book one slot through real MCP',
      task: 'Book slot_42 for customer_7.',
      agent: {
        id: 'scripted-agent',
        version,
        command: [process.execPath, join(fixtures, 'agent.mjs')],
        env: { TRACEDOJO_CLI: cli, MODEL: 'openai', MODEL_RETRIES: String(retries) },
      },
      servers: {
        booking: { command: [process.execPath, join(fixtures, 'booking-server.mjs')], env: { STATE_FILE: stateFile } },
      },
      tools: { reserve_slot: 'write', list_bookings: 'read' },
      state: {
        reset: [process.execPath, join(fixtures, 'state.mjs'), 'reset'],
        probe: [process.execPath, join(fixtures, 'state.mjs'), 'dump'],
        env: { STATE_FILE: stateFile },
      },
      model: { openai: model.url, anthropic: model.url },
      checks: [
        { id: 'one', label: 'Exactly one booking', type: 'count', path: '/bookings', expected: 1 },
        { id: 'owner', label: 'Correct customer', type: 'equals', path: '/bookings/0/customerId', expected: 'customer_7' },
        { id: 'other', label: 'Other customer unchanged', type: 'unchanged', path: '/otherCustomer' },
        { id: 'no-cancel', label: 'Never cancel everything', type: 'forbidden_tool', tool: 'cancel_all' },
      ],
      scenarios,
      limits: { timeoutMs: 20000 },
    };
    return await runProxy(config, { configDir: dir, port: 0, output: 'ignore', trials: 1 });
  } finally {
    await model.close();
    await rm(dir, { recursive: true, force: true });
  }
}

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
  case 'proxy-model':
    response = await proxyModelBatch(request);
    break;
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
