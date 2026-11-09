import assert from "node:assert/strict";
import { inputFields } from "../web/src/lib/flow.ts";
import { test } from "node:test";
import { clampPage, clearFilters, clearValues, distinctValues, emptyTable, filterRows, forgetSavedTables, hasFilters, loadPageSize, loadState, pageCount, pageForSize, pageRange, pageSlice, prepareRows, readPageSize, readState, savePageSize, saveState, selectValues, serverParams, setFilter, setSearch, setSort, sortRows, toggleValue, type Column, type TableState } from "../web/src/lib/table.ts";

const rows = [
  { name: "beta", version: 10, size: 2_048, status: "draft", at: "2026-03-05T12:00:00", email: "b@example.test" },
  { name: "Alpha", version: 2, size: 900_000, status: "live", at: "2026-11-01T12:00:00", email: "a@example.test" },
  { name: "gamma", version: null, size: null, status: "live", at: null, email: "c@example.test" },
  { name: "Delta 10", version: 9, size: 512, status: "draft", at: "2026-01-20T12:00:00", email: "d@example.test" },
  { name: "Delta 9", version: 1, size: 1_024, status: "live", at: "2026-06-15T12:00:00", email: "e@example.test" },
];

const columns: Column<(typeof rows)[number]>[] = [
  { key: "name", header: "Name", value: (row) => row.name, search: (row) => row.email },
  { key: "status", header: "Status", value: (row) => (row.status === "live" ? "Live" : "Draft") },
  { key: "version", header: "Version", kind: "number", value: (row) => row.version },
  { key: "size", header: "Size", kind: "number", value: (row) => row.size, text: (row) => (row.size === null ? "" : `${Math.ceil(row.size / 1024)} KB`), unit: { label: "KB", factor: 1024 } },
  { key: "at", header: "When", kind: "date", value: (row) => row.at },
  { key: "actions", header: "" },
];

const prepared = prepareRows(rows, columns);
const names = (items: typeof prepared) => items.map((item) => item.row.name);
const sorted = (key: string, direction: "asc" | "desc") => names(sortRows(prepared, columns, { key, direction }));
const filtered = (state: Partial<TableState>, except?: string) => names(filterRows(prepared, columns, { ...emptyTable, ...state }, except));

test("text sorts without regard to case, and numbers inside text sort as numbers", () => {
  assert.deepEqual(sorted("name", "asc"), ["Alpha", "beta", "Delta 9", "Delta 10", "gamma"]);
  assert.deepEqual(sorted("name", "desc"), ["gamma", "Delta 10", "Delta 9", "beta", "Alpha"]);
});

test("versions, sizes and dates sort by value, with empty cells last both ways", () => {
  assert.deepEqual(sorted("version", "asc"), ["Delta 9", "Alpha", "Delta 10", "beta", "gamma"]);
  assert.deepEqual(sorted("version", "desc"), ["beta", "Delta 10", "Alpha", "Delta 9", "gamma"]);
  assert.deepEqual(sorted("size", "asc"), ["Delta 10", "Delta 9", "beta", "Alpha", "gamma"]);
  assert.deepEqual(sorted("at", "desc"), ["Alpha", "Delta 9", "beta", "Delta 10", "gamma"]);
});

test("no sort keeps the original order, and an action column cannot sort", () => {
  assert.deepEqual(names(sortRows(prepared, columns, null)), rows.map((row) => row.name));
  assert.deepEqual(names(sortRows(prepared, columns, { key: "actions", direction: "asc" })), rows.map((row) => row.name));
  assert.deepEqual(names(sortRows(prepared, columns, { key: "gone", direction: "asc" })), rows.map((row) => row.name));
});

test("sorting does not change the rows it was given", () => {
  const before = names(prepared);
  sorted("name", "desc");
  assert.deepEqual(names(prepared), before);
});

test("the value filter uses human labels and combines with other columns", () => {
  assert.deepEqual(filtered({ filters: { status: { values: ["Draft"] } } }), ["beta", "Delta 10"]);
  assert.deepEqual(filtered({ filters: { status: { values: ["Live"] }, version: { from: "2" } } }), ["Alpha"]);
  assert.deepEqual(filtered({ filters: { status: { values: [] } } }), []);
});

test("number ranges use the shown unit, and an empty cell never passes a range", () => {
  assert.deepEqual(filtered({ filters: { size: { from: "1", to: "2" } } }), ["beta", "Delta 9"]);
  assert.deepEqual(filtered({ filters: { version: { to: "2" } } }), ["Alpha", "Delta 9"]);
});

test("a date range includes both of its days", () => {
  assert.deepEqual(filtered({ filters: { at: { from: "2026-03-05", to: "2026-06-15" } } }), ["beta", "Delta 9"]);
  assert.deepEqual(filtered({ filters: { at: { from: "2026-07-01" } } }), ["Alpha"]);
});

