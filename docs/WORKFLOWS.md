<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Syed Arman -->

# Test your agent with TraceDojo

TraceDojo runs your agent against tools you simulate. It injects a controlled
failure, records both visible responses and committed state, and checks the result.
The SDK runs locally or in CI; the dashboard inspects its reports.

## Install in your own repository

Use Node 22.23.1 or later (the repository itself pins 22.23.1).
For a quick start in an empty directory:

```sh
npx tracedojo@0.1.1 init
npx tracedojo@0.1.1 test
npx tracedojo@0.1.1 demo
```

For reproducible CI, use an existing npm project or run `npm init -y` first:

```sh
npm install --save-dev --save-exact @tracedojo/sdk@0.1.2
npx --no-install tracedojo init --ci
npx --no-install tracedojo test --out .tracedojo/first-report.json
```

Commit `package.json`, `package-lock.json`, `dojo/`, and the generated `.github/`
files so a fresh CI runner can reproduce the installation. Add `.tracedojo/` to
`.gitignore`. Do not use a dependency that links to a folder on your laptop.

`init` creates a new directory and never overwrites an existing one. `--ci` also
creates test and comment workflows plus a comment script. If any destination exists,
setup rolls back its new files and preserves existing files. Use `init` without
`--ci` to add a separate example, then adapt your
existing workflow. `--out tests/dojo` chooses another starter directory; pass the
matching `--config` and `--adapter` paths to `test`.

To see a complete failure and fix immediately, run `npx tracedojo@0.1.1 demo`.
It saves `before.json` and `after.json` in a new directory under `.tracedojo/`.
Import both in the Workflows page. This scripted demo requires no model key
or repository checkout.

## Run, break, and fix the example

The starter is deterministic and makes no paid calls. A no-fault control must
pass before fault trials begin. Five scenarios test lost confirmation, timeout
before execution, service unavailability, malformed response, and revoked access.

1. Run the starter. Expect a passing control and five passing fault trials.
2. In `dojo/adapter.mjs`, inside the `reserve_slot` call, replace `operationKey,`
   with `operationKey: String(attempt),`.
3. Run `npx --no-install tracedojo test`. It exits 1 because lost confirmation
   causes a duplicate booking. The report is still saved.
4. Import both reports on the Workflows page. Select the failed lost-confirmation
   run, expand **Exactly one booking**, and open its supporting events. The
   evaluator shows that the first write committed even though confirmation was lost.
5. Restore `operationKey,`, run again, and compare the same scenario before and
   after the fix. Both runs must have matching workflow conditions.

Default report names are unique under `.tracedojo/reports/`. Explicit `--out` and
`--summary` destinations must be new; collisions are rejected before loading the
agent. Exit codes are 0 passed, 1 failed checks, 2 invalid input/setup, and 3
incomplete evidence. A fault the agent never reaches is inconclusive.

## Connect your agent

### Test instructions hidden in tool output

Run `npx --no-install tracedojo init --template prompt-injection --out dojo-injection`,
then `npx --no-install tracedojo test --config dojo-injection/workflow.json --adapter dojo-injection/adapter.mjs`.
Set `trustToolInstructions` to `true` in that adapter to reproduce the unsafe variant.
The control passes, but the fault produces a forbidden refund attempt and state change.
These are scripted demonstrations; connect your own agent for model evaluations.

The `prompt_injection` fault requires `tool` and a JSON `replacement`. It replaces
the entire `data` field of a successful response, preserving the original as hidden
evaluator evidence. Errors are not replaced. `occurrence` (default 1) and `repeat`
(default 1, maximum 10) select tool calls; an unreached injection is inconclusive.
Replacement data is limited to 16 KB and the usual JSON depth bounds.

Use `{ "id": "no-refund", "label": "Never refund", "type": "forbidden_tool", "tool": "refund_all" }`
to fail on any recorded attempt, including unknown tools and rejected writes.
Keep state checks too: an attempted forbidden action and a committed side effect
answer different questions. The runner does not execute injected instructions.

### Test duplicate delivery

