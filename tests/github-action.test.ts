// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("action preserves failure/incomplete exits and treats shell-looking paths as data", () => {
  mkdirSync(".tracedojo", { recursive: true });
  const dir = mkdtempSync(".tracedojo/action-test-");
  try {
    const config = JSON.parse(
      readFileSync("packages/sdk/templates/workflow.json", "utf8"),
    );
    const original = readFileSync("packages/sdk/templates/adapter.mjs", "utf8");
    const workflow = join(dir, "workflow.json");
    const adapter = join(dir, "adapter.mjs");
    writeFileSync(workflow, JSON.stringify(config));
    writeFileSync(adapter, original);
    const run = (report: string, overrides = {}) =>
      spawnSync(process.execPath, ["scripts/github-action.mjs"], {
        env: {
          ...process.env,
          TD_CONFIG: workflow,
          TD_ADAPTER: adapter,
          TD_TRIALS: "1",
          TD_REPORT: report,
          GITHUB_OUTPUT: "",
          ...overrides,
        },
        encoding: "utf8",
      });
    const safe = join(dir, "report; echo injected.json");
    assert.equal(run(safe).status, 0);
    assert.ok(existsSync(safe));
    assert.equal(run(safe).status, 2, "must not overwrite evidence");
    assert.equal(
      run(join(dir, "invalid.json"), { TD_TRIALS: "1; exit 0" }).status,
      2,
    );
    writeFileSync(
      adapter,
      original.replace(
        "          operationKey,",
        "          operationKey: String(attempt),",
      ),
    );
    assert.equal(run(join(dir, "failed.json")).status, 1);
    writeFileSync(adapter, original);
    config.scenarios = [
      {
        ...config.scenarios[0],
        fault: { ...config.scenarios[0].fault, occurrence: 5 },
      },
    ];
    writeFileSync(workflow, JSON.stringify(config));
    assert.equal(run(join(dir, "incomplete.json")).status, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
