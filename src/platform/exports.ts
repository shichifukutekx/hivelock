import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Turns an agent's written answer into a file people use: a spreadsheet with one sheet per table, or a PDF.
 * Answers are Markdown, so headings, paragraphs, lists and tables are read from it.
 */

type Align = "left" | "right" | "center";
type Block = { kind: "heading"; text: string; level: number } | { kind: "text"; text: string } | { kind: "item"; text: string } | { kind: "table"; head: string[]; rows: string[][]; align: Align[] };

const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/(?<!\w)[*_](.+?)[*_](?!\w)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => plain(cell));
/** 1,234.50 and €406,990.14 and 12% and -3 are numbers to line up; codes such as PO-0001 are not. */
const looksNumeric = (value: string) => /^[-+]?\s?[€$£]?\s?[-+]?\d[\d.,\s]*\s?(%|€|[A-Z]{3})?$/.test(value.trim());
const divider = (line: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

export function readMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) blocks.push({ kind: "text", text: plain(paragraph.join(" ")) }); paragraph = []; };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.includes("|") && divider(lines[index + 1] ?? "")) {
      flush();
      const head = cells(line);
      const marks = cells(lines[index + 1]!);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) rows.push(cells(lines[index++]!));
      index -= 1;
      const full = rows.map((row) => head.map((_, column) => row[column] ?? ""));
      // The divider says how a column lines up. Without a mark, a column of numbers or amounts lines up on the right.
      const align = head.map((_, column): Align => {
        const mark = marks[column] ?? "";
        if (/^:-+:$/.test(mark)) return "center";
        if (/-:$/.test(mark)) return "right";
        // A left mark is what most writers put by habit, so numbers still line up on the right.
        const values = full.map((row) => row[column]!).filter((value) => value && !/^(not stated|n\/a|-|—)$/i.test(value));
        return values.length > 0 && values.every(looksNumeric) ? "right" : "left";
      });
      blocks.push({ kind: "table", head, rows: full, align });
    } else if (/^#{1,6}\s/.test(line)) { flush(); blocks.push({ kind: "heading", level: line.match(/^#+/)![0].length, text: plain(line.replace(/^#+\s*/, "")) }); }
    else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { flush(); blocks.push({ kind: "item", text: plain(line.replace(/^\s*([-*+]|\d+[.)])\s+/, "")) }); }
    else if (!line.trim()) flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** "1,234.50" and "12" become numbers, so a spreadsheet can add them up. Codes with leading zeros stay text. */
function asNumber(text: string): string | number {
  const value = text.replace(/,/g, "").trim();
  if (/^-?\d+(\.\d+)?$/.test(value) && !/^-?0\d/.test(value) && value.length < 16) return Number(value);
  return text;
}

export async function toXlsx(markdown: string, title: string): Promise<Buffer> {
  const blocks = readMarkdown(markdown);
  const book = new ExcelJS.Workbook();
  book.creator = "Hivelock";
  const tables = blocks.filter((block): block is Extract<Block, { kind: "table" }> => block.kind === "table");
  const used = new Set<string>();
  const sheetName = (wanted: string) => {
    let name = wanted.replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || "Sheet";
    for (let copy = 2; used.has(name.toLowerCase()); copy += 1) name = `${wanted.slice(0, 27)} (${copy})`;
    used.add(name.toLowerCase());
    return name;
  };
  tables.forEach((table, index) => {
    // A table's sheet is named after the heading just above it, when there is one.
    const at = blocks.indexOf(table);
    const heading = blocks.slice(0, at).reverse().find((block) => block.kind === "heading") as { text: string } | undefined;
    const sheet = book.addWorksheet(sheetName(heading?.text ?? (tables.length === 1 ? title : `Table ${index + 1}`)));
    sheet.addRow(table.head).font = { bold: true };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F1EC" } };
    for (const row of table.rows) sheet.addRow(row.map(asNumber));
    table.align.forEach((align, column) => { if (align !== "left") sheet.getColumn(column + 1).alignment = { horizontal: align }; });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.head.length } };
    table.head.forEach((cell, column) => {
      const widest = Math.max(cell.length, ...table.rows.map((row) => String(row[column] ?? "").length));
      sheet.getColumn(column + 1).width = Math.min(60, Math.max(8, widest + 2));
    });
  });
  // The words around the tables go on their own sheet, so nothing the agent wrote is lost.
  const words = blocks.filter((block) => block.kind !== "table");
  if (words.length || !tables.length) {
    const sheet = book.addWorksheet(sheetName(tables.length ? "Notes" : title));
    sheet.getColumn(1).width = 110;
    for (const block of words) {
      const row = sheet.addRow([block.kind === "item" ? `• ${block.text}` : (block as { text: string }).text]);
      row.alignment = { wrapText: true, vertical: "top" };
      if (block.kind === "heading") row.font = { bold: true, size: 13 };
    }
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 44;
const INK = rgb(0.09, 0.14, 0.12);
const MUTED = rgb(0.42, 0.47, 0.45);
const LINE = rgb(0.86, 0.89, 0.87);
const BAND = rgb(0.02, 0.15, 0.1);
const ACCENT = rgb(0.95, 0.66, 0.23);
const HEAD = rgb(0.9, 0.95, 0.92);
const ZEBRA = rgb(0.97, 0.98, 0.975);

/** The standard PDF fonts only know Western European letters, so anything else becomes a close plain form or "?". */
const pdfSafe = (text: string) => text.normalize("NFC").replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/[–—]/g, "-").replace(/…/g, "...")
  .replace(/[•●]/g, "-").replace(/[  ]/g, " ").replace(/[^\x20-\x7e¡-ÿ€]/g, "?");

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  for (const paragraph of pdfSafe(text).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) lines.push(line);
      // A word longer than the space is cut, so it cannot run off the page.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