test("search looks through labels and extra text, and every word must match", () => {
  assert.deepEqual(filtered({ search: "DELTA" }), ["Delta 10", "Delta 9"]);
  assert.deepEqual(filtered({ search: "c@example" }), ["gamma"]);
  assert.deepEqual(filtered({ search: "delta live" }), ["Delta 9"]);
});

test("the value list counts rows the other filters leave, and keeps every value", () => {
  const state = { ...emptyTable, filters: { version: { to: "2" } } };
  assert.deepEqual(distinctValues(prepared, columns, "status", filterRows(prepared, columns, state, "status")), [{ value: "Draft", count: 0 }, { value: "Live", count: 2 }]);
  assert.deepEqual(distinctValues(prepared, columns, "version").map((option) => option.value), ["1", "2", "9", "10", ""]);
  const days = distinctValues(prepared, columns, "at");
  assert.equal(days.length, 5);
  assert.equal(days.at(-1)!.value, "");
  assert.equal(days[0]!.value, new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date("2026-01-20T12:00:00")));
});

test("a column's own filter does not narrow its own list", () => {
  assert.deepEqual(filtered({ filters: { status: { values: ["Draft"] } } }, "status"), rows.map((row) => row.name));
});

test("Select all and Clear act on what the list shows", () => {
  const all = ["Draft", "Live", "Off"];
  assert.deepEqual(toggleValue(undefined, "Live", all), { values: ["Draft", "Off"] });
  assert.deepEqual(toggleValue({ values: ["Draft", "Off"] }, "Live", all), {});
  assert.deepEqual(clearValues(undefined, all, all), { values: [] });
  assert.deepEqual(selectValues({ values: [] }, all, all), {});
  assert.deepEqual(selectValues(undefined, ["Live"], all), { values: ["Live"] }, "a searched list becomes the selection");
  assert.deepEqual(selectValues({ values: ["Draft"] }, ["Live"], all), { values: ["Draft", "Live"] });
  assert.deepEqual(clearValues({ values: ["Draft", "Live"] }, ["Live"], all), { values: ["Draft"] });
  assert.deepEqual(selectValues({ values: ["Draft"], from: "2" }, all, all), { from: "2" }, "a range survives");
});

test("an empty filter counts as no filter", () => {
  const on = setFilter(emptyTable, "status", { values: ["Live"] });
  assert.equal(hasFilters(on), true);
  assert.equal(hasFilters(setFilter(on, "status", {})), false);
  assert.equal(hasFilters(setFilter(on, "status", { from: " " })), false);
  assert.equal(hasFilters({ ...emptyTable, search: "  " }), false);
});

test("saved state is checked before use", () => {
  assert.deepEqual(readState(null), emptyTable);
  assert.deepEqual(readState("not json"), emptyTable);
  assert.deepEqual(readState('"text"'), emptyTable);
  assert.deepEqual(readState('{"sort":{"key":"a","direction":"up"},"filters":{"a":{"values":[1]},"b":{"values":["x"],"from":2}},"search":7}'), { sort: null, filters: { b: { values: ["x"] } }, search: "", page: 1 });
});

test("state survives in session storage, and a missing or failing store does no harm", () => {
  const global = globalThis as any;
  const saved = Object.getOwnPropertyDescriptor(global, "sessionStorage");
  const set = (value: unknown) => Object.defineProperty(global, "sessionStorage", { configurable: true, ...(value as object) });
  try {
    const memory: Record<string, string> = {};
    const store = Object.defineProperties({}, {
      getItem: { value: (key: string) => memory[key] ?? null },
      setItem: { value: (key: string, value: string) => { memory[key] = value; Object.defineProperty(store, key, { value, enumerable: true, configurable: true }); } },
      removeItem: { value: (key: string) => { delete memory[key]; delete (store as any)[key]; } },
    });
    set({ value: store });
    const state: TableState = { sort: { key: "name", direction: "desc" }, filters: { status: { values: ["Live"] } }, search: "x", page: 3 };
    saveState("/w/1/runs:runs", state);
    assert.deepEqual(loadState("/w/1/runs:runs"), state);
    assert.deepEqual(loadState("/w/2/runs:runs"), emptyTable, "each page has its own");
    forgetSavedTables();
    assert.deepEqual(loadState("/w/1/runs:runs"), emptyTable);

    set({ get() { throw new Error("blocked"); } });
    assert.deepEqual(loadState("/w/1/runs:runs"), emptyTable);
    assert.doesNotThrow(() => { saveState("/w/1/runs:runs", state); forgetSavedTables(); });
  } finally {
    if (saved) Object.defineProperty(global, "sessionStorage", saved);
    else delete global.sessionStorage;
  }
});

