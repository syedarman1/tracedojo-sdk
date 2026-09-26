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
import {
  assertSupportedNode,
  ActionSetupError,
} from "../scripts/action-runtime.mjs";

test("action accepts the SDK Node minimum and newer major versions", () => {
  for (const version of ["22.23.1", "22.23.2", "22.24.0", "23.0.0", "24.0.0"]) {
    assert.doesNotThrow(() => assertSupportedNode(version), version);
  }
  for (const version of [
    "18.20.8",
    "20.99.0",
    "22.5.1",
    "22.23.0",
    "invalid",
  ]) {
    assert.throws(
      () => assertSupportedNode(version),
      (error: unknown) => {
        assert.ok(error instanceof ActionSetupError);
        assert.match(error.message, /Use Node 22\.23\.1 or later/);
        return true;
      },
    );
  }
});

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
    const invalid = run(join(dir, "invalid.json"), { TD_TRIALS: "1; exit 0" });
    assert.equal(invalid.status, 2);
    assert.match(
      invalid.stderr,
      /TraceDojo setup failed\. Trials must be 1–20\./,
    );
    assert.doesNotMatch(invalid.stderr, /1; exit 0/);
    const outside = run("../outside.json");
    assert.equal(outside.status, 2);
    assert.match(outside.stderr, /Use paths inside the checkout/);
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
