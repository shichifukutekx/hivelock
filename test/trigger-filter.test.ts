import assert from "node:assert/strict";
import { test } from "node:test";
import { passesFilter, triggerFilter } from "../src/platform/trigger-filter.ts";

const order = { order: { status: "Paid", total: "1200", tags: ["urgent", "export"], customer: { country: "ES" }, note: null }, items: [{ sku: "V-200" }] };
const check = (conditions: unknown[], match = "all") => passesFilter(triggerFilter.parse({ match, conditions }), order);

test("each check reads a dotted path, and text checks ignore capital letters", () => {
  assert.ok(check([{ field: "order.status", op: "equals", value: "paid" }]));
  assert.ok(check([{ field: "order.customer.country", op: "not_equals", value: "FR" }]));
  assert.ok(check([{ field: "order.tags", op: "contains", value: "URGENT" }]), "a list holds the value");
  assert.ok(!check([{ field: "order.tags", op: "contains", value: "urg" }]), "a list must hold it whole");
  assert.ok(check([{ field: "order.status", op: "contains", value: "ai" }]));
  assert.ok(check([{ field: "items.0.sku", op: "equals", value: "v-200" }]));
  assert.ok(check([{ field: "order.total", op: "greater", value: "1000" }]));
  assert.ok(!check([{ field: "order.total", op: "less", value: "1000" }]));
  assert.ok(!check([{ field: "order.status", op: "greater", value: "1" }]), "text is not a number");
  assert.ok(check([{ field: "order.note", op: "missing" }]) && check([{ field: "order.nothing", op: "missing" }]));
  assert.ok(check([{ field: "order.customer", op: "exists" }]));
  assert.ok(check([{ field: "order.nothing", op: "not_contains", value: "x" }]));
});

test("all needs every condition, any needs one, and no filter lets everything through", () => {
  const conditions = [{ field: "order.status", op: "equals", value: "paid" }, { field: "order.customer.country", op: "equals", value: "FR" }];
  assert.ok(!check(conditions, "all"));
  assert.ok(check(conditions, "any"));
  assert.ok(passesFilter(null, order) && passesFilter(undefined, "anything"));
  assert.ok(!passesFilter(triggerFilter.parse({ conditions: [{ field: "a", op: "exists" }] }), "not an object"));
});

test("a path cannot reach outside the sent data", () => {
  assert.ok(!check([{ field: "order.constructor", op: "exists" }]));
  assert.ok(!check([{ field: "__proto__", op: "exists" }]));
  assert.throws(() => triggerFilter.parse({ conditions: [] }));
  assert.throws(() => triggerFilter.parse({ conditions: [{ field: "x", op: "equals" }] }), /needs a value/);
  assert.throws(() => triggerFilter.parse({ conditions: Array.from({ length: 11 }, () => ({ field: "x", op: "exists" })) }));
});
