import {
  BrowserProvider,
  JsonRpcProvider,
  Contract,
  parseUnits,
  formatUnits,
  MaxUint256,
} from "ethers";
import "./style.css";
import { demoPriceReport } from "./prices.mjs";
import {
  toReport,
  hashSyntheticData,
  submitReport,
} from "./report-signing.mjs";
import { COUNCIL_POLICY_ID, submitCouncilReport } from "./council-signing.mjs";

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const fmt = (n, d = 18, digits = 4) =>
  Number(formatUnits(n ?? 0n, d)).toLocaleString("ko-KR", {
    maximumFractionDigits: digits,
  });
const modeText = (mode) =>
  Number(mode) === 0
    ? "가격 하락 / 만기 미상환 · 초과담보 반환"
    : "만기 미상환 · 남은 담보 전부 귀속";
const percent = (n) =>
  (Number(n) / 100).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const date = (n) =>
  new Date(Number(n) * 1000).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const localHost = (h) => ["localhost", "127.0.0.1", "[::1]"].includes(h);
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
// Live deployments this build may talk to. Anything else is refused.
const LIVE_CHAINS = {
  56: {
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    blockExplorerUrls: ["https://bscscan.com"],
  },
};
// Who runs the page and where its source is, shown on a live page so a visitor can check both.
const OPERATOR = "WBHouseSet";
const REPO_URL = "https://github.com/WBHouseSet/wbmb-p2p-lending";
// Oracle-free market: maker-fixed collateral, maturity-only settlement, no price feed.
const fixed = () => config?.oracleFree === true;
// Council-price market: collateral and liquidation follow the relayed Mobick council price.
const council = () => config?.policy === "council";
// Markets whose fees go to a plain fee wallet (no burner contract).
const vault = () => fixed() || council();
// Markets deployed before the settlement fee existed carry no flag; the page must not promise a fee they do not charge.
const settleFee = () => council() && config?.settlementFee === true;
// The one set of terms the council page posts and lists. The contract accepts other margins
// (any haircut from 1% to 90% with a liquidation line above 1 - haircut), so offers with other
// terms can exist; the page keeps them off the market tabs and does not fill them.
const COUNCIL_TERMS = {
  haircutBps: 5000,
  liquidationBps: 7000,
  mode: 0,
  grace: 86400,
};
const standardCouncilOffer = (o) =>
  Object.entries(COUNCIL_TERMS).every(
    ([key, value]) => Number(o.terms[key]) === value,
  );
// The same terms as the page words them.
const councilLtv = () => percent(10000 - COUNCIL_TERMS.haircutBps);
const councilLine = () => percent(COUNCIL_TERMS.liquidationBps);
const councilGrace = () => durationText(COUNCIL_TERMS.grace);
let bonusPct = "0";
// False until the price contract has accepted its first report.
let priceSet = true;
let priceLive = true;
let currentPrice = 0n;
// The price the contract sizes collateral with (the week's opening price while the price is live).
let openingPrice = 0n;
let staleDelay = "";
// The market's shortest grace, read from the chain (council market only).
let minGraceText = "";
// Addresses and the RPC endpoint compiled into a live build. A live page only talks to exactly these.
const PINNED = typeof __PINNED__ === "undefined" ? null : __PINNED__;
// WalletConnect project id, compiled into a live build that offers QR connection ("" otherwise).
const WC_PROJECT_ID =
  typeof __WC_PROJECT_ID__ === "undefined" ? "" : __WC_PROJECT_ID__;
let feePct = "5";
// Exact amount with no rounding, for what the user is about to sign.
const full = (n, d = 18) => formatUnits(n, d).replace(/\.0$/, "");
const durationText = (seconds) => {
  const s = Number(seconds);
  if (s % 86400 === 0) return `${s / 86400}일`;
  return s < 3600
    ? `${Math.round(s / 60)}분`
    : `${Math.round(s / 360) / 10}시간`;
};
// Price at which an active council loan becomes settleable: debt >= collateral * price * liquidationBps.
const liquidationPrice = (l) =>
  (l.debt * 10000n * 100000000n) /
  (l.collateral * BigInt(l.terms.liquidationBps));
// The contract's own test for filling a borrow request (quoteFill): the loan must fit under the
// lending limit at the opening price and, with interest to maturity, under the liquidation line now.
const collateralCovers = (amount, collateral, terms) => {
  const value = (price) => (collateral * price) / 100000000n;
  if (
    amount >
    (value(openingPrice) * (10000n - BigInt(terms.haircutBps))) / 10000n
  )
    return false;
  const year = 10000n * 31536000n;
  const atMaturity =
    amount +
    (amount * BigInt(terms.aprBps) * BigInt(terms.duration) + year - 1n) / year;
  return (
    atMaturity < (value(currentPrice) * BigInt(terms.liquidationBps)) / 10000n
  );
};
// The least WBMB (base units) a borrow request for `amount` MOVN must pledge to be fillable at today's price.
const minCollateral = (amount, terms) => {
  const year = 10000n * 31536000n;
  const atMaturity =
    amount +
    (amount * BigInt(terms.aprBps) * BigInt(terms.duration) + year - 1n) / year;
  const forLimit =
    (amount * 100000000n * 10000n) /
    (openingPrice * (10000n - BigInt(terms.haircutBps)));
  const forLine =
    (atMaturity * 100000000n * 10000n) /
    (currentPrice * BigInt(terms.liquidationBps));
  let c = forLimit > forLine ? forLimit : forLine;
  // The divisions above round down; the contract's rounding costs a unit or two more.
  for (let i = 0; i < 8 && !collateralCovers(amount, c, terms); i++) c += 1n;
  return c;
};
// A borrower types what they pledge, never the loan: the page works the loan out of the
// collateral and the council price. Loans are whole millionths of a MOVN, which also clears
// the contract's per-fill rounding when a request is filled in parts.
const LOAN_STEP = 10n ** 12n;
// The most MOVN that `collateral` (WBMB base units) carries at today's price under `terms`, by
// the contract's own fill test (collateralCovers). 0 when there is no price or too little WBMB.
const maxLoan = (collateral, terms) => {
  if (!priceLive || openingPrice <= 0n || currentPrice <= 0n) return 0n;
  const value = (price) => (collateral * price) / 100000000n;
  const byLimit =
    (value(openingPrice) * (10000n - BigInt(terms.haircutBps))) / 10000n;
  const year = 10000n * 31536000n;
  const line = (value(currentPrice) * BigInt(terms.liquidationBps)) / 10000n;
  const byLine =
    (line * year) / (year + BigInt(terms.aprBps) * BigInt(terms.duration));
  let loan = byLimit < byLine ? byLimit : byLine;
  loan -= loan % LOAN_STEP;
  for (
    let i = 0;
    i < 4 && loan > 0n && !collateralCovers(loan, collateral, terms);
    i++
  )
    loan -= LOAN_STEP;
  return loan > 0n && collateralCovers(loan, collateral, terms) ? loan : 0n;
};
// The council market's lend offers are taken by collateral (everything else types MOVN).
const byCollateral = (o) => council() && Number(o.side) === 1;
// What pledging `collateral` gets a borrower from lend offer `o`: the loan, capped by what is
// left, and the least collateral that reaches the offer's smallest fill.
const loanFor = (o, collateral) => {
  const minimum = o.remaining < o.minFill ? o.remaining : o.minFill;
  const least = minCollateral(minimum, o.terms);
  let loan = maxLoan(collateral, o.terms);
  if (loan >= o.remaining) loan = o.remaining;
  // A smallest fill that is not a whole millionth is still reachable with its own collateral.
  else if (loan < minimum && collateral >= least) loan = minimum;
  return { loan, minimum, least, enough: loan >= minimum && loan > 0n };
};
// The line under a collateral field on a lend offer: what the typed WBMB borrows, or why not.
const fillPreview = (o, text) => {
  if (!priceSet) return "첫 카운슬 가격이 등록되면 빌릴 금액이 계산됩니다.";
  if (!priceLive)
    return "카운슬 가격이 만료되어 빌릴 금액을 계산할 수 없습니다.";
  let collateral;
  try {
    collateral = amount(text, 8);
  } catch {
    return "맡길 WBMB를 숫자로 입력하면 빌릴 금액이 계산됩니다.";
  }
  const { loan, minimum, least, enough } = loanFor(o, collateral);
  if (!enough)
    return `담보가 적습니다 · 최소 참여 ${full(minimum)} MOVN에는 ${full(least, 8)} WBMB 이상이 필요합니다.`;
  return loan === o.remaining && maxLoan(collateral, o.terms) > loan
    ? `남은 금액 전부인 ${full(loan)} MOVN을 빌립니다 (담보는 필요한 만큼만 쓰입니다).`
    : `${full(collateral, 8)} WBMB를 맡기면 ${full(loan)} MOVN을 빌립니다 (담보 가치의 ${councilLtv()}%).`;
};
// A price shown to two decimals, rounded up: a liquidation price must never read lower than it is.
const priceUp = (n) =>
  (Number((n + 10n ** 16n - 1n) / 10n ** 16n) / 100).toLocaleString("ko-KR", {
    maximumFractionDigits: 2,
  });
// How far the council price can still fall before liquidation, in percent (null without a live price).
const marginPct = (l) =>
  priceLive
    ? (Number(currentPrice - liquidationPrice(l)) / Number(currentPrice)) * 100
    : null;
// The loan card's liquidation block: the price, how close the council price is to it, and what is left.
const liquidationBlock = (l) => {
  const liq = liquidationPrice(l);
  const pct = marginPct(l);
  const level =
    pct === null
      ? "off"
      : pct <= 0
        ? "hit"
        : pct < 10
          ? "near"
          : pct < 20
            ? "watch"
            : "safe";
  const margin =
    pct === null
      ? priceSet
        ? "가격 만료"
        : "가격 미등록"
      : pct <= 0
        ? "청산 대상"
        : `${pct.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}% 더 내리면 청산`;
  const fill = pct === null ? 0 : Math.max(0, Math.min(100, 100 - pct));
  return `<div class="liq ${level}"><div class="liq-head"><span>청산 가격</span><strong data-liq-price>${priceUp(liq)} MOVN</strong></div><div class="liq-bar" aria-hidden="true"><i style="width:${fill.toFixed(1)}%"></i></div><div class="liq-foot">${pct === null ? "" : `지금 ${fmt(currentPrice, 18, 2)} MOVN · `}<b data-liq-margin>${margin}</b></div></div>`;
};
// The council market's terms, the same few lines wherever the page states them.
const councilTermsHtml = () => {
  const drop =
    (1 - (10000 - COUNCIL_TERMS.haircutBps) / COUNCIL_TERMS.liquidationBps) *
    100;
  const rows = [
    ["빌릴 수 있는 금액", `담보 가치의 ${councilLtv()}%까지`],
    [
      "청산",
      `빚이 담보 가치의 ${councilLine()}%에 닿으면 (한도까지 빌렸다면 가격이 약 ${drop.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}% 내릴 때)`,
    ],
    ["갚는 기한", `만기 + 유예 ${councilGrace()}. 넘기면 정산`],
    [
      "정산되면",
      `대출자는 빚 + ${bonusPct}%어치의 WBMB, 남은 담보는 빌린 사람에게`,
    ],
    [
      "수수료",
      `이자의 ${feePct}% (빌린 사람이 이자에 더해 냄)${settleFee() ? `. 정산될 때는 못 낸 이자의 ${feePct}%를 남은 담보에서 WBMB로 뗌` : ""}`,
    ],
  ];
  return `<dl class="terms">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl><p class="terms-foot">가격은 모빅 카운슬 가격을 따릅니다. ${staleNote()}</p>`;
};
// The one disclosure of the stale-price escape; every council text that promises the borrower the rest uses it.
const staleNote = () =>
  `가격 갱신이 끊긴 채로 유예 종료와 가격 만료 뒤 각각 ${staleDelay}이 지나면 마지막 가격으로 정산됩니다.`;
// The other two markets' terms, in a sentence.
const plainTerms = () =>
  fixed()
    ? `만기 유예 1일. 단리 APR이며 실제 경과기간만 이자를 냅니다. 지급 이자의 ${feePct}%가 별도 수수료입니다. 가격이 내려가도 청산되지 않고, 만기·유예 후 미상환이면 추가 담보를 포함한 남은 WBMB 전부가 대출자에게 넘어갑니다.`
    : "체험 조건: 헤어컷 10% · 청산 기준 95% · 만기 유예 1일. 단리 APR이며 실제 경과기간만 이자를 냅니다. 지급 이자의 5%가 별도 소각 수수료입니다.";
