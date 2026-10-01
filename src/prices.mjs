// Pure report preparation. Does NOT authenticate source data or sign an on-chain oracle report.
export const BUCKET_SECONDS = 1800;
export const BUCKET_COUNT = 336;
const SCALE = 10n ** 18n;

export function buildPriceReport({
  dex,
  cex,
  windowEnd,
  now,
  conversionBps,
  maxDivergenceBps = 1000,
}) {
  if (
    !Number.isSafeInteger(windowEnd) ||
    windowEnd % BUCKET_SECONDS !== 0 ||
    !Number.isSafeInteger(now) ||
    windowEnd > now ||
    now - windowEnd >= BUCKET_SECONDS
  ) {
    throw new Error("가격 관측 구간이 오래됐거나 정렬되지 않았습니다.");
  }
  if (
    !Number.isInteger(conversionBps) ||
    conversionBps <= 0 ||
    conversionBps > 10000
  ) {
    throw new Error("검증된 BMB→WBMB 전환 조정계수가 필요합니다.");
  }
  if (
    !Number.isInteger(maxDivergenceBps) ||
    maxDivergenceBps < 0 ||
    maxDivergenceBps > 10000
  )
    throw new Error("잘못된 괴리 한도");
  const start = windowEnd - BUCKET_COUNT * BUCKET_SECONDS;
  function validate(rows) {
    if (!Array.isArray(rows) || rows.length !== BUCKET_COUNT)
      throw new Error("7일 전체 336개 구간이 필요합니다.");
    return rows.map((row, i) => {
      if (
        row.start !== start + i * BUCKET_SECONDS ||
        row.end !== row.start + BUCKET_SECONDS ||
        row.valid !== true
      ) {
        throw new Error("누락·중복·역순 또는 무효 가격 구간입니다.");
      }
      if (
        typeof row.price !== "bigint" ||
        row.price <= 0n ||
        row.price > 10n ** 30n
      )
        throw new Error("잘못된 가격 단위");
      return row.price;
    });
  }
  const d = validate(dex),
    cRaw = validate(cex),
    c = cRaw.map((p) => (p * BigInt(conversionBps)) / 10000n);
  for (let i = 0; i < d.length; i++) {
    if (c[i] === 0n) throw new Error("조정 가격 0");
    const lo = d[i] < c[i] ? d[i] : c[i],
      hi = d[i] > c[i] ? d[i] : c[i];
    if ((hi - lo) * 10000n > lo * BigInt(maxDivergenceBps))
      throw new Error("소스 간 가격 괴리가 한도를 초과했습니다.");
  }
  const min = (rows) => rows.reduce((a, b) => (a < b ? a : b));
  const current = d.at(-1) < c.at(-1) ? d.at(-1) : c.at(-1);
  const weekLow = min([...d, ...c]);
  return {
    policy: "synthetic-7d-30m-min-v1",
    windowStart: start,
    windowEnd,
    bucketCount: BUCKET_COUNT,
    weekLow,
    current,
    scale: SCALE,
    // Per-source values for signed reports; cex stays raw (before conversionBps).
    dexLow: min(d),
    dexCurrent: d.at(-1),
    cexLow: min(cRaw),
    cexCurrent: cRaw.at(-1),
  };
}

export function demoPriceReport(now) {
  const windowEnd = Math.floor(now / BUCKET_SECONDS) * BUCKET_SECONDS;
  const start = windowEnd - BUCKET_COUNT * BUCKET_SECONDS;
  const make = (offset) =>
    Array.from({ length: BUCKET_COUNT }, (_, i) => ({
      start: start + i * BUCKET_SECONDS,
      end: start + (i + 1) * BUCKET_SECONDS,
      price: BigInt(100 + (i % 5) + offset) * SCALE,
      valid: true,
    }));
  return buildPriceReport({
    dex: make(0),
    cex: make(1),
    windowEnd,
    now,
    conversionBps: 10000,
  });
}
