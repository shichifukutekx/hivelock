import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition } from "../src/platform/engine/definition.ts";
import "../src/platform/connectors/index.ts";
import { availableValues, layout, makesLoop, nextStepId, toCanvas, toDefinition, type WorkflowDefinition } from "../web/src/lib/flow.ts";

const workflow: WorkflowDefinition = {
  nodes: [
    { id: "start", type: "start", config: {} },
    { id: "check", type: "condition", label: "Big order?", config: { path: "input.amount", operator: "greater_than", value: 10 } },
    { id: "ok", type: "approval", config: { message: "Go?" } },
    { id: "done", type: "agent", config: { agent: "rfq-checker", prompt: "Check" } },
  ],
  edges: [{ from: "start", to: "check" }, { from: "check", to: "ok", when: "true" }, { from: "ok", to: "done", when: "approved" }],
};

test("a workflow survives a trip through the canvas, and the engine accepts the result", () => {
  const { nodes, edges } = toCanvas(workflow);
  const back = toDefinition(nodes, edges);
  assert.deepEqual(back.edges, workflow.edges);
  assert.deepEqual(back.nodes.map((n) => n.id), workflow.nodes.map((n) => n.id));
  assert.equal(back.nodes[1]!.label, "Big order?");
  const parsed = parseDefinition(back);
  assert.equal(parsed.nodes[1]!.label, "Big order?");
  assert.deepEqual(parsed.nodes[0]!.position, back.nodes[0]!.position);
});

test("workflows saved without positions are laid out left to right", () => {
  const positions = layout(workflow);
  assert.ok(positions.get("done")!.x > positions.get("ok")!.x);
  assert.ok(positions.get("ok")!.x > positions.get("check")!.x);
  assert.deepEqual(layout({ ...workflow, nodes: [{ ...workflow.nodes[0]!, position: { x: 7, y: 9 } }] }).get("start"), { x: 7, y: 9 });
});

test("the start step cannot be deleted, and running edges are marked", () => {
  const { nodes, edges } = toCanvas(workflow, { done: "running" });
  assert.equal(nodes[0]!.deletable, false);
  assert.equal(nodes[1]!.deletable, true);
  assert.equal(nodes[3]!.data.status, "running");
  assert.equal(edges[2]!.className, "live");
});

test("new step ids are readable and never collide", () => {
  assert.equal(nextStepId("agent", []), "agent_1");
  assert.equal(nextStepId("agent", ["agent_1", "agent_2"]), "agent_3");
});

test("loops are spotted before they are drawn", () => {
  const edges = [{ source: "a", target: "b" }, { source: "b", target: "c" }];
  assert.equal(makesLoop(edges, "c", "a"), true);
  assert.equal(makesLoop(edges, "a", "c"), false);
  assert.equal(makesLoop(edges, "a", "a"), true);
});

test("a step is only offered values from steps before it", () => {
  assert.deepEqual(availableValues(workflow, "done").map((v) => v.path), ["input", "steps.check.output", "steps.ok.output"]);
  assert.deepEqual(availableValues(workflow, "check").map((v) => v.path), ["input"]);
});