// States the market's terms in full in `el`: in the guide under the list and in the offer form.
const showTerms = (el) => {
  if (council()) el.innerHTML = councilTermsHtml();
  else el.textContent = plainTerms();
};
// The few terms a visitor needs to read an offer, as one line above the list. The full
// statement is in the guide below, and the line leads there.
const termsBriefHtml = () => {
  const points = council()
    ? [
        `담보 가치의 ${councilLtv()}%까지`,
        `청산선 ${councilLine()}%`,
        `유예 ${councilGrace()}`,
        `수수료 이자의 ${feePct}%`,
      ]
    : fixed()
      ? [
          "가격 청산 없음",
          "미상환이면 담보 전부 대출자에게",
          "유예 1일",
          `수수료 이자의 ${feePct}%`,
        ]
      : ["헤어컷 10%", "청산 기준 95%", "유예 1일", "소각 수수료 이자의 5%"];
  return `${points.map((p) => `<span>${p}</span>`).join("")}<a href="#guide-terms">조건 자세히</a>`;
};
// What the post button posts from the open tab: a request to borrow from the borrowing tab,
// an offer to lend from the lending tab.
const postSide = () => ({ borrow: "0", lend: "1" })[tab];
const postLabel = () =>
  tab === "swap"
    ? "사고팔기 글 올리기"
    : ({ 0: "빌리기 요청 올리기", 1: "빌려주기 제안 올리기" }[postSide()] ??
      "제안 올리기");
const spenderLine = () =>
  `승인 대상 컨트랙트: ${contracts.lending.target} (토큰 사용 승인은 이 주소에만 합니다)`;
const feeWord = () => (vault() ? "수수료" : "소각 수수료");
const ratioText = (o) =>
  o.collateralTotal > 0n
    ? `1 WBMB당 ${fmt((o.total * 100000000n) / o.collateralTotal)} MOVN`
    : "—";
// The WBMB/MOVN trade board, when this deployment has one.
const swapOn = () => Boolean(contracts?.swap);
let swapOffers = [],
  mySwapOffers = [],
  swapFeeBps = 0n,
  swapFeeVault = "";
const swapFeePct = () => percent(swapFeeBps);
// The price a trade is compared with: the live council price, or none.
const swapReference = () =>
  council() && priceSet && priceLive && currentPrice > 0n ? currentPrice : null;
// How far `price` is from the council price, in percent to one decimal (null without a reference).
const swapGap = (price) => {
  const reference = swapReference();
  return reference === null
    ? null
    : Number(((price - reference) * 1000n) / reference) / 10;
};
const gapNumber = (gap) =>
  Math.abs(gap).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
// From this far against the user (selling cheap, buying dear) the page asks once more. The
// contract itself accepts any price.
const SWAP_WARN_PCT = 20;
const swapWarning = (selling, price) => {
  const gap = swapGap(price);
  if (gap === null || (selling ? gap > -SWAP_WARN_PCT : gap < SWAP_WARN_PCT))
    return null;
  return `카운슬 가격(${fmt(swapReference())} MOVN)보다 ${gapNumber(gap)}% ${selling ? "싸게 팔게" : "비싸게 사게"} 됩니다.\nWBMB 1개 = ${full(price)} MOVN 이 맞는지 숫자와 자릿수를 다시 확인하세요.`;
};
// MOVN for `value` WBMB at `price`, rounded the way the contract rounds it.
const swapCost = (value, price, up) =>
  (value * price + (up ? 99999999n : 0n)) / 100000000n;
const swapSpender = () =>
  `승인 대상 컨트랙트: ${contracts.swap.target} (토큰 사용 승인은 이 주소에만 합니다)`;
const swapFeeLine = () =>
  `수수료는 수수료 지갑 ${swapFeeVault} 으로 갑니다. 소각되지 않습니다.`;
let config,
  abis,
  read,
  contracts,
  signer,
  address,
  wallet,
  revision = 0,
  tab = "borrow",
  busy = false,
  loading = false,
  limit = 25;
const MY_LIMIT = 200;
let dropTyped = false;
let myOffers = [],
  myLoans = [];
let offers = [],
  loans = [],
  latest = 0,
  more = false;
const wallets = [];
// What survives a reload: how the wallet was connected (this browser) and the open tab (this
// browser tab). Storage can be blocked; the page then simply starts fresh.
const WALLET_KEY = "wbmb.wallet",
  TAB_KEY = "wbmb.tab";
const remember = (store, key, value) => {
  try {
    if (value === null) window[store].removeItem(key);
    else window[store].setItem(key, value);
  } catch {
    // nothing is remembered
  }
};
const recall = (store, key) => {
  try {
    return window[store].getItem(key);
  } catch {
    return null;
  }
};

function announce(event) {
  const detail = event.detail;
  if (
    !detail?.provider?.request ||
    wallets.some((w) => w.provider === detail.provider)
  )
    return;
  wallets.push(detail);
  renderWallets();
}
window.addEventListener("eip6963:announceProvider", announce);
window.dispatchEvent(new Event("eip6963:requestProvider"));
function renderWallets() {
  $("#wallet-provider").innerHTML = wallets
    .map(
      (w, i) =>
        `<option value="${i}">${esc(w.info?.name || "브라우저 지갑")}</option>`,
    )
    .join("");
  $("#wallet-provider").hidden = wallets.length < 2;
}
const readyText = () =>
  config.demo
    ? "로컬 체인 준비 완료 · 체험 지갑을 선택하면 바로 거래할 수 있습니다."
    : "BNB Smart Chain 연결 완료 · 지갑을 연결하면 거래할 수 있습니다.";
let toastTimer;
function status(message, type = "") {
  $("#status").textContent = message;
  $("#status").className = type;
  // The status line sits near the top of a long page. While a transaction locks the controls,
  // its progress and result are repeated at the bottom of the screen, wherever the user is.
  if (!busy) return;
  $("#toast").textContent = message;
  $("#toast").className = `toast ${type}`;
  $("#toast").hidden = false;
}
// Until a wallet answers, nothing has been sent; a prompt that never shows (a phone wallet in
// the background, a lost QR session) would otherwise look like a frozen page.
const WALLET_WAIT =
  "지갑 승인을 기다리는 중입니다. 지갑 앱을 열어 요청을 승인하거나 거절하세요. 요청이 보이지 않으면 이 화면을 새로고침한 뒤 다시 시도하세요. 승인하기 전에는 아무것도 전송되지 않습니다.";
function errorMessage(e) {
  const raw = String(e.shortMessage || e.message || e);
  const messages = {
    STALE_PRICE: config?.demo
      ? "모의 가격이 만료됐습니다. 실험실에서 가격을 갱신하세요. 상환·담보 추가·수령은 계속 가능합니다."
      : "가격이 만료되어 지금은 체결·가격 정산을 할 수 없습니다. 상환·담보 추가·수령은 계속 가능합니다.",
    BAD_GRACE: minGraceText
      ? `이 시장은 유예 ${minGraceText} 이상인 조건만 게시할 수 있습니다.`
      : "이 시장이 정한 최소 유예보다 짧은 조건은 게시할 수 없습니다.",
    INSUFFICIENT_COLLATERAL:
      "현재 가격에서 담보가 부족합니다. 더 낮은 금액 또는 충분한 담보의 거래를 선택하세요.",
    NO_INTEREST_BUFFER: "만기 예상 이자까지 포함하면 담보 여유가 부족합니다.",
    COLLATERAL_SLIPPAGE:
      "가격이 바뀌어 필요한 담보가 확인한 상한을 넘었습니다. 다시 확인하세요.",
    NOT_OVERDUE: "아직 만기와 유예기간이 지나지 않았습니다.",
    HEALTHY: "현재 대출은 가격 청산 조건에 해당하지 않습니다.",
    OFFER_CLOSED: "이미 체결·취소됐거나 만료된 거래입니다.",
    BAD_FILL: "체결 금액은 최소 참여액 이상, 남은 금액 이하여야 합니다.",
    SELF_FILL: "자신이 게시한 거래는 직접 체결할 수 없습니다.",
    PRICE_MISMATCH:
      "게시글의 가격이 확인한 가격과 다릅니다. 새로고침한 뒤 다시 확인하세요.",
    ZERO_PAYMENT:
      "수량이 너무 작아 대금이 0이 됩니다. 더 큰 수량으로 체결하세요.",
    NO_FEES: "옮길 수수료가 없습니다.",
    REPAY_SLIPPAGE: "상환 견적이 바뀌었습니다. 금액을 다시 확인하세요.",
    NOT_ACTIVE: "이미 종료된 대출입니다.",
    BAD_OUTPUT: "모의 소각 수량이 너무 작거나 견적이 달라졌습니다.",
    BAD_MARGIN: "헤어컷과 청산 기준 사이에 여유가 필요합니다.",
    BAD_COLLATERAL:
      "이 금액으로는 배정될 담보가 없거나 담보 수량이 올바르지 않습니다. 더 큰 금액 또는 남은 전액으로 참여하세요.",
    ORACLE_FREE_TERMS:
      "이 시장은 만기형 조건(유예 1일 이상)만 게시할 수 있습니다.",
    INSUFFICIENT_FUNDS: "지갑의 가스비 또는 토큰 잔액이 부족합니다.",
  };
  for (const [key, value] of Object.entries(messages))
    if (raw.includes(key)) return value;
  if (
    e.code === 4001 ||
    e.code === "ACTION_REJECTED" ||
    raw.includes("user rejected")
  )
    return "지갑에서 요청을 취소했습니다. 완료되지 않은 거래는 반영되지 않습니다.";
  return raw.length > 250 ? raw.slice(0, 250) + "…" : raw;
}
function amount(text, decimals = 18) {
  if (!/^\d+(\.\d+)?$/.test(String(text).trim()))
    throw new Error("금액은 0 이상의 일반 숫자로 입력하세요.");
  return parseUnits(String(text).trim(), decimals);
}
function lock(yes) {
  busy = yes;
  clearTimeout(toastTimer);
  if (!yes) toastTimer = setTimeout(() => ($("#toast").hidden = true), 8000);
  document.querySelectorAll("button,input,select").forEach((el) => {
    if (el.closest("#confirm-dialog")) return;
    if (yes) {
      if (el.dataset.disabledBefore === undefined)
        el.dataset.disabledBefore = String(el.disabled);
      el.disabled = true;
    } else if (el.dataset.disabledBefore !== undefined) {
      el.disabled = el.dataset.disabledBefore === "true";
      delete el.dataset.disabledBefore;
    }
  });
}
function confirm(title, message) {
  $("#confirm-title").textContent = title;
  $("#confirm-body").textContent = message;
  const dialog = $("#confirm-dialog");
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.close();
      $("#confirm-submit").onclick = null;
      $("#confirm-cancel").onclick = null;
      dialog.oncancel = null;
      resolve(value);
    };
    $("#confirm-submit").onclick = () => finish(true);
    $("#confirm-cancel").onclick = () => finish(false);
    dialog.oncancel = (e) => {
      e.preventDefault();
      finish(false);
    };
  });
}
// Phone wallets announce their account and network right after a QR connection is approved,
// and some repeat it later. Only a real change ends the session: another account, or another network.
function onAccountsChanged(accounts) {
  const next = String(accounts?.[0] ?? "")
    .split(":")
    .pop();
  // Before the page has read the account there is nothing to invalidate; it reads the current one itself.
  if (!address || next.toLowerCase() === address.toLowerCase()) return;
  invalidateWallet();
}
function onChainChanged(id) {
  try {
    if (BigInt(id) === BigInt(config.chainId)) return;
  } catch {
    // not a number: treat as a change
  }
  invalidateWallet();
}
function invalidateWallet() {
  remember("localStorage", WALLET_KEY, null);
  dropWallet();
  revision++;
  signer = null;
  address = null;
  $("#demo-account").value = "";
  $("#wallet-panel").hidden = true;
  $("#connect").textContent = "지갑 연결";
  status("지갑 계정 또는 네트워크가 변경됐습니다. 다시 연결해 주세요.");
  render();
}
async function validateChain(provider = read) {
  const id = await provider.send("eth_chainId", []);
  if (BigInt(id) !== BigInt(config.chainId))
    throw new Error(
      config.demo
        ? "이 화면은 로컬 체인 31337에서만 거래합니다. 실제 BSC 자금은 사용할 수 없습니다."
        : `지갑 네트워크를 ${LIVE_CHAINS[config.chainId].chainName}(으)로 바꿔 주세요.`,
    );
}
async function useSigner(next, label) {
  await validateChain(next.provider);
  signer = next;
  address = await signer.getAddress();
  revision++;
  $("#account-label").textContent = label;
  $("#account-address").textContent = address;
  $("#wallet-panel").hidden = false;
  $("#connect").textContent = short(address);
  status(
    "지갑이 연결됐습니다. 거래 제안이나 부분 참여를 선택하세요.",
    "success",
  );
  await refresh();
}
async function connectWallet() {
  if (busy) return;
  let selected =
    wallets[Number($("#wallet-provider").value || 0)]?.provider ||
    window.ethereum;
  if (!selected)
    throw new Error(
      config.demo
        ? "설치된 지갑이 없습니다. ‘체험 지갑 선택’으로 로컬 모의 거래를 해보세요."
        : "설치된 지갑이 없습니다. MetaMask 같은 브라우저 지갑을 설치해 주세요.",
    );
  await selected.request({ method: "eth_requestAccounts" });
  const chainHex = "0x" + Number(config.chainId).toString(16);
  if (
    BigInt(await selected.request({ method: "eth_chainId" })) !==
    BigInt(config.chainId)
  ) {
    try {
      await selected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await selected.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainHex,
            rpcUrls: [config.rpcUrl],
            ...(config.demo
              ? {
                  chainName: "WBMB Local Demo",
                  nativeCurrency: {
                    name: "Test ETH",
                    symbol: "ETH",
                    decimals: 18,
                  },
                }
              : LIVE_CHAINS[config.chainId]),
          },
        ],
      });
      await selected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      });
    }
  }
  await attachWallet(selected, "연결된 지갑");
}
// Makes an EIP-1193 provider the page's wallet, whichever way it was connected.
async function attachWallet(selected, label) {
  dropWallet();
  wallet = selected;
  selected.on?.("accountsChanged", onAccountsChanged);
  selected.on?.("chainChanged", onChainChanged);
  selected.on?.("disconnect", invalidateWallet);
  const provider = new BrowserProvider(selected, "any");
  provider.pollingInterval = config.demo ? 100 : 3000;
  $("#demo-account").value = "";
  await useSigner(await provider.getSigner(), label);
  remember(
    "localStorage",
    WALLET_KEY,
    selected.isWalletConnect
      ? "qr"
      : `browser:${wallets.find((w) => w.provider === selected)?.info?.rdns ?? ""}`,
  );
}
// After a reload the last connection is picked up again without a prompt: a browser wallet is
// only asked which accounts this site may already see, a QR session is read back from storage.
async function restoreWallet() {
  const kind = recall("localStorage", WALLET_KEY);
  if (!kind || (kind === "qr" && !WC_PROJECT_ID)) return;
  try {
    if (kind === "qr") {
      const provider = await qrProvider();
      if (!provider.session || !provider.accounts?.length)
        throw new Error("no session");
      await attachWallet(provider, "연결된 지갑 (QR)");
      return;
    }
    const rdns = kind.slice("browser:".length);
    const index = wallets.findIndex((w) =>
      rdns ? w.info?.rdns === rdns : w.provider === window.ethereum,
    );
    const selected = wallets[index]?.provider || window.ethereum;
    const accounts = await selected?.request({ method: "eth_accounts" });
    if (!accounts?.length) throw new Error("no account");
    if (index >= 0) $("#wallet-provider").value = String(index);
    await attachWallet(selected, "연결된 지갑");
  } catch {
    // The wallet is locked, gone or on another network: start disconnected, as before.
    invalidateWallet();
    status(readyText(), "success");
  }
}
// Stops listening to the current wallet; a WalletConnect session is ended as well.
function dropWallet() {
  if (!wallet) return;
  wallet.removeListener?.("accountsChanged", onAccountsChanged);
  wallet.removeListener?.("chainChanged", onChainChanged);
  wallet.removeListener?.("disconnect", invalidateWallet);
  if (wallet.isWalletConnect) wallet.disconnect?.().catch(() => {});
  wallet = null;
}
// Rejects when the WalletConnect service does not answer, instead of waiting forever.
const within = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `QR 연결 서버가 응답하지 않습니다 (${what}). 잠시 뒤 다시 시도하세요.`,
            ),
          ),
        20000,
      ),
    ),
  ]);
