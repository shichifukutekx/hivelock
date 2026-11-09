/** Sorting, filtering and paging for tables. Plain functions, so a test can run them. */

export type ColumnKind = "text" | "number" | "date";
type CellValue = string | number | Date | null | undefined;

export interface Column<Row = any> {
  key: string;
  header: string;
  /** What the column sorts and filters on. Leave it out for a column of action buttons. */
  value?: (row: Row) => CellValue;
  kind?: ColumnKind;
  /** The human label for the filter list and search. Dates default to their day. */
  text?: (row: Row) => string | null | undefined;
  /** Extra text the shared search should find, such as an email under a name. */
  search?: (row: Row) => string | null | undefined;
  /** The unit of a number range, when the value is stored smaller, such as bytes shown in KB. */
  unit?: { label: string; factor: number };
  /** On a table the server pages: what the server can do with this column. Without this the column cannot sort or filter there. */
  server?: { sort?: boolean; options?: { value: string; label: string }[]; range?: boolean };
}

export interface ColumnFilter { values?: string[]; from?: string; to?: string }
export interface Sort { key: string; direction: "asc" | "desc" }
export interface TableState { sort: Sort | null; filters: Record<string, ColumnFilter>; search: string; page: number }
export interface Prepared<Row = any> { row: Row; index: number; sorts: (string | number | null)[]; labels: string[]; haystack: string }
export interface FilterOption { value: string; label?: string; count?: number }

export const emptyTable: TableState = { sort: null, filters: {}, search: "", page: 1 };
export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = PAGE_SIZES[0]!;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function sortValue(value: CellValue, kind: ColumnKind) {
  if (value === null || value === undefined || value === "") return null;
  if (kind === "text") return String(value).trim() || null;
  const number = kind === "date" ? new Date(value).getTime() : Number(value);
  return Number.isNaN(number) ? null : number;
}

function labelOf(column: Column, row: unknown, sort: string | number | null) {
  if (column.text) return column.text(row) ?? "";
  if (sort === null) return "";
  if (column.kind === "date") return day.format(sort as number);
  return column.kind === "number" ? (sort as number).toLocaleString() : String(sort);
}

/** Works out each cell once, so sorting and filtering stay quick over a few thousand rows. */
export function prepareRows<Row>(rows: Row[], columns: Column<Row>[]): Prepared<Row>[] {
  return rows.map((row, index) => {
    const sorts = columns.map((column) => (column.value ? sortValue(column.value(row), column.kind ?? "text") : null));
    const labels = columns.map((column, at) => (column.value ? labelOf(column, row, sorts[at]!) : ""));
    const extras = columns.map((column) => column.search?.(row) ?? "");
    return { row, index, sorts, labels, haystack: [...labels, ...extras].join(" ").toLowerCase() };
  });
}

function edge(column: Column, text: string | undefined, end: boolean) {
  if (!text?.trim()) return undefined;
  if (column.kind === "date") {
    const [year, month, date] = text.split("-").map(Number);
    const time = end ? new Date(year!, month! - 1, date, 23, 59, 59, 999) : new Date(year!, month! - 1, date);
    return Number.isNaN(time.getTime()) ? undefined : time.getTime();
  }
  const number = Number(text);
  return Number.isNaN(number) ? undefined : number * (column.unit?.factor ?? 1);
}

/** Rows that pass the search and every column filter. `except` leaves one column out, for that column's own counts. */
export function filterRows<Row>(prepared: Prepared<Row>[], columns: Column<Row>[], state: TableState, except?: string) {
  const checks = columns.flatMap((column, at) => {
    const filter = state.filters[column.key];
    if (!filter || !column.value || column.key === except) return [];
    return [{ at, allowed: filter.values && new Set(filter.values), from: edge(column, filter.from, false), to: edge(column, filter.to, true) }];
  });
  const terms = state.search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!checks.length && !terms.length) return prepared;
  return prepared.filter((item) => terms.every((term) => item.haystack.includes(term)) && checks.every(({ at, allowed, from, to }) => {
    if (allowed && !allowed.has(item.labels[at]!)) return false;
    if (from === undefined && to === undefined) return true;
    const value = item.sorts[at];
    return typeof value === "number" && (from === undefined || value >= from) && (to === undefined || value <= to);
  }));
}

