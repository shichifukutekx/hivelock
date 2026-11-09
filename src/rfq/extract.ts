import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const RFQ_EXTENSIONS = [".txt", ".csv", ".pdf", ".xlsx"];

const MAX_CHARS = 200_000;
const MAX_PDF_PAGES = 100;
const MAX_SHEET_ROWS = 5_000;
const MAX_PDF_ITEMS = 300_000;
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const CHILD_TIMEOUT_MS = 60_000;
const CHILD_HEAP_MB = 768;
const MAX_CHILD_OUTPUT = 5 * 1024 * 1024;
const COLUMN_GAP = 12;
const SAME_LINE_TOLERANCE = 3;

interface PositionedText { text: string; x: number; y: number; end: number }

/** Rebuilds lines from positioned PDF text, keeping table columns apart with " | ". */
export function layoutPage(items: PositionedText[]): string {
  const rows: PositionedText[][] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y)) {
    // Items come highest first, so only the newest row can still be close enough.
    const row = rows.at(-1);
    if (row && Math.abs(row[0]!.y - item.y) <= SAME_LINE_TOLERANCE) row.push(item);
    else rows.push([item]);
  }
  return rows
    .map((row) => {
      let line = "";
      let previousEnd: number | undefined;
      for (const item of row.sort((a, b) => a.x - b.x)) {
        if (previousEnd !== undefined) {
          const gap = item.x - previousEnd;
          // Overlapping text is a full cell running into the next one, so it must not be glued together.
          if (gap > COLUMN_GAP || gap < -1) line += " | ";
          else if (gap > 1 && !line.endsWith(" ")) line += " ";
        }
        line += item.text;
        previousEnd = item.end;
      }
      return line.trim();
    })
    .filter(Boolean)
    .join("\n");
}

async function readPdf(file: string): Promise<string> {
  const data = new Uint8Array(await readFile(file));
  const task = getDocument({ data, verbosity: 0 });
  try {
    const pdf = await task.promise.catch((error) => {
      if (error?.name === "PasswordException") throw new Error("This PDF is password protected.");
      throw new Error("This file could not be read as a PDF.");
    });
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`This PDF has ${pdf.numPages} pages, and the limit is ${MAX_PDF_PAGES}.`);

    const pages: string[] = [];
    let total = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      total += items.length;
      if (total > MAX_PDF_ITEMS) throw new Error("This PDF has too much text to read.");
      const positioned = items.flatMap((item) => {
        if (!("str" in item) || !item.str.trim()) return [];
        return [{ text: item.str, x: item.transform[4], y: item.transform[5], end: item.transform[4] + item.width }];
      });
      pages.push(`--- Page ${number} ---\n${layoutPage(positioned)}`);
    }

    const text = pages.join("\n\n");
    if (text.replace(/--- Page \d+ ---/g, "").trim().length < 20) {
      throw new Error("This PDF has no readable text, so it is probably a scan. Scanned PDFs are not supported yet.");
    }
    return text;
  } finally {
    await task.destroy();
  }
}

function cellText(cell: ExcelJS.Cell): string {
  if (cell.isMerged && cell.master.address !== cell.address) return "";
  const value = cell.value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === "object") {
    if ("result" in value) return value.result instanceof Date ? value.result.toISOString().slice(0, 10) : String(value.result ?? "");
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
    return "";
  }
  return String(value ?? "");
}

const NOT_A_WORKBOOK = "This file could not be read as an Excel workbook.";
const TOO_LARGE_UNPACKED = "This workbook is too large once unpacked.";

/**
 * A small workbook can unpack to gigabytes, and the sizes in its directory are only what it claims. So the claims are added up first,
 * then each entry is really unpacked, stopping at what is left of the allowance. The sizes tell nothing about a zip made to lie.
 */
