import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { readMarkdown, toCsv, toPdf, toXlsx } from "../src/platform/exports.ts";
import { extractRfqText } from "../src/rfq/extract.ts";

const rows = Array.from({ length: 70 }, (_, i) => `| Cliente Ñandú ${i} | PO-${String(i).padStart(4, "0")} | ${(1000 + i * 12.5).toLocaleString("en-US")} | 0${i} |`).join("\n");
const answer = `## Late purchase lines\n\n**70 lines** are late — chase the first ones.\n\n| Supplier | PO | Amount | Code |\n|---|---|---:|---|\n${rows}\n\n- Check “Tecno” first\n- Then the rest`;
const folder = mkdtempSync(join(tmpdir(), "exports-"));

test("an answer's tables become sheets of real numbers, with the words kept on their own sheet", async () => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await toXlsx(answer, "Late lines") as never);
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ["Late purchase lines", "Notes"]);
  const sheet = book.worksheets[0]!;
  assert.equal(sheet.rowCount, 71);
  assert.equal(sheet.getRow(2).getCell(3).value, 1000, "amounts are numbers");
  assert.equal(sheet.getRow(3).getCell(3).value, 1012.5);
  assert.equal(sheet.getRow(2).getCell(4).value, "00", "codes with a leading zero stay as typed");
  assert.equal(sheet.getRow(2).getCell(1).value, "Cliente Ñandú 0");
});

test("a PDF holds the title, every row across pages, and the header on each page", async () => {
  const file = join(folder, "late.pdf");
  writeFileSync(file, await toPdf(answer, "Late lines"));
  const text = await extractRfqText(file);
  assert.ok((text.match(/--- Page/g) ?? []).length >= 2);
  assert.equal((text.match(/Supplier/g) ?? []).length, (text.match(/--- Page/g) ?? []).length, "the header repeats on each page");
  assert.match(text, /Cliente Ñandú 69/);
  assert.match(text, /Late lines/);
});

test("a table with a one-dash divider, as many writers use, is still a table, and amounts line up on the right", () => {
  const [table] = readMarkdown("| Plant | Docs | Amount |\n| :--- | -: | :--- |\n| ACT01 | 68 | €406,990.14 |\n| ICP01 | 3 | Not stated |").filter((block) => block.kind === "table") as any[];
  assert.ok(table, "the table is found");
  assert.deepEqual(table.align, ["left", "right", "right"]);
});

test("Markdown is read into headings, text, lists and tables, and CSV quotes what it must", () => {
  assert.deepEqual(readMarkdown("# Title\n\nSome **bold** words.\n\n- one\n\n| A | B |\n|---|---|\n| 1, 2 | \"x\" |").map((block) => block.kind), ["heading", "text", "item", "table"]);
  assert.equal(toCsv("| A | B |\n|---|---|\n| 1, 2 | say \"hi\" |"), "A,B\r\n\"1, 2\",\"say \"\"hi\"\"\"\r\n");
});
