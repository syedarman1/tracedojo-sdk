// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { importLangSmithTrace, inferToolSignatures } from './langsmith.js';
import { boundedJson, parseWorkflow } from './schema.js';

export async function createLangSmithStarter(
  input: unknown,
  directory: string,
) {
  const draft = importLangSmithTrace(input);
  if (draft.observedCalls.length > 90)
    throw new Error(
      'Runnable scaffolds support at most 90 tool calls. Use --draft-only for larger traces.',
    );
  for (const call of draft.observedCalls) boundedJson(call, 40000);
  const signatures = inferToolSignatures(draft);
  const names = new Map(signatures.map((tool) => [tool.name, tool.alias]));
  const fixture = {
    ...draft,
    signatures,
    observedCalls: draft.observedCalls.map((call) => ({
      ...call,
      alias: names.get(call.name)!,
    })),
  };
  const workflow = parseWorkflow({
    schemaVersion: 'workflow/1',
    id: 'imported-trace-playback',
    title: 'Imported trace playback — needs review',
    task:
      draft.taskCandidate.slice(0, 10000).trim() ||
      'Replay the observed calls. Review the task before connecting an agent.',
    initialState: {},
    checks: [
      {
        id: 'playback-completes',
        label: 'Scripted playback completes (not a correctness check)',
        type: 'equals',
        source: 'completion',
        path: '/status',
        expected: 'completed',
      },
    ],
    scenarios: [
      {
        id: 'interrupted-playback',
        title: 'Recorded call sequence interrupted by a timeout',
        fault: {
          type: 'timeout_before',
          tool: fixture.observedCalls[0]!.alias,
        },
      },
    ],
    limits: { maxToolCalls: 100, maxRepeatedCalls: 100, timeoutMs: 5000 },
  });
  const files: Record<string, string> = {
    'workflow.json': JSON.stringify(workflow, null, 2) + '\n',
    'trace.json': JSON.stringify(fixture, null, 2) + '\n',
    'adapter.mjs': await readFile(
      new URL('../templates/langsmith-adapter.mjs', import.meta.url),
      'utf8',
    ),
    'README.md': `# Turn this trace into an agent test\n\nThis is a runnable, redacted playback scaffold. It does not recreate your agent or infer application correctness. No model or external service is called.\n\nRun with the SDK installed, replacing PATH with this directory:\n\n\`\`\`sh\nnpx --no-install tracedojo test --config PATH/workflow.json --adapter PATH/adapter.mjs\n\`\`\`\n\nFor a trace with successful, unambiguous tool outputs, the control passes and the injected timeout fails (exit 1). That failure demonstrates an interrupted scripted sequence, not a discovered bug in your agent. Missing outputs, recorded errors, or conflicting results for the same arguments block the control until you implement the TODOs.\n\n## Finish the adapter\n\n1. Review trace.json: signatures describe observed shapes only. Required fields appeared in every sample; they are not an authoritative API contract. Tool aliases map arbitrary trace names to valid runner names. Redaction is pattern-based; inspect files before sharing.\n2. Implement each tool in adapter.mjs. All stubs default to read-only fixture responses. Set kind to write only for tools that mutate state, and implement their real simulated transitions against the state argument. Supply synthetic initialState in workflow.json.\n3. Replace the playback completion check with independently defined state and safety checks. Never promote observed outputs into expected outcomes without review.\n4. Replace createAgent with your real decision loop, route all calls through context.call, and version the agent. The trace order is a starting point, not a reconstruction of parallel scheduling.\n5. Choose faults that matter to your workflow and run again. Prefer a prebuilt world when you need a complete stateful example.\n\nAdapters are trusted local code with environment/network access. Keep .tracedojo/ and private trace files out of Git.\n`,
  };
  for (const name of ['LICENSE', 'NOTICE'])
    files[name] = await readFile(
      new URL(`../${name}`, import.meta.url),
      'utf8',
    );
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  const created: string[] = [];
  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = resolve(directory, name);
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
      created.push(path);
    }
  } catch (error) {
    for (const path of created.reverse()) await unlink(path);
    await rmdir(directory);
    throw error;
  }
  return { calls: draft.observedCalls.length, tools: signatures.length };
}
