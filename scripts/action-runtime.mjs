// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman
export class ActionSetupError extends Error {}

export function assertSupportedNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  if (
    !match ||
    major < 22 ||
    (major === 22 && (minor < 23 || (minor === 23 && patch < 1)))
  ) {
    throw new ActionSetupError(
      "Use Node 22.23.1 or later. Configure actions/setup-node before TraceDojo.",
    );
  }
}
