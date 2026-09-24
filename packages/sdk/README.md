# TraceDojo SDK

A booking succeeds. Its confirmation times out. Your agent retries—and books twice.

TraceDojo injects tool failures, records actual state changes, and checks whether
your agent recovers correctly. Run the built-in failure and fix:

```sh
npx @tracedojo/sdk demo
```

Add the SDK to your application:

```sh
npm install --save-dev @tracedojo/sdk
npx tracedojo init --ci
npx tracedojo test
```

Use Node.js 22.23.1 or later. The starter is scripted and needs no API key.

Tools may return promises and receive `{ signal, clock }` as their third argument.
Transactions remain serialized and late results cannot commit after a trial stops.
Try `npx tracedojo init --virtual-time` for simulated service delays and retry
backoff. Use `clock.now()` / `await clock.sleep(ms)` in tools and agents. Reports
separate virtual elapsed time from actual runtime; native timers are unchanged.

Compare full batches with `npx tracedojo compare --base main-report.json --candidate pr-report.json --out comparison.json --summary comparison.md`.
Matching trials exit 0 for no new failures, 1 for regressions, and 3 for incomplete
or incompatible evidence. Known failures remain visible. Invalid input exits 2.

`init --ci` generates an exact-base regression check and a separate persistent PR
comment workflow. Merge the generated `.github/` files to the default branch first.
The comment script runs from that trusted branch; agent tests have read-only
permissions. Reports last 30 days, and missing baseline evidence blocks the gate.

List the starter worlds with `npx tracedojo templates`. Choose one with
`npx tracedojo init --template refunds --out dojo`. Available worlds: calendar,
payments, refunds, CRM (`crm`), email, files, SQL (`sql`), inventory, subscriptions,
and webhooks. Each includes five faults, a reference agent, state checks, and a
documented retry bug. These are synthetic fixtures, not full service emulators.

Use `init --template prompt-injection` for an additional tool-output attack fixture.
Its `prompt_injection` fault replaces successful response `data` with configured
JSON `replacement`; original results remain evaluator-only. The `forbidden_tool`
check catches an unsafe attempt even if it changes no state. Follow the generated
README to reproduce the scripted failure and fix; this is not a model security claim.

`init --template duplicate-delivery` tests a write request delivered twice. The
`duplicate_delivery` fault requires a write tool and preserves two transaction
records for one agent call. The fixture demonstrates service-side idempotency.

`init --template stale-read` tests version-based recovery after a write. The
`stale_read` fault substitutes the first captured successful response for identical
read inputs when a later response differs; fresh results and snapshot source stay
in evaluator evidence. Missing history or unchanged data does not trigger a fault.

Generate a fault matrix from your adapter's declared tools:

```sh
npx tracedojo matrix --out dojo/matrix.json
npx tracedojo test-matrix dojo/matrix.json --out matrix-reports
```

Generation imports trusted local code but does not invoke agents or tool handlers.
Review the editable matrix before running it: task, state, and outcome checks come
from your workflow, with matching scenario-specific checks preserved. The config
may omit `scenarios` entirely. Writes get six faults including lost confirmation
and duplicate delivery; reads get timeout, unavailability, and malformed output.
Use `--tools reserve_slot --faults timeout_after,duplicate_delivery` to narrow it.
Stale reads are opt-in (`--faults stale_read`); injection payloads require manual
review. Each tool gets a separate bounded suite and normal dashboard-compatible
report. `index.json` lists results and missing coverage; it is not a report import.
Unreached tools remain incomplete while other suites run. Interruptions and failed
controls stop remaining suites. This generates fault schedules, not business rules.

Start from a LangSmith JSON export with
`npx tracedojo import-langsmith trace.json --out imported-dojo`. This generates a
runnable playback adapter, observed signatures, and TODOs. Run it with
`npx tracedojo test --config imported-dojo/workflow.json --adapter imported-dojo/adapter.mjs`.
A successful, unambiguous trace passes its control and fails an injected timeout.
This demonstrates interrupted playback; connect your agent and define independent
state checks before treating it as an agent test. Use `--draft-only` to retain the
JSON-only import format.
Replace the task, in-memory tools, and outcome checks with your application's
behavior, and route your agent's tool calls through the SDK. LangChain JavaScript
tools are supported through `@tracedojo/sdk/langchain`.

The SDK, compiled distribution, documentation in this package, and starter
templates are licensed under [Apache-2.0](LICENSE). The hosted dashboard is
proprietary and is not included in this package.

[Setup guide](https://tracedojo.com/docs)
· [Security](https://tracedojo.com/docs/security)
· [Limitations](https://tracedojo.com/docs/limitations)
· [Dashboard](https://tracedojo.com)
