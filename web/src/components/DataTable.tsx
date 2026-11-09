import { ArrowDown, ArrowDown01, ArrowDown10, ArrowDownAZ, ArrowDownNarrowWide, ArrowDownWideNarrow, ArrowDownZA, ArrowUp, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronsUpDown, Filter, Search, SearchX, type LucideIcon } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { clampPage, clearFilters, clearValues, distinctValues, filterRows, hasFilters, loadPageSize, loadState, pageCount, pageForSize, pageRange, pageSlice, PAGE_SIZES, prepareRows, savePageSize, saveState, selectValues, serverParams, setFilter, setSearch, setSort, sortRows, toggleValue, type Column, type ColumnFilter, type ColumnKind, type FilterOption, type Prepared, type Sort, type TableState } from "../lib/table.ts";
import { Input } from "./ui.tsx";

const SEARCH_FROM = 10;
const LIST_LIMIT = 300;
const MENU_WIDTH = 272;
const GAP = 8;

const SORT_LABELS: Record<ColumnKind, { asc: [string, LucideIcon]; desc: [string, LucideIcon] }> = {
  text: { asc: ["Sort A to Z", ArrowDownAZ], desc: ["Sort Z to A", ArrowDownZA] },
  number: { asc: ["Sort low to high", ArrowDown01], desc: ["Sort high to low", ArrowDown10] },
  date: { asc: ["Sort oldest first", ArrowDownNarrowWide], desc: ["Sort newest first", ArrowDownWideNarrow] },
};

const rangeField = "field h-8 w-full min-w-0 rounded-lg px-2 text-[12px] text-ink focus:outline-none [color-scheme:light] dark:[color-scheme:dark]";
const textButton = "rounded px-1 text-[12px] font-medium text-accent hover:underline";

const nextSort = (sort: Sort | null, key: string): Sort | null => {
  if (sort?.key !== key) return { key, direction: "asc" };
  return sort.direction === "asc" ? { key, direction: "desc" } : null;
};

