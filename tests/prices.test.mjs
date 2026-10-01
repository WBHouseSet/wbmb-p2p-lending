import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPriceReport,
  demoPriceReport,
  BUCKET_COUNT,
} from "../src/prices.mjs";

function fixture() {
  const windowEnd = 1800 * 10000;
  const rows = () =>
    Array.from({ length: 336 }, (_, i) => ({
      start: windowEnd - 604800 + i * 1800,
      end: windowEnd - 604800 + (i + 1) * 1800,
      price: 100n * 10n ** 18n,
      valid: true,
    }));
  return {
    dex: rows(),
    cex: rows(),
    windowEnd,
    now: windowEnd + 100,
    conversionBps: 10000,
  };
}
test("336 complete buckets determine rolling low, not mean", () => {
  const f = fixture();
  f.dex[100].price = 95n * 10n ** 18n;
  const r = buildPriceReport(f);
  assert.equal(r.bucketCount, BUCKET_COUNT);
  assert.equal(r.weekLow, 95n * 10n ** 18n);
  assert.equal(r.current, 100n * 10n ** 18n);
});
test("rejects missing, duplicated, unordered and invalid buckets", () => {
  for (const mutate of [
    (f) => f.dex.pop(),
    (f) => (f.cex[1] = f.cex[0]),
    (f) => f.dex.reverse(),
    (f) => (f.cex[3].valid = false),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => buildPriceReport(f));
  }
});
test("rejects stale, future and unaligned windows", () => {
  for (const mutate of [
    (f) => (f.now += 1800),
    (f) => (f.now = f.windowEnd - 1),
    (f) => f.windowEnd++,
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => buildPriceReport(f));
  }
});
test("refuses to silently fall back when one source is missing or diverges", () => {
  const f = fixture();
  f.cex[20].price = 50n * 10n ** 18n;
  assert.throws(() => buildPriceReport(f), /괴리/);
  f.cex = [];
  assert.throws(() => buildPriceReport(f), /336/);
});
test("requires conversion policy and exact positive bigint values", () => {
  for (const mutate of [
    (f) => (f.conversionBps = undefined),
    (f) => (f.dex[0].price = 0n),
    (f) => (f.dex[0].price = 100),
    (f) => (f.dex[0].price = -1n),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => buildPriceReport(f));
  }
});
test("demo report is clearly synthetic with correct scale", () => {
  const r = demoPriceReport(18001000);
  assert.match(r.policy, /synthetic/);
  assert.equal(r.weekLow, 100n * 10n ** 18n);
});