// The WalletConnect provider for this market. It carries the session of an earlier visit, if any.
async function qrProvider() {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  return within(
    EthereumProvider.init({
      projectId: WC_PROJECT_ID,
      optionalChains: [Number(config.chainId)],
      rpcMap: { [Number(config.chainId)]: config.rpcUrl },
      showQrModal: false,
      metadata: {
        name: "WBMB Commons",
        description: "WBMB 담보 P2P 대출",
        url: location.origin,
        icons: [],
      },
    }),
    "준비",
  );
}
// QR connection for a phone wallet (WalletConnect). The page shows the pairing code itself;
// the wallet app scans it, and every transaction is then approved on the phone.
async function connectByQr() {
  if (busy) return;
  status("QR 연결을 준비하는 중입니다…");
  const [provider, QR] = await Promise.all([qrProvider(), import("qrcode")]);
  const dialog = $("#qr-dialog");
  const shown = new Promise((resolve) => provider.once("display_uri", resolve));
  provider.on("display_uri", async (uri) => {
    $("#qr-image").src = await QR.toDataURL(uri, { margin: 1, width: 280 });
    // On a phone the same pairing code opens the wallet app directly.
    $("#qr-open").href =
      "https://link.trustwallet.com/wc?uri=" + encodeURIComponent(uri);
    $("#qr-copy").onclick = () =>
      navigator.clipboard
        ?.writeText(uri)
        .then(() => ($("#qr-copy").textContent = "복사됨"));
    if (!dialog.open) dialog.showModal();
  });
  // Closing the dialog abandons the pairing.
  const closed = new Promise((_, reject) => {
    dialog.onclose = () => {
      if (!provider.session) reject(new Error("QR 연결을 취소했습니다."));
    };
  });
  try {
    // A session left over from an earlier visit is replaced, so the QR is always fresh.
    if (provider.session) await provider.disconnect();
    const connecting = provider.connect();
    connecting.catch(() => {}); // reported through the races below
    await within(Promise.race([shown, connecting]), "연결 코드");
    await Promise.race([connecting, closed]);
  } finally {
    dialog.onclose = null;
    if (dialog.open) dialog.close();
  }
  // A wallet may approve several networks and start on another one; the session is moved to ours.
  if (Number(provider.chainId) !== Number(config.chainId))
    await Promise.race([
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + Number(config.chainId).toString(16) }],
      }),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]).catch(() => {}); // validateChain reports it if the wallet did not follow
  await attachWallet(provider, "연결된 지갑 (QR)");
}
async function txAction(title, message, action) {
  if (busy) return;
  if (!signer || !address) {
    status("먼저 지갑을 연결하세요.", "error");
    return;
  }
  const version = revision,
    activeSigner = signer,
    activeAddress = address;
  const assertSession = async () => {
    if (revision !== version || address !== activeAddress)
      throw new Error("지갑이 변경됐습니다. 다시 확인해 주세요.");
    await validateChain(activeSigner.provider);
    const accounts = await activeSigner.provider.send("eth_accounts", []);
    if (!accounts.some((a) => a.toLowerCase() === activeAddress.toLowerCase()))
      throw new Error("지갑 연결이 해제됐습니다.");
  };
  lock(true);
  try {
    if (!(await confirm(title, message))) {
      status("거래를 취소했습니다.");
      return;
    }
    await assertSession();
    const send = async (promise, what = "") => {
      status(what ? `${what} · ${WALLET_WAIT}` : WALLET_WAIT);
      const transaction = await promise;
      status(`확정 대기 중 · ${short(transaction.hash)}`);
      const receipt = await transaction.wait();
      if (receipt.status !== 1) throw new Error("거래가 되돌려졌습니다.");
      return receipt;
    };
    const approve = async (
      token,
      value,
      spender = contracts.lending.target,
    ) => {
      await assertSession();
      // Without enough tokens the transfer would revert inside gas estimation and the wallet
      // would show a raw error; say what is missing before anything is sent.
      const held = await token.balanceOf(activeAddress);
      if (held < value) {
        const [unit, decimals] =
          token === contracts.wbmb ? ["WBMB", 8] : ["MOVN", 18];
        throw new Error(
          `지갑의 ${unit} 잔액이 부족합니다. 필요 ${full(value, decimals)} ${unit} · 보유 ${full(held, decimals)} ${unit}`,
        );
      }
      const contract = token.connect(activeSigner),
        current = await token.allowance(activeAddress, spender);
      if (current < value) {
        // Two prompts follow: this approval, then the transaction itself.
        const what = "토큰 사용 승인(다음에 본 거래를 확인합니다)";
        if (current > 0n) await send(contract.approve(spender, 0), what);
        await assertSession();
        await send(contract.approve(spender, value), what);
      }
      await assertSession();
    };
    await action({
      signer: activeSigner,
      lending: contracts.lending.connect(activeSigner),
      send,
      approve,
      assertSession,
    });
    dropTyped = true; // the confirmed amounts are spent; show fresh defaults
    await refresh();
    status(`${title} 완료 · 체인에 반영됐습니다.`, "success");
  } catch (e) {
    status(errorMessage(e), "error");
    await refresh().catch(() => {});
  } finally {
    lock(false);
  }
}

