// Beijing peak/off-peak selection follows the referenced DSH whale widget and DeepSeek pricing.
// Calendar source and verification dates are recorded in docs/pet-preview.md.
export const PRICING_CALENDAR_YEAR = 2026;
const HOLIDAYS = new Set([
  "2026-01-01",
  "2026-01-02",
  "2026-01-03",
  "2026-02-15",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-21",
  "2026-02-22",
  "2026-02-23",
  "2026-04-04",
  "2026-04-05",
  "2026-04-06",
  "2026-05-01",
  "2026-05-02",
  "2026-05-03",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-06-20",
  "2026-06-21",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
]);
const WEEKEND_VALLEY_FROM = Date.parse("2026-08-23T00:00:00+08:00");
const HOLIDAY_VALLEY_FROM = Date.parse("2026-09-19T00:00:00+08:00");

export function pricingPeriod(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  const beijing = new Date(timestamp + 8 * 3600000);
  if (!Number.isFinite(beijing.getTime())) {
    return null;
  }
  const hour = beijing.getUTCHours();
  if (!((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))) {
    return "offPeak";
  }
  if (timestamp >= WEEKEND_VALLEY_FROM && [0, 6].includes(beijing.getUTCDay())) {
    return "offPeak";
  }
  if (timestamp >= HOLIDAY_VALLEY_FROM) {
    // A future year's unverified holiday calendar must not silently turn holidays into peak charges.
    if (beijing.getUTCFullYear() !== PRICING_CALENDAR_YEAR) {
      return null;
    }
    if (HOLIDAYS.has(beijing.toISOString().slice(0, 10))) {
      return "offPeak";
    }
  }
  return "peak";
}

export function selectUsagePrice(usage, timestamp, basis = "usage-received") {
  if (!usage) {
    return usage;
  }
  const period = pricingPeriod(timestamp);
  const value = period ? usage[`${period}Cny`] : null;
  return {
    ...usage,
    costCny: Number.isFinite(value) && value >= 0 ? value : null,
    pricingPeriod: period,
    pricedAt: Number.isFinite(timestamp) ? timestamp : null,
    pricingTimeBasis: basis,
  };
}
