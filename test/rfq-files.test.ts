import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { makePdf, makeXlsx } from "../eval/make-files.ts";
import { deflateRawSync } from "node:zlib";
import { assertUnpackable, extractIsolated, extractRfqText, layoutPage } from "../src/rfq/extract.ts";

const dir = mkdtempSync(join(tmpdir(), "rfq-files-"));
const save = (name: string, data: string | Uint8Array) => {
  const file = join(dir, name);
  writeFileSync(file, data);
  return file;
};

test("reads a PDF and keeps table columns apart", async () => {
  const file = save("table.pdf", await makePdf("RFQ 12\nLine | Qty | Size | Class\n10 | 6 | 4 | 300"));
  const text = await extractRfqText(file);
  assert.match(text, /RFQ 12/);
  assert.match(text, /Line \| Qty \| Size \| Class/);
  assert.match(text, /10 \| 6 \| 4 \| 300/);
});

test("does not glue a number onto text that overflows its PDF column", async () => {
  const file = save("overlap.pdf", await makePdf("A | Gate valve API 600 long text | 6 | 4 | 5 | 7 | 8 | 9 | 1\n"));
  assert.match(await extractRfqText(file), /Gate valve API 600 long text \| 6/);
});

test("reads every page of a long PDF, in order", async () => {
  const lines = Array.from({ length: 120 }, (_, i) => `Item ${i + 1} gate valve`);
  const text = await extractRfqText(save("long.pdf", await makePdf(lines.join("\n"))));
  assert.match(text, /--- Page 2 ---/);
  assert.ok(text.indexOf("Item 1 gate") < text.indexOf("Item 120 gate"));
});

test("a PDF with no text is refused with a clear message", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  await assert.rejects(extractRfqText(save("scan.pdf", await pdf.save())), /scan/);
});

test("a damaged PDF is refused with a clear message", async () => {
  await assert.rejects(extractRfqText(save("bad.pdf", "%PDF-not really")), /could not be read as a PDF/);
});

test("reads Excel sheets, dates, formulas and merged cells", async () => {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("Valves");
  first.addRow(["Line", "Qty", "Each", "Total"]);
  first.addRow(["10", 6, 2, { formula: "B2*C2", result: 12 }]);
  first.addRow(["Delivery", new Date("2027-03-01T00:00:00Z")]);
  first.addRow(["Merged note", ""]);
  first.mergeCells("A4:D4");
  const second = workbook.addWorksheet("Notes");
  second.addRow(["All valves NACE"]);
  const hidden = workbook.addWorksheet("Secret");
  hidden.state = "hidden";
  hidden.addRow(["Hidden text"]);

  const text = await extractRfqText(save("book.xlsx", Buffer.from(await workbook.xlsx.writeBuffer())));
  assert.match(text, /10 \| 6 \| 2 \| 12/);
  assert.match(text, /Delivery \| 2027-03-01/);
  assert.equal(text.match(/Merged note/g)?.length, 1);
  assert.match(text, /--- Sheet: Notes ---\nAll valves NACE/);
  assert.match(text, /Sheet: Secret \(hidden\) ---\nHidden text/);
});

test("a fake Excel file is refused with a clear message", async () => {
  await assert.rejects(extractRfqText(save("bad.xlsx", "not a workbook")), /could not be read as an Excel/);
});

test("reads text and CSV, and refuses other types", async () => {
  assert.equal(await extractRfqText(save("a.csv", "line,qty\n1,4\n")), "line,qty\n1,4\n");
  await assert.rejects(extractRfqText(save("a.xls", "old")), /not supported/);
});

test("says so when a very large file is cut off", async () => {
  const text = await extractRfqText(save("big.txt", "x".repeat(250_000)));
  assert.match(text, /cut off at 200000 characters/);
});

test("the Excel test files keep their table cells", async () => {
  const text = await extractRfqText(save("cells.xlsx", await makeXlsx("Header\nA | B\n")));
  assert.match(text, /A \| B/);
});

/** A zip of one entry, saying whatever size it likes. */
function zip(content: Buffer, claimed = content.length, copies = 1) {
  const packed = deflateRawSync(content);
  const name = Buffer.from("xl/workbook.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(claimed, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(claimed, 24);
  central.writeUInt16LE(name.length, 28);
  const directory = Buffer.concat(Array.from({ length: copies }, () => Buffer.concat([central, name])));
  const start = local.length + name.length + packed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(copies, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(start, 16);
  return Buffer.concat([local, name, packed, directory, end]);
}

test("a workbook is measured before anything loads it", async () => {
  const bomb = Buffer.alloc(150 * 1024 * 1024);
  const claimed = zip(Buffer.from("small"), 150 * 1024 * 1024);
  assert.throws(() => assertUnpackable(claimed), /too large once unpacked/);
  assert.throws(() => assertUnpackable(zip(bomb, 1_000)), /too large once unpacked/, "the claim is not taken on trust");
  assert.throws(() => assertUnpackable(zip(Buffer.alloc(30 * 1024 * 1024), 30 * 1024 * 1024, 4)), /too large once unpacked/, "the same data listed many times counts each time");
  assert.throws(() => assertUnpackable(zip(Buffer.from("x"), 1, 10_001)), /too large once unpacked/);
  assert.doesNotThrow(() => assertUnpackable(zip(Buffer.from("hello"))));
  await assert.rejects(extractRfqText(save("bomb.xlsx", zip(bomb, 1_000))), /too large once unpacked/);
  const real = Buffer.from(await makeXlsx("Header\nA | B\n"));
  assert.doesNotThrow(() => assertUnpackable(real));
});

test("a page of many separate lines is laid out in reasonable time", () => {
  const items = Array.from({ length: 300_000 }, (_, index) => ({ text: "a", x: 0, y: index * 10, end: 5 }));
  const started = Date.now();
  assert.equal(layoutPage(items).split("\n").length, 300_000);
  assert.ok(Date.now() - started < 3_000);
  const sameRow = [{ text: "b", x: 20, y: 101, end: 25 }, { text: "a", x: 0, y: 100, end: 5 }, { text: "c", x: 0, y: 90, end: 5 }];
  assert.equal(layoutPage(sameRow), "a | b\nc");
});

test("a PDF with too many pieces of text is refused", async () => {
  const lines = Array.from({ length: 300_100 }, (_, index) => `1 0 0 1 10 ${(index % 700) + 10} Tm (a) Tj`).join("\n");
  const stream = `BT /F1 8 Tf\n${lines}\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const at = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const table = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${table}\n%%EOF`;
  await assert.rejects(extractRfqText(save("many.pdf", body)), /too much text/);
});

test("extraction in its own process gives the same answers, and is stopped at its limits", async () => {
  const pdf = save("isolated.pdf", await makePdf("RFQ 12\nLine | Qty | Size | Class\n10 | 6 | 4 | 300"));
  assert.equal(await extractIsolated(pdf), await extractRfqText(pdf));
  await assert.rejects(extractIsolated(save("isolated-bad.pdf", "%PDF-not really")), /could not be read as a PDF/);
  assert.equal(await extractIsolated(save("isolated.txt", "plain")), "plain");
  await assert.rejects(extractIsolated(pdf, { timeoutMs: 20 }), /too long/);
  await assert.rejects(extractIsolated(pdf, { heapMb: 1 }), /too large or too complex/);
});
