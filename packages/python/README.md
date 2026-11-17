# TraceDojo for Python

**Chaos testing for AI agent tools.**

The booking succeeded. The response timed out. Your agent booked it again.

TraceDojo runs your agent against tools you simulate in memory, makes a tool call
fail on purpose, and checks what actually changed in your application's state. Every
test runs a no-fault control first, a fault the agent never reaches is reported as
inconclusive instead of passing, and `compare` gates pull requests on regressions
against the base commit.

This is the Python SDK. It writes the same report format as the JavaScript SDK
(`@tracedojo/sdk`), so the TraceDojo dashboard, `compare`, and the CI gate accept
reports from either language, and a Python report compares cleanly against a
JavaScript one for the same workflow.

Python 3.10 or later. No runtime dependencies.

```sh
pip install tracedojo
pip install "tracedojo[langgraph]"  # with the LangGraph adapter
```

## See a failure and its fix

```sh
tracedojo demo
```

It runs a scripted booking agent twice against a lost confirmation. The version
that makes a new operation key per retry books twice and fails; the version that
reuses its key passes. Both reports are saved in a new directory under `.tracedojo/`.

## Test your agent

A workflow (`workflow.json`) holds the task, the starting state, outcome checks, and
fault scenarios. It is the same `workflow/1` file the JavaScript SDK reads; see
[`docs/WORKFLOWS.md`](../../docs/WORKFLOWS.md) for every field. An adapter module
defines the simulated tools and a factory for your agent:

```python
# dojo/adapter.py
from tracedojo import tool


@tool("write")
def reserve_slot(args, state, context):
    """Only successful writes commit. Mutate the state draft, return a result."""
    key = args.get("operationKey")
    if not key:
        return {"ok": False, "error": {"code": "INVALID_ARGUMENTS", "message": "Provide operationKey.", "retryable": False}}
    if key in state["operations"]:
        return {"ok": True, "data": state["operations"][key]}
    booking = {"id": f"booking_{len(state['bookings']) + 1}", "customerId": args["customerId"], "slot": args["slot"]}
    state["bookings"].append(booking)
    state["operations"][key] = booking
    return {"ok": True, "data": booking}


tools = {"reserve_slot": reserve_slot}


class BookingAgent:
    id = "booking-agent"
    version = "1"

    async def run(self, context):
        for _attempt in range(3):
            # Route every tool call through context.call and always await it.
            # Reuse one operation key so a retry cannot book twice.
            result = await context.call(
                "reserve_slot", {"customerId": "customer_7", "slot": "slot_42", "operationKey": "one-booking"}
            )
            if isinstance(result, dict) and result["ok"]:
                return {"status": "completed", "message": "Meeting booked.", "output": {"bookingId": result["data"]["id"]}}
            if isinstance(result, dict) and not result["error"]["retryable"]:
                return {"status": "blocked", "message": result["error"]["message"]}
        return {"status": "blocked", "message": "The booking could not be confirmed."}


def create_agent():
    return BookingAgent()  # a fresh agent, with fresh conversation state, per trial
```

```sh
tracedojo test --config dojo/workflow.json --adapter dojo/adapter.py --trials 3 --out .tracedojo/report.json
```

The complete booking starter ships inside the package. Copy it to `dojo/` to start
from it (the Python CLI has no `init`):

```sh
cp -r "$(python -c 'import os, tracedojo.templates.booking as t; print(os.path.dirname(t.__file__))')" dojo
```

`init`, the service simulations, `matrix`, and `proxy` are in the JavaScript SDK
only for now.

Or from Python:

```python
from tracedojo import run_workflow, run_workflow_sync, workflow_exit_code

batch = run_workflow_sync(workflow_dict, adapter_module, trials=3, commit_sha=None)
# inside an event loop: batch = await run_workflow(workflow_dict, adapter_module)
```

### Faults and checks