async function refresh() {
  if (!contracts || loading) return;
  loading = true;
  // Screen readers and the browser tests see when the list is being rebuilt.
  $("#cards").setAttribute("aria-busy", "true");
  try {
    const [oc, lc, block] = await Promise.all([
      contracts.lending.offerCount(),
      contracts.lending.loanCount(),
      read.getBlock("latest"),
    ]);
    latest = block.timestamp;
    $("#offer-count").textContent = oc.toString();
    $("#loan-count").textContent = lc.toString();
    if (council()) {
      const [current, validUntil, confirmedAt] = await Promise.all([
        contracts.oracle.current(),
        contracts.oracle.validUntil(),
        contracts.oracle.confirmedAt(),
      ]);
      // validUntil is 0 only until the first report: nothing has expired, there is no price yet.
      priceSet = validUntil !== 0n;
      priceLive = priceSet && latest <= Number(validUntil);
      const [opening] = priceLive ? await contracts.oracle.prices() : [current];
      currentPrice = current;
      openingPrice = opening;
      $("#week-price").textContent = priceSet ? fmt(opening) : "—";
      $("#current-price").textContent = priceSet ? fmt(current) : "—";
      $("#price-state").textContent = !priceSet
        ? "가격 미등록 · 첫 가격이 올라온 뒤 체결할 수 있습니다"
        : priceLive
          ? `카운슬 확정 ${date(confirmedAt)} · 유효 ${date(validUntil)}까지`
          : "가격 만료 · 신규 체결과 가격 정산 중단";
    } else if (!fixed()) {
      const [low, current, validUntil, windowEnd, round] = await Promise.all([
        contracts.oracle.weekLow(),
        contracts.oracle.current(),
        contracts.oracle.validUntil(),
        contracts.oracle.windowEnd(),
        contracts.oracle.lastRoundId(),
      ]);
      $("#week-price").textContent = fmt(low);
      $("#current-price").textContent = fmt(current);
      $("#price-state").textContent =
        latest > Number(validUntil)
          ? "가격 만료 · 신규 체결 중단"
          : `round ${round} · 관측 ${date(windowEnd)} · 서명 ${config.oracle.threshold}/${config.oracle.reporters.length}`;
    }
    const ids = (n) =>
      Array.from(
        { length: Math.min(Number(n), limit) },
        (_, i) => Number(n) - i,
      );
    const loadOffer = async (id) => {
      const o = await contracts.lending.getOffer(id);
      return {
        id,
        maker: o.maker,
        side: Number(o.side),
        closed: o.closed,
        expiresAt: o.expiresAt,
        total: o.total,
        remaining: o.remaining,
        minFill: o.minFill,
        collateralTotal: o.collateralTotal,
        collateralRemaining: o.collateralRemaining,
        terms: o.terms,
      };
    };
    const loadLoan = async (id) => {
      const l = await contracts.lending.getLoan(id);
      return {
        id,
        borrower: l.borrower,
        lender: l.lender,
        principal: l.principal,
        collateral: l.collateral,
        maturity: l.maturity,
        status: Number(l.status),
        terms: l.terms,
        debt: await contracts.lending.debtOf(id),
      };
    };
    // My own positions come from the contract's per-account index, never from the
    // newest-N window, so other people's activity cannot push them out of view.
    const mineIds = async (fn) =>
      address
        ? [...(await contracts.lending[fn](address))]
            .map(Number)
            .reverse()
            .slice(0, MY_LIMIT)
        : [];
    const [myOfferIds, myLoanIds] = await Promise.all([
      mineIds("offerIdsOf"),
      mineIds("loanIdsOf"),
    ]);
    [offers, loans, myOffers, myLoans] = await Promise.all([
      Promise.all(ids(oc).map(loadOffer)),
      Promise.all(ids(lc).map(loadLoan)),
      Promise.all(myOfferIds.map(loadOffer)),
      Promise.all(myLoanIds.map(loadLoan)),
    ]);
    more = Number(oc) > limit || Number(lc) > limit;
    if (swapOn()) {
      const count = await contracts.swap.offerCount();
      const loadSwap = async (id) => {
        const o = await contracts.swap.getOffer(id);
        return {
          id,
          maker: o.maker,
          side: Number(o.side),
          closed: o.closed,
          expiresAt: o.expiresAt,
          price: o.price,
          remaining: o.remaining,
          minFill: o.minFill,
        };
      };
      const mine = address
        ? [...(await contracts.swap.offerIdsOf(address))]
            .map(Number)
            .reverse()
            .slice(0, MY_LIMIT)
        : [];
      [swapOffers, mySwapOffers] = await Promise.all([
        Promise.all(ids(count).map(loadSwap)),
        Promise.all(mine.map(loadSwap)),
      ]);
      more ||= Number(count) > limit;
    }
    if (address) {
      const [u, w] = await Promise.all([
        contracts.movn.balanceOf(address),
        contracts.wbmb.balanceOf(address),
      ]);
      $("#wallet-balances").textContent = `${fmt(u)} MOVN · ${fmt(w, 8)} WBMB`;
    }
    syncCollateralHint();
    await render();
  } finally {
    loading = false;
    $("#cards").setAttribute("aria-busy", "false");
  }
}
// The amount row of an open offer. Taking a council lend offer, the borrower types the WBMB to
// pledge (it starts at what the smallest fill needs) and the loan is shown under it.
function fillRow(o, minimum) {
  const button = `<button class="button primary" data-action="fill" data-id="${o.id}">${o.side === 0 ? "빌려주기" : "빌리기"}</button>`;
  if (!byCollateral(o))
    return `<span class="fill-label">${o.side === 0 ? "빌려줄 금액" : "빌릴 금액"} (MOVN)</span><div class="input-row"><input data-fill-amount="${o.id}" aria-label="거래 ${o.id} 참여 금액" value="${formatUnits(minimum, 18)}" inputmode="decimal" />${button}</div>`;
  const start = priceLive ? full(minCollateral(minimum, o.terms), 8) : "";
  return `<span class="fill-label">맡길 담보 (WBMB)</span><div class="input-row"><input data-fill-collateral="${o.id}" aria-label="거래 ${o.id} 맡길 담보 (WBMB)" value="${start}" inputmode="decimal" />${button}</div><small class="field-hint" data-fill-preview="${o.id}">${esc(fillPreview(o, start))}</small>`;
}
// A card's facts, each a label over its value.
const factList = (facts) =>
  `<dl>${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
// A borrow request fixes its MOVN-per-WBMB ratio when it is posted, so it keeps the council
// price of that day: the price at which its collateral would carry exactly its amount. Rounded
// to the council's two decimals, so requests posted at one price compare equal.
const postedPrice = (o) => {
  const exact =
    (o.total * 100000000n * 10000n) /
    (o.collateralTotal * (10000n - BigInt(o.terms.haircutBps)));
  const cent = 10n ** 16n;
  return ((exact + cent / 2n) / cent) * cent;
};
// How a council borrow request stands against today's price: posted at it, below it (more
// collateral behind each MOVN: cheap for a lender) or above it (dear, and not fillable).
const priceMark = (o) => {
  if (!council() || o.side !== 0 || !priceLive || o.collateralTotal === 0n)
    return null;
  const posted = postedPrice(o);
  const now = ((openingPrice + 5n * 10n ** 15n) / 10n ** 16n) * 10n ** 16n;
  const gap = `${Math.abs((Number(posted - now) / Number(now)) * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;
  if (posted === now) return { kind: "now", badge: "현재 시세", posted };
  return posted < now
    ? {
        kind: "cheap",
        badge: "이전 시세 · 지금보다 쌈",
        posted,
        note: `올릴 때 시세 ${fmt(posted)} MOVN 기준입니다. 지금 시세 ${fmt(now)} MOVN보다 ${gap} 낮아, 같은 금액에 담보가 더 많이 잡혀 있습니다.`,
      }
    : {
        kind: "dear",
        badge: "이전 시세 · 지금보다 비쌈",
        posted,
        note: `올릴 때 시세 ${fmt(posted)} MOVN 기준입니다. 지금 시세 ${fmt(now)} MOVN보다 ${gap} 높아, 지금은 담보가 모자랍니다.`,
      };
};
// Market tabs list the reader's best terms first, so a newcomer need not compare rates to see
// what is dear. Borrowing: the lowest rate. Lending: the request posted at the lowest price
// (the most collateral behind each MOVN), then the highest rate. The older post first among
// equals, and a request nobody can fill at today's price below the ones that can.
const unfillable = (o) =>
  council() &&
  o.side === 0 &&
  priceLive &&
  !collateralCovers(o.total, o.collateralTotal, o.terms);
const bestTermsFirst = (tab) => (a, b) =>
  Number(unfillable(a)) - Number(unfillable(b)) ||
  (tab === "lend" && council() ? Number(postedPrice(a) - postedPrice(b)) : 0) ||
  (tab === "borrow" ? 1 : -1) *
    (Number(a.terms.aprBps) - Number(b.terms.aprBps)) ||
  a.id - b.id;
function offerCard(o) {
  const own = address?.toLowerCase() === o.maker.toLowerCase();
  const active = !o.closed && Number(o.expiresAt) > latest;
  const minimum = o.remaining < o.minFill ? o.remaining : o.minFill;
  // Only reachable in "내 거래": the market tabs never list a non-standard council offer.
  const odd = council() && !standardCouncilOffer(o);
  // A standard borrow request whose collateral no longer (or never did) cover it: the contract refuses every fill.
  const short_ =
    council() &&
    !odd &&
    o.side === 0 &&
    active &&
    priceLive &&
    !collateralCovers(o.total, o.collateralTotal, o.terms);
  const mark = odd || !active ? null : priceMark(o);
  const markBadge = mark
    ? `<span class="badge price-${mark.kind}" data-price-mark="${mark.kind}">${mark.badge}</span>`
    : "";
  const markNote = mark?.note ? `<p class="note">${mark.note}</p>` : "";
  const shortNote = short_
    ? `<p class="note warning">담보 부족 · 지금 카운슬 가격에서는 체결할 수 없습니다. ${fmt(o.total)} MOVN 요청에는 담보가 최소 ${full(minCollateral(o.total, o.terms), 8)} WBMB 필요한데 ${full(o.collateralTotal, 8)} WBMB만 맡겨져 있습니다.${own ? " 미체결분을 회수한 뒤 담보를 늘려 다시 올리세요." : ""}</p>`
    : "";
  // The terms every standard council offer shares are stated once in the guide, not on each card.
  const standard = council() && !odd;
  const facts = [
    ["대출 기간", durationText(o.terms.duration)],
    ["최소 참여", `${fmt(minimum)} MOVN`],
    ...(fixed()
      ? [["담보 비율", ratioText(o)]]
      : standard
        ? o.side === 0
          ? [["맡긴 담보", `${fmt(o.collateralRemaining, 8, 8)} WBMB`]]
          : []
        : [
            [
              council() ? "담보 여유" : "헤어컷",
              `${percent(o.terms.haircutBps)}%`,
            ],
            ...(council()
              ? [["청산선", `${percent(o.terms.liquidationBps)}%`]]
              : []),
          ]),
    ["게시 만료", date(o.expiresAt)],
  ];
  const mode = standard
    ? ""
    : `<div class="mode">${modeText(o.terms.mode)} · 만기 후 유예 ${durationText(o.terms.grace)}${odd ? `<br>이 화면의 표준 조건(담보 여유 ${percent(COUNCIL_TERMS.haircutBps)}% · 청산선 ${councilLine()}% · 유예 ${councilGrace()})과 달라 시장 목록에 나오지 않고 이 화면에서 체결되지 않습니다.` : ""}</div>`;
  return `<article class="card" data-offer="${o.id}"><div class="card-top"><span class="badge ${o.side === 0 ? "neutral" : ""}">${o.side === 0 ? "빌리고 싶어요" : "빌려드려요"}${odd ? " · 비표준 조건" : ""}</span>${markBadge}<span class="card-id">#${o.id} · ${esc(short(o.maker))}</span></div><div class="card-figures"><div class="figure"><strong>${percent(o.terms.aprBps)}<small>%</small></strong><span class="sub">고정 연이율 (APR)</span></div><div class="figure end"><h3>${fmt(o.remaining)} <small>MOVN</small></h3><span class="sub">${active ? "남은 참여 가능 금액" : o.closed ? "종료된 게시글" : "게시기간 만료"}</span></div></div>${factList(facts)}${mode}${markNote}${shortNote}${active && !own && !short_ ? fillRow(o, minimum) : ""}${own && !o.closed ? `<div class="row-actions"><button class="button outline small" data-action="close" data-id="${o.id}">미체결분 회수</button></div>` : ""}</article>`;
}
function loanCard(l) {
  const isBorrower = address?.toLowerCase() === l.borrower.toLowerCase();
  const state = ["없음", "진행 중", "MOVN 상환 완료", "WBMB 정산 완료"][
    l.status
  ];
  const due = l.maturity + BigInt(l.terms.grace);
  const open = l.status === 1;
  const priced = council() && Number(l.terms.mode) === 0;
  // What the borrower can do, the most likely first: repay, then add collateral.
  const borrowerActions =
    open && isBorrower
      ? `<span class="fill-label">갚을 원금 (MOVN)</span><div class="input-row"><input data-repay-amount="${l.id}" aria-label="대출 ${l.id} 상환 원금" value="${formatUnits(l.principal, 18)}" inputmode="decimal" /><button class="button primary" data-action="repay" data-id="${l.id}">상환</button></div><div class="row-actions"><button class="text-button" data-action="interest" data-id="${l.id}">이자만 납부</button></div>${fixed() ? "" : `<span class="fill-label">추가할 담보 (WBMB)</span><div class="input-row"><input data-topup-amount="${l.id}" aria-label="대출 ${l.id} 추가 담보" value="0.1" inputmode="decimal" /><button class="button outline" data-action="topup" data-id="${l.id}">담보 추가</button></div>`}`
      : "";
  const detail =
    l.status === 3
      ? "MOVN으로 상환된 것이 아닙니다. 수령 가능한 WBMB는 위 잔액에서 확인하세요."
      : fixed() || (council() && !priced)
        ? `유예 종료(${date(due)})까지 전액 상환하지 않으면 남은 담보 전부가 대출자에게 넘어갑니다. 일부 상환으로는 담보가 풀리지 않습니다.`
        : council()
          ? `카운슬 가격이 청산 가격 이하로 내려가거나 ${date(due)}까지 갚지 않으면 정산됩니다. 대출자는 빚 + ${bonusPct}%어치의 WBMB를 받고 나머지는 차입자에게 돌아갑니다. 담보를 추가하면 청산 가격이 내려갑니다.`
          : "담보 추가는 만기 연장이 아닙니다. 체결된 원금은 대출자가 임의 회수할 수 없습니다.";
  return `<article class="card" data-loan="${l.id}"><div class="card-top"><span class="badge">${isBorrower ? "빌린 거래" : "빌려준 거래"} · ${state}</span><span class="card-id">대출 #${l.id}</span></div><div class="card-figures"><div class="figure"><h3>${fmt(l.debt, 18, 6)} <small>MOVN</small></h3><span class="sub">${open ? "미상환 원금 + 발생 이자 (수수료 별도)" : "현재 남은 부채"}</span></div></div>${factList(
    [
      ["배정 담보", `${fmt(l.collateral, 8, 8)} WBMB`],
      ["고정 연이율", `${percent(l.terms.aprBps)}% APR`],
    ],
  )}${priced && open && l.collateral > 0n ? liquidationBlock(l) : ""}<div class="mode">${priced ? `갚는 기한 ${date(due)} (만기 ${date(l.maturity)})` : `${modeText(l.terms.mode)}<br>만기 ${date(l.maturity)} · 유예 종료 ${date(due)}`}</div>${borrowerActions}${open ? `<div class="row-actions"><button class="button outline small" data-action="settle" data-id="${l.id}">WBMB 정산 조건 확인</button></div>` : ""}<p class="loan-detail">${detail}</p></article>`;
}
// A trade post: the price leads, and what is left is shown in WBMB and in MOVN.
function swapCard(o) {
  const own = address?.toLowerCase() === o.maker.toLowerCase();
  const active = !o.closed && Number(o.expiresAt) > latest;
  const minimum = o.remaining < o.minFill ? o.remaining : o.minFill;
  const sell = o.side === 0;
  const gap = swapGap(o.price);
  const gapText =
    gap === null
      ? "기준 가격 없음"
      : gap === 0
        ? "같음"
        : `${gap > 0 ? "+" : "-"}${gapNumber(gap)}%`;
  // Taking a sell offer buys WBMB; taking a buy offer sells it.
  const fill =
    active && !own
      ? `<span class="fill-label">${sell ? "살" : "팔"} 수량 (WBMB)</span><div class="input-row"><input data-swap-amount="${o.id}" aria-label="직거래 ${o.id} 체결 수량 (WBMB)" value="${full(minimum, 8)}" inputmode="decimal" /><button class="button primary" data-action="swapFill" data-id="${o.id}">${sell ? "사기" : "팔기"}</button></div>`
      : "";
  const close =
    own && !o.closed
      ? `<div class="row-actions"><button class="button outline small" data-action="swapClose" data-id="${o.id}">미체결분 회수</button></div>`
      : "";
  return `<article class="card" data-swap-offer="${o.id}"><div class="card-top"><span class="badge ${sell ? "neutral" : ""}">${sell ? "WBMB 팝니다" : "WBMB 삽니다"}</span><span class="card-id">#${o.id} · ${esc(short(o.maker))}</span></div><div class="card-figures"><div class="figure"><strong>${fmt(o.price)} <small>MOVN</small></strong><span class="sub">WBMB 1개 가격</span></div><div class="figure end"><h3>${fmt(swapCost(o.remaining, o.price, false))} <small>MOVN</small></h3><span class="sub">${active ? "남은 수량 전체 대금" : o.closed ? "종료된 게시글" : "게시기간 만료"}</span></div></div>${factList(
    [
      ["남은 수량", `${fmt(o.remaining, 8, 8)} WBMB`],
      ["최소 체결", `${fmt(minimum, 8, 8)} WBMB`],
      ["카운슬 가격 대비", gapText],
      ["게시 만료", date(o.expiresAt)],
    ],
  )}${fill}${close}</article>`;
}
async function render() {
  if (!contracts) return;
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
    b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
  });
  const descriptions = {
    borrow:
      "MOVN을 빌려주는 사람들의 제안입니다. 원하는 금액만큼 WBMB를 맡기고 참여하세요.",
    lend: "WBMB를 담보로 맡기는 사람들의 요청입니다. 조건을 확인하고 MOVN으로 일부 참여하세요.",
    swap: `사람끼리 WBMB와 MOVN을 직접 사고팝니다. 체결하면 그 자리에서 맞교환되고, WBMB를 파는 쪽이 대금의 ${swapFeePct()}%를 수수료로 냅니다.`,
    mine: "내 게시글, 체결된 대출, 지금 수령할 수 있는 자산을 확인합니다.",
    burn: vault()
      ? `차입자가 낸 이자의 ${feePct}%가 별도 수수료로 쌓입니다.${settleFee() ? ` 정산으로 끝난 대출은 못 낸 이자의 ${feePct}%가 WBMB로 쌓입니다.` : ""} 현재는 소각하지 않고 아래 수수료 지갑으로 보관합니다.`
      : "지급된 이자의 별도 수수료만 소각 재원으로 사용합니다. 개발자에게 배분하지 않습니다.",
  };
  $("#tab-description").textContent = descriptions[tab];
  // One line of terms above the lending lists; the full statement is in the guide below.
  $("#terms-brief").hidden = tab !== "borrow" && tab !== "lend";
  $("#terms-brief").innerHTML = termsBriefHtml();
  showTerms($("#market-terms"));
  $("#market-terms").hidden = false;
  $("#open-offer").textContent = postLabel();
  $("#load-more").hidden = !more || tab === "burn";
  let html = "";
  if (tab === "borrow" || tab === "lend") {
    const side = tab === "borrow" ? 1 : 0;
    const filtered = offers.filter(
      (o) =>
        o.side === side &&
        !o.closed &&
        Number(o.expiresAt) > latest &&
        (!council() || standardCouncilOffer(o)),
    );
    html =
      filtered.sort(bestTermsFirst(tab)).map(offerCard).join("") ||
      `<div class="empty">아직 열린 거래가 없습니다.<small>원하는 조건으로 첫 제안을 올려보세요.</small><button class="button primary small" data-action="post">${postLabel()}</button></div>`;
  } else if (tab === "swap") {
    const open = swapOffers.filter(
      (o) => !o.closed && Number(o.expiresAt) > latest,
    );
    const byPrice = (a, b) =>
      a.price < b.price ? -1 : a.price > b.price ? 1 : 0;
    const list = (side, order, empty) =>
      open
        .filter((o) => o.side === side)
        .sort((a, b) => order * byPrice(a, b) || a.id - b.id)
        .map(swapCard)
        .join("") || `<div class="empty">${empty}</div>`;
    html =
      '<h3 class="section-title">팝니다 · 싼 가격부터</h3>' +
      list(0, 1, "아직 파는 글이 없습니다.") +
      '<h3 class="section-title">삽니다 · 비싼 가격부터</h3>' +
      list(1, -1, "아직 사는 글이 없습니다.");
  } else if (tab === "mine") {
    if (!address)
      html =
        '<div class="empty">지갑을 연결하면 내 거래가 보입니다.<small>상단에서 체험 지갑을 선택해 볼 수 있습니다.</small></div>';
    else {
      const [u, w] = await Promise.all([
        contracts.lending.claimableMOVN(address),
        contracts.lending.claimableWBMB(address),
      ]);
      html = `<div class="claim-box"><p>지금 수령 가능<br><strong>${fmt(u, 18, 8)} MOVN · ${fmt(w, 8, 8)} WBMB</strong></p><div class="row-actions"><button class="button primary small" data-action="claimMOVN" ${u === 0n ? "disabled" : ""}>MOVN 수령</button> <button class="button outline small" data-action="claimWBMB" ${w === 0n ? "disabled" : ""}>WBMB 수령</button></div></div>`;
      html +=
        '<h3 class="section-title">체결된 대출</h3>' +
        (myLoans.map(loanCard).join("") ||
          '<div class="empty">아직 체결된 대출이 없습니다.</div>');
      html +=
        '<h3 class="section-title">내 게시글</h3>' +
        myOffers.map(offerCard).join("");
      if (swapOn())
        html +=
          '<h3 class="section-title">내 직거래 게시</h3>' +
          (mySwapOffers.map(swapCard).join("") ||
            '<div class="empty">아직 올린 직거래 글이 없습니다.</div>');
    }
  } else if (vault()) {
    const [pending, held, settled] = await Promise.all([
      contracts.lending.feeBalance(),
      contracts.movn.balanceOf(config.feeWallet),
      settleFee() ? contracts.lending.claimableWBMB(config.feeWallet) : 0n,
    ]);
    const settledCard = settleFee()
      ? `<article class="card"><span class="sub">정산 수수료 · WBMB</span><strong>${fmt(settled, 8, 8)}</strong><p class="sub">수수료 지갑이 직접 수령합니다 (그 지갑이 받을 다른 WBMB 포함 가능)</p></article>`
      : "";
    html = `<div class="burn-stats"><article class="card"><span class="sub">컨트랙트에 쌓인 수수료 · MOVN</span><strong>${fmt(pending, 18, 8)}</strong><div class="row-actions"><button class="button outline small" data-action="flush" ${pending === 0n ? "disabled" : ""}>수수료 지갑으로 이동</button></div></article><article class="card"><span class="sub">수수료 지갑 · ${esc(short(config.feeWallet))}</span><strong>${fmt(held, 18, 8)}</strong><p class="sub">지갑의 MOVN 잔액 전체 (수수료 외 금액 포함 가능)</p></article>${settledCard}</div><p class="burn-description">수수료 지갑 주소는 컨트랙트 생성 시 고정되어 바꿀 수 없습니다. 누구나 이동을 실행할 수 있지만 받는 곳은 항상 이 지갑입니다. 수수료는 소각되지 않으며 운영자가 보관합니다. 대출자 원금·이자와 담보는 수수료 지갑으로 이동할 수 없습니다.</p>`;
    if (swapOn()) {
      const tradeFees = await contracts.swap.feeBalance();
      html += `<h3 class="section-title">직거래 수수료</h3><div class="burn-stats"><article class="card" data-swap-fees><span class="sub">직거래 컨트랙트에 쌓인 수수료 · MOVN</span><strong>${fmt(tradeFees, 18, 8)}</strong><div class="row-actions"><button class="button outline small" data-action="swapFlush" ${tradeFees === 0n ? "disabled" : ""}>수수료 지갑으로 이동</button></div></article></div><p class="burn-description">직거래에서는 WBMB를 파는 쪽이 대금의 ${swapFeePct()}%를 냅니다. 받는 곳은 ${esc(swapFeeVault)} 으로 고정되어 바꿀 수 없고, 수수료는 소각되지 않습니다.</p>`;
    }
  } else {
    const [pending, ready, burned, used] = await Promise.all([
      contracts.lending.feeBalance(),
      contracts.movn.balanceOf(config.addresses.burner),
      contracts.burner.totalWBMBBurned(),
      contracts.burner.totalMOVNUsed(),
    ]);
    html = `<div class="burn-stats"><article class="card"><span class="sub">수수료 적립 · MOVN</span><strong>${fmt(pending, 18, 8)}</strong><div class="row-actions"><button class="button outline small" data-action="flush" ${pending === 0n ? "disabled" : ""}>소각 재원으로 이동</button></div></article><article class="card"><span class="sub">모의 매입 대기 · MOVN</span><strong>${fmt(ready, 18, 8)}</strong><div class="row-actions"><button class="button primary small" data-action="burn" ${ready < 10n ** 12n ? "disabled" : ""}>모의 매입·소각</button></div></article><article class="card"><span class="sub">모의 WBMB 소각량</span><strong>${fmt(burned, 8, 8)}</strong><p class="sub">사용한 모의 MOVN ${fmt(used, 18, 8)}</p></article></div><p class="burn-description">이 화면의 소각은 로컬 모의 토큰의 공급량을 줄이는 실험입니다. 실제 Uniswap 매입이나 실제 WBMB·원본 BMB 소각이 아닙니다. 소각 처리에 실패해도 대출 상환·담보 수령은 영향을 받지 않습니다.</p>`;
  }
  // Keep amounts the user has typed: a refresh must never silently reset them to defaults.
  const typed = [...$("#cards").querySelectorAll("input")]
    .filter((el) => !dropTyped && el.value !== el.defaultValue)
    .map((el) => [
      Object.keys(el.dataset)
        .map((k) => `${k}=${el.dataset[k]}`)
        .join(),
      el.value,
    ]);
  $("#cards").innerHTML = html;
  for (const el of $("#cards").querySelectorAll("input")) {
    const key = Object.keys(el.dataset)
      .map((k) => `${k}=${el.dataset[k]}`)
      .join();
    const kept = typed.find(([k]) => k === key);
    if (kept) el.value = kept[1];
  }
  for (const el of $("#cards").querySelectorAll("[data-fill-collateral]"))
    syncFillPreview(el);
  dropTyped = false;
  if (busy) lock(true);
}

