import assert from "node:assert/strict";
import { test } from "node:test";
import { asPostgres } from "../src/platform/connectors/sql-dialect.ts";

test("MySQL habits become what PostgreSQL expects", () => {
  assert.equal(asPostgres("select a from t where b = ? and c = ? limit 5", ["x", 2]), "select a from t where b = $1 and c = $2 limit 5");
  assert.equal(asPostgres("SELECT `pohnum_0`, `a\"b` FROM `porderq`", []), 'SELECT "pohnum_0", "a""b" FROM "porderq"');
  assert.equal(asPostgres("select a\\nfrom t\\twhere b = 1", []), "select a from t where b = 1");
});

test("a statement that already works is never changed", () => {
  const valid = [
    "select btrim(pohnum_0) from porderq where btrim(pohnum_0) = $1 limit 5",
    "select 'it''s ? `here` \\n' as text, \"odd ? name\" from t",
    "select data ? 'key' from t",
    "select $tag$ ? `x` \\n $tag$, $$ ? $$ from t",
    "select 1 -- why? `because` \\n\nfrom t /* ? `x` */",
  ];
  for (const sql of valid) assert.equal(asPostgres(sql, []), sql, sql);
  // ? stays a JSON operator when the count does not match the values, or numbered values are already used.
  assert.equal(asPostgres("select data ? 'k' from t where id = ?", ["1"]), "select data ? 'k' from t where id = ?");
  assert.equal(asPostgres("select data ? 'k' from t where id = $1", ["1"]), "select data ? 'k' from t where id = $1");
});
