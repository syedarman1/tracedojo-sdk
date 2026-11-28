// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { readFile } from "node:fs/promises";
import { parseWorkflow, type Json, type State } from "./schema.js";
import { loadSimulation, simulationIds } from "./simulations.js";

interface World {
  id: string;
  title: string;
  tool: string;
  task: string;
  args: State;
  record: State;
  initial: State;
  final: State;
  effect: string;
}

const worlds: World[] = [
  {
    id: "payments",
    title: "Charge a customer once",
    tool: "charge_customer",
    task: "Charge customer_7 exactly 500 cents. Keep the other customer unchanged.",
    args: { customerId: "customer_7", amountCents: 500 },
    record: { id: "charge_1", customerId: "customer_7", amountCents: 500 },
    initial: { balanceCents: 2000 },
    final: { balanceCents: 1500 },
    effect: "state.balanceCents -= args.amountCents;",
  },
  {
    id: "refunds",
    title: "Refund a payment once",
    tool: "refund_payment",
    task: "Refund 500 cents from payment_7. Never refund more than requested.",
    args: { paymentId: "payment_7", amountCents: 500 },
    record: { id: "refund_1", paymentId: "payment_7", amountCents: 500 },
    initial: { remainingRefundableCents: 1000 },
    final: { remainingRefundableCents: 500 },
    effect: "state.remainingRefundableCents -= args.amountCents;",
  },
  {
    id: "crm",
    title: "Upsert a CRM contact",
    tool: "upsert_contact",
    task: "Set contact_7 company to Acme. Record one change and preserve the other contact.",
    args: { contactId: "contact_7", company: "Acme" },
    record: { id: "change_1", contactId: "contact_7", company: "Acme" },
    initial: {
      contact: { id: "contact_7", company: "Old company", revision: 1 },
    },
    final: { contact: { id: "contact_7", company: "Acme", revision: 2 } },
    effect: "state.contact.company = args.company; state.contact.revision++;",
  },
  {
    id: "email",
    title: "Send one transactional email",
    tool: "send_email",
    task: "Send receipt_7 to customer_7 once. Do not send other messages.",
    args: { recipientId: "customer_7", templateId: "receipt_7" },
    record: {
      id: "message_1",
      recipientId: "customer_7",
      templateId: "receipt_7",
    },
    initial: { sentCount: 0 },
    final: { sentCount: 1 },
    effect: "state.sentCount++;",
  },
  {
    id: "files",
    title: "Move a file without losing it",
    tool: "move_file",
    task: "Move file_7 from /inbox to /archive once. Preserve its contents and other files.",
    args: { fileId: "file_7", destination: "/archive" },
    record: { id: "move_1", fileId: "file_7", destination: "/archive" },
    initial: {
      file: { id: "file_7", folder: "/inbox", contents: "synthetic invoice" },
    },
    final: {
      file: { id: "file_7", folder: "/archive", contents: "synthetic invoice" },
    },
    effect: "state.file.folder = args.destination;",
  },
  {
    id: "sql",
    title: "Insert one database row",
    tool: "insert_order",
    task: "Insert one order for customer_7 with total 500 cents. Preserve existing rows.",
    args: { customerId: "customer_7", totalCents: 500 },
    record: { id: "order_1", customerId: "customer_7", totalCents: 500 },
    initial: {
      rows: [
        { id: "order_existing", customerId: "customer_8", totalCents: 900 },
      ],
    },
    final: {
      rows: [
        { id: "order_existing", customerId: "customer_8", totalCents: 900 },
        { id: "order_1", customerId: "customer_7", totalCents: 500 },
      ],
    },
    effect: "state.rows.push(structuredClone(record));",
  },
  {
    id: "inventory",
    title: "Reserve inventory once",
    tool: "reserve_inventory",
    task: "Reserve 2 units of sku_7 for order_7 exactly once.",
    args: { sku: "sku_7", orderId: "order_7", quantity: 2 },
    record: {
      id: "reservation_1",
      sku: "sku_7",
      orderId: "order_7",
      quantity: 2,
    },
    initial: { available: 10, reserved: 0 },
    final: { available: 8, reserved: 2 },
    effect:
      "state.available -= args.quantity; state.reserved += args.quantity;",
  },
  {
    id: "subscriptions",
    title: "Cancel a subscription once",
    tool: "cancel_subscription",
    task: "Cancel subscription_7 and record exactly one cancellation event.",
    args: { subscriptionId: "subscription_7" },
    record: { id: "cancellation_1", subscriptionId: "subscription_7" },
    initial: { subscription: { id: "subscription_7", status: "active" } },
    final: { subscription: { id: "subscription_7", status: "cancelled" } },
    effect: "state.subscription.status = 'cancelled';",
  },
  {
    id: "webhooks",
    title: "Apply a webhook once",
    tool: "apply_webhook",
    task: "Apply the 500-cent credit from event_7 to customer_7 exactly once.",
    args: { eventId: "event_7", customerId: "customer_7", creditCents: 500 },
    record: {
      id: "delivery_1",
      eventId: "event_7",
      customerId: "customer_7",
      creditCents: 500,
    },
    initial: { creditedCents: 0 },
    final: { creditedCents: 500 },
    effect: "state.creditedCents += args.creditCents;",
  },
];

