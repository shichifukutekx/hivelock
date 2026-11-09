import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDraft } from "../src/platform/workflow-drafts.ts";

const DB = "11111111-1111-4111-8111-111111111111";
const MAIL = "22222222-2222-4222-8222-222222222222";
const available = {
  connections: [
    { connectionId: DB, connector: "database", name: "Sage", service: "Database", actions: [{ action: "query", label: "Read data", changesData: false }, { action: "execute", label: "Change data", changesData: true }] },
    { connectionId: MAIL, connector: "email", name: "Mail", service: "Email", actions: [{ action: "send", label: "Send an email", changesData: true }] },
  ],
  mcp: [], files: [],
};
const agents = [{ name: "sage-reports", title: "Sage reports" }];

test("a draft reuses an existing agent, and anything that sends waits for a person first", () => {
  const draft = checkDraft({
    name: "Late orders", agent: { use: "sage-reports" },
    steps: [
      { type: "agent", label: "Find late orders", prompt: "List late sales orders." },
      { type: "connector", label: "Email it", connectionId: MAIL, action: "send", params: { to: "[[recipient]]", subject: "Late", text: "{{steps.s1.output}}" } },
    ],
    schedule: { cron: "0 8 * * 1-5", note: "Weekdays at 08:00" },
  }, available, agents);
  assert.deepEqual(draft.agent, { existing: agents[0] });
  assert.deepEqual(draft.definition.nodes.map((node) => node.type), ["start", "agent", "approval", "connector"]);
  assert.deepEqual(draft.definition.edges.find((edge) => edge.to === "s2"), { from: "s2_check", to: "s2", when: "approved" });
  assert.deepEqual(draft.blanks, ["who receives it"]);
  assert.equal(draft.schedule!.cron, "0 8 * * 1-5");
});

test("a new agent only reads, steps on unknown connections become agent work, and a bad schedule is dropped", () => {
  const draft = checkDraft({
    agent: { new: { name: "Order Finder!", title: "Order finder", description: "Finds orders.", instructions: "Find orders.", connections: [{ connectionId: DB, action: "query" }, { connectionId: DB, action: "execute" }, { connectionId: "33333333-3333-4333-8333-333333333333", action: "query" }] } },
    steps: [{ type: "connector", label: "Query", connectionId: "nope", action: "query", params: { sql: "select 1" } }],
    schedule: { cron: "whenever" },
  }, available, agents);
  assert.ok("created" in draft.agent);
  const created = (draft.agent as { created: any }).created;
  assert.equal(created.name, "order-finder");
  assert.deepEqual(created.connections, [{ connectionId: DB, action: "query" }]);
  assert.deepEqual(draft.definition.nodes.map((node) => node.type), ["start", "agent"]);
  assert.equal(draft.definition.nodes[1]!.config.agent, "order-finder");
  assert.equal(draft.schedule, undefined);
  assert.throws(() => checkDraft({ steps: [] }, available, agents), /no steps/);
});