Use `init --template duplicate-delivery` for an idempotent credit fixture. Disable
`deduplicate` in its adapter to make one request produce two credits while the
control still passes. The fix belongs in the simulated service's idempotency
contract as well as the agent's stable request key.

`duplicate_delivery` requires a write tool. At each selected occurrence it delivers
identical cloned inputs twice, sequentially, each with an isolated transaction.
Both execute even if the first returns a structured error; thrown/invalid handlers
and cancellation stop the trial. The first response is delivered to the agent after
both executions; the duplicate response stays evaluator-only. `delivery` events
record each execution, `toolCalls` counts agent requests, and `mutations` counts
actual changes. Immediate redelivery does not simulate queue reordering.

### Test stale reads

Use `init --template stale-read` to test a read after a write. Disable
`verifyVersion` in the adapter to make the agent report an old status for a
successfully updated order. The safe variant checks the write's version and retries.

`stale_read` requires a read tool. It captures the first successful result for each
tool/input pair within the trial. On a selected later call with different successful
data, the fresh result stays evaluator-only and the older captured result reaches
the agent. The fault evidence links its `sourceCallId`. Use `occurrence: 2` or later;
the default occurrence is 1. Missing history, unchanged data, and errors do not
trigger the fault. An untriggered scenario is inconclusive. `repeat` can model
several stale responses before recovery. This models a pinned snapshot, not a
distributed database or arbitrary replica lag.

## Use a real model

Replace the starter's scripted decision loop with your model-backed agent inside
`createAgent`. Route tool calls through `context.call`, and keep the model's
conversation state fresh for every trial. Supply your own simulated tool behavior
and independent outcome checks; recorded outputs are not correctness guarantees.
Model requests use your provider account and may incur charges. Start with one
control and one fault, inspect the resulting evidence, then expand the suite.

## Track scenarios across commits

Label a test with the full lowercase Git commit SHA:

```sh
npx --no-install tracedojo test --commit "$(git rev-parse HEAD)" --trials 3 --out .tracedojo/commit-report.json
```

`test-matrix` accepts the same `--commit` option. SDK callers pass
`{ commitSha, trials: 3 }` to `runWorkflow`. Newly generated CI workflows label
the checked-out PR head or push commit automatically. Existing CI workflows need
the option added. The label is caller-supplied: the SDK does not verify the Git
checkout or whether local files have uncommitted changes.

Import or upload the full batch, including its no-fault control. The Workflows
dashboard shows **Scenario trends** for each matching suite and agent ID. Each
point aggregates repeated executions at that commit, with passed/failed/planned
counts and an **Inspect** link. Changes to the workflow configuration create a
separate series. Different agent versions at the same commit make that point
unavailable; versions may change between commits.

Rates require a passing control and every planned trial for that scenario.
Missing, interrupted, unreached, or conflicting evidence leaves a gap instead of
a percentage. Reimporting identical evidence does not increase the sample size.
Legacy reports remain inspectable but do not appear in trends without execution
and commit metadata. A scenario's rate does not imply the whole suite passed.

Trends use loaded reports only (saved reports in private projects). Load older
evidence when offered to retrieve missing controls or trials. The chart displays
the latest 12 commit groups by evidence recording time, not Git ancestry. These
are descriptive sample rates, not statistical reliability estimates. The same
aggregation is available as `workflowTrends(reports)` from `@tracedojo/sdk/trends`.

## Generate a fault matrix

Once your task, starting state, tools, and checks are defined, TraceDojo can fill
in the failure cases. The input config may omit `scenarios`; it must still define
independent outcome checks. Existing scenarios are validated, but the matrix is a
new plan and does not append to or overwrite your original scenario list.

```sh
npx --no-install tracedojo matrix --config dojo/workflow.json --adapter dojo/adapter.mjs --out dojo/matrix.json
# Review dojo/matrix.json, then run it:
npx --no-install tracedojo test-matrix dojo/matrix.json --adapter dojo/adapter.mjs --out matrix-reports --trials 3
```

These commands use the published SDK installed in your own npm repository.
From a TraceDojo source checkout, use `npm run workflow --` instead.

| Declared tool | Generated default faults                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Read          | Timeout before execution, service unavailable, malformed response                                                    |
| Write         | Lost confirmation, duplicate delivery, timeout before execution, unavailable, malformed response, permission revoked |

