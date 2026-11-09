// Runs one extraction for extractIsolated in extract.ts, and answers on standard output.
import { extractRfqText } from "./extract.ts";

try {
  process.stdout.write(JSON.stringify({ text: await extractRfqText(process.argv[2]!) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: (error as Error).message }));
}