Faults: `timeout_before`, `timeout_after`, `unavailable`, `malformed`,
`permission_revoked`, `duplicate_delivery`, `stale_read`, `prompt_injection`, each
with `occurrence` and `repeat`. Checks: `count`, `equals` (state or completion),
`unchanged`, `forbidden_tool`, `tool_calls`, `tool_order`. Semantics, limits, and
statuses are identical to the JavaScript SDK.

Model faults (`rate_limited`, `server_error`, `model_timeout`, `stream_cut`,
`stream_stall`, with `target: "model"`) sit between an agent process and its model
API, so only the JavaScript proxy runner (`npx tracedojo proxy`) injects them.
`run_workflow` rejects them, as the JavaScript `runWorkflow` does. The Python SDK
reads, validates, compares, summarizes, and uploads proxy reports that contain them.

### The agent context

| Member | Purpose |
| --- | --- |
| `await context.call(tool, args)` | Simulated tool call. Returns `{"ok": True, "data": ...}`, `{"ok": False, "error": {...}}`, or a string for a malformed response. |
| `context.record_model(detail, payload=None)` | Evaluator-only model telemetry. Never include credentials or private reasoning. |
| `context.clock.now()`, `await context.clock.sleep(ms)` | Real time, or virtual time when the workflow sets `"clock": {"mode": "virtual"}`. |
| `context.signal` | Cancellation flag: `aborted`, `throw_if_aborted()`. |
| `context.task` | The workflow task text. |
| `context.with_call(fn)` | A copy whose `call` is wrapped, for retry or backoff wrappers. |

Tools and `run` may be sync or async. `context.call` starts the call immediately
and returns an awaitable; a call still pending when the agent finishes is recorded
as `unawaited_calls`. Use `context.clock.sleep` (not `asyncio.sleep`) so virtual
time applies. Deadlines are cooperative: a synchronous handler that blocks the event
loop cannot be interrupted, and adapters are trusted code, not sandboxed.

## Compare, gate, and upload

```sh
tracedojo compare --base base-report.json --candidate pr-report.json --out comparison.json --summary comparison.md
TRACEDOJO_UPLOAD_TOKEN=... tracedojo upload report.json --url https://tracedojo.com --project PROJECT_UUID
```

Exit codes: 0 passed, 1 failed checks or regressions, 2 invalid input, 3 incomplete
or inconclusive evidence. Output files must be new; existing evidence is never
overwritten. Reports are redacted with the same patterns as the JavaScript SDK
before they are written.

The base and candidate reports can come from either SDK. The JavaScript
`npx tracedojo compare` and this `tracedojo compare` produce identical results.

## LangGraph

```python
from tracedojo.langgraph import LangGraphAgent

def create_agent():
    return LangGraphAgent(
        "support-agent",
        "2026-11-15",
        [reserve_slot_tool],          # your real LangChain tools; only name, description, and schema are used
        build_graph=lambda tools: my_graph_builder(model, tools),  # returns a compiled graph
        to_completion=lambda state: {"status": "completed", "message": state["messages"][-1].text},
    )
```

`create_tools(context, tools)` returns simulated stand-ins for your LangChain tools
that route through `context.call`; the live tool functions are never invoked.
Invoke graphs asynchronously (`ainvoke`). Model requests made by your graph use your
provider account and may incur charges.

## How parity is tested

`tests/test_parity.py` runs 38 workflow cases through both SDKs (the booking
starter, all eight faults, every check type, run limits, protocol violations, and
virtual time) and requires byte-identical reports after removing random IDs and
timings. It also checks that each SDK's schema accepts the other's batches and
rejects the same tampered ones, that `compare` gives identical results on mixed
pairs, and that fingerprints, imported report IDs, redaction, workflow parsing,
and Markdown summaries match. It needs Node and the built JavaScript SDK:

```sh
npm ci && npm run build            # repository root
cd packages/python && pip install -e ".[langgraph]" pytest && pytest
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
