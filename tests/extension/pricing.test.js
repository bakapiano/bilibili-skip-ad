import assert from "node:assert/strict";
import { test } from "node:test";
import { pricingPeriod } from "../../extension/lib/pricing.js";
import { usageCost, publicRecord } from "../../extension/lib/core.js";
import { DeepSeekClient } from "../../extension/lib/providers.js";
import { context, usage, defaults, json, jsonOutput } from "./fixtures.js";

const time = (value) => Date.parse(`${value}+08:00`);

test("Beijing pricing selects the exact 09/12/14/18 boundaries independently of host timezone", () => {
  for (const [clock, expected] of [
    ["08:59:59", "offPeak"],
    ["09:00:00", "peak"],
    ["11:59:59", "peak"],
    ["12:00:00", "offPeak"],
    ["13:59:59", "offPeak"],
    ["14:00:00", "peak"],
    ["17:59:59", "peak"],
    ["18:00:00", "offPeak"],
    ["23:59:59", "offPeak"],
  ]) {
    assert.equal(pricingPeriod(time(`2026-10-08T${clock}`)), expected, clock);
  }
  assert.equal(pricingPeriod(Date.parse("2026-10-08T01:00:00Z")), "peak");
  assert.equal(pricingPeriod(Date.parse("2026-10-07T18:00:00-07:00")), "peak");
});

test("weekends, make-up working weekends and declared holidays use valley pricing", () => {
  for (const day of [
    "2026-09-25",
    "2026-09-26",
    "2026-10-01",
    "2026-10-07",
    "2026-10-10",
    "2026-10-11",
  ]) {
    assert.equal(pricingPeriod(time(`${day}T10:00:00`)), "offPeak", day);
  }
  assert.equal(pricingPeriod(time("2026-08-22T10:00:00")), "peak");
  assert.equal(pricingPeriod(time("2026-08-23T10:00:00")), "offPeak");
  assert.equal(pricingPeriod(time("2026-09-24T10:00:00")), "peak");
});

test("unverified future holiday dates and invalid timestamps keep costs explicitly unresolved", () => {
  for (const value of [null, undefined, NaN, Infinity, "2026-10-08", Number.MAX_VALUE]) {
    assert.equal(pricingPeriod(value), null);
  }
  const estimate = usageCost(usage, time("2027-01-01T10:00:00"));
  assert.equal(estimate.costCny, null);
  assert.equal(estimate.pricingPeriod, null);
  assert.equal(pricingPeriod(time("2027-01-02T10:00:00")), "offPeak");
});

test("one selected amount retains token/cache accounting without double-counting reasoning", () => {
  const input = { ...usage, completion_tokens_details: { reasoning_tokens: 99 } };
  const peak = usageCost(input, time("2026-10-08T10:00:00"));
  const valley = usageCost(input, time("2026-10-08T12:00:00"));
  assert.equal(peak.costCny, 0.002604);
  assert.equal(valley.costCny, 0.001302);
  assert.equal(peak.pricingPeriod, "peak");
  assert.equal(valley.pricingPeriod, "offPeak");
  assert.equal(peak.pricedAt, time("2026-10-08T10:00:00"));
  assert.equal(peak.pricingTimeBasis, "usage-received");
  assert.equal(peak.cacheBasis, "measured");
});

test("provider fixes the charge when usage arrives across a tariff boundary, including output errors", async () => {
  const ctx = await context();
  let now = time("2026-10-08T08:59:59");
  let malformed = false;
  const model = new DeepSeekClient(
    async () => {
      now = time("2026-10-08T09:00:01");
      return json({
        usage,
        choices: [
          { finish_reason: "stop", message: { content: malformed ? "bad JSON" : jsonOutput } },
        ],
      });
    },
    { clock: () => now },
  );
  const result = await model.analyze(ctx, defaults.apiKey);
  assert.equal(result.usage.costCny, 0.002604);
  assert.equal(result.usage.pricedAt, now);
  now = time("2026-10-08T19:00:00");
  assert.equal(result.usage.costCny, 0.002604);
  malformed = true;
  await assert.rejects(
    model.analyze(ctx, defaults.apiKey),
    (error) => error.details.usage.costCny === 0.002604,
  );
});

test("historical records select their recorded price pair by stored time, never the current clock", () => {
  const legacy = { offPeakCny: 0.0123, peakCny: 0.0246, asOf: "historical-test" };
  const record = { createdAt: time("2026-10-08T10:00:00"), usage: legacy };
  const projected = publicRecord(record);
  assert.equal(projected.usage.costCny, 0.0246);
  assert.equal(projected.usage.pricingTimeBasis, "record-created");
  assert.equal(Object.hasOwn(legacy, "costCny"), false);
  assert.equal(publicRecord({ usage: legacy }).usage.costCny, null);
  const fixed = usageCost(usage, time("2026-10-08T12:00:00"));
  assert.equal(publicRecord({ ...record, usage: fixed }).usage.costCny, 0.001302);
});