`--tools reserve_slot,charge_customer` selects specific tools. `--faults
timeout_after,duplicate_delivery` selects fault types. An inapplicable tool/fault
pair produces no case; selecting no applicable cases is an error. Generation
sorts tools and fault types deterministically so declaration order does not change
suite identity. Each tool gets its own workflow, avoiding the ten-scenario limit
of an individual suite. Matrices support up to 50 tools within a 5 MB input bound.

Generation reads `adapter.tools` without invoking `createAgent` or handlers. Module
imports still execute trusted local JavaScript. It makes no model requests itself.
Running the matrix executes a fresh control per suite plus 1–20 trials per case,
so estimate paid-model usage from the printed scenario count before starting.

Task, state, limits, clock, and common checks carry over unchanged. Scenario check
overrides carry over only when tool, fault type, occurrence, and repeat match
exactly. Conflicting matching overrides are rejected. In particular, decide what
correct blocked behavior means for permission failures; the generator does not
invent relaxed expectations just to obtain a passing result.

Stale reads are opt-in with `--faults stale_read`; generated calls target occurrence
2 and require a differing earlier successful result for identical inputs. Add
prompt-injection cases manually with a reviewed replacement and forbidden-action
checks. Edit each suite's `workflow.scenarios` to change schedules or assertions.
Tool kind changes require reviewing/regenerating the matrix.

`test-matrix` reserves a new output directory before importing the adapter. It
saves one ordinary workflow batch per suite plus `index.json`, a coverage index.
Import each report into the dashboard or upload it with `tracedojo upload`; the
matrix definition and coverage index themselves are not run reports. Compare
matching per-tool reports with the existing `compare` command in CI. Aggregate
matrix comparison and a matrix-specific dashboard are not yet implemented.

Exit 0 requires all suites to pass; 1 means completed evidence contains failures;
3 means some evidence is missing, interrupted, or inconclusive. Invalid input/setup
exits 2. An unreached tool does not prevent testing the next tool, but remains
incomplete. A failed control, cancellation, timeout, or execution-contract issue
stops remaining suites. The index distinguishes completed reports, errors without
reports, and suites not run. Completed reports survive later failures.

### Adapter contract

`workflow.json` defines the task, initial state, checks, and fault scenarios.
`adapter.mjs` exports `tools` and `createAgent()`. The factory must return fresh
conversation state for every trial. Change its version when changing the agent.

The decision loop receives:

| Field                               | Purpose                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `task`                              | The task from the workflow configuration                                     |
| `call(name, args)`                  | Invoke a simulated tool through the fault boundary                           |
| `signal`                            | Cooperative cancellation for model requests and asynchronous work            |
| `recordModel({ detail, payload? })` | Record bounded evaluator-only model observations without exposing test state |

Route every tool invocation through `call`; bypassing it bypasses TraceDojo.
Results are `{ ok: true, data }`, `{ ok: false, error }`, or a malformed string
when that fault is injected. Return `{ status: 'completed' | 'blocked', message,
output? }`. The agent does not receive the evaluator's initial/final state.

Tools declare `kind: 'read' | 'write'` and `execute(args, state, context)`, returning
a result directly or through a promise. `context.signal` supplies cancellation.
A successful write commits its state draft; errors discard it. Read tools must
not mutate state. Implement in-memory behavior, including your own argument
validation and idempotency rules. Use synthetic fixtures; do not call real
services from simulated handlers. Concurrent calls are queued in invocation order;
each transaction, including its awaits, finishes before the next draft starts.
Late results cannot commit after cancellation, completion, or a deadline. This
does not simulate overlapping service transactions. Your agent's model calls can
be asynchronous.

Adapters are trusted local `.mjs`/`.js` modules; compile TypeScript before loading
it. They can access the environment and network. Cancellation and tool limits are
cooperative, not a security sandbox. Model calls you add may incur charges.

### LangChain JavaScript

For tools with waits or retry backoff, you can first try the virtual-time starter
described below; it works with the same `context.call` boundary.

