// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { WorkflowContext } from './index.js';
import { boundedJson, type Json } from './schema.js';

export interface LangChainToolSpec {
  name: string;
  description: string;
  schema: z.ZodObject;
}

/** Pass these tools to your existing LangChain agent instead of its live tools. */
export function createLangChainTools(
  context: WorkflowContext,
  definitions: LangChainToolSpec[],
) {
  if (new Set(definitions.map((d) => d.name)).size !== definitions.length)
    throw new Error('Tool names must be unique.');
  return definitions.map((definition) =>
    tool(
      async (args) => {
        boundedJson(args, 16000);
        return JSON.stringify(
          await context.call(definition.name, args as Record<string, Json>),
        );
      },
      {
        name: definition.name,
        description: definition.description,
        schema: definition.schema,
      },
    ),
  );
}
