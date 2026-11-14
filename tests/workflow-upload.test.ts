// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  runWorkflow,
  type WorkflowAdapter,
} from '../packages/sdk/src/index.js';
import { parseWorkflowReports } from '../packages/sdk/src/reports.js';
import {
  uploadMessage,
  uploadWorkflowReports,
} from '../packages/sdk/src/upload.js';

const config = JSON.parse(
  await readFile('packages/sdk/templates/workflow.json', 'utf8'),
);
const starter: WorkflowAdapter = await import(
  new URL('../packages/sdk/templates/adapter.mjs', import.meta.url).href
);
const destination = {
  url: 'https://tracedojo.example',
  project: '11111111-1111-4111-8111-111111111111',
  token: `td_upload_${'a'.repeat(64)}`,
};

test('upload reports the server receipt, not the local file count', async () => {
  const batch = await runWorkflow(config, starter);
  const stored = new Set<string>();
  const send: typeof fetch = async (_url, init) => {
    const reports = parseWorkflowReports(JSON.parse(String(init!.body)));
    const fresh = reports.filter((report) => !stored.has(report.id));
    for (const report of fresh) stored.add(report.id);
    return Response.json(
      {
        inserted: fresh.length,
        duplicates: reports.length - fresh.length,
        runIds: reports.map((report) => report.id),
      },
      { status: 201 },
    );
  };
  const first = await uploadWorkflowReports(batch, destination, send);
  assert.equal(first.inserted, first.count);
  assert.equal(first.duplicates, 0);
  assert.equal(
    uploadMessage(first),
    `Uploaded ${first.count} new reports. https://tracedojo.example/projects/${destination.project}/workflows`,
  );
  const again = await uploadWorkflowReports(batch, destination, send);
  assert.equal(again.count, first.count);
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, first.count);
  assert.match(
    uploadMessage(again),
    new RegExp(`^Uploaded 0 new reports, ${first.count} already stored\\. `),
  );
  assert.match(
    uploadMessage({ inserted: 1, duplicates: 2, url: 'u' }),
    /^Uploaded 1 new report, 2 already stored\. u$/,
  );
});
