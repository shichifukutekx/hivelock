/** Reading list requests. Everything a request can choose goes through here, so limits stay bounded and only named columns reach the SQL. */

/** The most rows any list answers with at once. */
export const MAX_PAGE_SIZE = 200;
const MAX_OFFSET = 10_000_000;
const MAX_TERMS = 8;

type Query = (name: string) => string | undefined;

const whole = (text: string | undefined) => (text !== undefined && /^\d{1,9}$/.test(text) ? Number(text) : undefined);

/** A bad number falls back to the default, as other read endpoints do. */
export function readPage(query: Query, defaultLimit: number, maxLimit = MAX_PAGE_SIZE) {
  const limit = whole(query("limit"));
  const offset = whole(query("offset"));
  return {
    limit: limit === undefined || limit < 1 ? defaultLimit : Math.min(limit, maxLimit),
    offset: Math.min(offset ?? 0, MAX_OFFSET),
  };
}

/** Builds a where clause with numbered values, so nothing a person typed is ever part of the SQL text. */
export function conditions() {
  const parts: string[] = [];
  const values: unknown[] = [];
  const value = (item: unknown) => `$${values.push(item)}`;
  return {
    value,
    add: (part: string) => { parts.push(part); },
    where: () => (parts.length ? `where ${parts.join(" and ")}` : ""),
    values,
  };
}

const likeTerm = (word: string) => `%${word.replace(/[\\%_]/g, "\\$&")}%`;

/** The patterns a search asks for, each one safe to pass to ilike. */
export const searchTerms = (text: string | undefined) => (text ?? "").trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS).map((word) => likeTerm(word.slice(0, 100)));

/** Every word must appear somewhere in `expression`. The expression is code here, and never holds sealed data. */
export function addSearch(where: ReturnType<typeof conditions>, expression: string, text: string | undefined) {
  for (const term of searchTerms(text)) where.add(`${expression} ilike ${where.value(term)}`);
}

/** A comma list, kept to known values. Sent but empty means nothing was chosen, so it matches no rows. */
export function addChoice(where: ReturnType<typeof conditions>, column: string, text: string | undefined, allowed: readonly string[]) {
  if (text === undefined) return;
  const chosen = text.split(",").filter((item) => allowed.includes(item));
  where.add(`${column} = any(${where.value(chosen)}::text[])`);
}

/** A date Postgres can read. JavaScript allows years outside these, which print in a form Postgres refuses. */
export const instant = (text: string | undefined) => {
  if (!text) return undefined;
  const time = new Date(text);
  if (Number.isNaN(time.getTime())) return undefined;
  const year = time.getUTCFullYear();
  return year >= 1 && year <= 9999 ? time.toISOString() : undefined;
};

export function addRange(where: ReturnType<typeof conditions>, column: string, from: string | undefined, to: string | undefined) {
  const [start, end] = [instant(from), instant(to)];
  if (start) where.add(`${column} >= ${where.value(start)}::timestamptz`);
  if (end) where.add(`${column} <= ${where.value(end)}::timestamptz`);
}

/** For a list that sorts on time alone: newest first unless asked otherwise. */
export const orderDirection = (query: Query) => (query("sort") === "when" && query("direction") === "asc" ? "asc" : "desc");

/** Only keys named in `columns` can sort. `tieBreak` keeps a row from appearing on two pages when values match. */
export function orderBy(query: Query, columns: Record<string, string>, fallback: string, tieBreak: string) {
  const key = query("sort") ?? "";
  const column = Object.hasOwn(columns, key) ? columns[key] : undefined;
  if (!column) return `order by ${fallback}, ${tieBreak}`;
  return `order by ${column} ${query("direction") === "asc" ? "asc" : "desc"} nulls last, ${tieBreak}`;
}