Install `@langchain/core` and `zod` in your agent repository. The wrapper is
available at `@tracedojo/sdk/langchain`; it creates tools with validated arguments
whose execution goes through the simulated boundary.

This complete scripted adapter demonstrates the boundary. Save it as
`dojo/langchain-adapter.mjs` alongside the generated `adapter.mjs`:

```js
import { z } from 'zod';
import { createLangChainTools } from '@tracedojo/sdk/langchain';
export { tools } from './adapter.mjs';

export function createAgent() {
  return {
    id: 'langchain-booking',
    version: '1',
    async run(context) {
      const [reserve] = createLangChainTools(context, [
        {
          name: 'reserve_slot',
          description: 'Reserve a meeting slot.',
          schema: z.object({
            customerId: z.string(),
            slot: z.string(),
            operationKey: z.string(),
          }),
        },
      ]);
      for (let attempt = 0; attempt < 3; attempt++) {
        context.signal.throwIfAborted();
        const result = JSON.parse(
          await reserve.invoke({
            customerId: 'customer_7',
            slot: 'slot_42',
            operationKey: 'one-booking',
          }),
        );
        if (typeof result !== 'string' && result.ok)
          return {
            status: 'completed',
            message: 'Booked.',
            output: { bookingId: result.data.id },
          };
        if (typeof result !== 'string' && !result.ok && !result.error.retryable)
          return { status: 'blocked', message: result.error.message };
      }
      return { status: 'blocked', message: 'Could not confirm booking.' };
    },
  };
}
```

Run it with `npx --no-install tracedojo test --adapter dojo/langchain-adapter.mjs`.
For your model-driven agent, supply these wrapped tools to its decision loop and
convert its final output into the structured completion. Do not retain the
agent's original real-service tools alongside their simulated replacements.

## Define correct outcomes

Use JSON Pointer paths: `/bookings/0/customerId` selects a field; an empty path
selects the whole state. Escape `~` as `~0` and `/` as `~1` in field names.

| Check       | Example                                                                                                             | Meaning                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `count`     | `{"id":"one","label":"One booking","type":"count","path":"/bookings","expected":1}`                                 | Exactly one array entry     |
| `equals`    | `{"id":"owner","label":"Correct customer","type":"equals","path":"/bookings/0/customerId","expected":"customer_7"}` | Exact JSON value            |
| `unchanged` | `{"id":"other","label":"Other customer unchanged","type":"unchanged","path":"/otherCustomer"}`                      | Same value before and after |

An equality check can use `"source":"completion"` to inspect the agent's stated
result. Scenario-specific `checks` replace the workflow's default checks; the
permission-revoked example expects no write and a truthful blocked completion.
Missing paths fail checks. Tool ordering and arbitrary predicates are not supported.

## Run checks on pull requests

The generated workflow installs dependencies with `npm ci`, then executes one
control and three trials per fault. It uses only read access to repository contents.
Base-branch runs fail for failed or incomplete tests. PR runs compare against the
exact base commit and fail on regressions or incomplete comparisons. The workflow
writes a Markdown summary and preserves JSON evidence for 30 days even on failure.

The summary separates passed, failed, and incomplete trials and shows whether the
fault was reached. Counts describe observed trials, not statistical confidence.
Review changes to expectations alongside the agent code; changed suites require
a matching baseline. See the baseline and persistent PR comment setup below.

The starter needs no secrets. Adding a paid model is an explicit change: supply
credentials through your CI provider and do not expose them to untrusted pull
requests. Reports are redacted by patterns, not guaranteed free of personal data.
Review artifact contents and repository visibility before using private fixtures.

## Inspect and save reports