// Keeps the line under a lend offer's collateral field in step with what is typed.
function syncFillPreview(field) {
  const id = Number(field.dataset.fillCollateral);
  const o = offers.find((x) => x.id === id);
  const line = $(`[data-fill-preview="${id}"]`);
  if (!o || !line) return;
  line.textContent = fillPreview(o, field.value);
  line.classList.toggle(
    "warning",
    line.textContent.startsWith("담보가 적습니다"),
  );
}
$("#cards").addEventListener("input", (e) => {
  if (e.target.dataset?.fillCollateral) syncFillPreview(e.target);
});
async function handleSwapAction(action, id) {
  if (action === "swapFlush") {
    const pending = await contracts.swap.feeBalance();
    await txAction(
      "직거래 수수료 이동",
      `${fmt(pending, 18, 8)} MOVN을 직거래 컨트랙트에서 수수료 지갑으로 옮깁니다.\n${swapFeeLine()}`,
      async (ctx) => {
        await ctx.send(contracts.swap.connect(ctx.signer).flushFees());
      },
    );
    return;
  }
  const o = await contracts.swap.getOffer(id);
  const sell = Number(o.side) === 0;
  if (action === "swapClose") {
    await txAction(
      "직거래 미체결분 회수",
      `직거래 게시글 #${id}을 닫고 남은 ${sell ? full(o.remaining, 8) + " WBMB" : full(o.movnRemaining) + " MOVN"}을 돌려받습니다. 닫은 글은 다시 열 수 없습니다.`,
      async (ctx) => {
        await ctx.send(contracts.swap.connect(ctx.signer).closeOffer(id));
      },
    );
    return;
  }
  const value = amount($(`[data-swap-amount="${id}"]`).value, 8);
  const [gross, fee] = await contracts.swap.quoteFill(id, value);
  // Filling a sell offer makes me the buyer; filling a buy offer makes me the seller.
  const warning = swapWarning(!sell, o.price);
  if (warning && !(await confirm("가격 경고", warning))) {
    status("거래를 취소했습니다.");
    return;
  }
  await txAction(
    sell ? "WBMB 사기" : "WBMB 팔기",
    `직거래 게시글 #${id} · WBMB 1개 = ${full(o.price)} MOVN\n내가 보내는 것: ${sell ? full(gross) + " MOVN" : full(value, 8) + " WBMB"}\n내가 받는 것: ${sell ? full(value, 8) + " WBMB" : full(gross - fee) + " MOVN"}\n수수료 ${swapFeePct()}% · ${full(fee)} MOVN (${sell ? "파는 쪽이 받을 대금에서 뗍니다. 내가 내는 금액에 더해지지 않습니다" : "내가 받을 대금에서 이미 뗀 금액입니다"})\n체결하면 그 자리에서 맞교환되고 되돌릴 수 없습니다.\n${swapFeeLine()}\n${swapSpender()}`,
    async (ctx) => {
      await ctx.approve(
        sell ? contracts.movn : contracts.wbmb,
        sell ? gross : value,
        contracts.swap.target,
      );
      const block = await read.getBlock("latest");
      await ctx.send(
        contracts.swap
          .connect(ctx.signer)
          .fillOffer(id, value, o.price, block.timestamp + 300),
      );
    },
  );
}
async function handleAction(action, id) {
  if (!signer) {
    status("먼저 지갑을 연결하거나 체험 지갑을 선택하세요.", "error");
    return;
  }
  if (action.startsWith("swap")) return handleSwapAction(action, id);
  if (action === "fill") {
    // Before any amount check, so an empty field on an expired price still explains the real reason.
    if (council() && !priceSet)
      throw new Error(
        "첫 카운슬 가격이 아직 등록되지 않아 체결할 수 없습니다. 가격이 올라온 뒤 다시 시도하세요.",
      );
    if (council() && !priceLive)
      throw new Error("카운슬 가격이 만료되어 지금은 체결할 수 없습니다.");
    const o = await contracts.lending.getOffer(id);
    if (council() && !standardCouncilOffer(o))
      throw new Error(
        "이 게시글은 화면의 표준 조건과 달라 여기서 체결할 수 없습니다.",
      );
    // A borrower's typed collateral decides the loan and caps what the contract may take.
    let input,
      pledged = null;
    if (byCollateral(o)) {
      pledged = amount($(`[data-fill-collateral="${id}"]`).value, 8);
      const { loan, minimum, least, enough } = loanFor(o, pledged);
      if (!enough)
        throw new Error(
          `담보가 적습니다. 최소 참여 ${full(minimum)} MOVN에는 ${full(least, 8)} WBMB 이상이 필요합니다.`,
        );
      input = loan;
    } else input = amount($(`[data-fill-amount="${id}"]`).value);
    const collateral = await contracts.lending.quoteFill(id, input);
    if (pledged !== null && collateral > pledged)
      throw new Error(
        `카운슬 가격이 바뀌어 ${full(input)} MOVN에는 ${full(collateral, 8)} WBMB가 필요합니다. 새로고침한 뒤 다시 확인하세요.`,
      );
    const interest =
      (input * BigInt(o.terms.aprBps) * BigInt(o.terms.duration)) /
      (10000n * 31536000n);
    // Filling a borrow request makes me the lender; filling a lend offer makes me the borrower.
    const lending_ = Number(o.side) === 0;
    const token = lending_ ? contracts.movn : contracts.wbmb;
    const repayBy = latest + Number(o.terms.duration) + Number(o.terms.grace);
    // In the council market a settled lender receives debt plus the bonus, never "the collateral",
    // and the borrower must see where this very fill would be liquidated before confirming.
    const lenderGets = council()
      ? `상환되면 원금과 이자(MOVN), 정산되면 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB(담보가 모자라면 담보 전부)`
      : "상환되면 원금과 이자(MOVN), 미상환이면 담보 WBMB";
    const liquidationLine = council()
      ? `\n청산선 ${percent(o.terms.liquidationBps)}% · 청산 가격: ${priceUp(liquidationPrice({ debt: input, collateral, terms: o.terms }))} MOVN 이하 (지금 카운슬 가격 ${fmt(currentPrice)} MOVN · 이자가 쌓이면 청산 가격도 올라갑니다)`
      : "";
    const settlementLine = council()
      ? `카운슬 가격이 청산 가격 이하로 내려가거나 상환 기한까지 갚지 않으면 정산됩니다. 정산되면 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB가 대출자에게 가고 나머지 담보는 차입자에게 돌아갑니다.${settleFee() ? ` 이때 못 낸 이자의 ${feePct}%가 수수료로 돌려받을 담보에서 빠집니다.` : ""} 대출자는 MOVN 대신 WBMB를 받습니다. ${staleNote()}`
      : "담보 정산 시 대출자는 MOVN 대신 WBMB를 받습니다.";
    await txAction(
      "부분 체결",
      `${lending_ ? "MOVN을 빌려줍니다" : "WBMB를 맡기고 MOVN을 빌립니다"} · 게시글 #${id}\n내가 보내는 것: ${lending_ ? full(input) + " MOVN" : full(collateral, 8) + " WBMB (담보)"}\n내가 받는 것: ${lending_ ? lenderGets : full(input) + " MOVN"}\n배정 담보: ${fmt(collateral, 8, 8)} WBMB\n담보 비율: ${ratioText({ total: input, collateralTotal: collateral })}${liquidationLine}\nAPR ${percent(o.terms.aprBps)}% · 기간 ${durationText(o.terms.duration)} · 유예 ${durationText(o.terms.grace)}\n상환 기한(유예 포함): ${date(repayBy)} 무렵\n만기까지 예상 이자 ${fmt(interest, 18, 8)} MOVN (${feeWord()} 별도)\n${modeText(o.terms.mode)}\n${settlementLine}\n${spenderLine()}`,
      async (ctx) => {
        await ctx.approve(token, lending_ ? input : collateral);
        const block = await read.getBlock("latest");
        await ctx.assertSession();
        await ctx.send(
          ctx.lending.fillOffer(
            id,
            input,
            // A borrower caps the collateral they post. A lender has no use for a cap:
            // the offer is immutable and concurrent fills move rounding by one unit at most.
            lending_ ? MaxUint256 : collateral,
            block.timestamp + 300,
          ),
        );
      },
    );
  } else if (action === "close") {
    await txAction(
      "미체결분 회수",
      `게시글 #${id}의 남은 부분을 취소하고 내 수령 잔액으로 돌립니다. 이미 체결된 대출은 계속 유지됩니다.`,
      (ctx) => ctx.send(ctx.lending.closeOffer(id)),
    );
  } else if (action === "topup") {
    const value = amount($(`[data-topup-amount="${id}"]`).value, 8);
    await txAction(
      "담보 추가",
      `대출 #${id}에 ${fmt(value, 8, 8)} WBMB를 추가합니다. 만기는 연장되지 않습니다. 만기형 전체 귀속 계약이면 추가한 담보도 정산 대상입니다.`,
      async (ctx) => {
        await ctx.approve(contracts.wbmb, value);
        await ctx.send(ctx.lending.addCollateral(id, value));
      },
    );
  } else if (action === "repay" || action === "interest") {
    const value =
      action === "interest"
        ? 0n
        : amount($(`[data-repay-amount="${id}"]`).value);
    const l = await contracts.lending.getLoan(id),
      q = await contracts.lending.quoteRepay(id, value);
    const buffer =
      (((l.principal * BigInt(l.terms.aprBps) * 300n) / (10000n * 31536000n)) *
        105n) /
        100n +
      100n;
    const max = q.total + buffer;
    await txAction(
      action === "interest" ? "이자 납부" : "상환",
      `상환 원금 ${full(value)} MOVN\n발생 이자 ${fmt(q.interest, 18, 8)} MOVN\n${feeWord()} ${fmt(q.fee, 18, 8)} MOVN\n현재 합계 ${fmt(q.total, 18, 8)} MOVN\n확정 대기 중 이자를 포함한 최대 승인액 ${fmt(max, 18, 10)} MOVN\n${value < l.principal ? (council() && Number(l.terms.mode) === 0 ? `일부만 갚으면 담보는 풀리지 않습니다. 카운슬 가격이 청산 가격 이하로 내려가거나 유예가 끝날 때까지 남은 원금을 갚지 않으면, 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB가 대출자에게 가고 나머지는 돌려받습니다. ${staleNote()}` : "일부만 갚으면 담보는 풀리지 않습니다. 유예가 끝날 때까지 남은 원금을 갚지 않으면 담보 전부가 대출자에게 넘어갑니다.") : "전액 상환하면 담보 WBMB를 수령할 수 있습니다."}\n${spenderLine()}`,
      async (ctx) => {
        await ctx.approve(contracts.movn, max);
        await ctx.send(ctx.lending.repay(id, value, max));
      },
    );
  } else if (action === "settle") {
    const q = await contracts.lending.quoteSettlement(id);
    // quoteSettlement also reports price 0 for maturity-only loans, so the stale-price wording needs the loan's mode.
    const loan = await contracts.lending.getLoan(id);
    const priced = council() && Number(loan.terms.mode) === 0;
    // The settlement fee is the collateral the quote gives to neither side.
    const fee = loan.collateral - q.toLender - q.toBorrower;
    await txAction(
      "WBMB 정산",
      `대출 #${id}를 WBMB로 종료합니다.\n대출자 귀속 ${fmt(q.toLender, 8, 8)} WBMB\n차입자 반환 ${fmt(q.toBorrower, 8, 8)} WBMB${fee > 0n ? `\n수수료 ${fmt(fee, 8, 8)} WBMB (못 낸 이자의 ${feePct}%)` : ""}\n종료 부채 ${fmt(q.debt, 18, 8)} MOVN${council() ? (priced ? (q.price === 0n ? "\n쓸 수 있는 가격이 없어 담보 전부가 대출자에게 갑니다." : `\n적용 가격 ${fmt(q.price)} MOVN${priceLive ? "" : " (가격 갱신이 끊겨 마지막 가격을 씁니다)"} · 보너스 ${bonusPct}% 포함`) : `\n${modeText(1)}`) : ""}\nMOVN이 지급되는 것이 아니며 이 대출의 채권은 컨트랙트에서 종료됩니다.`,
      (ctx) => ctx.send(ctx.lending.settle(id)),
    );
  } else if (action === "claimMOVN" || action === "claimWBMB") {
    const unit = action === "claimMOVN" ? "MOVN" : "WBMB";
    const value =
      await contracts.lending[
        action === "claimMOVN" ? "claimableMOVN" : "claimableWBMB"
      ](address);
    await txAction(
      `${unit} 수령`,
      `${fmt(value, unit === "MOVN" ? 18 : 8, 8)} ${unit}${unit === "MOVN" ? "을" : "를"} 현재 연결한 지갑으로 수령합니다.`,
      (ctx) => ctx.send(ctx.lending[action]()),
    );
  } else if (action === "flush") {
    await txAction(
      "수수료 이동",
      vault()
        ? `쌓인 수수료를 고정된 수수료 지갑(${short(config.feeWallet)})으로 보냅니다. 대출자 원금과 담보는 사용하지 않습니다.`
        : "적립된 수수료만 고정된 모의 소각 컨트랙트로 이동합니다. 대출자 원금과 담보는 사용하지 않습니다.",
      (ctx) => ctx.send(ctx.lending.flushFees()),
    );
  } else if (action === "burn") {
    let value = await contracts.movn.balanceOf(config.addresses.burner);
    if (value > parseUnits("1000", 18)) value = parseUnits("1000", 18);
    const [, price] = await contracts.oracle.prices(),
      out = (value * 100000000n) / price;
    await txAction(
      "모의 매입·소각",
      `${fmt(value, 18, 8)} 모의 MOVN으로 ${fmt(out, 8, 8)} 모의 WBMB를 소각합니다. 실제 시장 매입이 아닙니다.`,
      async (ctx) => {
        const block = await read.getBlock("latest");
        await ctx.send(
          contracts.burner
            .connect(ctx.signer)
            .burnFees(value, out, block.timestamp + 300),
        );
      },
    );
  }
}

