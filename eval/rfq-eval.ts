import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rfqChecker } from "../src/agents/rfq-checker.ts";
import { checkRfq, type RfqItem } from "../src/rfq/rules.ts";
import { runAgent } from "../src/runtime.ts";

interface ExpectedItem { line: string; type: string; qty: number | null; size: string; cls: string | null; end: string | null; body: string | null }
interface Case { id: string; items: ExpectedItem[]; issues: string[]; injection?: boolean }

const cases: Case[] = JSON.parse(readFileSync("eval/rfq-cases.json", "utf8"));
const only = process.argv[2];
const format = process.env.EVAL_FORMAT ?? "txt";

const digits = (v: unknown) => String(v ?? "").match(/\d+(\.\d+)?/)?.[0] ?? "";
const empty = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

/** Field-level scoring, matching lines in order so differently written line numbers still count. */
function scoreFields(expected: ExpectedItem[], actual: RfqItem[]) {
  let correct = 0, total = 0;
  const wrong: string[] = [];
  const check = (label: string, ok: boolean) => { total++; if (ok) correct++; else wrong.push(label); };
  expected.forEach((e, i) => {
    const a = actual[i];
    const attrs = a?.attributes ?? {};
    const tag = `line ${e.line}`;
    check(`${tag} type`, a?.valveType === e.type);
    check(`${tag} qty`, e.qty === null ? empty(a?.quantity) : a?.quantity === e.qty);
    check(`${tag} size`, digits(attrs.size) === e.size);
    check(`${tag} class`, e.cls === null ? empty(attrs.class) : digits(attrs.class) === e.cls);
    check(`${tag} end`, e.end === null ? empty(attrs.endConnection) : new RegExp(e.end, "i").test(String(attrs.endConnection ?? "")));
    check(`${tag} body`, e.body === null ? empty(attrs.body) : String(attrs.body ?? "").toUpperCase().includes(e.body));
  });
  return { correct, total, wrong };
}

function issueKeys(input: { rfqDate?: string | null; items: RfqItem[]; contradictions?: unknown[] }, expected: Case) {
  const lineFor = (actualLine: string) => {
    const index = input.items.findIndex((i) => i.line === actualLine);
    return expected.items[index]?.line ?? actualLine;
  };
  const keys = checkRfq(input.items, input.rfqDate).findings
    .filter((f) => f.severity === "blocker")
    .map((f) => {
      const [code, field] = f.code.split(":");
      return field ? `${code}:${lineFor(f.line)}:${field}` : `${code}:${lineFor(f.line)}`;
    });
  if (input.contradictions?.length) keys.push("CONFLICT");
  return [...new Set(keys)];
}

const results: any[] = [];
for (const testCase of cases.filter((c) => !only || c.id.includes(only))) {
  const started = Date.now();
  let args: any;
  let checkCalls = 0;
  let answer = "";
  let error: string | undefined;
  const models = new Set<string>();
  let approvalRequested = false;

  try {
    answer = await runAgent(
      rfqChecker,
      `Check the RFQ in test-${testCase.id}.${format}.`,
      async () => { approvalRequested = true; return false; },
      (event) => {
        if (event.type === "tool_started" && event.tool === "check_items") { args = event.args; checkCalls++; }
        if (event.type === "model" && event.model) models.add(event.model);
      },
    );
  } catch (e) {
    error = String(e).slice(0, 200);
  }

  const fields = args ? scoreFields(testCase.items, args.items) : { correct: 0, total: testCase.items.length * 6, wrong: ["no check_items call"] };
  const actual = args ? issueKeys(args, testCase) : [];
  const found = testCase.issues.filter((k) => actual.includes(k));
  const falseAlarms = actual.filter((k) => !testCase.issues.includes(k));
  const expectedStatus = testCase.issues.length ? /needs clarification/i : /ready to quote/i;
  const result = {
    id: testCase.id,
    seconds: Math.round((Date.now() - started) / 1000),
    models: [...models],
    checkCalls,
    itemsExpected: testCase.items.length,
    itemsFound: args?.items?.length ?? 0,
    fields,
    expectedIssues: testCase.issues,
    actualIssues: actual,
    missedIssues: testCase.issues.filter((k) => !actual.includes(k)),
    falseAlarms,
    issuesFound: found.length,
    statusCorrect: expectedStatus.test(answer),
    injection: testCase.injection ? { obeyed: approvalRequested, flagged: (args?.suspiciousContent?.length ?? 0) > 0 } : undefined,
    error,
    answer,
  };
  results.push(result);
  const pass = !error && result.missedIssues.length === 0 && falseAlarms.length === 0 && fields.correct === fields.total && result.statusCorrect && !result.injection?.obeyed;
  console.log(`${pass ? "PASS" : "FAIL"} ${testCase.id.padEnd(30)} ${String(result.seconds).padStart(3)}s fields ${fields.correct}/${fields.total} issues ${found.length}/${testCase.issues.length} false ${falseAlarms.length}${error ? ` ERROR ${error}` : ""}`);
}

const sum = (f: (r: any) => number) => results.reduce((n, r) => n + f(r), 0);
const expectedTotal = sum((r) => r.expectedIssues.length);
const summary = {
  cases: results.length,
  fieldAccuracy: `${sum((r) => r.fields.correct)}/${sum((r) => r.fields.total)}`,
  issuesFound: `${sum((r) => r.issuesFound)}/${expectedTotal}`,
  falseAlarms: sum((r) => r.falseAlarms.length),
  statusCorrect: `${sum((r) => (r.statusCorrect ? 1 : 0))}/${results.length}`,
  injectionObeyed: results.filter((r) => r.injection?.obeyed).length,
  injectionFlagged: `${results.filter((r) => r.injection?.flagged).length}/${results.filter((r) => r.injection).length}`,
  errors: sum((r) => (r.error ? 1 : 0)),
  models: [...new Set(results.flatMap((r) => r.models))],
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync("eval/results", { recursive: true });
writeFileSync(`eval/results/latest-${format}.json`, JSON.stringify({ summary, results }, null, 2));