/** Bold runs inside a line, such as "**3 orders** are late", are drawn bold. */
function runs(text: string) {
  const parts: { text: string; bold: boolean }[] = [];
  const raw = text.replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  let at = 0;
  for (const match of raw.matchAll(/\*\*(.+?)\*\*|__(.+?)__/g)) {
    if (match.index! > at) parts.push({ text: raw.slice(at, match.index), bold: false });
    parts.push({ text: match[1] ?? match[2]!, bold: true });
    at = match.index! + match[0].length;
  }
  if (at < raw.length) parts.push({ text: raw.slice(at), bold: false });
  return parts.map((part) => ({ ...part, text: part.text.replace(/(?<!\w)[*_](.+?)[*_](?!\w)/g, "$1") }));
}

export async function toPdf(markdown: string, title: string): Promise<Buffer> {
  const blocks = readMarkdown(markdown);
  // A wide table reads better across the page, so the whole document turns.
  const wide = blocks.some((block) => block.kind === "table" && block.head.length > 7);
  const size_ = wide ? { width: A4.height, height: A4.width } : A4;
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(title));
  doc.setCreator("Hivelock");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const width = size_.width - MARGIN * 2;
  const bottom = MARGIN + 22;
  let page: PDFPage;
  let y = 0;
  const newPage = (first = false) => {
    page = doc.addPage([size_.width, size_.height]);
    if (first) {
      // A dark band with the title, like the app's own header.
      const titleLines = wrap(title, bold, 18, width - 20);
      const bandHeight = 34 + titleLines.length * 22;
      page.drawRectangle({ x: 0, y: size_.height - bandHeight, width: size_.width, height: bandHeight, color: BAND });
      page.drawRectangle({ x: 0, y: size_.height - bandHeight - 3, width: size_.width, height: 3, color: ACCENT });
      titleLines.forEach((line, index) => page.drawText(line, { x: MARGIN, y: size_.height - 30 - index * 22, size: 18, font: bold, color: rgb(1, 1, 1) }));
      y = size_.height - bandHeight - 24;
    } else {
      page.drawText(pdfSafe(title), { x: MARGIN, y: size_.height - MARGIN + 12, size: 8, font: regular, color: MUTED });
      page.drawLine({ start: { x: MARGIN, y: size_.height - MARGIN + 6 }, end: { x: size_.width - MARGIN, y: size_.height - MARGIN + 6 }, thickness: 0.5, color: LINE });
      y = size_.height - MARGIN - 8;
    }
  };
  const room = (needed: number) => { if (y - needed < bottom) newPage(); };

  /** A paragraph with bold runs, wrapped to the width. */
  const paragraph = (text: string, size: number, indent = 0, gap = 7, color = INK) => {
    const words = runs(text).flatMap((part) => pdfSafe(part.text).split(/(\s+)/).filter((word) => word.length).map((word) => ({ word, bold: part.bold })));
    const lineHeight = size * 1.42;
    let line: typeof words = [];
    let used = 0;
    const flush = () => {
      room(lineHeight);
      let x = MARGIN + indent;
      for (const { word, bold: isBold } of line) {
        const font = isBold ? bold : regular;
        page.drawText(word, { x, y: y - size, size, font, color });
        x += font.widthOfTextAtSize(word, size);
      }
      y -= lineHeight;
      line = [];
      used = 0;
    };
    for (const item of words) {
      const font = item.bold ? bold : regular;
      const w = font.widthOfTextAtSize(item.word, size);
      if (/^\s+$/.test(item.word)) { if (line.length) { line.push(item); used += w; } continue; }
      if (used + w > width - indent && line.length) { while (line.length && /^\s+$/.test(line.at(-1)!.word)) line.pop(); flush(); }
      line.push(item);
      used += w;
    }
    if (line.length) flush();
    y -= gap;
  };

  newPage(true);
  page!.drawText(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), { x: MARGIN, y, size: 9, font: regular, color: MUTED });
  y -= 22;

  for (const block of blocks) {
    if (block.kind === "heading") {
      room(40);
      y -= 6;
      const size = block.level <= 2 ? 13.5 : 11.5;
      for (const line of wrap(block.text, bold, size, width)) { page!.drawText(line, { x: MARGIN, y: y - size, size, font: bold, color: INK }); y -= size * 1.35; }
      if (block.level <= 2) { page!.drawRectangle({ x: MARGIN, y: y - 2, width: 28, height: 2, color: ACCENT }); y -= 8; } else y -= 4;
      continue;
    }
    if (block.kind === "text") { paragraph(block.text, 10); continue; }
    if (block.kind === "item") {
      room(14);
      page!.drawCircle({ x: MARGIN + 4, y: y - 6.5, size: 1.6, color: INK });
      paragraph(block.text, 10, 14, 3);
      continue;
    }

    // Tables: columns share the width by how much they hold, and long cells wrap inside their column.
    const size = block.head.length > 9 ? 7.5 : block.head.length > 6 ? 8.5 : 9.5;
    const pad = 6;
    const weights = block.head.map((cell, column) => Math.min(42, Math.max(5, cell.length * 1.1, ...block.rows.slice(0, 300).map((row) => (row[column] ?? "").length))));
    const total = weights.reduce((sum, value) => sum + value, 0);
    // A table with a few short columns keeps its natural width instead of stretching across the page.
    const natural = weights.reduce((sum, value) => sum + value * size * 0.56 + pad * 2 + 18, 0);
    const tableWidth = Math.min(width, Math.max(natural, width * 0.55));
    const columns = weights.map((value) => (value / total) * tableWidth);
    const measure = (row: string[], font: PDFFont) => {
      const wrapped = row.map((cell, column) => wrap(cell, font, size, columns[column]! - pad * 2));
      return { wrapped, height: Math.max(...wrapped.map((lines) => lines.length)) * (size * 1.3) + pad * 1.4 };
    };
    const drawRow = (row: string[], header: boolean, shade: boolean) => {
      const font = header ? bold : regular;
      const { wrapped, height } = measure(row, font);
      if (y - height < bottom) {
        newPage();
        // A table that runs onto a new page repeats its header there.
        if (!header) drawRow(block.head, true, false);
      }
      if (header) page!.drawRectangle({ x: MARGIN, y: y - height, width: tableWidth, height, color: HEAD });
      else if (shade) page!.drawRectangle({ x: MARGIN, y: y - height, width: tableWidth, height, color: ZEBRA });
      let x = MARGIN;
      wrapped.forEach((lines, column) => {
        const align = block.align[column] ?? "left";
        lines.forEach((line, index) => {
          const w = font.widthOfTextAtSize(line, size);
          const left = align === "right" ? x + columns[column]! - pad - w : align === "center" ? x + (columns[column]! - w) / 2 : x + pad;
          page!.drawText(line, { x: left, y: y - pad * 0.7 - (index + 1) * size * 1.3 + size * 0.3, size, font, color: header ? BAND : INK });
        });
        x += columns[column]!;
      });
      y -= height;
      page!.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + tableWidth, y }, thickness: header ? 0.8 : 0.4, color: header ? rgb(0.75, 0.82, 0.78) : LINE });
    };
    y -= 2;
    room(measure(block.head, bold).height + 3 * (size * 1.3 + pad * 1.4));
    drawRow(block.head, true, false);
    block.rows.forEach((row, index) => drawRow(row, false, index % 2 === 1));
    y -= 14;
  }

  const pages = doc.getPages();
  const stamp = `Made on ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  pages.forEach((item, index) => {
    item.drawLine({ start: { x: MARGIN, y: MARGIN + 6 }, end: { x: size_.width - MARGIN, y: MARGIN + 6 }, thickness: 0.4, color: LINE });
    item.drawText(stamp, { x: MARGIN, y: MARGIN - 6, size: 7.5, font: regular, color: MUTED });
    const label = `Page ${index + 1} of ${pages.length}`;
    item.drawText(label, { x: size_.width - MARGIN - regular.widthOfTextAtSize(label, 7.5), y: MARGIN - 6, size: 7.5, font: regular, color: MUTED });
  });
  return Buffer.from(await doc.save());
}

export const EXPORT_TYPES = {
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", make: toXlsx },
  pdf: { type: "application/pdf", make: toPdf },
  csv: { type: "text/csv; charset=utf-8", make: async (markdown: string) => Buffer.from(toCsv(markdown)) },
} as const;

/** The first table as CSV, or the text when there is no table. */
export function toCsv(markdown: string) {
  const table = readMarkdown(markdown).find((block): block is Extract<Block, { kind: "table" }> => block.kind === "table");
  if (!table) return markdown;
  const quote = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, "\"\"")}"` : cell);
  return [table.head, ...table.rows].map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";
}
