// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  boundedJson,
  stableJson,
  workflowBatchSchema,
  workflowReportSchema,
  type WorkflowReport,
} from './schema.js';
import { sanitizeWorkflowReport } from './privacy.js';

export function parseWorkflowReports(input: unknown): WorkflowReport[] {
  boundedJson(input);
  const bundle =
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    input.schemaVersion === 'workflow-upload/1'
      ? z
          .strictObject({
            schemaVersion: z.literal('workflow-upload/1'),
            reports: z.array(workflowReportSchema).min(1).max(21),
          })
          .parse(input).reports
      : undefined;
  const single = workflowReportSchema.safeParse(input);
  const batch =
    single.success || bundle ? undefined : workflowBatchSchema.parse(input);
  return (
    bundle ??
    (single.success ? [single.data] : [batch!.baseline, ...batch!.runs])
  ).map((report) => {
    const { origin, ...data } = report;
    const originalId = origin?.originalId ?? report.id;
    const sanitized = sanitizeWorkflowReport({ ...data, id: originalId });
    const digest = createHash('sha256')
      .update(stableJson(sanitized))
      .digest('hex')
      .slice(0, 32);
    const id = `run_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
    return workflowReportSchema.parse({
      ...sanitized,
      id,
      origin: { kind: 'imported', originalId },
    });
  });
}