const compare = (a: string | number, b: string | number) => (typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b)));

/** Sorts by real value with empty cells last either way. No sort keeps the original order. */
export function sortRows<Row>(prepared: Prepared<Row>[], columns: Column<Row>[], sort: Sort | null) {
  const at = sort ? columns.findIndex((column) => column.key === sort.key && column.value) : -1;
  if (at < 0) return prepared;
  const sign = sort!.direction === "asc" ? 1 : -1;
  return [...prepared].sort((a, b) => {
    const [x, y] = [a.sorts[at]!, b.sorts[at]!];
    if (x === null) return y === null ? 0 : 1;
    return y === null ? -1 : sign * compare(x, y);
  });
}

/** Every value in a column, in value order. Counts come from `counted`, the rows the other filters leave. */
export function distinctValues<Row>(prepared: Prepared<Row>[], columns: Column<Row>[], key: string, counted = prepared): FilterOption[] {
  const at = columns.findIndex((column) => column.key === key);
  const counts = new Map<string, number>();
  for (const item of counted) counts.set(item.labels[at]!, (counts.get(item.labels[at]!) ?? 0) + 1);
  const seen = new Map<string, string | number | null>();
  for (const item of prepared) if (!seen.has(item.labels[at]!)) seen.set(item.labels[at]!, item.sorts[at]!);
  return [...seen].sort(([labelA, a], [labelB, b]) => {
    if (a === null || b === null) return a === b ? collator.compare(labelA || "￿", labelB || "￿") : a === null ? 1 : -1;
    return compare(a, b);
  }).map(([value]) => ({ value, count: counts.get(value) ?? 0 }));
}

function withValues(filter: ColumnFilter | undefined, chosen: Set<string>, all: string[]): ColumnFilter {
  const { values: _, ...rest } = filter ?? {};
  return all.every((value) => chosen.has(value)) ? rest : { ...rest, values: [...chosen] };
}

export function toggleValue(filter: ColumnFilter | undefined, value: string, all: string[]) {
  const chosen = new Set(filter?.values ?? all);
  if (!chosen.delete(value)) chosen.add(value);
  return withValues(filter, chosen, all);
}

/** Adds what the list shows. With nothing filtered yet, a searched list becomes the whole selection, as in Excel. */
export const selectValues = (filter: ColumnFilter | undefined, shown: string[], all: string[]) =>
  withValues(filter, new Set([...(filter?.values ?? []), ...shown]), all);

export function clearValues(filter: ColumnFilter | undefined, shown: string[], all: string[]) {
  const chosen = new Set(filter?.values ?? all);
  for (const value of shown) chosen.delete(value);
  return withValues(filter, chosen, all);
}

const filterIsOn = (filter: ColumnFilter) => !!(filter.values || filter.from?.trim() || filter.to?.trim());

export function setFilter(state: TableState, key: string, filter: ColumnFilter): TableState {
  const { [key]: _, ...others } = state.filters;
  return { ...state, page: 1, filters: filterIsOn(filter) ? { ...others, [key]: filter } : others };
}

export const setSearch = (state: TableState, search: string): TableState => ({ ...state, search, page: 1 });
export const setSort = (state: TableState, sort: Sort | null): TableState => ({ ...state, sort, page: 1 });
export const clearFilters = (state: TableState): TableState => ({ ...state, filters: {}, search: "", page: 1 });

export const pageCount = (total: number, size: number) => Math.max(1, Math.ceil(total / size));
/** Rows can shrink under a table at any moment, so the page shown is always worked out from what is there. */
export const clampPage = (page: number, total: number, size: number) => Math.min(Math.max(1, Math.floor(page) || 1), pageCount(total, size));
export const pageSlice = <T,>(rows: T[], page: number, size: number) => rows.slice((page - 1) * size, page * size);

/** The numbers for "Showing 26 to 50 of 312". */
export function pageRange(page: number, total: number, size: number) {
  return total === 0 ? { from: 0, to: 0 } : { from: (page - 1) * size + 1, to: Math.min(page * size, total) };
}