Locally, open `/workflows` and import JSON to save reports in the local store.
On [tracedojo.com](https://tracedojo.com), sign in, create a project, and open its
Workflows page. **Preview report** loads a file in the browser without saving it.
To persist it, create an upload token in project settings and set
`TRACEDOJO_UPLOAD_TOKEN` in your terminal environment. Then:

```sh
npx --no-install tracedojo upload .tracedojo/first-report.json --url https://tracedojo.com --project YOUR_PROJECT_UUID
```

The CLI prints a link to the project. Upload retries preserve local evidence and
deduplicate the same reports. Tokens can be revoked in project settings. Never
commit credentials or include them in workflow configurations.

## Start from a LangSmith trace

Import one complete JSON trace containing its root and tool spans:

```sh
npx --no-install tracedojo import-langsmith trace.json --out imported-dojo
npx --no-install tracedojo test --config imported-dojo/workflow.json --adapter imported-dojo/adapter.mjs
```

The CLI writes `adapter.mjs`, `workflow.json`, redacted `trace.json`, and a README
with TODOs. Signatures summarize observed input/output shapes and map tool names
to safe aliases. They are not an authoritative API contract. With successful,
unambiguous tool observations, the no-fault playback passes and the injected
timeout fails (exit 1). This demonstrates an interrupted recorded sequence, not a
bug discovered in your actual agent. Missing, conflicting, or error outputs block
the control until the stubs are implemented. Scaffolds accept up to 90 tool calls.

Replace the read-only fixture stubs with stateful simulations, supply synthetic
starting state, define independent correctness checks, and connect your agent.
Review write/read classifications before choosing write faults. Export order is
preserved when timestamps are incomplete; playback does not reconstruct parallel
scheduling. No model or service is contacted by the generated code.

The dashboard still produces a review draft. For the same JSON-only output from
the CLI, use `import-langsmith trace.json --draft-only --out trace-draft.json`.
Direct LangSmith API synchronization is not implemented.

For complete stateful examples, run `npx --no-install tracedojo templates`, then
`npx --no-install tracedojo init --template refunds --out dojo`. Ten worlds cover calendar,
payments, refunds, CRM, email, files, SQL, inventory, subscriptions, and webhooks.
Each includes five faults and instructions to reproduce a retry bug. These are
small fixture simulations, not full implementations of external services.

## Async tools and virtual time

Generate a complete example with `npx --no-install tracedojo init --virtual-time`.
It wraps the reference tools with a 25 ms simulated delay and retries with a
1000 ms backoff. Run `npx --no-install tracedojo test` as usual. The lost-confirmation
scenario takes 1050 simulated milliseconds: two tool attempts plus one backoff.
No real service or model is contacted. This option also works with `--template`.

For an existing workflow, add `"clock": { "mode": "virtual", "startMs": 0,
"maxTimeMs": 60000 }` to its JSON. Agents and tool handlers both receive a clock:

```js
async execute(args, state, { clock, signal }) {
  await clock.sleep(25);
  signal.throwIfAborted();
  state.updatedAt = clock.now();
  return { ok: true, data: state.updatedAt };
}
```

Use `await context.clock.sleep(1000)` for agent backoff. Each trial gets a new
clock. Concurrent sleeps resolve in due-time order; equal-time sleepers retain
registration order. Whole tool transactions remain serialized. The clock advances
when awaiting work yields; it does not reproduce distributed service concurrency.
`Date.now()`, native timers, model requests, and external I/O are not virtualized.
Without the optional clock setting, this API uses real time.

Sleep delays must be integer milliseconds from 0 to 86400000. Each trial allows
at most 1000 sleeps. Exceeding the virtual time budget produces `timed_out`;
invalid delays or excessive sleeps produce incomplete evidence, even if agent
code catches the error. Abandoned sleeps are reported as unawaited work. The
real `limits.timeoutMs` deadline remains active for hangs and external calls.

Reports store the clock's start/end and virtual event timestamps. The dashboard
shows simulated elapsed time separately from `metrics.durationMs`, which remains
actual runtime. Clock settings are included in the suite fingerprint, so real-time
and virtual-time runs cannot silently compare as matching conditions.

## Gate on regressions

Save a full batch from the base commit and another from the candidate, using the
same workflow and trial count. Compare them with:

```sh
npx --no-install tracedojo compare --base main-report.json --candidate pr-report.json --out comparison.json --summary comparison.md
```

Exit 0 means no new failures in the matched observations, even if known failures
remain. Exit 1 means a scenario's failed-trial count, an individual assertion's
failure count, or an execution-limit failure count increased. A newly failed
no-fault control is also a regression. Improvements cannot cancel out a newly
failing assertion elsewhere.

Exit 3 means the comparison is incomplete: missing reports, changed suite or
agent identity, unequal trial counts, interrupted trials, or unreached faults.
Invalid JSON/report evidence exits 2. Neither should count as passing CI.
Changed scenarios require review and a matching baseline; they are never silently
dropped from comparison. Agent versions may differ. Simulated tool code is not
part of the suite fingerprint, so review changes to its behavior separately.
Counts describe observed trials, not statistical significance.

### GitHub baseline and persistent PR comment

`init --ci` creates `.github/workflows/tracedojo.yml`,
`.github/workflows/tracedojo-comment.yml`, and `.github/tracedojo/comment.cjs`.
Merge these files to the default branch first. The test workflow saves full
reports on pushes to `main`. Change the branch filter if your base branch differs.
For PRs it fetches the same workflow's report for the exact PR base commit, runs
three trials per scenario on the head commit, and gates the comparison. Known
failures can remain on a PR without creating a new regression; pushes to the base
branch still require all tests to pass. No model credentials are configured.

Reports are retained for 30 days. Missing or expired baseline artifacts produce an
incomplete gate, never an automatic pass. Rerun the base commit's workflow to
recreate its artifact, or manually dispatch the workflow on that exact base ref.
When tests change, review the new suite and establish matching baseline evidence.
Configure the `agent-checks` job as a required check in branch protection if you
want GitHub to enforce it before merges; generating a workflow does not change
repository protection settings. The initial adoption PR may report an incomplete
comparison until these workflows reach the default branch. Verify that its first
baseline run succeeds before making the check required.

The separate `workflow_run` job posts one comment per workflow and updates it on
subsequent runs. It checks the current PR head/base and refuses stale results.
It reads only bounded comparison JSON, never executes artifact contents, and
loads its script from the default branch. Test execution has read-only permissions;
only the comment job has `pull-requests: write`. This follows
[GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use).
Fork results can be commented after the repository's normal Actions approval;
repository policy may still restrict bot writes. Missing or invalid comparison
data produces an incomplete comment. The comment supplements the check, not a
security attestation of untrusted PR code.

## Troubleshooting

### Setup and output files

- **Init cannot create files:** choose a new starter directory and check whether
  `.github/workflows/tracedojo.yml` already exists. Existing files are preserved.
- **Test exits 2:** check paths, JSON, dependency installation, and adapter exports.
  Raw loader/schema details are suppressed to avoid leaking inputs.
- **Adapter import errors:** run from the repository containing your installed
  dependencies, check the adapter path, and ensure its exports match the adapter
  contract above. Use Node 22.23.1 or newer. Review trusted adapter code locally;
  avoid posting credentials or private traces when requesting support.
- **`--out` already exists:** choose a fresh report filename and, when used, a
  fresh `--summary` filename. TraceDojo opens output files exclusively and does
  not overwrite previous evidence. Archive the previous run instead of deleting
  it just to make the command pass.
- **CI cannot install the SDK:** commit `package.json` and `package-lock.json`
  with the pinned published SDK dependency. If using the optional local archive
  installation, commit that archive too. Avoid local directory links. Validate
  with `npm ci` in a fresh checkout.

### Incomplete or failed runs

- **Exit code 3:** the test is incomplete or the comparison is incomparable.
  Inspect the saved report for an untriggered fault, stopped run, missing trials,
  or mismatched task, checks, initial state, or fault schedule. Do not treat it
  as a passing check. Exit 1 means an observed failure or regression; exit 0
  means the command's checks passed, not a guarantee of production reliability.
- **Control fails:** fix ordinary execution before interpreting resilience. No
  fault trials run until the control passes.
- **Fault not reached:** target a tool and occurrence the agent actually calls;
  skipped faults do not establish recovery.

### Saving and comparing evidence

- **Hosted preview disappears:** upload with a project token to save the report.
- **Report too large:** imports/uploads accept at most 5 MB per payload. Reduce
  fixture/trace size or trial count. CLI upload chunks batches into bounded groups.
- **Cannot compare as an improvement:** verify matching task, initial state,
  checks, and fault schedule. A different suite is a different experiment.
