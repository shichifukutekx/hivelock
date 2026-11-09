// Pattern checks on what goes in and out of agents. Each pattern is linear, so hostile text cannot stall a worker.
const SECRETS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "api key"],
  [/\bnvapi-[A-Za-z0-9_-]{20,}\b/g, "api key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "slack token"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "github token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]*PRIVATE KEY-----/g, "private key"],
];

const INJECTION = [
  /ignore (?:all |any |your |the )?(?:previous|prior|above|earlier) (?:instructions|rules|prompts?)/i,
  /disregard (?:all |any |your |the )?(?:previous|prior|above|earlier|system) (?:instructions|rules|prompts?)/i,
  /reveal (?:your |the )?(?:system prompt|instructions)/i,
  /you are now (?:in )?(?:developer|dan|jailbreak)/i,
];

const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

function validCard(candidate: string) {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2) digit = digit > 4 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Removes credentials wherever they appear. There is no setting to turn this off. */
export function redactSecrets(text: string) {
  let found = 0;
  let result = text;
  for (const [pattern, label] of SECRETS) {
    result = result.replace(pattern, () => {
      found += 1;
      return `[removed ${label}]`;
    });
  }
  return { text: result, found };
}

export function redactPersonalData(text: string) {
  let found = 0;
  const result = text
    .replace(EMAIL, () => {
      found += 1;
      return "[removed email]";
    })
    .replace(CARD, (match) => {
      if (!validCard(match)) return match;
      found += 1;
      return "[removed card number]";
    });
  return { text: result, found };
}

const clean = (value: unknown, personal: boolean): unknown => {
  if (typeof value === "string") {
    const text = redactSecrets(value).text;
    return personal ? redactPersonalData(text).text : text;
  }
  if (Array.isArray(value)) return value.map((item) => clean(item, personal));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item, personal)]));
  return value;
};

/** The parts of a run's events that hold what people, models and tools wrote. Ids and times stay out, because they can look like card numbers. */
const EVENT_TEXT = ["prompt", "answer", "message", "preview", "output", "args"];

/** Stands in front of whatever stores or shows a run's events, so the feed gets the same treatment as the final answer. */
export const guardEvents = <E extends object>(personal: boolean | undefined, onEvent: (event: E) => void) => (event: E) =>
  onEvent(Object.fromEntries(Object.entries(event).map(([key, value]) => [key, EVENT_TEXT.includes(key) ? clean(value, !!personal) : value])) as E);

/** A warning sign only: wording changes easily, so this flags attempts rather than proving safety. */
export const looksLikeInjection = (text: string) => INJECTION.some((pattern) => pattern.test(text.slice(0, 100_000)));