$("#cards").addEventListener("click", (e) => {
  const button = e.target.closest("[data-action]");
  if (!button || busy) return;
  // The post button of an empty list is the one in the bar.
  if (button.dataset.action === "post") return $("#open-offer").click();
  handleAction(button.dataset.action, Number(button.dataset.id)).catch((e) =>
    status(errorMessage(e), "error"),
  );
});
document.querySelectorAll("[data-tab]").forEach((button) =>
  button.addEventListener("click", () => {
    if (busy) return;
    tab = button.dataset.tab;
    remember("sessionStorage", TAB_KEY, tab);
    render().catch((e) => status(errorMessage(e), "error"));
  }),
);
$("#connect").onclick = () =>
  connectWallet().catch((e) => status(errorMessage(e), "error"));
$("#connect-qr").onclick = () =>
  connectByQr().catch((e) => status(errorMessage(e), "error"));
$("#qr-cancel").onclick = () => $("#qr-dialog").close();
$("#demo-account").onchange = async (e) => {
  if (!e.target.value) {
    invalidateWallet();
    return;
  }
  try {
    if (
      !config.demo ||
      !localHost(location.hostname) ||
      !localHost(new URL(config.rpcUrl).hostname)
    )
      throw new Error("체험 지갑은 localhost에서만 사용할 수 있습니다.");
    await validateChain();
    await read.send("hardhat_metadata", []);
    dropWallet();
    const i = Number(e.target.value);
    await useSigner(
      await read.getSigner(config.demoAccounts[i - 1]),
      `체험 지갑 ${i}`,
    );
  } catch (error) {
    status(errorMessage(error), "error");
  }
};
$("#disconnect").onclick = () => {
  invalidateWallet();
  status("지갑 연결을 해제했습니다.");
};
$("#refresh").onclick = () =>
  refresh().catch((e) => status(errorMessage(e), "error"));
