import assert from "node:assert/strict";
import { test } from "node:test";
import { addChoice, addRange, addSearch, conditions, instant, MAX_PAGE_SIZE, orderBy, readPage } from "../src/platform/paging.ts";

const query = (values: Record<string, string>) => (name: string) => values[name];

test("page requests stay bounded", () => {
  assert.deepEqual(readPage(query({}), 100), { limit: 100, offset: 0 });
  assert.deepEqual(readPage(query({ limit: "25", offset: "50" }), 100), { limit: 25, offset: 50 });
  assert.equal(readPage(query({ limit: "99999" }), 100).limit, MAX_PAGE_SIZE);
  assert.equal(readPage(query({ limit: "5000" }), 100, 1000).limit, 1000);
  assert.equal(readPage(query({ limit: "0" }), 100).limit, 100);
  for (const bad of ["-1", "1.5", "abc", "1e9", "99999999999999999999"]) {
    assert.deepEqual(readPage(query({ limit: bad, offset: bad }), 100), { limit: 100, offset: 0 }, bad);
  }
});

test("a date must fall in years 1 to 9999, which Postgres can read", () => {
  assert.equal(instant("2026-11-07T00:00:00Z"), "2026-11-07T00:00:00.000Z");
  assert.equal(instant("0001-01-01T00:00:00Z"), "0001-01-01T00:00:00.000Z");
  assert.equal(instant("9999-12-31T23:59:59Z"), "9999-12-31T23:59:59.000Z");
  for (const bad of ["0000-12-31T23:59:59Z", "+010000-01-01T00:00:00.000Z", "+275760-09-13T00:00:00.000Z", "-000001-06-15T00:00:00.000Z", "not a date", "", undefined]) {
    assert.equal(instant(bad), undefined, String(bad));
  }
  const where = conditions();
  addRange(where, "at", "+275760-09-13T00:00:00.000Z", "-000001-06-15T00:00:00.000Z");
  assert.deepEqual([where.where(), where.values], ["", []]);
});

test("nothing typed reaches the SQL text", () => {
  const where = conditions();
  addSearch(where, "name", "100% a_b back\\slash");
  addChoice(where, "status", "failed,' or 1=1 --", ["failed"]);
  addRange(where, "at", "2026-01-02T00:00:00.000Z", "not a date");
  const text = where.where();
  assert.ok(!text.includes("100%") && !text.includes("or 1=1") && !text.includes("not a date"));
  assert.deepEqual(where.values, ["%100\\%%", "%a\\_b%", "%back\\\\slash%", ["failed"], "2026-01-02T00:00:00.000Z"]);
  assert.equal(conditions().where(), "");
});

test("search takes a bounded number of words", () => {
  const where = conditions();
  addSearch(where, "name", Array.from({ length: 30 }, (_, index) => `word${index}`).join(" "));
  assert.equal(where.values.length, 8);
});

test("only named columns can sort, and the order is always complete", () => {
  const columns = { name: "w.name" };
  assert.equal(orderBy(query({ sort: "name", direction: "asc" }), columns, "w.at desc", "w.id"), "order by w.name asc nulls last, w.id");
  assert.equal(orderBy(query({ sort: "name" }), columns, "w.at desc", "w.id"), "order by w.name desc nulls last, w.id");
  assert.equal(orderBy(query({ sort: "w.id; drop table runs" }), columns, "w.at desc", "w.id"), "order by w.at desc, w.id");
  assert.equal(orderBy(query({ sort: "constructor" }), columns, "w.at desc", "w.id"), "order by w.at desc, w.id");
});
