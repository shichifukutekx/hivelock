import { realpath, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractRfqText } from "../rfq/extract.ts";
import { toPdf, toXlsx } from "../platform/exports.ts";
import { allFiles, baseOf, cleanPath, ensureFolder, freeName, parentOf } from "../platform/workspace-files.ts";

// Set by the platform to one workspace's folder, so this process can only ever see that workspace.
const folder = resolve(process.env.FILES_DIR ?? "data/files");
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const server = new McpServer({ name: "files", version: "0.1.0" });

server.registerTool(
  "list_files",
  { description: "List the files in this workspace, with their folders, such as reports/2026/late-orders.xlsx.", inputSchema: {} },
  async () => {
    const rows = allFiles(folder).map((file) => `${file.path} (${file.size} bytes)`);
    return text(rows.join("\n") || "No files yet.");
  },
);

server.registerTool(
  "read_file",
  { description: "Read a file by name. Supports PDF, Excel (.xlsx), CSV and text files.", inputSchema: { name: z.string() } },
  async ({ name }) => {
    const root = await realpath(folder);
    const target = await realpath(join(root, name));
    if (!target.startsWith(root + sep)) throw new Error("That file is outside this workspace.");
    return text(await extractRfqText(target));
  },
);

server.registerTool(
  "save_file",
  {
    description: "Save a new file in this workspace. Use .xlsx for a spreadsheet or .pdf for a document a person will print or send: give the content as Markdown, with tables as Markdown tables, and it is converted. Use .csv or .txt for plain data. The name may include folders, such as reports/late-orders.xlsx. Existing files are never overwritten: a clash gets a new name.",
    inputSchema: { name: z.string().max(400), content: z.string().max(1_000_000) },
  },
  async ({ name, content }) => {
    const wanted = cleanPath(name);
    const extension = extname(wanted).toLowerCase();
    if (![".txt", ".csv", ".xlsx", ".pdf"].includes(extension)) throw new Error("Saved files must be .xlsx, .pdf, .csv or .txt.");
    const place = parentOf(wanted);
    ensureFolder(folder, place);
    const saved = place ? `${place}/${freeName(folder, place, baseOf(wanted))}` : freeName(folder, "", baseOf(wanted));
    const title = baseOf(saved).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    const data = extension === ".xlsx" ? await toXlsx(content, title) : extension === ".pdf" ? await toPdf(content, title) : content;
    await writeFile(join(folder, saved), data, { flag: "wx" });
    return text(`Saved ${saved}`);
  },
);

await server.connect(new StdioServerTransport());
