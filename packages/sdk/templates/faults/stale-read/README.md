# Read your write through a stale replica

Run `npx --no-install tracedojo test --config dojo/workflow.json --adapter dojo/adapter.mjs`
from the parent of `dojo` (adjust paths for your chosen directory).

The scripted reference checks the version returned by the write and re-reads when
the replica response is older. Set `verifyVersion = false` in `adapter.mjs`: the
control passes, but the stale read makes the agent report pending for a shipped
order. The state check passes while the independent completion check fails.

`stale_read` requires a read tool. The runner pins its first successful response
for each identical set of inputs within a trial. At selected later calls, it executes
the fresh read but substitutes that earlier response when the data differs. The
fresh response remains evaluator-only; the fault's `sourceCallId` points to the
captured read. Inputs, tools, and trials never share snapshots. Errors, missing
history, and unchanged data are not counted as triggered stale reads.

Choose `occurrence: 2` or later (default scheduling starts at 1). The fixture performs
a real simulated write between reads; it does not manufacture an arbitrary old
payload. No reached differing snapshot means inconclusive, not recovered. This
models a pinned old replica response, not distributed transactions or replica lag.