test("page numbers stay in range however the rows change", () => {
  assert.equal(pageCount(0, 25), 1);
  assert.equal(pageCount(26, 25), 2);
  assert.equal(pageCount(312, 25), 13);
  assert.equal(clampPage(14, 312, 25), 13);
  assert.equal(clampPage(5, 10, 25), 1, "rows went away");
  assert.equal(clampPage(0, 100, 25), 1);
  assert.equal(clampPage(Number.NaN, 100, 25), 1);
  assert.deepEqual(pageRange(2, 312, 25), { from: 26, to: 50 });
  assert.deepEqual(pageRange(13, 312, 25), { from: 301, to: 312 });
  assert.deepEqual(pageRange(1, 0, 25), { from: 0, to: 0 });
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5], 2, 2), [3, 4]);
  assert.equal(pageForSize(3, 25, 100), 1, "row 51 is on the first page of 100");
  assert.equal(pageForSize(2, 100, 25), 5, "row 101 stays in view");
});

test("filtering, searching and sorting go back to page one", () => {
  const away = { ...emptyTable, page: 4 };
  assert.equal(setFilter(away, "status", { values: ["Live"] }).page, 1);
  assert.equal(setSearch(away, "x").page, 1);
  assert.equal(setSort(away, { key: "name", direction: "asc" }).page, 1);
  assert.equal(clearFilters({ ...away, search: "x" }).page, 1);
  assert.equal(readState(JSON.stringify({ page: 3 })).page, 3);
  assert.equal(readState(JSON.stringify({ page: -2 })).page, 1);
  assert.equal(readState(JSON.stringify({ page: "2" })).page, 1);
});

test("a server table asks only for what its columns allow", () => {
  const columns: Column[] = [
    { key: "name", header: "Name", value: (row) => row.name, server: { sort: true } },
    { key: "status", header: "Status", value: (row) => row.status, server: { options: [{ value: "failed", label: "Failed" }] } },
    { key: "started", header: "Started", kind: "date", value: (row) => row.at, server: { range: true } },
    { key: "size", header: "Size", kind: "number", value: (row) => row.size },
  ];
  const state: TableState = {
    sort: { key: "size", direction: "asc" }, search: " acme ", page: 3,
    filters: { status: { values: ["failed", "running"] }, started: { from: "2026-01-02" }, size: { from: "4" } },
  };
  const params = new URLSearchParams(serverParams(state, 25, columns));
  assert.equal(params.get("limit"), "25");
  assert.equal(params.get("offset"), "50");
  assert.equal(params.get("q"), "acme");
  assert.equal(params.get("status"), "failed,running");
  assert.equal(new Date(params.get("startedFrom")!).getTime(), new Date(2026, 0, 2).getTime(), "a day starts in the viewer's own time zone");
  assert.equal(params.get("sort"), null, "this column cannot sort on the server");
  assert.equal(params.get("sizeFrom"), null);
  assert.equal(new URLSearchParams(serverParams({ ...state, sort: { key: "name", direction: "desc" } }, 50, columns)).get("direction"), "desc");
  assert.equal(new URLSearchParams(serverParams({ ...emptyTable, filters: { status: { values: [] } } }, 25, columns)).get("status"), "", "nothing chosen stays nothing");
});

test("rows per page are remembered per table, and only the sizes on offer count", () => {
  assert.equal(readPageSize("50"), 50);
  assert.equal(readPageSize("7"), 25);
  assert.equal(readPageSize(null), 25);
  const saved = new Map<string, string>();
  const store = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) };
  (globalThis as any).localStorage = store;
  try {
    savePageSize("/w/1/runs:runs", 100);
    assert.equal(loadPageSize("/w/1/runs:runs"), 100);
    assert.equal(loadPageSize("/w/1/audit:audit"), 25);
  } finally {
    delete (globalThis as any).localStorage;
  }
  assert.equal(loadPageSize("/w/1/runs:runs"), 25, "no storage at all still works");
});

test("a workflow's run form asks for what its steps read", () => {
  const definition = { edges: [], nodes: [
    { id: "start", type: "start", config: {} },
    { id: "a", type: "agent", config: { prompt: "Write to {{input.customer}} about {{ input.orderNumber }} and {{steps.x.input.nope}}" } },
    { id: "c", type: "condition", config: { path: "input.amount" } },
  ] };
  assert.deepEqual(inputFields(definition), ["customer", "orderNumber", "amount"]);
  assert.deepEqual(inputFields(undefined), []);
  assert.deepEqual(inputFields({ edges: [], nodes: [{ id: "start", type: "start", config: {} }] }), []);
});