$("#load-more").onclick = () => {
  limit += 25;
  refresh().catch((e) => status(errorMessage(e), "error"));
};
$("#open-offer").onclick = () => {
  if (!signer) {
    status("먼저 체험 지갑을 선택하거나 지갑을 연결하세요.", "error");
    return;
  }
  if (tab === "swap") {
    // Start from the council price; the poster types their own over it.
    const reference = swapReference();
    if (!swapForm.elements.tradePrice.value && reference !== null)
      swapForm.elements.tradePrice.value = full(reference);
    syncSwapTotal();
    $("#swap-dialog").showModal();
    return;
  }
  // The form opens on the side of the open tab.
  if (postSide()) form.elements.side.value = postSide();
  ownMinFill = false;
  syncOfferForm();
  syncCollateralHint();
  $("#offer-dialog").showModal();
};
const swapForm = $("#swap-form");
// The line under the form: what the whole post is worth and what the poster ends up with.
function syncSwapTotal() {
  const line = $("#swap-total");
  try {
    const selling = swapForm.elements.tradeSide.value === "0";
    const cost = swapCost(
      amount(swapForm.elements.tradeAmount.value, 8),
      amount(swapForm.elements.tradePrice.value),
      !selling,
    );
    const fee = (cost * swapFeeBps + 9999n) / 10000n;
    line.textContent = selling
      ? `전체 대금 ${full(cost)} MOVN · 다 팔리면 수수료 ${swapFeePct()}%를 뗀 ${fmt(cost - fee, 18, 8)} MOVN쯤 받습니다.`
      : `전체 대금 ${full(cost)} MOVN을 지금 맡깁니다. 수수료는 파는 쪽이 냅니다.`;
  } catch {
    line.textContent = "수량과 가격을 입력하면 전체 대금이 나옵니다.";
  }
}
swapForm.oninput = syncSwapTotal;
swapForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const selling = swapForm.elements.tradeSide.value === "0";
    const total = amount(swapForm.elements.tradeAmount.value, 8),
      price = amount(swapForm.elements.tradePrice.value),
      minFill = amount(swapForm.elements.tradeMinFill.value, 8),
      expiry = Number(swapForm.elements.tradeExpiry.value);
    if (!Number.isInteger(expiry) || expiry < 1 || expiry > 90)
      throw new Error("게시 기간은 1~90일의 정수로 입력하세요.");
    if (total <= 0n || price <= 0n || minFill <= 0n || minFill > total)
      throw new Error(
        "수량·가격을 확인하세요. 최소 체결량은 0보다 크고 전체 수량 이하여야 합니다.",
      );
    // A buyer escrows the rounded-up cost of the whole amount, exactly as the contract takes it.
    const cost = swapCost(total, price, !selling);
    if (cost === 0n)
      throw new Error("수량과 가격이 너무 작아 대금이 0이 됩니다.");
    $("#swap-dialog").close();
    const warning = swapWarning(selling, price);
    if (warning && !(await confirm("가격 경고", warning))) {
      status("거래를 취소했습니다.");
      return;
    }
    await txAction(
      "직거래 글 올리기",
      `${selling ? "WBMB 팔기" : "WBMB 사기"} · ${full(total, 8)} WBMB · WBMB 1개 = ${full(price)} MOVN\n최소 체결 ${full(minFill, 8)} WBMB · 게시 ${expiry}일\n내가 보내는 것: ${selling ? full(total, 8) + " WBMB" : full(cost) + " MOVN"} (컨트랙트에 맡기며, 체결되지 않은 만큼은 회수할 수 있습니다)\n다 체결되면 받는 것: ${selling ? `${full(cost)} MOVN에서 수수료 ${swapFeePct()}%를 뗀 금액` : full(total, 8) + " WBMB"}\n가격과 수량은 올린 뒤 바꿀 수 없습니다. 바꾸려면 회수하고 다시 올리세요.\n${swapFeeLine()}\n${swapSpender()}`,
      async (ctx) => {
        await ctx.approve(
          selling ? contracts.wbmb : contracts.movn,
          selling ? total : cost,
          contracts.swap.target,
        );
        const block = await read.getBlock("latest");
        await ctx.send(
          contracts.swap
            .connect(ctx.signer)
            .createOffer(
              selling ? 0 : 1,
              total,
              price,
              minFill,
              block.timestamp + expiry * 86400,
            ),
        );
      },
    );
  } catch (error) {
    status(errorMessage(error), "error");
  }
};
document
  .querySelectorAll("[data-close]")
  .forEach(
    (b) => (b.onclick = () => document.getElementById(b.dataset.close).close()),
  );
const form = $("#offer-form");
function syncOfferForm() {
  const lend = form.elements.side.value === "1";
  $("#collateral-field").hidden = lend && !fixed();
  $("#collateral-label").textContent =
    lend && fixed() ? "한도 전체에 요구할 담보 (WBMB)" : "맡길 담보 (WBMB)";
  form.elements.mode.closest("label").hidden = vault();
  $("#terms-note").textContent = fixed()
    ? `만기 유예 1일. 단리 APR이며 실제 경과기간만 이자를 냅니다. 지급 이자의 ${feePct}%가 별도 수수료입니다. 가격이 내려가도 청산되지 않고, 만기·유예 후 미상환이면 추가 담보를 포함한 남은 WBMB 전부가 대출자에게 넘어갑니다.`
    : council()
      ? ""
      : "체험 조건: 헤어컷 10% · 청산 기준 95% · 만기 유예 1일. 단리 APR이며 실제 경과기간만 이자를 냅니다. 지급 이자의 5%가 별도 소각 수수료입니다.";
  if (council()) $("#terms-note").innerHTML = councilTermsHtml();
}
// A council borrow request is sized by its collateral: the poster types the WBMB and the form
// works out the loan (never typed) and, until the poster sets their own, the smallest fill.
const sizedByCollateral = () => council() && form.elements.side.value === "0";
let ownMinFill = false;
// The loan the typed collateral carries at today's price, or null while it cannot be worked out.
function requestLoan() {
  try {
    const days = Number(form.elements.duration.value);
    if (!Number.isInteger(days) || days < 1) return null;
    const loan = maxLoan(amount(form.elements.collateral.value, 8), {
      ...COUNCIL_TERMS,
      aprBps: amount(form.elements.apr.value, 2),
      duration: days * 86400,
    });
    return loan > 0n ? loan : null;
  } catch {
    return null; // an amount still being typed
  }
}
function syncCollateralHint() {
  const hint = $("#collateral-hint");
  const sized = sizedByCollateral();
  form.elements.total.readOnly = sized;
  $("#total-label").textContent = sized
    ? "빌릴 금액 (MOVN) · 자동 계산"
    : "총 대출 한도 (MOVN)";
  hint.hidden = !sized;
  if (!sized) return;
  const loan = requestLoan();
  form.elements.total.value = loan === null ? "" : full(loan);
  if (!ownMinFill)
    form.elements.minFill.value =
      loan === null
        ? ""
        : full(loan / 10n - ((loan / 10n) % LOAN_STEP) || loan);
  hint.textContent = !priceLive
    ? "카운슬 가격이 없어 빌릴 금액을 계산할 수 없습니다."
    : `지금 카운슬 가격(${fmt(currentPrice)} MOVN)에서 담보 가치의 ${councilLtv()}%까지 빌릴 수 있습니다. 올린 뒤 가격이 내려가면 이 글은 체결되지 않으니, 회수한 뒤 다시 올리세요.`;
  hint.classList.toggle("warning", !priceLive);
}
form.addEventListener("input", (e) => {
  if (e.target === form.elements.minFill) ownMinFill = true;
  syncCollateralHint();
});
form.elements.side.onchange = () => {
  // Leaving the collateral-sized request: the worked-out amounts are not the lender's.
  if (council() && !sizedByCollateral()) {
    form.elements.total.value = form.elements.total.defaultValue;
    if (!ownMinFill)
      form.elements.minFill.value = form.elements.minFill.defaultValue;
  }
  syncOfferForm();
  syncCollateralHint();
};
form.elements.mode.onchange = () => {
  $("#mode-warning").hidden = form.elements.mode.value !== "1";
};
form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const side = Number(form.elements.side.value);
    if (sizedByCollateral()) {
      if (!priceLive)
        throw new Error(
          "카운슬 가격이 없어 빌릴 금액을 계산할 수 없습니다. 가격이 올라온 뒤 다시 시도하세요.",
        );
      // Worked out again from the collateral here, whatever the read-only field shows.
      const loan = requestLoan();
      if (loan === null)
        throw new Error(
          "맡길 담보(WBMB)를 입력하세요. 빌릴 금액은 담보에서 자동으로 계산됩니다.",
        );
      form.elements.total.value = full(loan);
    }
    const total = amount(form.elements.total.value);
    const needsCollateral = side === 0 || fixed();
    const collateral = needsCollateral
        ? amount(form.elements.collateral.value, 8)
        : 0n,
      minFill = amount(form.elements.minFill.value);
    const days = Number(form.elements.duration.value),
      expiry = Number(form.elements.expiry.value),
      mode = fixed()
        ? 1
        : council()
          ? COUNCIL_TERMS.mode
          : Number(form.elements.mode.value);
    if (
      !Number.isInteger(days) ||
      !Number.isInteger(expiry) ||
      days < 1 ||
      days > 365 ||
      expiry < 1 ||
      expiry > 90
    )
      throw new Error("기간은 허용 범위의 정수 일수로 입력하세요.");
    const apr = amount(form.elements.apr.value, 2);
    if (
      apr > 10000n ||
      total <= 0n ||
      minFill <= 0n ||
      minFill > total ||
      (needsCollateral && collateral <= 0n)
    )
      throw new Error("금액·담보·금리 범위를 확인하세요.");
    const terms = {
      aprBps: apr,
      haircutBps: fixed() ? 0 : council() ? COUNCIL_TERMS.haircutBps : 1000,
      liquidationBps: fixed()
        ? 0
        : council()
          ? COUNCIL_TERMS.liquidationBps
          : 9500,
      duration: days * 86400,
      grace: council() ? COUNCIL_TERMS.grace : 86400,
      mode,
    };
    if (council() && side === 0 && priceLive) {
      const min = minCollateral(total, terms);
      if (collateral < min)
        throw new Error(
          `담보가 부족합니다. 지금 카운슬 가격(${fmt(currentPrice)} MOVN)에서 ${fmt(total)} MOVN을 빌리려면 담보가 최소 ${full(min, 8)} WBMB 필요합니다 (담보 가치의 ${councilLtv()}%까지 빌릴 수 있습니다). 이대로 올리면 아무도 체결할 수 없습니다.`,
        );
    }
    $("#offer-dialog").close();
    await txAction(
      "거래 게시",
      `${side === 0 ? "MOVN 빌리기" : "MOVN 빌려주기"} · 한도 ${fmt(total)} MOVN\n최소 참여 ${fmt(minFill)} MOVN · APR ${percent(apr)}% · ${days}일\n${modeText(mode)}\n내가 보내는 것: ${side === 0 ? full(collateral, 8) + " WBMB" : full(total) + " MOVN"} (미체결 주문에 잠기며, 미체결분은 취소 후 수령할 수 있습니다)${needsCollateral ? `\n담보 비율: ${ratioText({ total, collateralTotal: collateral })} — 한도 전체 ${full(total)} MOVN에 담보 ${full(collateral, 8)} WBMB. 숫자와 단위를 다시 확인하세요.` : ""}${side === 1 && fixed() ? "\n차입자는 이 비율대로만 담보를 맡기고 빌릴 수 있습니다. 담보를 너무 적게 적으면 누구나 즉시 전액을 빌려갈 수 있습니다." : ""}\n${council() ? `카운슬 가격이 청산 가격 이하로 내려가거나 만기 후 유예 ${councilGrace()}이 지나면, 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB가 대출자에게 가고 나머지는 차입자에게 돌아갑니다. ${staleNote()}` : "만기 후 유예 1일이 지나면 미상환 대출의 담보는 대출자에게 넘어갑니다."}\n이자 지급액의 ${feePct}% 수수료가 별도로 부과됩니다.\n${spenderLine()}`,
      async (ctx) => {
        await ctx.approve(
          side === 0 ? contracts.wbmb : contracts.movn,
          side === 0 ? collateral : total,
        );
        const block = await read.getBlock("latest");
        await ctx.send(
          ctx.lending.createOffer(
            side,
            total,
            collateral,
            minFill,
            block.timestamp + expiry * 86400,
            terms,
          ),
        );
      },
    );
  } catch (error) {
    status(errorMessage(error), "error");
  }
};

