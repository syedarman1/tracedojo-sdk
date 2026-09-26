// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { ActionSetupError, assertSupportedNode } from "./action-runtime.mjs";

try {
  assertSupportedNode(process.versions.node);
  const root = process.cwd();
  const path = (value) => {
    if (!value || /[\r\n\0]/.test(value))
      throw new ActionSetupError("Invalid path input.");
    const absolute = resolve(root, value);
    const rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`))
      throw new ActionSetupError("Use paths inside the checkout.");
    return absolute;
  };
  const config = path(process.env.TD_CONFIG);
  const adapter = path(process.env.TD_ADAPTER);
  const report = path(process.env.TD_REPORT);
  const trials = process.env.TD_TRIALS;
  if (!/^(?:[1-9]|1[0-9]|20)$/.test(trials ?? ""))
    throw new ActionSetupError("Trials must be 1–20.");
  const require = createRequire(resolve(root, "package.json"));
  const cli = resolve(dirname(require.resolve("@tracedojo/sdk")), "cli.js");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new ActionSetupError("Cannot identify checked-out revision.");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `report=${report}\n`);
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "test",
      "--config",
      config,
      "--adapter",
      adapter,
      "--trials",
      trials,
      "--commit",
      commit,
      "--out",
      report,
    ],
    { cwd: root, stdio: "inherit", shell: false },
  );
  process.exitCode = result.status ?? 2;
} catch (error) {
  console.error(
    error instanceof ActionSetupError
      ? `TraceDojo setup failed. ${error.message}`
      : "TraceDojo setup failed. Check npm ci, the SDK dependency, checkout revision, and report output access.",
  );
  process.exitCode = 2;
}