export function assertUnpackable(data: Buffer) {
  const end = data.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (end < 0 || end + 22 > data.length) throw new Error(NOT_A_WORKBOOK);
  // Measured back from its end, because a zip may have something in front of it. The offsets inside are moved by the same amount.
  const directorySize = data.readUInt32LE(end + 12);
  const start = end - directorySize;
  const shift = start - data.readUInt32LE(end + 16);
  if (start < 0 || shift < 0) throw new Error(NOT_A_WORKBOOK);

  const entries: { method: number; packed: number; offset: number }[] = [];
  let claimed = 0;
  for (let at = start; at + 46 <= end && data.readUInt32LE(at) === 0x02014b50;) {
    claimed += data.readUInt32LE(at + 24);
    if (claimed > MAX_UNZIPPED_BYTES || entries.length >= MAX_ZIP_ENTRIES) throw new Error(TOO_LARGE_UNPACKED);
    entries.push({ method: data.readUInt16LE(at + 10), packed: data.readUInt32LE(at + 20), offset: data.readUInt32LE(at + 42) + shift });
    at += 46 + data.readUInt16LE(at + 28) + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }

  let left = MAX_UNZIPPED_BYTES;
  for (const { method, packed, offset } of entries) {
    if (offset + 30 > data.length || data.readUInt32LE(offset) !== 0x04034b50) throw new Error(NOT_A_WORKBOOK);
    const body = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
    const stored = data.subarray(body, body + packed);
    try {
      left -= method === 8 ? inflateRawSync(stored, { maxOutputLength: left + 1 }).length : stored.length;
    } catch (error) {
      throw new Error((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? TOO_LARGE_UNPACKED : NOT_A_WORKBOOK);
    }
    if (left < 0) throw new Error(TOO_LARGE_UNPACKED);
  }
}

async function readXlsx(file: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const data = await readFile(file);
  assertUnpackable(data);
  await workbook.xlsx.load(data as unknown as ArrayBuffer).catch(() => {
    throw new Error(NOT_A_WORKBOOK);
  });

  const sheets = workbook.worksheets.map((sheet) => {
    const lines = [`--- Sheet: ${sheet.name}${sheet.state === "visible" ? "" : " (hidden)"} ---`];
    let rows = 0;
    sheet.eachRow((row) => {
      if (++rows > MAX_SHEET_ROWS) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellText(cell).trim();
        if (text) cells.push(text);
      });
      if (cells.length) lines.push(cells.join(" | "));
    });
    if (rows > MAX_SHEET_ROWS) lines.push(`[Only the first ${MAX_SHEET_ROWS} of ${rows} rows were read.]`);
    return lines.join("\n");
  });
  return sheets.join("\n\n");
}

/** Turns an RFQ file into text. Throws a clear message rather than returning partial nonsense. */
export async function extractRfqText(file: string): Promise<string> {
  const extension = extname(file).toLowerCase();
  let text: string;
  if (extension === ".pdf") text = await readPdf(file);
  else if (extension === ".xlsx") text = await readXlsx(file);
  else if (extension === ".txt" || extension === ".csv") text = await readFile(file, "utf8");
  else throw new Error(`${extension || "This file type"} is not supported. Use ${RFQ_EXTENSIONS.join(", ")}.`);

  if (text.length > MAX_CHARS) {
    return `${text.slice(0, MAX_CHARS)}\n\n[This RFQ was cut off at ${MAX_CHARS} characters. Tell the user that the rest was not checked.]`;
  }
  return text;
}

/**
 * The same, for files from strangers on a server shared with other people's work. Parsing runs in its own process with limited memory and time,
 * and with no settings passed on, so a file made to exhaust or crash a parser costs only that process.
 */
export function extractIsolated(file: string, { timeoutMs = CHILD_TIMEOUT_MS, heapMb = CHILD_HEAP_MB } = {}): Promise<string> {
  if (![".pdf", ".xlsx"].includes(extname(file).toLowerCase())) return extractRfqText(file);
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL("./extract-child.ts", import.meta.url));
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, "--import", "tsx", script, file], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp" },
    });
    const parts: Buffer[] = [];
    let size = 0;
    let failure: string | undefined;
    const giveUp = (message: string) => {
      failure ??= message;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => giveUp("This file took too long to read."), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CHILD_OUTPUT) giveUp("This file could not be read.");
      else parts.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (failure) return reject(new Error(failure));
      try {
        const { text, error } = JSON.parse(Buffer.concat(parts).toString("utf8")) as { text?: string; error?: string };
        if (error !== undefined) reject(new Error(error));
        else resolve(text!);
      } catch {
        // It ran out of memory or crashed, so there is no answer to read.
        reject(new Error("This file is too large or too complex to read."));
      }
    });
  });
}
