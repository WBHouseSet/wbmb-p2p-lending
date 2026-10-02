// Decides what the council price relay should publish. Pure: no network, no clock.
import { parseUnits } from "ethers";

export const COUNCIL_API_URL = "https://movnvote.com/api/public/price/latest";
// Margin between the local decision and the block that carries it.
const VALIDITY_MARGIN = 600;

/// `json` is the API answer: { price: 112.3, date, confirmedAt: ISO string }.
export function parseCouncilPrice(json) {
  const fail = () => new Error("카운슬 가격 응답을 해석할 수 없습니다.");
  const text = typeof json?.price === "number" ? String(json.price) : "";
  // Plain decimals only: exponent forms and strings are refused rather than guessed.
  if (!/^\d{1,12}(\.\d{1,18})?$/.test(text)) throw fail();
  const price = parseUnits(text, 18);
  const ms =
    typeof json.confirmedAt === "string" ? Date.parse(json.confirmedAt) : NaN;
  if (price <= 0n || !Number.isFinite(ms) || ms <= 0) throw fail();
  return { price, confirmedAt: Math.floor(ms / 1000) };
}

/// A council price beyond the contract's per-report limit is approached one maximum step per
/// `minInterval` (user decision 2026-10-02: automatic, no person in the loop). A stepped report
/// carries the chain's `confirmedAt`, because its price is not one the council confirmed.
/// `step` is the operator mode behind `--step`: it only lifts the refusal of an API
/// confirmation time older than the chain's.
export function planRelay({ api, chain, now, policyId, step = false }) {
  const submit = (price, confirmedAt, reason, extra = {}) => ({
    action: "submit",
    reason,
    ...extra,
    report: {
      policyId,
      roundId: chain.lastRoundId + 1,
      price,
      confirmedAt,
      validUntil: now + chain.maxAge - VALIDITY_MARGIN,
    },
  });
  if (api.confirmedAt > now)
    throw new Error("카운슬 확정 시각이 미래입니다. 보내지 않았습니다.");
  if (chain.lastRoundId === 0)
    return submit(api.price, api.confirmedAt, "첫 가격 등록");
  const changed = api.price !== chain.current;
  const expiring = chain.validUntil - now < Math.floor(chain.maxAge / 3);
  if (changed) {
    const older = api.confirmedAt < chain.confirmedAt;
    if (older && !step)
      throw new Error(
        "카운슬 확정 시각이 체인에 올라간 값보다 과거입니다. 보내지 않았습니다. 사람이 값을 확인한 뒤 --step 으로 보낼 수 있습니다.",
      );
    const up = api.price > chain.current;
    const diff = up ? api.price - chain.current : chain.current - api.price;
    const beyond = diff * 10000n > chain.current * BigInt(chain.maxChangeBps);
    // Floored, so the step itself always satisfies the contract's `diff * BPS <= current * maxChangeBps`.
    const most = (chain.current * BigInt(chain.maxChangeBps)) / 10000n;
    const plan = beyond
      ? submit(
          up ? chain.current + most : chain.current - most,
          chain.confirmedAt,
          `한도 ${chain.maxChangeBps / 100}%만큼 단계 이동`,
          { step: true },
        )
      : older
        ? submit(
            api.price,
            chain.confirmedAt,
            "가격 변경 (확정 시각은 체인 값 유지)",
          )
        : submit(api.price, api.confirmedAt, "가격 변경");
    if (now >= chain.changedAt + chain.minInterval) return plan;
    if (!expiring)
      return {
        action: "wait",
        reason: "가격이 바뀌었지만 최소 간격이 지나지 않았습니다.",
      };
  }
  if (expiring)
    return submit(chain.current, chain.confirmedAt, "유효기한 연장");
  return { action: "none", reason: "변경 없음" };
}