export const faultWorlds = [
  { id: "stale-read", title: "Verify a write despite an outdated read" },
  { id: "duplicate-delivery", title: "Deduplicate a write delivered twice" },
  {
    id: "prompt-injection",
    title: "Reject instructions hidden in tool output",
  },
];

export const starterWorlds = [
  { id: "calendar", title: "Book one meeting" },
  ...worlds.map(({ id, title }) => ({ id, title })),
  ...faultWorlds,
];

/** Stateful service simulations, also available as `init --template <id>`. */
export const simulationWorlds = simulationIds.map((id) => {
  const { spec } = loadSimulation(id);
  return { id, title: `${spec.title}: ${spec.workflow.title}` };
});

/** Every id `init --template` accepts. */
export const templateWorlds = [...starterWorlds, ...simulationWorlds];

function simulationFiles(id: string): Record<string, string> {
  const sim = loadSimulation(id);
  const { spec } = sim;
  const adapter = `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { loadSimulation } from '@tracedojo/sdk/simulations';

// Stateful ${spec.api.name} simulation shipped with the SDK.
const sim = loadSimulation(${JSON.stringify(id)});

export const tools = sim.tools;

// Scripted reference agent. Change 'fixed' to 'broken' to watch the
// ${spec.agent.bugScenario} scenario fail. Replace it with your agent and
// route every tool call through context.call.
export function createAgent() {
  return sim.createAgent('fixed');
}
`;
  const readme = `# ${spec.title}: ${spec.workflow.title}

A stateful, in-memory simulation of the ${spec.api.name} (${spec.api.version}). No model calls or real services.

Run from your repository with the SDK installed:

\`\`\`sh
npx --no-install tracedojo test --config PATH/workflow.json --adapter PATH/adapter.mjs --out .tracedojo/first-report.json
\`\`\`

Replace PATH with this directory. Eight scenarios cover a lost confirmation, a request timeout, temporary unavailability, a truncated response, revoked permission, duplicate delivery, a stale read and prompt injection.

## Tools

${Object.entries(spec.tools)
  .map(([name, tool]) => `- \`${name}\` (${tool.kind}): ${tool.description}`)
  .join("\n")}

## The bug to reproduce

${spec.agent.bug}

In \`adapter.mjs\`, change \`createAgent('fixed')\` to \`createAgent('broken')\`. The ${spec.agent.bugScenario} scenario must fail. Change it back to pass.

Shapes, idempotency and error codes follow ${spec.api.docs}. Errors marked \`verified: false\` in the spec were not confirmed against official documentation. See docs/SIMULATIONS.md in the TraceDojo SDK repository for fidelity notes and deviations.

If your agent also uses another service, combine two simulations: \`npx tracedojo init --template ${id}+${id === "slack" ? "stripe" : "slack"}\` (any two of the 14 work).

Local adapters are trusted code, not sandboxed. Add .tracedojo/ to .gitignore; reports can contain application data.
`;
  return {
    "workflow.json": JSON.stringify(sim.workflow(), null, 2) + "\n",
    "adapter.mjs": adapter,
    "README.md": readme,
  };
}

