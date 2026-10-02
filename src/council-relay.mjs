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

export function planRelay({ api, chain, now, policyId }) {
  const submit = (price, confirmedAt, reason) => ({
    action: "submit",
    reason,
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
    if (api.confirmedAt < chain.confirmedAt)
      throw new Error(
        "카운슬 확정 시각이 체인에 올라간 값보다 과거입니다. 보내지 않았습니다.",
      );
    const diff =
      api.price > chain.current
        ? api.price - chain.current
        : chain.current - api.price;
    if (diff * 10000n > chain.current * BigInt(chain.maxChangeBps))
      throw new Error(
        "가격 변동이 컨트랙트 한도를 넘습니다. 사람이 확인해야 합니다. 보내지 않았습니다.",
      );
    if (now >= chain.changedAt + chain.minInterval)
      return submit(api.price, api.confirmedAt, "가격 변경");
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
