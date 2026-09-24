// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  boundedJson,
  parseWorkflow,
  stableJson,
  workflowSchema,
  type Workflow,
} from './schema.js';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const inventorySchema = z
  .array(z.strictObject({ name, kind: z.enum(['read', 'write']) }))
  .min(1)
  .max(50)
  .refine(
    (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
    'Tool names must be unique.',
  );
export type MatrixTool = z.infer<typeof inventorySchema>[number];
const faultTypes = [
  'timeout_after',
  'duplicate_delivery',
  'timeout_before',
  'unavailable',
  'malformed',
  'permission_revoked',
  'stale_read',
] as const;
const optionsSchema = z.strictObject({
  tools: z.array(name).min(1).max(50).optional(),
  faults: z.array(z.enum(faultTypes)).min(1).max(7).optional(),
});
export type MatrixOptions = z.infer<typeof optionsSchema>;
export function parseMatrixOptions(input: unknown): MatrixOptions {
  boundedJson(input, 20000);
  return optionsSchema.parse(input);
}
export function parseMatrixDefinition(input: unknown): Workflow {
  boundedJson(input, 500000);
  const definition =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return parseWorkflow({
    ...definition,
    ...(Object.hasOwn(definition, 'scenarios')
      ? {}
      : {
          scenarios: [
            {
              id: 'matrix-placeholder',
              title: 'Matrix placeholder',
              fault: { type: 'timeout_before', tool: 'matrix_tool' },
            },
          ],
        }),
  });
}
const applicable = (kind: MatrixTool['kind'], fault: string) =>
  kind === 'write'
    ? fault !== 'stale_read'
    : ['timeout_before', 'unavailable', 'malformed', 'stale_read'].includes(
        fault,
      );

export const workflowMatrixSchema = z
  .strictObject({
    schemaVersion: z.literal('workflow-matrix/1'),
    suites: z
      .array(
        z.strictObject({
          id: name,
          tool: name,
          kind: z.enum(['read', 'write']),
          workflow: workflowSchema,
        }),
      )
      .min(1)
      .max(50),
  })
  .superRefine((matrix, ctx) => {
    if (
      new Set(matrix.suites.map((suite) => suite.id)).size !==
        matrix.suites.length ||
      new Set(matrix.suites.map((suite) => suite.tool)).size !==
        matrix.suites.length ||
      matrix.suites.some((suite) =>
        suite.workflow.scenarios.some(
          ({ fault }) =>
            fault.type === 'none' ||
            fault.tool !== suite.tool ||
            (['duplicate_delivery', 'permission_revoked'].includes(
              fault.type,
            ) &&
              suite.kind !== 'write') ||
            (fault.type === 'stale_read' && suite.kind !== 'read'),
        ),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Matrix suites require unique IDs and tools with applicable faults.',
      });
  });
export type WorkflowMatrix = z.infer<typeof workflowMatrixSchema>;
export function parseWorkflowMatrix(input: unknown): WorkflowMatrix {
  boundedJson(input);
  const matrix = workflowMatrixSchema.parse(input);
  for (const suite of matrix.suites) boundedJson(suite.workflow, 500000);
  return matrix;
}

/** Generate editable scenarios from declarations, without executing tools or an agent. */
export function generateFaultMatrix(
  input: unknown,
  inventory: unknown,
  options: MatrixOptions = {},
): WorkflowMatrix {
  boundedJson(input, 500000);
  boundedJson(inventory, 20000);
  boundedJson(options, 20000);
  const tools = inventorySchema
    .parse(inventory)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const selected = parseMatrixOptions(options);
  if (
    selected.tools &&
    (new Set(selected.tools).size !== selected.tools.length ||
      selected.tools.some(
        (tool) => !tools.some((entry) => entry.name === tool),
      ))
  )
    throw new Error('Select unique, registered tool names.');
  if (
    selected.faults &&
    new Set(selected.faults).size !== selected.faults.length
  )
    throw new Error('Select unique fault types.');
  // A task/state/check definition may omit scenarios entirely. Existing scenarios
  // are still validated, and their exact-match check overrides are preserved.
  const workflow = parseMatrixDefinition(input);
  const originals = Object.hasOwn(input as object, 'scenarios')
    ? workflow.scenarios
    : [];
  const faults = faultTypes.filter((type) =>
    selected.faults ? selected.faults.includes(type) : type !== 'stale_read',
  );
  const suites: WorkflowMatrix['suites'] = [];
  for (const tool of tools.filter(
    (tool) => !selected.tools || selected.tools.includes(tool.name),
  )) {
    const scenarios: Workflow['scenarios'] = [];
    for (const type of faults.filter((type) => applicable(tool.kind, type))) {
      const fault = {
        type,
        tool: tool.name,
        occurrence: type === 'stale_read' ? 2 : 1,
        repeat: 1,
      };
      const matches = originals.filter(
        (scenario) => stableJson(scenario.fault) === stableJson(fault),
      );
      if (
        new Set(
          matches.map((scenario) =>
            stableJson(scenario.checks ?? workflow.checks),
          ),
        ).size > 1
      )
        throw new Error(
          'Matching scenarios have conflicting checks. Keep one set of expectations before generating a matrix.',
        );
      scenarios.push({
        id: `matrix-${type}`,
        title: `${tool.name}: ${type.replaceAll('_', ' ')}`,
        fault,
        ...(matches[0]?.checks
          ? { checks: structuredClone(matches[0].checks) }
          : {}),
      });
    }
    if (!scenarios.length) continue;
    const digest = createHash('sha256')
      .update(tool.name)
      .digest('hex')
      .slice(0, 12);
    suites.push({
      id: `${tool.name.slice(0, 60)}-${digest}`,
      tool: tool.name,
      kind: tool.kind,
      workflow: parseWorkflow({ ...structuredClone(workflow), scenarios }),
    });
  }
  if (!suites.length)
    throw new Error('No selected fault applies to the selected tools.');
  return parseWorkflowMatrix({ schemaVersion: 'workflow-matrix/1', suites });
}
