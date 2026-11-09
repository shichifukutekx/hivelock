/**
 * Quote-readiness checks. These run as ordinary code, so document text cannot talk
 * them out of a result. The field lists and limits are a starter set: a sales engineer
 * should confirm them before the results are relied on.
 */

export interface RfqItem {
  line: string;
  valveType: string;
  quantity?: number | null;
  attributes: Record<string, string | number | null | undefined>;
}

export interface Finding {
  code: string;
  line: string;
  severity: "blocker" | "warning";
  message: string;
}

/** Same field names as mes-sales-rfq. */
const CORE_FIELDS = ["size", "class", "endConnection", "body"] as const;
const LABELS: Record<string, string> = {
  quantity: "quantity",
  size: "size",
  class: "pressure class",
  endConnection: "end connection",
  body: "body material",
  trim: "trim",
  seat: "seat material",
};

const VALID_CLASSES = new Set([125, 150, 250, 300, 400, 600, 800, 900, 1500, 2000, 2500, 3000, 4500, 5000, 10000]);

/** Approximate ambient ratings in barg for ASME B16.34 Group 1.1 (carbon steel). */
const AMBIENT_RATING_BARG: Record<number, number> = { 150: 19.6, 300: 51.1, 600: 102.1, 900: 153.2, 1500: 255.3, 2500: 425.5 };
const WCB_MIN_TEMP_C = -29;

const hasValue = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
const text = (value: unknown) => (hasValue(value) ? String(value) : "");
const firstNumber = (value: unknown) => {
  const match = text(value).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : undefined;
};

function pressureInBarg(value: unknown): number | undefined {
  const number = firstNumber(value);
  if (number === undefined) return undefined;
  if (/psi/i.test(text(value))) return number / 14.504;
  if (/mpa/i.test(text(value))) return number * 10;
  return number;
}

function temperatureInC(value: unknown): number | undefined {
  const number = firstNumber(value);
  if (number === undefined) return undefined;
  return /°?\s*f\b/i.test(text(value)) ? ((number - 32) * 5) / 9 : number;
}

function missingFields(item: RfqItem): string[] {
  const a = item.attributes;
  const missing: string[] = [];
  if (!hasValue(item.quantity)) missing.push("quantity");
  for (const field of CORE_FIELDS) if (!hasValue(a[field])) missing.push(field);

  const isBall = item.valveType.includes("BALL");
  const hasTrim = [a.trim, a.trimNo].some(hasValue);
  const hasBallTrim = hasValue(a.ball) && hasValue(a.stem);
  if (isBall ? !hasTrim && !hasBallTrim : !hasTrim && !hasValue(a.seat) && !hasValue(a.disc)) missing.push("trim");
  if (isBall && !hasValue(a.seat)) missing.push("seat");
  return missing;
}

export function checkItem(item: RfqItem, rfqDate?: string | null): Finding[] {
  const a = item.attributes;
  const findings: Finding[] = missingFields(item).map((field) => ({
    code: `MISSING:${field}`,
    line: item.line,
    severity: "blocker",
    message: `Line ${item.line}: ${LABELS[field]} is missing.`,
  }));
  const add = (code: string, severity: Finding["severity"], message: string) =>
    findings.push({ code, line: item.line, severity, message: `Line ${item.line}: ${message}` });

  const classText = text(a.class);
  const isPn = /PN\s*\d+/i.test(classText);
  const classNumber = isPn ? undefined : firstNumber(classText);
  if (hasValue(a.class) && !isPn && !VALID_CLASSES.has(classNumber ?? 0)) {
    add("INVALID_CLASS", "blocker", `"${classText}" is not a recognised pressure class.`);
  }

  const pressure = pressureInBarg(a.shutOffPressure);
  const rating = classNumber === undefined ? undefined : AMBIENT_RATING_BARG[classNumber];
  if (pressure !== undefined && rating !== undefined && pressure > rating) {
    add("PRESSURE_EXCEEDS_CLASS", "blocker", `${pressure.toFixed(1)} barg is above the roughly ${rating} barg ambient rating for Class ${classNumber}.`);
  }

  const minTemp = temperatureInC(a.operatingTempMin);
  if (minTemp !== undefined && minTemp < WCB_MIN_TEMP_C && /WCB|\bA216\b/i.test(text(a.body))) {
    add("LOW_TEMP_MATERIAL", "blocker", `WCB is normally limited to ${WCB_MIN_TEMP_C} C, but the minimum temperature is ${Math.round(minTemp)} C.`);
  }

  const isSour = /sour|h2s/i.test(`${text(a.service)} ${text(a.specialRequirements)}`);
  const hasNace = /nace|mr\s?0?175|mr\s?0?103|iso\s?15156/i.test(`${text(a.compliance)} ${text(a.specialRequirements)}`);
  if (isSour && !hasNace) add("SOUR_WITHOUT_NACE", "blocker", "sour service is stated, but no NACE MR0175 / ISO 15156 requirement is given.");

  if (rfqDate && hasValue(a.deliveryDate)) {
    const delivery = Date.parse(text(a.deliveryDate));
    const issued = Date.parse(rfqDate);
    if (!Number.isNaN(delivery) && !Number.isNaN(issued) && delivery < issued) {
      add("DELIVERY_BEFORE_RFQ", "blocker", `delivery date ${text(a.deliveryDate)} is before the RFQ date ${rfqDate}.`);
    }
  }

  if (!hasValue(a.certification)) add("NO_CERTIFICATION", "warning", "no certificate requirement is stated.");
  return findings;
}

export function checkRfq(items: RfqItem[], rfqDate?: string | null) {
  const findings = items.flatMap((item) => checkItem(item, rfqDate));
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  return { status: blockers ? "needs_clarification" : "ready_to_quote", blockers, findings };
}
