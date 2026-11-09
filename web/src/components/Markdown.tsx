/** @jsxRuntime automatic @jsxImportSource react */
import { useState, type ReactNode } from "react";

/**
 * Shows an agent's reply as formatted text: headings, lists, tables, code and emphasis.
 * Everything stays text built by React, so nothing an agent writes can become HTML or script.
 */

const SAFE_LINK = /^https?:\/\//i;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const id = `${key}-${index++}`;
    if (token.startsWith("`")) out.push(<code key={id} className="rounded bg-sunken px-1 py-0.5 font-mono text-[12.5px]">{token.slice(1, -1)}</code>);
    else if (token.startsWith("**") || token.startsWith("__")) out.push(<strong key={id} className="font-semibold">{inline(token.slice(2, -2), id)}</strong>);
    else if (token.startsWith("*")) out.push(<em key={id}>{inline(token.slice(1, -1), id)}</em>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      out.push(SAFE_LINK.test(href!) ? <a key={id} href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline">{label}</a> : label);
    }
    last = match.index! + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const isDivider = (row: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(row);
const numeric = (value: string) => /^[-+]?[\d.,\s%€$£]+$/.test(value) && /\d/.test(value);

const PAGE = 10;

/** A long table shows a page at a time, so an answer with hundreds of rows stays readable. */
export function Table({ id, head, rows }: { id: string; head: string[]; rows: string[][] }) {
  const [shown, setShown] = useState(PAGE);
  const right = head.map((_, column) => rows.length > 0 && rows.every((row) => !row[column] || numeric(row[column]!)));
  const visible = rows.slice(0, shown);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-raised text-left text-[12px] text-muted">
            <tr>{head.map((cell, column) => <th key={column} className={`px-3 py-2 font-medium whitespace-nowrap ${right[column] ? "text-right" : ""}`}>{inline(cell, `${id}h${column}`)}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((row, r) => (
              <tr key={r}>{head.map((_, column) => <td key={column} className={`px-3 py-1.5 align-top whitespace-nowrap ${right[column] ? "text-right tabular-nums" : ""}`}>{inline(row[column] ?? "", `${id}r${r}c${column}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > PAGE && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-raised px-3 py-1.5 text-[12px] text-muted">
          <span className="tabular-nums">Showing {visible.length} of {rows.length}</span>
          <span className="flex gap-3">
            {shown < rows.length && <button type="button" className="font-medium text-accent hover:underline" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</button>}
            {shown < rows.length && rows.length - shown > PAGE && <button type="button" className="hover:text-ink hover:underline" onClick={() => setShown(rows.length)}>Show all</button>}
            {shown > PAGE && <button type="button" className="hover:text-ink hover:underline" onClick={() => setShown(PAGE)}>Show fewer</button>}
          </span>
        </div>
      )}
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const key = `b${i}`;
    if (!line.trim()) { i += 1; continue; }

    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      for (i += 1; i < lines.length && !lines[i]!.trimStart().startsWith("```"); i += 1) body.push(lines[i]!);
      i += 1;
      blocks.push(<pre key={key} className="overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-[12.5px] leading-snug">{body.join("\n")}</pre>);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const size = heading[1]!.length <= 2 ? "text-[15px]" : "text-[14px]";
      blocks.push(<p key={key} className={`${size} mt-1 font-semibold`}>{inline(heading[2]!, key)}</p>);
      i += 1;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim(); i += 1) rows.push(cells(lines[i]!));
      blocks.push(<Table key={key} id={key} head={head} rows={rows} />);
      continue;
    }

    const bullet = /^\s*([-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && bullet.test(lines[i]!); i += 1) items.push(lines[i]!.replace(bullet, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={key} className={`space-y-0.5 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>{items.map((item, n) => <li key={n}>{inline(item, `${key}i${n}`)}</li>)}</List>);
      continue;
    }

    const paragraph: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*([-*•]|\d+[.)])\s)/.test(lines[i]!) && !(lines[i]!.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1]!)); i += 1) paragraph.push(lines[i]!);
    if (!paragraph.length) { paragraph.push(line); i += 1; }
    blocks.push(<p key={key}>{paragraph.map((part, n) => <span key={n}>{n > 0 && <br />}{inline(part, `${key}p${n}`)}</span>)}</p>);
  }
  return <div className="space-y-2.5">{blocks}</div>;
}
