# Tool simulations

Fourteen stateful, in-memory simulations of real services ship with `@tracedojo/sdk`. Each one keeps
state between calls, returns the service's response shapes and error codes, honors the service's
idempotency rules, and works with every TraceDojo tool fault. None of them call a network or a model.

```sh
npx tracedojo templates                         # list them
npx tracedojo init --template stripe --out dojo  # workflow.json, adapter.mjs, README.md
npx --no-install tracedojo test --config dojo/workflow.json --adapter dojo/adapter.mjs
```

Or use one directly:

```js
import { loadSimulation } from '@tracedojo/sdk/simulations';

const stripe = loadSimulation('stripe');
export const tools = stripe.tools;           // SimulatedTool map for runWorkflow / the CLI
const workflow = stripe.workflow();          // workflow/1 with the spec's initial state
const agent = stripe.createAgent('fixed');   // scripted reference agent ('fixed' or 'broken')
const defs = stripe.toolDefinitions();      // [{ name, description, parameters }] for a model's tool API
```

`loadSimulation(spec)` also accepts your own spec object; it is validated the same way.

## Catalog

| Id | Service | Tools (read / write) | Workflow | Bug the broken agent has |
| --- | --- | --- | --- | --- |
| `stripe` | Stripe API v1 (2026-10-28) | retrieve payment intent, retrieve charge, list refunds / create refund | Refund part of a payment once | Puts the attempt number in its idempotency key, so a retry refunds twice |
| `slack` | Slack Web API | conversations.history / chat.postMessage, reactions.add | Announce a fix once | Retries chat.postMessage without checking history, so it posts twice |
| `github` | GitHub REST API (2022-11-28) | get pull request, list issue comments / merge, create issue comment | Merge a PR and comment once | Retries a merge that landed, gets 405, reports failure |
| `gmail` | Gmail API v1 | messages.list, messages.get / messages.send, messages.modify | Email a receipt once | Retries messages.send without searching its Message-ID, so it sends twice |
| `google-calendar` | Google Calendar API v3 | events.list, events.get / events.insert, events.patch | Book one meeting | Retries an insert with its own event id and gets 409 duplicate |
| `postgres` | PostgreSQL 16 (structured queries) | select / insert | Insert one order row | Retries INSERT without ON CONFLICT DO NOTHING and gets 23505 |
| `shopify` | Shopify Admin GraphQL (2026-01) | inventory level / inventoryAdjustQuantities | Reserve inventory once | No idempotency key or changeFromQuantity, so a retry decrements twice |
| `zendesk` | Zendesk Ticketing API v2 | show ticket, list comments / create ticket, update ticket | Reply and solve once | Retries an update that carries a comment, so the customer gets it twice |
| `jira` | Jira Cloud REST API v3 | search, get issue / create issue, transition, add comment | Open one incident issue | Retries create without searching its label, so it opens two issues |
| `hubspot` | HubSpot CRM v3 (contacts) | search, get / create, update | Add a lead once | Retries create, gets 409 CONFLICT for the contact it made, reports failure |
| `datadog` | Datadog Incident Management API v2 | search incidents, get / create, update | Declare and resolve one incident | Retries create without searching its title, so the outage gets two incidents and one stays open |
| `pagerduty` | PagerDuty Events API v2 + REST incidents | list incidents / enqueue event | Page once, acknowledge and resolve | Triggers without a dedup_key, so a retry pages on-call twice |
| `sentry` | Sentry API (issues) | get, list issues, list comments / update issue, create comment | Resolve an issue and note it once | Retries a comment without listing comments, so the note appears twice |
| `salesforce` | Salesforce REST API v62.0 (Contact) | query, get / create, upsert, update | Sync two contacts idempotently | Retries a POST create without querying its external ID, so the contact is duplicated |

Every simulation has the same eight scenarios: lost confirmation, request timeout, temporary
unavailability, truncated response, revoked permission, duplicate delivery, stale read and prompt
injection. The fixed reference agent passes all eight. The broken one passes the no-fault baseline
and fails at least the lost-confirmation scenario.

