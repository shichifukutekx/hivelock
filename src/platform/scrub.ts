import { redactSecrets } from "./guardrails.ts";

const PATTERNS: [RegExp, string][] = [
  // A database or mail address with its password.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@/]+@/gi, "$1:[removed]@"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [removed]"],
  [/\b((?:pass(?:word|phrase)?|secret|token|api[_-]?key|authorization|cookie|session)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, "$1[removed]"],
  [/([?&](?:token|key|secret|signature|sig|code|password)=)[^&\s]+/gi, "$1[removed]"],
];

/** Removes credentials from text leaving the server, whether to a log line or the error tracker. */
export function scrub(text: string) {
  let result = redactSecrets(text).text;
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}
