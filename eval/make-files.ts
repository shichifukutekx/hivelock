import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** Builds PDF and Excel copies of the test RFQs. Lines using " | " become real table columns. */
const dir = "data/rfqs";
const PAGE = { width: 595, height: 842, margin: 40, lineHeight: 15, size: 9 };
const clean = (line: string) => line.replace(/[^\x20-\x7e]/g, "?");

export async function makePdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const usable = PAGE.width - PAGE.margin * 2;
  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.margin;
  const nextLine = () => {
    y -= PAGE.lineHeight;
    if (y < PAGE.margin) {
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - PAGE.margin;
    }
  };
  const write = (value: string, x: number) => page.drawText(value, { x, y, size: PAGE.size, font });

  for (const raw of text.split("\n")) {
    const line = clean(raw);
    if (line.includes(" | ")) {
      const cells = line.split(" | ");
      const width = usable / cells.length;
      cells.forEach((cell, i) => write(cell.trim(), PAGE.margin + i * width));
      nextLine();
      continue;
    }
    let current = "";
    for (const word of line.split(" ")) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, PAGE.size) > usable) {
        write(current, PAGE.margin);
        nextLine();
        current = word;
      } else {
        current = next;
      }
    }
    if (current) write(current, PAGE.margin);
    nextLine();
  }
  return pdf.save();
}

export async function makeXlsx(text: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("RFQ");
  for (const line of text.split("\n")) {
    if (line.trim()) sheet.addRow(line.split(" | ").map((cell) => cell.trim()));
    else sheet.addRow([]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

if (process.argv[1]?.endsWith("make-files.ts")) {
  const files = readdirSync(dir).filter((f) => f.startsWith("test-") && f.endsWith(".txt"));
  for (const file of files) {
    const text = readFileSync(`${dir}/${file}`, "utf8");
    writeFileSync(`${dir}/${file.replace(".txt", ".pdf")}`, await makePdf(text));
    writeFileSync(`${dir}/${file.replace(".txt", ".xlsx")}`, await makeXlsx(text));
  }
  console.log(`Created PDF and Excel copies of ${files.length} RFQs in ${dir}`);
}