## Fidelity

Response shapes, idempotency behavior and error codes were checked against each service's official
documentation. Errors that could not be confirmed there are marked `"verified": false` in the spec
file (`packages/sdk/simulations/<id>.json`) and listed below. Treat their exact code and message as a
best guess; the status and the fact that the call fails are what the simulation relies on.

| Id | Idempotency | Unverified errors |
| --- | --- | --- |
| `stripe` | `idempotency_key` replays the stored response; a different request with the same key returns `idempotency_error` | `invalid_request_error` for bad types, `parameter_missing` for refunds without a target, `parameters_exclusive`, `amount_too_large` (from a secondary source) |
| `slack` | None; a retry posts again. `reactions.add` repeats return `already_reacted` | `invalid_arguments` |
| `github` | None; the merge `sha` check returns 409 `head_modified`, a merged PR returns 405 | `validation_failed` (422) |
| `gmail` | None; a retry sends again. Search by `rfc822msgid` to check first | `invalidArgument`, `notFound` |
| `google-calendar` | A client-supplied event id; a repeat returns 409 `duplicate`. `ifMatch` etags return 412 | `required`, `invalid` (input validation) |
| `postgres` | `ON CONFLICT (target) DO NOTHING` returns `rowCount: 0` | `22023` for malformed tool input |
| `shopify` | `@idempotent(key:)`; a reused key with different input returns the `IDEMPOTENCY_KEY_PARAMETER_MISMATCH` user error. `changeFromQuantity` returns `CHANGE_FROM_QUANTITY_STALE` | `INVALID_VARIABLES` for malformed tool input |
| `zendesk` | `Idempotency-Key` on ticket create; a different body returns `IdempotentRequestError`. `safe_update` with `updated_stamp` returns 409 when stale | `RecordInvalid`, `RecordNotFound`, `UpdateConflict` (status confirmed, error name not) |
| `jira` | None; search by label before retrying a create | All Jira error messages and the `bad_request`/`not_found` codes |
| `hubspot` | None; email is unique, so a repeat create returns 409 `CONFLICT` with the existing id | `VALIDATION_ERROR`, `OBJECT_NOT_FOUND` |
| `datadog` | None; search for your incident before retrying a create. Resolving twice changes nothing | `not_found` message, `Invalid value for` field errors (docs show only `{"errors": ["Bad Request"]}`) |
| `pagerduty` | `dedup_key`: a trigger joins the open alert with the same key and routing key; a resolved key opens a new incident; acknowledge and resolve without an open alert are dropped | `invalid_event` (status and message from community reports), REST `2001` input error |
| `sentry` | None for comments. Issue updates only change the attributes sent, so resolving twice is harmless | All error bodies; the comments endpoint (`/api/0/issues/{id}/comments/`) is not in the public API reference |
| `salesforce` | Upsert on an external ID field: 201 `created: true`, 200 `created: false`, 300 when several records match | All error messages; the codes (`REQUIRED_FIELD_MISSING`, `DUPLICATE_VALUE`, `NOT_FOUND`, `INVALID_FIELD`, `INVALID_TYPE`) come from Salesforce's docs, the text does not |

Shopify validation problems (`INVALID_REASON`, `INVALID_QUANTITY_NAME`, `INVALID_INVENTORY_ITEM`,
`CHANGE_FROM_QUANTITY_STALE`, `IDEMPOTENCY_KEY_PARAMETER_MISMATCH`) are GraphQL `userErrors` inside a
successful response, as in the real API, so they appear in the tool's `data`, not as tool errors.

### Deviations

These are deliberate simplifications. Each is also stated in the tool's description.

- **Codes when the API has none.** GitHub and Jira errors have no machine-readable code, so the
  simulations use a short name such as `not_found` or `bad_request` and keep the HTTP status.
- **Structured inputs instead of query languages.** Gmail takes `rfc822msgid` and `labelId` instead of
  a `q` string. Jira takes `project`, `label` and `status` instead of JQL. Postgres takes table,
  filters and values instead of SQL text. HubSpot search supports `EQ` and `NEQ` only. Datadog search takes
  `state` and `severity` lists instead of a query string, Sentry issue lists take `status` instead of a
  search query, and Salesforce takes `sobject` and `where` filters instead of SOQL.
