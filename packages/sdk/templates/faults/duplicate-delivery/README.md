# One request delivered twice

Run `npx --no-install tracedojo test --config dojo/workflow.json --adapter dojo/adapter.mjs`
from the parent of `dojo` (adjust paths for your chosen directory).

The scripted reference passes. Set `deduplicate = false` in `adapter.mjs`: the
control still passes, but duplicate delivery credits 1000 cents instead of 500.
Restore it to verify the fix. This models service idempotency as well as agent inputs.

`duplicate_delivery` requires a write tool. The selected call invokes it twice,
sequentially, with identical cloned arguments and separate state transactions.
Both attempts execute even if the first returns a structured error. The agent
receives only the first response after both finish. A thrown/invalid handler or
cancellation stops execution and preserves partial evidence. This is immediate
redelivery, not arbitrary queue reordering or concurrent writes.

Evaluator-only `delivery` events distinguish executions from the single agent
`tool_call`. Each committed effect has its own mutation evidence; a deduplicated
second execution can have no mutation. Never call a real payment service here.