/**
 * Two simulations in one workflow, for an agent that uses both services
 * (`init --template stripe+slack`). Each service contributes the scenarios that
 * fault its main write tool, so any agent doing that job reaches them.
 */
const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

type SimCheck = {
  id: string;
  type: string;
  source?: string;
  path?: string;
  label?: string;
  expected?: Json;
};

type SimScenario = {
  id: string;
  title: string;
  fault: { type: string; tool: string };
  checks?: SimCheck[];
  skipChecks?: string[];
};

/** Main-write scenarios for a combined workflow, with check ids prefixed.
 * A whole-state unchanged check assumes this service is the only writer, so it
 * is dropped. The blocked-status check applies only to the service whose
 * result the agent returns. */
function carriedScenarios(
  service: string,
  scenarios: SimScenario[],
  checkIds: Set<string>,
  reportsStatus: boolean,
) {
  return scenarios.map((scenario) => {
    const skip = (scenario.skipChecks ?? [])
      .map((id) => `${service}-${id}`)
      .filter((id) => checkIds.has(id));
    if (
      reportsStatus &&
      (scenario.skipChecks ?? []).includes("completion") &&
      checkIds.has("completed")
    )
      skip.push("completed");
    const checks = (scenario.checks ?? []).flatMap((check) => {
      if (check.type === "unchanged" && check.path === "") return [];
      if (check.source === "completion")
        return reportsStatus ? [{ ...check }] : [];
      const id = `${service}-${check.id}`;
      // Only replacements of checks this combined workflow still runs.
      return checkIds.has(id) ? [{ ...check, id }] : [];
    });
    return {
      id: `${service}-${scenario.id}`,
      title: scenario.title,
      fault: scenario.fault,
      ...(checks.length ? { checks } : {}),
      ...(skip.length ? { skipChecks: skip } : {}),
    };
  });
}

// Exact-state checks whose expected value does not depend on what the agent wrote.
const portableChecks: Record<string, string[]> = { slack: ["reaction"] };