- **Gmail send** takes `to`, `subject`, `text` and `messageId` instead of a base64url MIME message.
- **Postgres** has `pg_select` and `pg_insert` only. There is no update or delete tool yet.
- **Unknown arguments** are rejected by every simulation, so typos fail loudly. Some real APIs, Slack's
  among them, ignore unknown arguments instead.
- **Stripe** does not store failed idempotent requests, so retrying a request that failed runs it again.
  Real Stripe replays some failures too.
- **Jira** transitions return `{}` for 204 No Content; comments take plain text, not Atlassian Document Format.
- **Zendesk** update and create return `{ ticket }` without the `audit` object.
- **Datadog** incidents keep a subset of attributes (no relationships, `included` or `time_to_*` metrics).
- **PagerDuty** generates zero-padded dedup keys instead of UUIDs, and maps severity critical/error to high
  urgency and warning/info to low, as a dynamic-urgency service does.
- **Sentry** issue updates return the whole issue instead of only the changed attributes.
- **Salesforce** models Contact only and returns timestamps as `2024-11-15T05:53:21Z`, not
  `2024-11-15T05:53:21.000+0000`. `External_Id__c` is an external ID field that is not unique.
- **Paging** is not simulated. List and search tools return the first page with no cursor.
- **Time** is deterministic: each spec has an `epoch`, and the clock moves one second per generated id.

## Writing your own

A simulation is one JSON file in the `simulation/1` format. The JSON Schema is published at
`packages/sdk/simulations/simulation.schema.json` (`node_modules/@tracedojo/sdk/simulations/simulation.schema.json`
in an installed project). It checks shape only. `parseSimulation` also checks every cross-reference:
tools, errors, collections, operators, scenarios and agent steps.

Top-level fields:

- `collections`: named lists of records, each with optional `unique` key sets and a `conflict` error.
- `state`: the initial records.
- `errors`: name → `{ code, message, status, retryable, verified }`. Messages may use `{{path}}` templates.
- `tools`: name → `{ kind, description, input, invalid, idempotency?, steps }`. `input` is a JSON Schema
  subset (object, string, integer, boolean, array, any). `invalid` names the error for bad input, or
  `{ missing, unknown, type }` for one per reason; the error scope gets `field`, `reason` and `value`.
  `idempotency` is `{ arg, conflict }`, where `conflict` is an error name or `{ "return": expr }`.
- `workflow`: a `workflow/1` workflow without `initialState` (the spec's `state` is used).
- `agent`: `{ bug, bugScenario, fixed, broken }`, two scripted agents. A step's `beforeRetry.find.where`
  matches items by top-level key, or by JSON pointer when the key starts with `/` (for example
  `{ "/attributes/title": "..." }`).

Steps: `let`, `require` (with `error` or `return`), `find` (live reference), `filter` (a copy, with
`order` and `limit`), `insert`, `update`, `updateWhere`, `deleteWhere`, `if`, `each`, `fail`, `return`.
A collection name may be `{ "$": path }` resolved at run time; guard it with `require` first.

Expressions: `$` (lookup), `$literal`, `$add $sub $mul $div $mod $min $max` (integers; `$div` and `$mod`
floor), `$eq $ne $lt $lte $gt $gte`, `$and $or $not $if $coalesce`, `$len $in $pick $merge $map $filter
$keys $type`, `$concat $pad $lower`, `$seq $time $isotime`, and `$filters` (PostgREST-style column filters).
null, false, 0 and "" are false; everything else, including `[]` and `{}`, is true.

Tools run against a private copy of state. Changes are kept only when the tool returns `ok`, so an error
never leaves a partial write. A matching idempotency key and request replay the stored response.

Each simulation has test vectors in `packages/sdk/simulations/vectors/<id>.json`
(`simulation-vectors/1`): call sequences with exact expected results and state. Ports to other
languages should pass the same vectors.
