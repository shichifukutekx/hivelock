import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SETTING = /\b(?:SMTP_URL|MAIL_FROM|ALLOWED_[A-Z_]+|HIVELOCK_[A-Z_]+|LLM_[A-Z_]+|KIMI_[A-Z_]+|DATABASE_[A-Z_]+|STRIPE_[A-Z_]+|SECRETS_MASTER_KEY|BETTER_AUTH_SECRET|BOOTSTRAP_ADMIN_EMAIL)\b/;

const filesIn = (folder: string): string[] => !existsSync(folder) ? [] : readdirSync(folder).flatMap((name) => {
  const path = join(folder, name);
  return statSync(path).isDirectory() ? filesIn(path) : /\.tsx?$/.test(name) ? [path] : [];
});

const withoutComments = (code: string) => code.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");

test("customer screens never name a server setting", () => {
  const found = filesIn("web/src").filter((path) => SETTING.test(readFileSync(path, "utf8")));
  assert.deepEqual(found, []);
});

test("messages a customer can read never name a server setting", () => {
  const sentences = /["'`][^"'`\n]* [^"'`\n]*["'`]/g;
  const found = ["src/platform/mailer.ts", "src/platform/app.ts", "src/config.ts", ...filesIn("src/platform/routes")]
    .filter((path) => existsSync(path))
    .flatMap((path) => (withoutComments(readFileSync(path, "utf8")).match(sentences) ?? []).filter((text) => SETTING.test(text) && !text.includes("Copy .env.example") && !text.includes("is missing, but")).map((text) => `${path}: ${text}`));
  assert.deepEqual(found, []);
});
