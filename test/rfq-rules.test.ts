import assert from "node:assert/strict";
import { test } from "node:test";
import { checkItem, checkRfq, type RfqItem } from "../src/rfq/rules.ts";

const complete: RfqItem = {
  line: "1",
  valveType: "GATE VALVE",
  quantity: 4,
  attributes: { size: "6", class: "300", endConnection: "RF", body: "WCB", trimNo: "8", certification: "3.1" },
};
const withAttrs = (attrs: RfqItem["attributes"]): RfqItem => ({ ...complete, attributes: { ...complete.attributes, ...attrs } });
const codes = (item: RfqItem, date?: string) => checkItem(item, date).map((f) => f.code);

test("a complete item is ready to quote", () => {
  assert.deepEqual(checkRfq([complete]), { status: "ready_to_quote", blockers: 0, findings: [] });
});

test("flags each missing core field", () => {
  assert.deepEqual(codes({ ...complete, quantity: null }), ["MISSING:quantity"]);
  assert.deepEqual(codes(withAttrs({ class: null })), ["MISSING:class"]);
  assert.deepEqual(codes(withAttrs({ endConnection: "", body: "  " })), ["MISSING:endConnection", "MISSING:body"]);
  assert.deepEqual(codes(withAttrs({ trimNo: null })), ["MISSING:trim"]);
});

test("ball valves need seats, and ball and stem count as trim", () => {
  const ball = { ...complete, valveType: "FLOATING BALL VALVE", attributes: { ...complete.attributes, trimNo: null, ball: "316", stem: "316" } };
  assert.deepEqual(codes(ball), ["MISSING:seat"]);
  assert.deepEqual(codes({ ...ball, attributes: { ...ball.attributes, seat: "PTFE" } }), []);
});

test("checks the pressure class", () => {
  assert.deepEqual(codes(withAttrs({ class: "Class 350" })), ["INVALID_CLASS"]);
  assert.deepEqual(codes(withAttrs({ class: "#600" })), []);
  assert.deepEqual(codes(withAttrs({ class: "PN40" })), []);
});

test("converts pressure units before comparing with the class", () => {
  assert.deepEqual(codes(withAttrs({ shutOffPressure: "85 barg" })), ["PRESSURE_EXCEEDS_CLASS"]);
  assert.deepEqual(codes(withAttrs({ shutOffPressure: "500 psi" })), []);
  assert.deepEqual(codes(withAttrs({ shutOffPressure: "1,500 psi" })), ["PRESSURE_EXCEEDS_CLASS"]);
  assert.deepEqual(codes(withAttrs({ class: "PN40", shutOffPressure: "85 barg" })), []);
});

test("flags WCB below its temperature limit only", () => {
  assert.deepEqual(codes(withAttrs({ operatingTempMin: "-46 C" })), ["LOW_TEMP_MATERIAL"]);
  assert.deepEqual(codes(withAttrs({ operatingTempMin: "-20 C" })), []);
  assert.deepEqual(codes(withAttrs({ operatingTempMin: "-46 C", body: "A352 LCB" })), []);
  assert.deepEqual(codes(withAttrs({ operatingTempMin: "-50 F" })), ["LOW_TEMP_MATERIAL"]);
});

test("sour service needs a NACE requirement", () => {
  assert.deepEqual(codes(withAttrs({ service: "sour gas" })), ["SOUR_WITHOUT_NACE"]);
  assert.deepEqual(codes(withAttrs({ service: "H2S gas", compliance: "NACE MR0175" })), []);
});

test("delivery cannot be before the RFQ", () => {
  assert.deepEqual(codes(withAttrs({ deliveryDate: "2026-08-15" }), "2026-11-02"), ["DELIVERY_BEFORE_RFQ"]);
  assert.deepEqual(codes(withAttrs({ deliveryDate: "2027-01-01" }), "2026-11-02"), []);
});

test("a missing certificate is a warning, not a blocker", () => {
  const result = checkRfq([withAttrs({ certification: null })]);
  assert.equal(result.status, "ready_to_quote");
  assert.equal(result.findings[0]?.code, "NO_CERTIFICATION");
});
