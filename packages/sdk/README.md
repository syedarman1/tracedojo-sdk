# TraceDojo

**Chaos testing for AI agent tools.**

The booking succeeded. The response timed out. Your agent booked it again.

TraceDojo makes your agent's tools fail on purpose — lost confirmations,
duplicate deliveries, stale reads, injected instructions — and then checks what
actually changed in your application's state, not what the agent claimed.

[![npm](https://img.shields.io/npm/v/@tracedojo/sdk)](https://www.npmjs.com/package/@tracedojo/sdk)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/syedarman1/tracedojo-sdk/blob/main/packages/sdk/LICENSE)

![A lost confirmation causes a duplicate booking; a stable operation key fixes the retry.](https://tracedojo.com/demo/tracedojo-demo.gif)

## Try it in 30 seconds

No API key, no account. Node.js 22.23.1 or later.

```sh
npx tracedojo@0.1.1 demo
```

```text
A booking succeeded. Its confirmation timed out. The agent retried.
Before: failed — 2 committed writes; duplicate booking.
After:  passed — 1 committed write; the retry reused the original booking.
Both no-fault controls passed. Scripted example; no model calls.
```

## What it catches

| Fault                                                              | What happens to the tool call                     | Typical agent bug                            |
| ------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------- |
| `timeout_after`                                                    | The write commits, then the response is lost      | Retry with a new key → duplicate record      |
| `duplicate_delivery`                                               | The same write is delivered twice                 | No idempotency → double charge or email      |
| `stale_read`                                                       | A later read returns an earlier snapshot          | Agent gives up, or "repairs" with a rewrite  |
| `prompt_injection`                                                 | Tool output is replaced with attacker-chosen data | Agent calls a tool it must never call        |
| `timeout_before`, `unavailable`, `malformed`, `permission_revoked` | The call fails in a controlled way                | Wrong outcome, false "done", unsafe fallback |

Every scenario runs against a passing no-fault control first, so a failure means
the fault caused it. Faults that are never reached are reported as
inconclusive, not as passes.

## How it works

1. **Simulate your tools** in plain JavaScript against an in-memory state.
2. **Route your agent's tool calls** through `context.call()`. Bring any agent: scripted,
   OpenAI, Claude, or LangChain JS (`@tracedojo/sdk/langchain`).
3. **Declare outcomes** on the resulting state in `workflow.json`:

```json
{
  "checks": [
    {
      "id": "one-booking",
      "type": "count",
      "path": "/bookings",
      "expected": 1
    },
    { "id": "other-customer", "type": "unchanged", "path": "/otherCustomer" },
    {
      "id": "done",
      "type": "equals",
      "source": "completion",
      "path": "/status",
      "expected": "completed"
    }
  ],
  "scenarios": [
    {
      "id": "lost-confirmation",
      "fault": { "type": "timeout_after", "tool": "reserve_slot" }
    }
  ]
}
```

Then:

```sh
npm install --save-dev --save-exact @tracedojo/sdk@0.1.2
npx tracedojo init            # starter adapter + workflow
npx tracedojo test --trials 3
```

Ten starter worlds are included — calendar, payments, refunds, CRM, email, files,
SQL, inventory, subscriptions, webhooks: `npx tracedojo init --template refunds`.
Or generate a fault matrix from your declared tools: `npx tracedojo matrix`.

## Gate pull requests

```sh
npx tracedojo init --ci
```

Generates a GitHub workflow that runs the suite on every PR, compares it against
the base commit, fails on new regressions, and keeps a single up-to-date PR
comment. No model credentials required for scripted agents. A standalone
[GitHub Action](https://github.com/marketplace/actions/tracedojo-agent-test) is
also available.

## Start from a production trace

```sh
npx tracedojo import-langsmith trace.json --out imported-dojo
```

Generates a runnable playback adapter with observed tool signatures and review
TODOs — a starting point for a real test, not a test of your agent by itself.

## Real-model evidence

We ran our model-backed booking agent through the suite. One of three stale-read
trials stopped and reported itself blocked even though the booking existed. A
one-paragraph prompt change was followed by three passing trials under the same
faults. Small sample, synthetic data, full evidence downloadable:
[read the case study](https://tracedojo.com/docs/booking-case-study).

## Honest limits

TraceDojo tests behavior inside a simulation you define. A pass is evidence about
the tested scenario, not a guarantee of production reliability. Adapters are
trusted code, not a sandbox. Read the full
[limitations](https://tracedojo.com/docs/limitations) and
[security boundaries](https://tracedojo.com/docs/security).

## Docs and community

- [Setup guide](https://tracedojo.com/docs) · [Demos](https://tracedojo.com/demos) ·
  [Full CLI reference](https://github.com/syedarman1/tracedojo-sdk/blob/main/docs/WORKFLOWS.md)
- Optional hosted dashboard for saving and comparing reports: [tracedojo.com](https://tracedojo.com)
- Bugs and feature requests: [open an issue](https://github.com/syedarman1/tracedojo-sdk/issues)

The SDK, launcher, and starter templates are Apache-2.0. The hosted dashboard is
proprietary and is not included in this package.
