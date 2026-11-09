import assert from "node:assert/strict";
import { test } from "node:test";
import { plainError, serviceProblem } from "../src/platform/plain-errors.ts";

test("a refusal from a service reads as something a person can act on", () => {
  assert.equal(serviceProblem("The AI provider", 401), "The AI provider did not accept the key or password. Check it is correct and still active.");
  assert.match(serviceProblem("The AI provider", 429), /limiting requests/);
  assert.match(serviceProblem("Slack", 503), /having trouble/);
  assert.match(serviceProblem("The service", 400, "missing field\n  at line 3"), /could not accept this request\. Details: missing field at line 3$/);
  for (const status of [401, 403, 404, 429, 500]) assert.doesNotMatch(serviceProblem("X", status), /\b\d{3}\b|answered/);
});

test("network failures are explained, not quoted", () => {
  assert.match(plainError(Object.assign(new Error("getaddrinfo ENOTFOUND api.exampel.com"), { code: "ENOTFOUND" })), /could not be found/);
  assert.match(plainError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }), "The database"), /The database is not answering/);
  assert.match(plainError(new Error("401 status code (no body)"), "The AI provider"), /did not accept the key/);
  assert.match(plainError(new Error("The server does not support SSL connections")), /untick Use TLS/);
});