function FilterMenu({ column, columns, prepared, server, state, anchor, onFilter, onSort, onClose }: {
  column: Column; columns: Column[]; prepared: Prepared[]; server: boolean; state: TableState; anchor: HTMLElement;
  onFilter: (filter: ColumnFilter) => void; onSort: (sort: Sort | null) => void; onClose: (refocus: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>(() => ({ left: 0, top: 0, width: Math.min(MENU_WIDTH, innerWidth - GAP * 2) }));
  const filter = state.filters[column.key];
  const kind = column.kind ?? "text";
  // A server-paged table has a fixed list of choices, because the rows here are only one page of them.
  const options = useMemo<FilterOption[]>(() => (server ? column.server?.options ?? [] : distinctValues(prepared, columns, column.key, filterRows(prepared, columns, state, column.key))), [server, column, prepared, columns, state]);
  const all = useMemo(() => options.map((option) => option.value), [options]);
  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return wanted ? options.filter((option) => (option.label ?? (option.value || "empty")).toLowerCase().includes(wanted)) : options;
  }, [options, query]);
  const shownValues = shown.map((option) => option.value);
  const chosen = filter?.values && new Set(filter.values);

  const place = useCallback(() => {
    if (!box.current) return;
    const button = anchor.getBoundingClientRect();
    const width = Math.min(MENU_WIDTH, innerWidth - GAP * 2);
    const height = box.current.offsetHeight;
    const fitsBelow = button.bottom + 4 + height <= innerHeight - GAP;
    const above = button.top - height - 4;
    const top = fitsBelow ? button.bottom + 4 : above >= GAP ? above : Math.max(GAP, innerHeight - height - GAP);
    setPosition({ left: Math.max(GAP, Math.min(button.left, innerWidth - width - GAP)), top, width, maxHeight: innerHeight - GAP * 2 });
  }, [anchor]);

  useLayoutEffect(place, [place, shown.length]);

  useEffect(() => {
    const keep = (event: Event) => { if (!box.current?.contains(event.target as Node)) place(); };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) onClose(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose(true);
    };
    addEventListener("scroll", keep, true);
    addEventListener("resize", place);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      removeEventListener("scroll", keep, true);
      removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [anchor, onClose, place]);

  // A phone keyboard would cover the list, so touch screens open without it.
  useEffect(() => {
    const touch = matchMedia("(pointer: coarse)").matches;
    (touch ? box.current : box.current?.querySelector("input[type=search]") as HTMLElement | null)?.focus();
  }, []);

  const moveFocus = (event: KeyboardEvent) => {
    const root = box.current!;
    if (event.key === "Tab") {
      const stops = [...root.querySelectorAll<HTMLElement>("button, input")].filter((item) => !item.hasAttribute("disabled"));
      const edge = event.shiftKey ? stops[0] : stops.at(-1);
      if (document.activeElement === edge || document.activeElement === root) {
        event.preventDefault();
        (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
      }
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const boxes = [...root.querySelectorAll<HTMLElement>("input[type=checkbox]")];
      const active = document.activeElement as HTMLElement;
      const at = boxes.indexOf(active);
      const isSearch = active.matches("input[type=search]");
      if (at < 0 && !isSearch) return;
      event.preventDefault();
      if (at <= 0 && event.key === "ArrowUp") root.querySelector<HTMLElement>("input[type=search]")?.focus();
      else boxes[event.key === "ArrowDown" ? at + 1 : at - 1]?.focus();
    }
  };

  // React sends a portal's events up to the table, so they stop here and never reach a row.
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  const canSort = !server || !!column.server?.sort;
  const hasRange = server ? !!column.server?.range : kind !== "text";
  const range = hasRange && (
    <div role="group" aria-label={`${column.header} range`} className="border-b border-line p-2">
      <p className="mb-1 text-[12px] font-medium text-muted">Range{column.unit ? ` (${column.unit.label})` : ""}</p>
      <div className="grid grid-cols-2 gap-2">
        {(["from", "to"] as const).map((side) => (
          <label key={side} className="min-w-0 text-[11px] text-muted">
            <span className="mb-0.5 block">{side === "from" ? "From" : "To"}</span>
            <input aria-label={`${column.header} ${side}`} className={rangeField} type={kind === "date" ? "date" : "number"} step="any" inputMode="decimal" value={filter?.[side] ?? ""} onChange={(event) => onFilter({ ...filter, [side]: event.target.value })} />
          </label>
        ))}
      </div>
    </div>
  );

  return createPortal(
    <div ref={box} role="dialog" aria-label={`Sort and filter ${column.header}`} tabIndex={-1} style={position}
      className="enter-pop fixed z-[60] origin-top overflow-y-auto rounded-lg border border-line bg-surface text-[13px] text-ink shadow-lg focus:outline-none"
      onClick={stop} onMouseDown={stop} onDoubleClick={stop} onKeyDown={(event) => { stop(event); moveFocus(event); }}>
      <div>
        {canSort && <div className="border-b border-line p-1">
          {(["asc", "desc"] as const).map((direction) => {
            const [label, Icon] = SORT_LABELS[kind][direction];
            const active = state.sort?.key === column.key && state.sort.direction === direction;
            return (
              <button key={direction} type="button" aria-pressed={active} onClick={() => onSort(active ? null : { key: column.key, direction })}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-sunken ${active ? "font-medium text-accent" : ""}`}>
                <Icon size={14} className="shrink-0" /> {label}
              </button>
            );
          })}
        </div>}
        {range}
        {options.length > 0 && <div className="p-2 pb-1">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
            <input type="search" aria-label={`Search values in ${column.header}`} placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="field h-8 w-full rounded-lg pr-2 pl-7 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none" />
          </div>
          <div className="mt-1 flex items-center gap-2">
            <button type="button" className={textButton} onClick={() => onFilter(selectValues(filter, shownValues, all))}>Select all</button>
            <button type="button" className={textButton} onClick={() => onFilter(clearValues(filter, shownValues, all))}>Clear</button>
          </div>
        </div>}
      </div>
      {options.length > 0 && <div className="max-h-52 overflow-y-auto px-1 pb-1" role="group" aria-label={`Values in ${column.header}`}>
        {shown.length === 0 && <p className="px-2 py-1 text-[12px] text-muted">No matching values.</p>}
        {shown.slice(0, LIST_LIMIT).map(({ value, label, count }) => (
          <label key={value} className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-sunken">
            <input type="checkbox" className="shrink-0 accent-[var(--accent)]" checked={chosen ? chosen.has(value) : true} onChange={() => onFilter(toggleValue(filter, value, all))} />
            <span className={`min-w-0 flex-1 truncate ${value ? "" : "text-muted italic"}`} title={value || undefined}>{label ?? (value || "Empty")}</span>
            {count !== undefined && <span className={`shrink-0 text-[12px] tabular-nums ${count ? "text-muted" : "text-faint"}`}>{count.toLocaleString()}</span>}
          </label>
        ))}
        {shown.length > LIST_LIMIT && <p className="px-2 py-1 text-[12px] text-muted">Showing {LIST_LIMIT} of {shown.length.toLocaleString()}. Search to find the rest.</p>}
      </div>}
    </div>,
    document.body,
  );
}

const SortMark = ({ direction }: { direction?: Sort["direction"] }) => {
  if (direction === "asc") return <ArrowUp size={12} className="shrink-0 text-accent" aria-hidden="true" />;
  if (direction === "desc") return <ArrowDown size={12} className="shrink-0 text-accent" aria-hidden="true" />;
  return <ChevronsUpDown size={12} className="shrink-0 text-faint" aria-hidden="true" />;
};

const pagerButton = "press inline-flex h-8 w-8 items-center justify-center rounded-md border border-line-strong text-muted hover:bg-sunken hover:text-ink aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted";

/**
 * Page controls, for a table or any other paged list. Hidden when everything fits on one page.
 * The ends stay focusable and do nothing, because a disabled button would throw a keyboard user out of the row.
 */
export function Pager({ page, total, size, onPage, onSize, label = "rows" }: { page: number; total: number; size: number; onPage: (page: number) => void; onSize: (size: number) => void; label?: string }) {
  const last = pageCount(total, size);
  if (total <= size) return null;
  const { from, to } = pageRange(page, total, size);
  const step = (name: string, target: number, Icon: LucideIcon, off: boolean) => (
    <button type="button" aria-label={name} title={name} aria-disabled={off} className={pagerButton} onClick={() => { if (!off) onPage(target); }}><Icon size={14} /></button>
  );
  return (
    <nav aria-label={`Pages of ${label}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line px-4 py-2 text-[12px] text-muted">
      <span role="status" className="tabular-nums">Showing {from.toLocaleString()} to {to.toLocaleString()} of {total.toLocaleString()}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-1.5">
          <span>Rows per page</span>
          <select aria-label="Rows per page" className="field field-select h-8 rounded-lg pr-7 pl-2 text-[12px] text-ink focus:outline-none" value={size} onChange={(event) => onSize(Number(event.target.value))}>
            {PAGE_SIZES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-1">
          {step("First page", 1, ChevronsLeft, page <= 1)}
          {step("Previous page", page - 1, ChevronLeft, page <= 1)}
          <span className="px-1.5 whitespace-nowrap tabular-nums">Page {page.toLocaleString()} of {last.toLocaleString()}</span>
          {step("Next page", page + 1, ChevronRight, page >= last)}
          {step("Last page", last, ChevronsRight, page >= last)}
        </div>
      </div>
    </nav>
  );
}

/** Keeps a table's sort, filters, page and rows per page. A page that loads rows from the server holds this itself, to build its request. */
export function useTable(id: string) {
  const { pathname } = useLocation();
  const storageKey = `${pathname}:${id}`;
  const [state, setState] = useState(() => loadState(storageKey));
  const [size, setSize] = useState(() => loadPageSize(storageKey));
  useEffect(() => saveState(storageKey, state), [storageKey, state]);
  const changeSize = useCallback((next: number) => {
    savePageSize(storageKey, next);
    setState((current) => ({ ...current, page: pageForSize(current.page, size, next) }));
    setSize(next);
  }, [storageKey, size]);
  return { state, setState, size, setSize: changeSize };
}

export type Table = ReturnType<typeof useTable>;

/** The query string for a server-paged table. Typing waits a moment; page and sort changes do not. */
export function useTableParams(table: Table, columns: Column[]) {
  const [search, setSearched] = useState(table.state.search);
  useEffect(() => {
    const timer = setTimeout(() => setSearched(table.state.search), 250);
    return () => clearTimeout(timer);
  }, [table.state.search]);
  return serverParams({ ...table.state, search }, table.size, columns);
}

/**
 * The table for every list of records. With `rows` alone it pages, sorts and filters in the browser, over all of them.
 * With `total` and `table`, `rows` is one page the server chose, and sort, filter and search go through the request. See `useTableParams`.
 * `columns` should keep its identity between renders. `children` draws one row and owns its key.
 * `note` says when the page only loaded part of the data. Set `searchable={false}` where the page has its own search.
 */
export function DataTable<Row>({ id, columns, rows, children, note, searchable = true, table, total }: {
  id: string; columns: Column<Row>[]; rows: Row[]; children: (row: Row, index: number) => ReactNode; note?: string; searchable?: boolean; table?: Table; total?: number;
}) {
  const own = useTable(id);
  const { state, setState, size, setSize } = table ?? own;
  const server = total !== undefined;
  const top = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ key: string; anchor: HTMLElement } | null>(null);

  const applied = useDeferredValue(state);
  const prepared = useMemo(() => prepareRows(rows, columns), [rows, columns]);
  const filtered = useMemo(() => (server ? prepared : filterRows(prepared, columns, applied)), [server, prepared, columns, applied]);
  const sorted = useMemo(() => (server ? prepared : sortRows(filtered, columns, applied.sort)), [server, prepared, filtered, columns, applied.sort]);
  const count = total ?? sorted.length;
  const page = clampPage(state.page, count, size);
  const shown = useMemo(() => (server ? sorted : pageSlice(sorted, page, size)), [server, sorted, page, size]);
  const body = useMemo(() => shown.map((item) => children(item.row, item.index)), [shown, children]);

  // Keeps the saved page in range after rows go away, so a request never sits past the end.
  useEffect(() => { if (page !== state.page) setState((current) => ({ ...current, page })); }, [page, state.page, setState]);

  const turn = (next: number) => {
    setState((current) => ({ ...current, page: next }));
    // Only when the top of the table has scrolled away, so a short table does not jump.
    if (top.current && top.current.getBoundingClientRect().top < 44) top.current.scrollIntoView({ block: "start" });
  };
  const close = useCallback((refocus: boolean) => {
    if (refocus) open?.anchor.focus();
    setOpen(null);
  }, [open]);
  const active = hasFilters(state);
  const showSearch = searchable && (count >= SEARCH_FROM || !!state.search);
  const openColumn = open && columns.find((column) => column.key === open.key);
  const sorts = (column: Column<Row>) => (server ? !!column.server?.sort : true);
  const filters = (column: Column<Row>) => (server ? !!(column.server?.options || column.server?.range) : true);

  return (
    <div ref={top} className="scroll-mt-4">
      {(showSearch || active) && (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-b border-line px-4 py-2">
          {showSearch && (
            <div className="relative mr-auto w-full sm:w-64">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
              <Input type="search" aria-label="Search this table" placeholder="Search this table" className="h-8 pl-8" value={state.search} onChange={(event) => setState(setSearch(state, event.target.value))} />
            </div>
          )}
          {active && (
            <div className="enter-fade flex items-center gap-3 text-[12px] text-muted">
              <span role="status" className="tabular-nums">{server ? `${count.toLocaleString()} ${count === 1 ? "match" : "matches"}` : `${count.toLocaleString()} of ${rows.length.toLocaleString()}`}</span>
              <button type="button" className={textButton} onClick={() => setState(clearFilters)}>Clear filters</button>
            </div>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-[12px] text-muted">
              {columns.map((column) => {
                if (!column.value || !(sorts(column) || filters(column))) return <th key={column.key} aria-label={column.header || "Actions"} className="px-4 py-2.5 font-medium whitespace-nowrap">{column.header}</th>;
                const direction = state.sort?.key === column.key ? state.sort.direction : undefined;
                const filtering = !!state.filters[column.key];
                const isOpen = open?.key === column.key;
                return (
                  <th key={column.key} aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"} className="px-4 py-1.5 font-medium whitespace-nowrap">
                    <span className="inline-flex items-center gap-0.5">
                      {sorts(column) ? (
                        <button type="button" onClick={() => setState(setSort(state, nextSort(state.sort, column.key)))} className="inline-flex items-center gap-1 rounded py-1 font-medium hover:text-ink">
                          {column.header} <SortMark direction={direction} />
                        </button>
                      ) : column.header}
                      {filters(column) && <button type="button" aria-label={`Filter ${column.header}${filtering ? ", filter on" : ""}`} title="Sort and filter" aria-haspopup="dialog" aria-expanded={isOpen}
                        onClick={(event) => { const anchor = event.currentTarget; setOpen(isOpen ? null : { key: column.key, anchor }); }}
                        className={`press inline-flex h-6 w-6 items-center justify-center rounded hover:bg-sunken hover:text-ink ${filtering ? "text-accent" : "text-faint"}`}>
                        <Filter size={12} fill={filtering ? "currentColor" : "none"} />
                      </button>}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line [&>tr:hover]:bg-raised">
            {body}
            {(server ? rows.length === 0 : rows.length > 0 && sorted.length === 0) && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-[13px] text-muted">
                  <span className="inline-flex items-center gap-1.5"><SearchX size={14} /> No rows match these filters.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={count} size={size} onPage={turn} onSize={setSize} />
      {note && <p className="border-t border-line px-4 py-2 text-[12px] text-faint">{note}</p>}
      {open && openColumn && (
        <FilterMenu key={open.key} column={openColumn} columns={columns} prepared={prepared} server={server} state={state} anchor={open.anchor} onClose={close}
          onFilter={(filter) => setState((current) => setFilter(current, open.key, filter))}
          onSort={(sort) => setState((current) => setSort(current, sort))} />
      )}
    </div>
  );
}
