// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  runWorkflow,
  parseWorkflow,
  type WorkflowAdapter,
} from "../packages/sdk/src/index.js";
import { createStarter } from "../packages/sdk/src/starter.js";

async function calendar(
  checks: unknown[],
  scenarioChecks: unknown[],
  run: (
    config: ReturnType<typeof parseWorkflow>,
    adapter: WorkflowAdapter,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "dojo-tool-checks-"));
  const dir = join(root, "dojo");
  try {
    await createStarter(dir, false);
    const raw = JSON.parse(await readFile(join(dir, "workflow.json"), "utf8"));
    const config = parseWorkflow({
      ...raw,
      checks: [...raw.checks, ...checks],
      scenarios: raw.scenarios
        .filter((s: { id: string }) => s.id === "lost-confirmation")
        .map(({ checks: _, ...s }: Record<string, unknown>) =>
          scenarioChecks.length
            ? { ...s, checks: [...raw.checks, ...scenarioChecks] }
            : s,
        ),
    });
    const adapter: WorkflowAdapter = await import(
      pathToFileURL(join(dir, "adapter.mjs")).href
    );
    await run(config, adapter);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("tool_calls bounds how often the agent calls a tool", async () => {
  await calendar(
    [
      {
        id: "single-write",
        label: "Reserve once",
        type: "tool_calls",
        tool: "reserve_slot",
        max: 1,
      },
      {
        id: "bounded-retries",
        label: "At most one retry",
        type: "tool_calls",
        tool: "reserve_slot",
        min: 1,
        max: 2,
      },
    ],
    [],
    async (config, adapter) => {
      const batch = await runWorkflow(config, adapter);
      const control = batch.baseline.assertions;
      assert.equal(control.find((a) => a.id === "single-write")?.passed, true);
      const faulted = batch.runs[0]!;
      assert.equal(faulted.fault.triggerCount, 1);
      const single = faulted.assertions.find((a) => a.id === "single-write")!;
      assert.equal(single.passed, false);
      assert.equal(single.actual, 2);
      assert.deepEqual(single.expected, { max: 1 });
      assert.equal(single.evidenceIds.length, 2);
      assert.match(single.detail, /2 times; expected at most 1/);
      assert.equal(
        faulted.assertions.find((a) => a.id === "bounded-retries")?.passed,
        true,
      );
    },
  );
});

test("tool_order matches an in-order subsequence of tool calls", async () => {
  await calendar(
    [],
    [
      {
        id: "retried",
        label: "Reserve, then retry",
        type: "tool_order",
        tools: ["reserve_slot", "reserve_slot"],
      },
      {
        id: "retried-twice",
        label: "Reserve, then retry twice",
        type: "tool_order",
        tools: ["reserve_slot", "reserve_slot", "reserve_slot"],
      },
    ],
    async (config, adapter) => {
      const batch = await runWorkflow(config, adapter);
      assert.equal(batch.baseline.status, "passed");
      const run = batch.runs[0]!;
      const once = run.assertions.find((a) => a.id === "retried")!;
      assert.equal(once.passed, true);
      assert.equal(once.evidenceIds.length, 2);
      assert.deepEqual(once.actual, ["reserve_slot", "reserve_slot"]);
      const twice = run.assertions.find((a) => a.id === "retried-twice")!;
      assert.equal(twice.passed, false);
      assert.match(twice.detail, /No reserve_slot call followed reserve_slot/);
      assert.equal(twice.evidenceIds.length, 2);
      assert.equal(run.status, "failed");
    },
  );
});

test("tool check definitions reject empty or inverted bounds", () => {
  const base = {
    schemaVersion: "workflow/1",
    id: "w",
    title: "W",
    task: "T",
    initialState: {},
    scenarios: [
      { id: "s", title: "S", fault: { type: "timeout_after", tool: "t" } },
    ],
  };
  const check = (c: Record<string, unknown>) => () =>
    parseWorkflow({ ...base, checks: [{ id: "c", label: "C", ...c }] });
  assert.throws(check({ type: "tool_calls", tool: "t" }));
  assert.throws(check({ type: "tool_calls", tool: "t", min: 3, max: 2 }));
  assert.throws(check({ type: "tool_order", tools: ["t"] }));
  assert.doesNotThrow(check({ type: "tool_calls", tool: "t", min: 2, max: 2 }));
  assert.doesNotThrow(check({ type: "tool_order", tools: ["a", "b"] }));
});
