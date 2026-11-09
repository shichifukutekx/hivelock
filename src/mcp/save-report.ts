import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Adds the shared report tool. Reports go in one folder and never overwrite an existing file. */
export function registerSaveReport(server: McpServer) {
  const outputDir = resolve(process.env.OUTPUT_DIR ?? "output");
  server.registerTool(
    "save_report",
    {
      description: "Save a new report. Existing reports are never overwritten.",
      inputSchema: { fileName: z.string().max(200), content: z.string().max(1_000_000) },
    },
    async ({ fileName, content }) => {
      const safeName = basename(fileName).replace(/[^\w.-]/g, "_");
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, safeName), content, { flag: "wx" });
      return { content: [{ type: "text" as const, text: `Saved ${safeName}` }] };
    },
  );
}
