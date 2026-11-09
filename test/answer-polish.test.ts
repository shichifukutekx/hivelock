import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseNames, hideDatabaseNames } from "../src/platform/answer-polish.ts";

const queried = databaseNames(`select btrim(po.pohnum_0), sq.qty_0 from public.porder po join "porderq" pq on pq.pohnum_0 = po.pohnum_0
  left join public.sorder so on so.sohnum_0 = pq.sohnum_0 join sorderq sq on true where bpcnam_0 ilike $1`);

test("the tables and columns an agent queried are found in its SQL", () => {
  for (const name of ["porder", "porderq", "sorder", "sorderq", "pohnum_0", "bpcnam_0"]) assert.ok(queried.has(name), name);
});

test("an answer never names them, and still reads well", () => {
  const cases: [string, string][] = [
    ["These are the overdue purchase order lines for supplier S-1042, from the porder and porderq tables, looking back as far as the data goes:",
      "These are the overdue purchase order lines for supplier S-1042, looking back as far as the data goes:"],
    ["Here are some similar customer names from the `sorder` table:", "Here are some similar customer names:"],
    ["Here are the details for this order from the sorderq table:", "Here are the details for this order:"],
    ["The total quantity is 1011 units, from the porderq table.", "The total quantity is 1011 units."],
    ["I searched the customer name (bpcnam_0) for Indutech.", "I searched the customer name for Indutech."],
    ["Using the SORDER table, I found 3 orders.", "I found 3 orders."],
  ];
  for (const [said, shown] of cases) assert.equal(hideDatabaseNames(said, queried), shown);
});

test("ordinary words and other answers are left alone", () => {
  const plain = "The order from the customer table of contents is in porderly shape, and the purchase order is late.";
  assert.equal(hideDatabaseNames(plain, queried), plain);
  assert.equal(hideDatabaseNames("Nothing to change here.", new Set()), "Nothing to change here.");
});
