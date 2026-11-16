// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { z } from 'zod';
import {
  boundedJson,
  checkSchema,
  isModelFault,
  workflowFaultSchema,
} from '../schema.js';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const text = z.string().trim().min(1).max(2000);
const command = z.array(z.string().min(1).max(4000)).min(1).max(100);
const env = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10000))
  .optional();
const cwd = z.string().min(1).max(4000).optional();
const httpUrl = z.url({ protocol: /^https?$/ });
const checks = z
  .array(checkSchema)
  .min(1)
  .max(50)
  .refine(
    (items) => new Set(items.map((c) => c.id)).size === items.length,
    'Check IDs must be unique.',
  );

export const proxyServerSchema = z.union([
  z.strictObject({ command, cwd, env }),
  z.strictObject({
    url: httpUrl,
    headers: z.record(z.string().min(1).max(200), z.string().max(10000)).optional(),
  }),
]);
export type ProxyServer = z.infer<typeof proxyServerSchema>;

export const proxyConfigSchema = z
  .strictObject({
    schemaVersion: z.literal('proxy/1'),
    id: name,
    title: text,
    task: z.string().trim().min(1).max(10000),
    /** The agent process. It is started once per trial and must exit when done. */
    agent: z.strictObject({ id: name, version: text, command, cwd, env }),
    /** Upstream MCP servers, keyed by the name the agent's MCP config uses. */
    servers: z
      .record(name, proxyServerSchema)
      .refine((servers) => {
        const count = Object.keys(servers).length;
        return count >= 1 && count <= 20;
      }, 'Declare 1 to 20 MCP servers.'),
    /** Tool kinds. Undeclared tools use the MCP readOnlyHint, else write. */
    tools: z.record(name, z.enum(['read', 'write'])).optional(),
    /** Commands that restore and read the real application state. */
    state: z.strictObject({
      reset: command.optional(),
      probe: command,
      cwd,
      env,
    }),
    /** Upstream model API origins. Defaults are the public provider APIs. */
    model: z
      .strictObject({ openai: httpUrl.optional(), anthropic: httpUrl.optional() })
      .optional(),
    checks,
    scenarios: z
      .array(
        z.strictObject({
          id: name,
          title: text,
          fault: workflowFaultSchema,
          checks: checks.optional(),
        }),
      )
      .min(1)
      .max(10),
    limits: z
      .strictObject({
        maxToolCalls: z.number().int().min(1).max(100).default(20),
        maxRepeatedCalls: z.number().int().min(1).max(100).default(5),
        maxModelCalls: z.number().int().min(1).max(1000).default(50),
        timeoutMs: z.number().int().min(1).max(1_800_000).default(120_000),
      })
      .default({
        maxToolCalls: 20,
        maxRepeatedCalls: 5,
        maxModelCalls: 50,
        timeoutMs: 120_000,
      }),
    port: z.number().int().min(0).max(65535).optional(),
  })
  .superRefine((config, ctx) => {
    if (
      new Set(config.scenarios.map((s) => s.id)).size !==
        config.scenarios.length ||
      config.scenarios.some(
        (s) => s.id === 'baseline' || s.fault.type === 'none',
      )
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Scenario IDs must be unique and cannot use the reserved baseline.',
      });
    for (const { fault } of config.scenarios) {
      if (fault.type === 'none' || isModelFault(fault)) continue;
      const kind = config.tools?.[fault.tool];
      if (
        ((fault.type === 'permission_revoked' ||
          fault.type === 'duplicate_delivery') &&
          kind !== 'write') ||
        (fault.type === 'stale_read' && kind !== 'read')
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Declare the faulted tool in "tools": permission revocation and duplicate delivery need a write tool; stale reads need a read tool.',
        });
    }
  });
export type ProxyConfig = z.infer<typeof proxyConfigSchema>;

export function parseProxyConfig(input: unknown): ProxyConfig {
  boundedJson(input, 500000);
  return proxyConfigSchema.parse(input);
}

/** Expand ${NAME} from the environment. Values never reach reports. */
export function expandEnv(
  value: string,
  source: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    const found = source[key];
    if (found === undefined)
      throw new Error(`Environment variable ${key} is not set.`);
    return found;
  });
}

export function expandRecord(
  record: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => [key, expandEnv(value)]),
  );
}
