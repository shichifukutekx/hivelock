import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Loaded by address: the server's type check does not compile the web app's JSX.
const { Markdown } = await import(new URL("../web/src/components/Markdown.tsx", import.meta.url).href) as { Markdown: (props: { text: string }) => unknown };

const html = (text: string) => renderToStaticMarkup(createElement(Markdown as any, { text }));

test("an agent's reply shows tables, lists, headings and emphasis", () => {
  const out = html("**3 lines are overdue.**\n\n| PO | Days late | Open qty |\n|---|---|---|\n| PO1 | 5 | 6 |\n| PO2 | 12 | 1,200 |\n\n- First\n- Second\n\n## Next\nDone `now`.");
  assert.match(out, /<strong[^>]*>3 lines are overdue\.<\/strong>/);
  assert.match(out, /<table/);
  assert.match(out, /<th[^>]*>PO<\/th>/);
  assert.match(out, /<td class="[^"]*text-right[^"]*">1,200<\/td>/, "numbers line up on the right");
  assert.match(out, /<ul[^>]*><li>First<\/li><li>Second<\/li><\/ul>/);
  assert.match(out, /<code[^>]*>now<\/code>/);
});

test("nothing an agent writes becomes HTML, script or an unsafe link", () => {
  const out = html("<img src=x onerror=alert(1)> **<b>x</b>** [click](javascript:alert(1)) [ok](https://example.test)");
  assert.doesNotMatch(out, /<img|<b>|javascript:/);
  assert.match(out, /&lt;img/);
  assert.match(out, /<a href="https:\/\/example\.test" target="_blank" rel="noopener noreferrer"/);
});

test("a long table shows ten rows first, and says how many there are", () => {
  const rows = Array.from({ length: 25 }, (_, n) => `| PO${n} | ${n} |`).join("\n");
  const out = html(`| PO | Qty |\n|---|---|\n${rows}`);
  assert.equal((out.match(/<tr>/g) ?? []).length, 11, "a header row and ten data rows");
  assert.match(out, /Showing 10 of 25/);
  assert.match(out, /Show 10 more/);
  assert.match(out, /Show all/);
  const short = html("| PO | Qty |\n|---|---|\n| PO1 | 1 |");
  assert.doesNotMatch(short, /Showing/);
});