/** Moves the first row in view with it, so a new page size does not lose a person's place. */
export const pageForSize = (page: number, oldSize: number, newSize: number) => Math.floor(((page - 1) * oldSize) / newSize) + 1;

/**
 * The request for a table the server pages. Only columns that say so go through. Filter names follow column keys, which each endpoint knows:
 * a list as `status=failed,running`, a range as `startedFrom` and `startedTo`.
 */
export function serverParams<Row>(state: TableState, size: number, columns: Column<Row>[]) {
  const params = new URLSearchParams({ limit: String(size), offset: String((state.page - 1) * size) });
  if (state.search.trim()) params.set("q", state.search.trim());
  const sorted = columns.find((column) => column.key === state.sort?.key && column.server?.sort);
  if (sorted) {
    params.set("sort", sorted.key);
    params.set("direction", state.sort!.direction);
  }
  for (const column of columns) {
    const filter = state.filters[column.key];
    if (!filter || !column.server) continue;
    if (filter.values && column.server.options) params.set(column.key, filter.values.join(","));
    if (!column.server.range) continue;
    const [from, to] = [edge(column, filter.from, false), edge(column, filter.to, true)];
    if (from !== undefined) params.set(`${column.key}From`, new Date(from).toISOString());
    if (to !== undefined) params.set(`${column.key}To`, new Date(to).toISOString());
  }
  return params.toString();
}

export const hasFilters = (state: TableState) => !!state.search.trim() || Object.keys(state.filters).length > 0;

const PREFIX = "hivelock.table:";

interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const store = () => (globalThis as unknown as { sessionStorage: Store }).sessionStorage;
const safely = <T,>(action: () => T, fallback: T) => {
  try { return action(); } catch { return fallback; }
};

/** Takes only the shape it expects, because saved text may be old or edited. */
export function readState(text: string | null): TableState {
  const saved = safely(() => JSON.parse(text ?? "null"), null);
  if (!saved || typeof saved !== "object") return emptyTable;
  const filters: Record<string, ColumnFilter> = {};
  for (const [key, value] of Object.entries(saved.filters ?? {})) {
    const { values, from, to } = (value ?? {}) as ColumnFilter;
    const filter: ColumnFilter = {};
    if (Array.isArray(values) && values.every((item) => typeof item === "string")) filter.values = values;
    if (typeof from === "string") filter.from = from;
    if (typeof to === "string") filter.to = to;
    if (filterIsOn(filter)) filters[key] = filter;
  }
  const { key, direction } = saved.sort ?? {};
  return {
    sort: typeof key === "string" && (direction === "asc" || direction === "desc") ? { key, direction } : null,
    filters, search: typeof saved.search === "string" ? saved.search : "",
    page: Number.isInteger(saved.page) && saved.page > 0 ? saved.page : 1,
  };
}

export const loadState = (key: string) => safely(() => readState(store().getItem(PREFIX + key)), emptyTable);

export function saveState(key: string, state: TableState) {
  safely(() => (hasFilters(state) || state.sort || state.page > 1 ? store().setItem(PREFIX + key, JSON.stringify(state)) : store().removeItem(PREFIX + key)), undefined);
}

const SIZE_PREFIX = "hivelock.rows:";
const lasting = () => (globalThis as unknown as { localStorage: Store }).localStorage;

export function readPageSize(text: string | null) {
  const size = Number(text);
  return PAGE_SIZES.includes(size) ? size : DEFAULT_PAGE_SIZE;
}

/** Rows per page outlive the session: it is a preference, and it says nothing about what was looked at. */
export const loadPageSize = (key: string) => safely(() => readPageSize(lasting().getItem(SIZE_PREFIX + key)), DEFAULT_PAGE_SIZE);
export const savePageSize = (key: string, size: number) => safely(() => lasting().setItem(SIZE_PREFIX + key, String(size)), undefined);

/** On sign-out, so the next person in this tab does not inherit one person's search. */
export function forgetSavedTables() {
  safely(() => { for (const key of Object.keys(store())) if (key.startsWith(PREFIX)) store().removeItem(key); }, undefined);
}