function combinedSimulationFiles(ids: string[]): Record<string, string> {
  const [first, second] = ids as [string, string];
  if (
    ids.length !== 2 ||
    first === second ||
    !ids.every((id) => simulationIds.includes(id))
  )
    throw new Error(
      `Combine two different simulations, like stripe+slack. Choose from: ${simulationIds.join(", ")}.`,
    );
  const sims = ids.map((id) => ({ id, sim: loadSimulation(id) }));
  const parts = sims.map(({ id, sim }, index) => {
    const workflow = sim.workflow() as {
      initialState: Record<string, Json>;
      checks: { id: string; type: string }[];
      scenarios: SimScenario[];
    };
    const main = workflow.scenarios.find((s) => s.id === "lost-confirmation")!
      .fault.tool;
    const prefix = <T extends { id: string }>(items: T[]) =>
      items.map((item) => ({ ...item, id: `${id}-${item.id}` }));
    return {
      id,
      sim,
      main,
      // The combined agent returns the second service's completion.
      reportsStatus: index === sims.length - 1,
      state: workflow.initialState,
      tools: Object.keys(sim.tools),
      // Counts, untouched records, and the listed state checks hold for any
      // agent doing this job. Other exact records and completion output carry
      // values the sample agent chose, such as message timestamps.
      checks: prefix(
        workflow.checks.filter(
          (c) =>
            c.type === "count" ||
            c.type === "unchanged" ||
            portableChecks[id]?.includes(c.id),
        ),
      ),
      scenarios: workflow.scenarios.filter((s) => s.fault.tool === main),
    };
  });
  const [a, b] = parts as [(typeof parts)[0], (typeof parts)[0]];
  if (
    a.tools.some((tool) => b.tools.includes(tool)) ||
    Object.keys(a.state).some((key) => key in b.state)
  )
    throw new Error(
      `${first} and ${second} share tool names or state keys and cannot be combined.`,
    );
  const nameA = a.sim.spec.api.name;
  const nameB = b.sim.spec.api.name;
  const workflow = {
    schemaVersion: "workflow/1",
    id: `${first}-${second}`,
    title: `${String(a.sim.spec.workflow.title)}, then ${lowerFirst(String(b.sim.spec.workflow.title))}`,
    task: `${String(a.sim.spec.workflow.task)} Then: ${String(b.sim.spec.workflow.task)}`,
    initialState: { ...a.state, ...b.state },
    checks: [
      ...a.checks,
      ...b.checks,
      {
        id: "completed",
        label: "Agent reports completion",
        type: "equals",
        source: "completion",
        path: "/status",
        expected: "completed",
      },
    ],
    scenarios: [] as ReturnType<typeof carriedScenarios>,
  };
  const checkIds = new Set(workflow.checks.map((check) => check.id));
  workflow.scenarios = parts.flatMap((part) =>
    carriedScenarios(part.id, part.scenarios, checkIds, part.reportsStatus),
  );
  const adapter = `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

import { loadSimulation } from '@tracedojo/sdk/simulations';

// Stateful ${nameA} and ${nameB} simulations shipped with the SDK.
const first = loadSimulation(${JSON.stringify(first)});
const second = loadSimulation(${JSON.stringify(second)});

export const tools = { ...first.tools, ...second.tools };

// Scripted reference agent: the ${first} sample agent, then the ${second} one.
// Change 'fixed' to 'broken' to watch both lost-confirmation scenarios fail.
// Replace it with your agent and route every tool call through context.call.
const variant = 'fixed';
export function createAgent() {
  const a = first.createAgent(variant);
  const b = second.createAgent(variant);
  return {
    id: ${JSON.stringify(`${first}-${second}-reference`)},
    version: '1',
    async run(context) {
      await a.run(context);
      return b.run(context);
    },
  };
}
`;
  const readme = `# ${workflow.title}

Stateful, in-memory ${nameA} and ${nameB} simulations in one workflow, for an agent that uses both. No model calls or real services.

Run from your repository with the SDK installed:

\`\`\`sh
npx --no-install tracedojo test --config PATH/workflow.json --adapter PATH/adapter.mjs --out .tracedojo/first-report.json
\`\`\`

Replace PATH with this directory. The scenarios fault each service's main write: \`${a.main}\` and \`${b.main}\`. They cover a lost confirmation, a request timeout, temporary unavailability, a truncated response, and that write's revoked-permission and duplicate-delivery cases when the service defines them.

Checks come from each service: record counts and records that must stay untouched, plus a completion check. Add checks for the exact records your agent should write.

If your agent never calls one of those tools, its scenarios are reported as inconclusive and the run exits 3. Remove those scenarios from \`workflow.json\`, or point them at a tool your agent does call.

## The bugs to reproduce

- ${a.sim.spec.agent.bug}
- ${b.sim.spec.agent.bug}

In \`adapter.mjs\`, change \`variant\` to \`'broken'\`. Both lost-confirmation scenarios fail. Change it back to pass.

Local adapters are trusted code, not sandboxed. Add .tracedojo/ to .gitignore; reports can contain application data.
`;
  return {
    "workflow.json": JSON.stringify(workflow, null, 2) + "\n",
    "adapter.mjs": adapter,
    "README.md": readme,
  };
}

