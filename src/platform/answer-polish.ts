/**
 * People ask about orders, not about the tables they are stored in. An agent is told never to name them,
 * but a model can still write "from the porderq table", so the names it actually queried are taken out of
 * its answer before anyone sees it.
 */

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Table names after FROM or JOIN, and column-style names such as pohnum_0, from the SQL an agent ran. */
export function databaseNames(sql: string): Set<string> {
  const names = new Set<string>();
  for (const [, raw] of sql.matchAll(/\b(?:from|join)\s+([`"]?[\w.]+[`"]?)/gi)) {
    const name = raw!.replace(/[`"]/g, "").split(".").pop()!;
    if (/^[a-z_][\w]*$/i.test(name) && !/^(select|lateral|unnest|generate_series)$/i.test(name)) names.add(name.toLowerCase());
  }
  for (const [name] of sql.matchAll(/\b[a-z]+_\d+\b/gi)) names.add(name.toLowerCase());
  return names;
}

export function hideDatabaseNames(text: string, names: Iterable<string>): string {
  const list = [...new Set([...names].filter((name) => name.length >= 3))].sort((a, b) => b.length - a.length);
  if (!list.length) return text;
  const name = `[\`"]?(?:${list.map(escape).join("|")})[\`"]?`;
  const several = `(?:the\\s+)?${name}(?:\\s*(?:,|\\band\\b|&)\\s*(?:the\\s+)?${name})*`;
  const kind = "(?:tables?|views?|columns?|fields?|records?|data(?:base)?)";
  let out = text
    // ", from the porder and porderq tables" and "using the sorder table"
    .replace(new RegExp(`\\s*[,;]?\\s*\\b(?:from|in|using|via|based on|according to|out of|within|on)\\s+${several}(?:\\s+${kind})?\\b`, "gi"), "")
    // "the sorderq table" anywhere else
    .replace(new RegExp(`\\b(?:the\\s+)?${name}\\s+${kind}\\b`, "gi"), "")
    // "(pohnum_0)"
    .replace(new RegExp(`\\s*\\(\\s*${several}\\s*\\)`, "gi"), "");
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/,\s*([.:;])/g, "$1")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    // A sentence that began with the removed words starts again with a capital.
    .replace(/(^|[.!?]\s+)[,;]\s*(\p{L})/gmu, (_, before: string, letter: string) => `${before}${letter.toUpperCase()}`);
  return out;
}

/** Collects the names an agent queried while it worked, from its tool calls. */
export function namesFromToolCall(event: { type?: string; args?: unknown }, into: Set<string>) {
  if (event.type !== "tool_started" || !event.args || typeof event.args !== "object") return;
  const sql = (event.args as { sql?: unknown }).sql;
  if (typeof sql === "string") for (const name of databaseNames(sql)) into.add(name);
}