async function labAction(seconds, refreshPrice = true) {
  if (busy || !config?.demo) return;
  lock(true);
  try {
    if (
      !localHost(location.hostname) ||
      !localHost(new URL(config.rpcUrl).hostname)
    )
      throw new Error("로컬에서만 가능합니다.");
    await validateChain();
    await read.send("hardhat_metadata", []);
    if (fixed()) {
      if (!seconds) return;
      await read.send("evm_increaseTime", [seconds]);
      await read.send("evm_mine", []);
      await refresh();
      status(`${seconds / 86400}일이 경과했습니다.`, "success");
      return;
    }
    if (council()) {
      const price = seconds
        ? await contracts.oracle.current()
        : amount($("#lab-price").value);
      if (seconds) {
        await read.send("evm_increaseTime", [seconds]);
        await read.send("evm_mine", []);
      }
      // `refreshPrice` false leaves the price to expire, to show what an outage looks like.
      if (refreshPrice) {
        const reporter = await read.getSigner(config.oracle.reporterIndex);
        const t = Number((await read.getBlock("latest")).timestamp);
        await (
          await submitCouncilReport(
            contracts.oracle.connect(reporter),
            {
              policyId: COUNCIL_POLICY_ID,
              roundId: Number(await contracts.oracle.lastRoundId()) + 1,
              price,
              confirmedAt: t,
              validUntil: t + Number(config.oracle.maxAge) - 60,
            },
            [reporter],
          )
        ).wait();
      }
      await refresh();
      status(
        seconds
          ? `${seconds / 86400}일이 경과했습니다.`
          : "모의 카운슬 가격을 반영했습니다.",
        "success",
      );
      return;
    }
    const current = seconds
      ? await contracts.oracle.current()
      : amount($("#lab-price").value);
    const oldLow = await contracts.oracle.weekLow(),
      low = current < oldLow ? current : oldLow;
    if (seconds) {
      await read.send("evm_increaseTime", [seconds]);
      await read.send("evm_mine", []);
    }
    // Local reporters sign a synthetic report; the contract verifies threshold signatures.
    const pr = demoPriceReport(
      Number((await read.getBlock("latest")).timestamp),
    );
    const values = {
      dexLow: low,
      cexLow: low,
      dexCurrent: current,
      cexCurrent: current,
    };
    const report = {
      ...toReport(pr, {
        roundId: Number(await contracts.oracle.lastRoundId()) + 1,
        validUntil: pr.windowEnd + Number(config.oracle.maxAge),
        rawDataHash: hashSyntheticData({ windowEnd: pr.windowEnd, ...values }),
      }),
      ...values,
    };
    const signers = await Promise.all(
      config.oracle.reporterIndices
        .slice(0, config.oracle.threshold)
        .map((i) => read.getSigner(i)),
    );
    await (
      await submitReport(contracts.oracle.connect(signers[0]), report, signers)
    ).wait();
    await refresh();
    status(
      seconds
        ? `${seconds / 86400}일이 경과했습니다. 모의 가격 유효기간도 갱신했습니다.`
        : "모의 가격을 반영했습니다.",
      "success",
    );
  } catch (e) {
    status(errorMessage(e), "error");
  } finally {
    lock(false);
  }
}
$("#set-price").onclick = () => labAction(0);
$("#advance-day").onclick = () => labAction(86400);
$("#advance-month").onclick = () => labAction(31 * 86400);
$("#advance-week").onclick = () => labAction(7 * 86400, false);

// The live page's "check it yourself" block: every address it uses, on the explorer, and its source.
function renderVerify() {
  const explorer = LIVE_CHAINS[config.chainId].blockExplorerUrls[0];
  const rows = [
    ["시장 컨트랙트", config.addresses.lending],
    ...(council() ? [["가격 컨트랙트", config.addresses.oracle]] : []),
    ...(swapOn() ? [["직거래 컨트랙트", config.addresses.swap]] : []),
    ["WBMB 토큰", config.addresses.wbmb],
    ["MOVN 토큰", config.addresses.movn],
  ];
  $("#verify-addresses").innerHTML = rows
    .map(
      ([label, address]) =>
        `<div><dt>${label}</dt><dd><a href="${explorer}/address/${esc(address)}" target="_blank" rel="noopener">${esc(address)}</a></dd></div>`,
    )
    .join("");
  $("#verify-source").href =
    `https://repo.sourcify.dev/${config.chainId}/${config.addresses.lending}`;
  $("#verify-repo").href = REPO_URL;
  $("#verify-contact").href = `${REPO_URL}/issues`;
  $("#verify-operator").textContent = OPERATOR;
  $("#verify").hidden = false;
  $("#movn-risk").hidden = false;
  $("#movn-risk-council").hidden = !council();
}

async function init() {
  const responses = await Promise.all([
    fetch("/deployment.json", { cache: "no-store" }),
    fetch("/abis.json", { cache: "no-store" }),
  ]);
  if (responses.some((r) => !r.ok))
    throw new Error(
      "배포 설정을 찾을 수 없습니다. 로컬 체험은 프로젝트 폴더에서 npm run dev를 실행하세요.",
    );
  [config, abis] = await Promise.all(responses.map((r) => r.json()));
  const demoOk =
    config.demo === true &&
    config.chainId === 31337 &&
    localHost(new URL(config.rpcUrl).hostname) &&
    (fixed() ||
      (council()
        ? config.oracle?.contract === "CouncilPricePolicy"
        : config.oracle?.contract === "SignedPricePolicy"));
  // Live mode exists for the oracle-free and the council-price market on an allow-listed chain.
  const sameAddress = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase();
  // The fetched file must match the addresses compiled into this build, so a swapped
  // deployment.json cannot redirect approvals to another contract. The RPC endpoint is
  // pinned as well: every term, quote and price the page shows is read through it.
  const liveOk =
    config.demo === false &&
    // The build decides the market type; the fetched file cannot change it.
    (PINNED?.oracle
      ? council() &&
        !fixed() &&
        sameAddress(config.addresses?.oracle, PINNED.oracle)
      : fixed() && !council()) &&
    PINNED !== null &&
    typeof config.chainId === "number" &&
    Object.hasOwn(LIVE_CHAINS, config.chainId) &&
    config.chainId === PINNED.chainId &&
    typeof PINNED.rpcUrl === "string" &&
    config.rpcUrl === PINNED.rpcUrl &&
    ["lending", "movn", "wbmb"].every((k) =>
      sameAddress(config.addresses?.[k], PINNED[k]),
    ) &&
    sameAddress(config.feeWallet, PINNED.feeWallet) &&
    // A trade contract is used only when the build was made with that very address.
    (!config.addresses?.swap ||
      sameAddress(config.addresses.swap, PINNED.swap));
  if (!demoOk && !liveOk) throw new Error("허용되지 않은 배포 설정입니다.");
  read = new JsonRpcProvider(
    config.rpcUrl,
    config.demo ? undefined : config.chainId,
    {
      cacheTimeout: -1,
      staticNetwork: !config.demo,
    },
  );
  read.pollingInterval = config.demo ? 100 : 3000;
  await validateChain();
  if (config.demo) await read.send("hardhat_metadata", []);
  contracts = {};
  const names = fixed()
    ? { lending: "P2PLending", movn: null, wbmb: null }
    : council()
      ? {
          lending: "P2PLending",
          movn: null,
          wbmb: null,
          oracle: "CouncilPricePolicy",
        }
      : {
          lending: "P2PLending",
          movn: "MockToken",
          wbmb: "MockToken",
          oracle: "SignedPricePolicy",
          burner: "MockFeeBurner",
        };
  for (const [key, name] of Object.entries(names)) {
    if ((await read.getCode(config.addresses[key])) === "0x")
      throw new Error(
        config.demo
          ? "로컬 배포 주소에 컨트랙트가 없습니다. npm run dev로 다시 시작하세요."
          : "배포 주소에 컨트랙트가 없습니다. 배포 설정을 확인하세요.",
      );
    contracts[key] = new Contract(
      config.addresses[key],
      name ? abis[name] : ERC20_ABI,
      read,
    );
  }
  if (vault()) {
    // The page must describe the contract it really talks to.
    const [policy, feeVault, onchainMovn, onchainWbmb, feeBps] =
      await Promise.all([
        contracts.lending.pricePolicy(),
        contracts.lending.feeVault(),
        contracts.lending.movn(),
        contracts.lending.wbmb(),
        contracts.lending.feeBps(),
      ]);
    feePct = percent(feeBps);
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    if (
      (council()
        ? !same(policy, config.addresses.oracle)
        : BigInt(policy) !== 0n) ||
      !same(feeVault, config.feeWallet) ||
      !same(onchainMovn, config.addresses.movn) ||
      !same(onchainWbmb, config.addresses.wbmb)
    )
      throw new Error("배포 설정이 컨트랙트의 실제 값과 다릅니다.");
    if (fixed()) {
      for (const el of [$("#week-price"), $("#current-price")])
        el.closest("div").hidden = true;
      for (const el of [$("#lab-price").closest("label"), $("#set-price")])
        el.hidden = true;
    }
    $('[data-tab="burn"]').textContent = "수수료";
    // Fees are kept by the operator in this market; the page must not claim otherwise.
    $("#fee-tag").textContent = `수수료 이자의 ${feePct}%`;
    if (fixed()) $("#footer-version").textContent = "WBMB Commons · 만기형 v1";
    if (council()) {
      bonusPct = percent(await contracts.lending.liquidationBonusBps());
      staleDelay = durationText(await contracts.lending.staleSettleDelay());
      minGraceText = durationText(await contracts.lending.minGrace());
      $("#week-label").textContent = "체결 기준가";
      $("#current-label").textContent = "카운슬 가격";
      $("#advance-week").hidden = false;
      $("#footer-version").textContent = "WBMB Commons · 카운슬 가격형 v1";
    }
  }
  if (vault() && config.addresses.swap) {
    if ((await read.getCode(config.addresses.swap)) === "0x")
      throw new Error("직거래 배포 주소에 컨트랙트가 없습니다.");
    const swap = new Contract(config.addresses.swap, abis.P2PSwap, read);
    const [onchainMovn, onchainWbmb, feeVault, feeBps] = await Promise.all([
      swap.movn(),
      swap.wbmb(),
      swap.feeVault(),
      swap.feeBps(),
    ]);
    if (
      !sameAddress(onchainMovn, config.addresses.movn) ||
      !sameAddress(onchainWbmb, config.addresses.wbmb)
    )
      throw new Error("배포 설정이 직거래 컨트랙트의 실제 값과 다릅니다.");
    // A live build also carries where the trade fees go and the rate, and opens only on a match.
    if (
      !config.demo &&
      (!sameAddress(feeVault, PINNED.swapFeeVault) ||
        feeBps !== BigInt(PINNED.swapFeeBps))
    )
      throw new Error("직거래 컨트랙트의 수수료 설정이 이 빌드와 다릅니다.");
    contracts.swap = swap;
    swapFeeBps = feeBps;
    // Where trade fees go is read from the chain, never from the fetched file.
    swapFeeVault = feeVault;
    $('[data-tab="swap"]').hidden = false;
    $("#swap-note").textContent =
      `가격과 수량은 올린 뒤 바꿀 수 없습니다. 체결되면 그 자리에서 맞교환되고, WBMB를 파는 쪽이 대금의 ${swapFeePct()}%를 수수료로 냅니다. 이 화면은 카운슬 가격과 ${SWAP_WARN_PCT}% 이상 불리한 가격에만 경고하며, 컨트랙트는 가격을 막지 않습니다.`;
  }
  syncOfferForm();
  if (!config.demo) {
    $("#demo-account").hidden = true;
    $(".lab").hidden = true;
    $(".demo-banner").innerHTML =
      '<span class="dot"></span> 실제 자금 · BNB Smart Chain · 감사받지 않은 컨트랙트입니다. 잃어도 되는 금액만 사용하세요';
    $(".demo-banner").classList.add("live");
    renderVerify();
  }
  $("#demo-account").innerHTML =
    '<option value="">체험 지갑 선택</option>' +
    (config.demoAccounts || [])
      .map(
        (a, i) =>
          `<option value="${i + 1}">체험 ${i + 1} · ${esc(short(a))}</option>`,
      )
      .join("");
  $("#connect-qr").hidden = config.demo || !WC_PROJECT_ID;
  if (window.ethereum && !wallets.some((w) => w.provider === window.ethereum))
    wallets.push({
      info: { name: "브라우저 지갑" },
      provider: window.ethereum,
    });
  renderWallets();
  const openTab = recall("sessionStorage", TAB_KEY);
  if (document.querySelector(`[data-tab="${CSS.escape(openTab ?? "")}"]`))
    tab = openTab;
  if (tab === "swap" && !swapOn()) tab = "borrow";
  await refresh();
  status(readyText(), "success");
  await restoreWallet();
}
init().catch((e) => {
  status(errorMessage(e), "error");
  $("#cards").innerHTML =
    '<div class="empty">체인에 연결하지 못했습니다.<small>잠시 후 새로고침하세요. 로컬 체험은 npm run dev로 시작합니다.</small></div>';
});
