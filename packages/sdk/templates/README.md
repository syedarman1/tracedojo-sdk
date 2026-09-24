# Your first TraceDojo workflow

This is a scripted booking agent with synthetic data. It makes no model calls.
Run from your repository root, with `@tracedojo/sdk` installed:

```sh
npx --no-install tracedojo test --config dojo/workflow.json --adapter dojo/adapter.mjs
```

If you chose another directory, replace `dojo` in the command. Each invocation
saves a new report in `.tracedojo/reports/`. Add `.tracedojo/` to your repository's
`.gitignore`; reports can contain application data.

## Reproduce a bug and protect the fix

The starter passes five failure scenarios. In `adapter.mjs`, inside the call to
`reserve_slot`, replace the `operationKey,` argument with
`operationKey: String(attempt),`. Run the command again. A booking succeeds but
its confirmation is lost; retrying with a new key creates a duplicate. The check
fails and the command exits with code 1. Restore `operationKey,` and run again.

Import each report on the TraceDojo Workflows page. Select the lost-confirmation
scenario, open its failed check, and view the supporting events. Compare the
failure and fix under the same scenario.

## Connect your application

1. Replace `workflow.json` with your task, synthetic starting state, outcome checks,
   and tool failures. Scenario-specific checks can describe correct refusal.
2. Replace `tools` with in-memory simulations of your tool behavior. Handlers may
   return promises and receive cancellation through the third argument's signal.
   Successful writes commit their state draft; errors discard it. Do not connect
   these handlers to production services.
3. Replace `createAgent().run()` with your decision loop. Pass `context.task` to the
   agent and route **every** tool invocation through `context.call(name, args)`.
   Use `context.signal` for cancellation. Return a structured completion.
4. Keep conversation state inside `createAgent()` so every trial starts fresh.
   Update the agent version when changing its implementation.

Your adapter is trusted local code. It can access your environment and network;
model calls you add may cost money. Limits are cooperative, not a code sandbox.
LangChain tools can be wrapped with `@tracedojo/sdk/langchain`.

## Pull-request checks

If initialized with `--ci`, `.github/workflows/tracedojo.yml` runs this workflow
with three trials per fault. Commit your adapter, config, package manifest,
lockfile, and the SDK tarball if installed from a local archive. The SDK dependency
must be reproducible on a fresh runner; a link to a folder on your laptop will fail.

The PR job compares against a report for the exact base commit and fails on new
regressions or incomplete comparisons. Known failures remain visible. Base-branch
runs still require all checks to pass. Reports are kept for 30 days. Merge the
generated test/comment workflows and `.github/tracedojo/comment.cjs` to the
default branch first. The separate comment workflow updates one PR comment using
trusted default-branch code. Missing baseline artifacts require rerunning the
base workflow. Configure the check in branch protection to enforce it on merges.
Review artifact contents and repository visibility
before adding private fixtures. The supplied setup needs no secrets. Opt into
paid model calls separately; never expose credentials to untrusted pull requests.

Exit codes: 0 passed, 1 failed checks, 2 invalid setup/input, 3 incomplete results.
Reports preserve individual trials; new assertion failures cannot cancel each other out.

Full setup: https://tracedojo.com/docs