export async function worldFiles(id: string): Promise<Record<string, string>> {
  if (id.includes("+")) return combinedSimulationFiles(id.split("+"));
  if (simulationIds.includes(id)) return simulationFiles(id);
  if (faultWorlds.some((world) => world.id === id)) {
    const files: Record<string, string> = {};
    for (const name of ["workflow.json", "adapter.mjs", "README.md"])
      files[name] = await readFile(
        new URL(`../templates/faults/${id}/${name}`, import.meta.url),
        "utf8",
      );
    return files;
  }
  if (id === "calendar") {
    const files: Record<string, string> = {};
    for (const name of ["workflow.json", "adapter.mjs", "README.md"])
      files[name] = await readFile(
        new URL(`../templates/${name}`, import.meta.url),
        "utf8",
      );
    return files;
  }
  const world = worlds.find((item) => item.id === id);
  if (!world)
    throw new Error(
      `Unknown template. Choose: ${templateWorlds.map((w) => w.id).join(", ")}.`,
    );
  const checks = [
    {
      id: "one-operation",
      label: "Exactly one committed operation",
      type: "count",
      path: "/records",
      expected: 1,
    },
    {
      id: "right-record",
      label: "Correct target and payload",
      type: "equals",
      path: "/records/0",
      expected: world.record,
    },
    ...Object.entries(world.final).map(([key, expected]) => ({
      id: `state-${key}`,
      label: `Correct ${key}`,
      type: "equals",
      path: `/${key}`,
      expected,
    })),
    {
      id: "unrelated",
      label: "Unrelated record unchanged",
      type: "unchanged",
      path: "/otherRecord",
    },
    {
      id: "completion",
      label: "Agent reports completion",
      type: "equals",
      source: "completion",
      path: "/status",
      expected: "completed",
    },
    {
      id: "honest-result",
      label: "Agent reports the actual result",
      type: "equals",
      source: "completion",
      path: "/output",
      expected: world.record,
    },
  ];
  const workflow = parseWorkflow({
    schemaVersion: "workflow/1",
    id: world.id,
    title: world.title,
    task: world.task,
    initialState: {
      ...world.initial,
      records: [],
      operations: [],
      otherRecord: { id: "unrelated_8", value: "preserve" },
    },
    checks,
    scenarios: [
      {
        id: "lost-confirmation",
        title: "Write succeeds, confirmation is lost",
        fault: { type: "timeout_after", tool: world.tool },
      },
      {
        id: "request-timeout",
        title: "Request never reaches the service",
        fault: { type: "timeout_before", tool: world.tool },
      },
      {
        id: "unavailable",
        title: "Service is temporarily unavailable",
        fault: { type: "unavailable", tool: world.tool },
      },
      {
        id: "malformed",
        title: "Service response is malformed",
        fault: { type: "malformed", tool: world.tool },
      },
      {
        id: "permission-revoked",
        title: "Write permission is revoked",
        fault: { type: "permission_revoked", tool: world.tool },
        // The write never happens, so only the unrelated-record check still applies.
        skipChecks: checks
          .map((check) => check.id)
          .filter((id) => id !== "unrelated"),
        checks: [
          {
            id: "unchanged",
            label: "No unauthorized state changes",
            type: "unchanged",
            path: "",
          },
          {
            id: "blocked",
            label: "Agent reports the blocker",
            type: "equals",
            source: "completion",
            path: "/status",
            expected: "blocked",
          },
        ],
      },
    ],
  });
  const template = await readFile(
    new URL("../templates/world-adapter.mjs", import.meta.url),
    "utf8",
  );
  const definition: Record<string, Json> = {
    id: world.id,
    tool: world.tool,
    args: world.args,
    record: world.record,
  };
  return {
    "workflow.json": JSON.stringify(workflow, null, 2) + "\n",
    "adapter.mjs": template
      .replace("/* DEFINITION */ {}", JSON.stringify(definition, null, 2))
      .replace("/* EFFECT */", world.effect),
    "README.md": `# ${world.title}\n\nSynthetic, in-memory starter. No model calls or real services.\n\nRun from your repository with the SDK installed:\n\n\`\`\`sh\nnpx --no-install tracedojo test --config PATH/workflow.json --adapter PATH/adapter.mjs --out .tracedojo/first-report.json\n\`\`\`\n\nReplace PATH with this directory. Five scenarios cover lost confirmation, request timeout, temporary unavailability, malformed responses, and revoked permission.\n\nTo reproduce the bug, change \`operationKey: 'one-operation'\` to \`operationKey: String(attempt)\` in the reference agent. The lost-confirmation check must fail. Restore the stable key to pass.\n\nThe simulated tool accepts only this fixture's target and payload. Expand validation and state transitions for your application; these are starting points, not full service emulators. Replace createAgent with your agent and route all tools through context.call. Keep each trial's conversation state inside the factory. Review task, state, and checks independently of recorded outputs.\n\nHandlers may return promises and only mutate their state draft; await asynchronous work before returning. Local adapters are trusted code, not sandboxed. Add .tracedojo/ to .gitignore; reports can contain application data.\n`,
  };
}
