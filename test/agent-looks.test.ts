import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgent } from "../src/agents/registry.ts";
import { agentLooks } from "../src/platform/agent-looks.ts";
import { presentation } from "../src/platform/templates/install.ts";
import { templates } from "../src/platform/templates/index.ts";

const base = { name: "order-helper", description: "Helps with orders.", model: "main", instructions: "Help with orders." };

test("an agent can carry a title, a how-to line and examples, and none of it reaches its instructions", () => {
  const agent = buildAgent({ ...base, title: "Order helper", guide: "Name the order.", starters: ["Where is order 12?"] });
  assert.equal(agent.title, "Order helper");
  assert.deepEqual(agent.starters, ["Where is order 12?"]);
  assert.doesNotMatch(agent.instructions, /Where is order 12|Name the order/);
  assert.throws(() => buildAgent({ ...base, starters: ["a", "b", "c", "d", "e"] }), /starters/);
  assert.throws(() => buildAgent({ ...base, title: "x".repeat(81) }), /title/);
});

test("an agent without a title reads as words, or borrows its template's", () => {
  assert.equal(agentLooks({ name: "supplier-chase-2" }).title, "Supplier chase 2");
  const template = templates.find((item) => item.agent && item.run.kind === "chat")!;
  const looks = agentLooks({ name: `${template.agent!.name}-2` });
  assert.equal(looks.title, presentation(template).title);
  assert.equal(looks.guide, template.run.note);
  const step = templates.find((item) => item.agent && item.workflow)!;
  assert.equal(agentLooks({ name: step.agent!.name }).workflow, step.name);
  assert.match(agentLooks({ name: step.agent!.name }).guide!, /one step of the workflow/);
});
