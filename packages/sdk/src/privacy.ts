// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import {
  boundedJson,
  workflowBatchSchema,
  workflowReportSchema,
  type Json,
  type WorkflowBatch,
  type WorkflowReport,
} from './schema.js';

function scrub(value: string): string {
  return value
    .replace(
      /\b(?:td_upload_[a-f0-9]{64}|sb_secret_[A-Za-z0-9_-]+|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      '[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      '$1="[REDACTED]"',
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (address) =>
      /@(?:[a-z0-9.-]+\.)?(?:example|invalid)$/i.test(address)
        ? address
        : 'redacted@private.invalid',
    );
}

/** Pattern-based redaction, not comprehensive personal-data detection. */
export function sanitizeJson(input: unknown): Json {
  boundedJson(input);
  const walk = (value: unknown): Json => {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(
        ([key, item]): [string, Json] => [
          scrub(key),
          /authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token/i.test(
            key,
          )
            ? '[REDACTED]'
            : walk(item),
        ],
      );
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw new Error(
          'Redaction would merge distinct fields. Remove private fields before export.',
        );
      return Object.fromEntries(entries);
    }
    return value as Json;
  };
  return walk(input);
}

export function sanitizeWorkflowReport(input: unknown): WorkflowReport {
  boundedJson(input);
  const report = workflowReportSchema.parse(input);
  // Revalidate after scrubbing. If distinct secrets collapse into a false match,
  // fail closed rather than silently changing a recorded verdict.
  return workflowReportSchema.parse(sanitizeJson(report));
}
export function sanitizeWorkflowBatch(input: unknown): WorkflowBatch {
  boundedJson(input);
  const batch = workflowBatchSchema.parse(input);
  return workflowBatchSchema.parse({
    ...(sanitizeJson(batch) as unknown as WorkflowBatch),
    baseline: sanitizeWorkflowReport(batch.baseline),
    runs: batch.runs.map(sanitizeWorkflowReport),
  });
}
