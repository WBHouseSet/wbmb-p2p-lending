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
// Oracle-free market: maker-fixed collateral, maturity-only settlement, no price feed.
const fixed = () => config?.oracleFree === true;
// Council-price market: collateral and liquidation follow the relayed Mobick council price.
const council = () => config?.policy === "council";
// Markets whose fees go to a plain fee wallet (no burner contract).
const vault = () => fixed() || council();
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
let staleDelay = "";
// The market's shortest grace, read from the chain (council market only).
let minGraceText = "";
// Addresses and the RPC endpoint compiled into a live build. A live page only talks to exactly these.
const PINNED = typeof __PINNED__ === "undefined" ? null : __PINNED__;
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
  return `<div class="liq ${level}"><div class="liq-head"><span>청산 가격</span><strong data-liq-price>${priceUp(liq)} USDT</strong></div><div class="liq-bar" aria-hidden="true"><i style="width:${fill.toFixed(1)}%"></i></div><div class="liq-foot">${pct === null ? "" : `지금 ${fmt(currentPrice, 18, 2)} USDT · `}<b data-liq-margin>${margin}</b></div></div>`;
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
    ["수수료", `이자의 ${feePct}% (빌린 사람이 이자에 더해 냄)`],
  ];
  return `<dl class="terms">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl><p class="terms-foot">가격은 모빅 카운슬 가격을 따릅니다. ${staleNote()}</p>`;
};
// The one disclosure of the stale-price escape; every council text that promises the borrower the rest uses it.
const staleNote = () =>
  `가격 갱신이 끊긴 채로 유예 종료와 가격 만료 뒤 각각 ${staleDelay}이 지나면 마지막 가격으로 정산됩니다.`;
const spenderLine = () =>
  `승인 대상 컨트랙트: ${contracts.lending.target} (토큰 사용 승인은 이 주소에만 합니다)`;
const feeWord = () => (vault() ? "수수료" : "소각 수수료");
const ratioText = (o) =>
  o.collateralTotal > 0n
    ? `1 WBMB당 ${fmt((o.total * 100000000n) / o.collateralTotal)} USDT`
    : "—";
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
function status(message, type = "") {
  $("#status").textContent = message;
  $("#status").className = type;
}
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
function invalidateWallet() {
  if (wallet?.removeListener) {
    wallet.removeListener("accountsChanged", invalidateWallet);
    wallet.removeListener("chainChanged", invalidateWallet);
  }
  revision++;
  signer = null;
  address = null;
  wallet = null;
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
  if (wallet?.removeListener) {
    wallet.removeListener("accountsChanged", invalidateWallet);
    wallet.removeListener("chainChanged", invalidateWallet);
  }
  wallet = selected;
  selected.on?.("accountsChanged", invalidateWallet);
  selected.on?.("chainChanged", invalidateWallet);
  const provider = new BrowserProvider(selected, "any");
  provider.pollingInterval = config.demo ? 100 : 3000;
  $("#demo-account").value = "";
  await useSigner(await provider.getSigner(), "연결된 지갑");
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
    const send = async (promise) => {
      const transaction = await promise;
      status(`확정 대기 중 · ${short(transaction.hash)}`);
      const receipt = await transaction.wait();
      if (receipt.status !== 1) throw new Error("거래가 되돌려졌습니다.");
      return receipt;
    };
    const approve = async (token, value) => {
      await assertSession();
      const contract = token.connect(activeSigner),
        current = await token.allowance(
          activeAddress,
          contracts.lending.target,
        );
      if (current < value) {
        status("토큰 사용 승인 중 · 다음에 본 거래를 확인합니다.");
        if (current > 0n)
          await send(contract.approve(contracts.lending.target, 0));
        await assertSession();
        await send(contract.approve(contracts.lending.target, value));
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
    if (address) {
      const [u, w] = await Promise.all([
        contracts.usdt.balanceOf(address),
        contracts.wbmb.balanceOf(address),
      ]);
      $("#wallet-balances").textContent = `${fmt(u)} USDT · ${fmt(w, 8)} WBMB`;
    }
    await render();
  } finally {
    loading = false;
  }
}
function offerCard(o) {
  const own = address?.toLowerCase() === o.maker.toLowerCase();
  const active = !o.closed && Number(o.expiresAt) > latest;
  const minimum = o.remaining < o.minFill ? o.remaining : o.minFill;
  // Only reachable in "내 거래": the market tabs never list a non-standard council offer.
  const odd = council() && !standardCouncilOffer(o);
  return `<article class="card" data-offer="${o.id}"><div class="card-top"><span class="badge ${o.side === 0 ? "neutral" : ""}">${o.side === 0 ? "빌리고 싶어요" : "빌려드려요"}${odd ? " · 비표준 조건" : ""}</span><span class="card-id">#${o.id} · ${esc(short(o.maker))}</span></div><h3>${fmt(o.remaining)} <small>USDT</small></h3><span class="sub">${active ? "남은 참여 가능 금액" : o.closed ? "종료된 게시글" : "게시기간 만료"}</span><dl><div><dt>고정 연이율</dt><dd>${percent(o.terms.aprBps)}% APR</dd></div><div><dt>대출 기간</dt><dd>${durationText(o.terms.duration)}</dd></div><div><dt>최소 참여</dt><dd>${fmt(minimum)} USDT</dd></div>${fixed() ? `<div><dt>담보 비율</dt><dd>${ratioText(o)}</dd></div>` : council() && !odd ? "" : `<div><dt>${council() ? "담보 여유" : "헤어컷"}</dt><dd>${percent(o.terms.haircutBps)}%</dd></div>${council() ? `<div><dt>청산선</dt><dd>${percent(o.terms.liquidationBps)}%</dd></div>` : ""}`}</dl><div class="mode">${council() && !odd ? "" : `${modeText(o.terms.mode)}<br>만기 후 유예 ${durationText(o.terms.grace)} · `}게시 만료 ${date(o.expiresAt)}${odd ? `<br>이 화면의 표준 조건(담보 여유 ${percent(COUNCIL_TERMS.haircutBps)}% · 청산선 ${councilLine()}% · 유예 ${councilGrace()})과 달라 시장 목록에 나오지 않고 이 화면에서 체결되지 않습니다.` : ""}</div>${active && !own ? `<div class="input-row"><input data-fill-amount="${o.id}" aria-label="거래 ${o.id} 참여 금액" value="${formatUnits(minimum, 18)}" inputmode="decimal" /><button class="button primary" data-action="fill" data-id="${o.id}">${o.side === 0 ? "빌려주기" : "빌리기"}</button></div>` : ""}${own && !o.closed ? `<div class="row-actions"><button class="button outline small" data-action="close" data-id="${o.id}">미체결분 회수</button></div>` : ""}</article>`;
}
function loanCard(l) {
  const isBorrower = address?.toLowerCase() === l.borrower.toLowerCase();
  const state = ["없음", "진행 중", "USDT 상환 완료", "WBMB 정산 완료"][
    l.status
  ];
  const due = l.maturity + BigInt(l.terms.grace);
  return `<article class="card" data-loan="${l.id}"><div class="card-top"><span class="badge">${isBorrower ? "빌린 거래" : "빌려준 거래"} · ${state}</span><span class="card-id">대출 #${l.id}</span></div><h3>${fmt(l.debt, 18, 6)} <small>USDT</small></h3><span class="sub">${l.status === 1 ? "미상환 원금 + 발생 이자 (수수료 별도)" : "현재 남은 부채"}</span><dl><div><dt>배정 담보</dt><dd>${fmt(l.collateral, 8, 8)} WBMB</dd></div><div><dt>고정 연이율</dt><dd>${percent(l.terms.aprBps)}% APR</dd></div></dl>${council() && l.status === 1 && Number(l.terms.mode) === 0 && l.collateral > 0n ? liquidationBlock(l) : ""}<div class="mode">${council() && Number(l.terms.mode) === 0 ? `갚는 기한 ${date(due)} (만기 ${date(l.maturity)})` : `${modeText(l.terms.mode)}<br>만기 ${date(l.maturity)} · 유예 종료 ${date(due)}`}</div>${l.status === 1 && isBorrower ? `${fixed() ? "" : `<div class="input-row"><input data-topup-amount="${l.id}" aria-label="대출 ${l.id} 추가 담보" value="0.1" inputmode="decimal" /><button class="button outline small" data-action="topup" data-id="${l.id}">담보 추가</button></div>`}<div class="input-row"><input data-repay-amount="${l.id}" aria-label="대출 ${l.id} 상환 원금" value="${formatUnits(l.principal, 18)}" inputmode="decimal" /><button class="button primary small" data-action="repay" data-id="${l.id}">상환</button></div><div class="row-actions"><button class="text-button" data-action="interest" data-id="${l.id}">이자만 납부</button></div>` : ""}${l.status === 1 ? `<div class="row-actions"><button class="button outline small" data-action="settle" data-id="${l.id}">WBMB 정산 조건 확인</button></div>` : ""}<p class="loan-detail">${l.status === 3 ? "USDT로 상환된 것이 아닙니다. 수령 가능한 WBMB는 위 잔액에서 확인하세요." : fixed() || (council() && Number(l.terms.mode) !== 0) ? `유예 종료(${date(due)})까지 전액 상환하지 않으면 남은 담보 전부가 대출자에게 넘어갑니다. 일부 상환으로는 담보가 풀리지 않습니다.` : council() ? `카운슬 가격이 청산 가격 이하로 내려가거나 ${date(due)}까지 갚지 않으면 정산됩니다. 대출자는 빚 + ${bonusPct}%어치의 WBMB를 받고 나머지는 차입자에게 돌아갑니다. 담보를 추가하면 청산 가격이 내려갑니다.` : "담보 추가는 만기 연장이 아닙니다. 체결된 원금은 대출자가 임의 회수할 수 없습니다."}</p></article>`;
}
async function render() {
  if (!contracts) return;
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
    b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
  });
  const descriptions = {
    borrow:
      "USDT를 빌려주는 사람들의 제안입니다. 원하는 금액만큼 WBMB를 맡기고 참여하세요.",
    lend: "WBMB를 담보로 맡기는 사람들의 요청입니다. 조건을 확인하고 USDT로 일부 참여하세요.",
    mine: "내 게시글, 체결된 대출, 지금 수령할 수 있는 자산을 확인합니다.",
    burn: vault()
      ? `차입자가 낸 이자의 ${feePct}%가 별도 수수료로 쌓입니다. 현재는 소각하지 않고 아래 수수료 지갑으로 보관합니다.`
      : "지급된 이자의 별도 수수료만 소각 재원으로 사용합니다. 개발자에게 배분하지 않습니다.",
  };
  $("#tab-description").textContent = descriptions[tab];
  $("#market-terms").hidden = !council() || tab === "burn";
  if (council()) $("#market-terms").innerHTML = councilTermsHtml();
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
      filtered.map(offerCard).join("") ||
      '<div class="empty">아직 열린 거래가 없습니다.<small>원하는 조건으로 첫 제안을 올려보세요.</small></div>';
  } else if (tab === "mine") {
    if (!address)
      html =
        '<div class="empty">지갑을 연결하면 내 거래가 보입니다.<small>상단에서 체험 지갑을 선택해 볼 수 있습니다.</small></div>';
    else {
      const [u, w] = await Promise.all([
        contracts.lending.claimableUSDT(address),
        contracts.lending.claimableWBMB(address),
      ]);
      html = `<div class="claim-box"><p>지금 수령 가능<br><strong>${fmt(u, 18, 8)} USDT · ${fmt(w, 8, 8)} WBMB</strong></p><div class="row-actions"><button class="button primary small" data-action="claimUSDT" ${u === 0n ? "disabled" : ""}>USDT 수령</button> <button class="button outline small" data-action="claimWBMB" ${w === 0n ? "disabled" : ""}>WBMB 수령</button></div></div>`;
      html +=
        '<h3 class="section-title">체결된 대출</h3>' +
        (myLoans.map(loanCard).join("") ||
          '<div class="empty">아직 체결된 대출이 없습니다.</div>');
      html +=
        '<h3 class="section-title">내 게시글</h3>' +
        myOffers.map(offerCard).join("");
    }
  } else if (vault()) {
    const [pending, held] = await Promise.all([
      contracts.lending.feeBalance(),
      contracts.usdt.balanceOf(config.feeWallet),
    ]);
    html = `<div class="burn-stats"><article class="card"><span class="sub">컨트랙트에 쌓인 수수료 · USDT</span><strong>${fmt(pending, 18, 8)}</strong><div class="row-actions"><button class="button outline small" data-action="flush" ${pending === 0n ? "disabled" : ""}>수수료 지갑으로 이동</button></div></article><article class="card"><span class="sub">수수료 지갑 · ${esc(short(config.feeWallet))}</span><strong>${fmt(held, 18, 8)}</strong><p class="sub">지갑의 USDT 잔액 전체 (수수료 외 금액 포함 가능)</p></article></div><p class="burn-description">수수료 지갑 주소는 컨트랙트 생성 시 고정되어 바꿀 수 없습니다. 누구나 이동을 실행할 수 있지만 받는 곳은 항상 이 지갑입니다. 수수료는 소각되지 않으며 운영자가 보관합니다. 대출자 원금·이자와 담보는 수수료 지갑으로 이동할 수 없습니다.</p>`;
  } else {
    const [pending, ready, burned, used] = await Promise.all([
      contracts.lending.feeBalance(),
      contracts.usdt.balanceOf(config.addresses.burner),
      contracts.burner.totalWBMBBurned(),
      contracts.burner.totalUSDTUsed(),
    ]);
    html = `<div class="burn-stats"><article class="card"><span class="sub">수수료 적립 · USDT</span><strong>${fmt(pending, 18, 8)}</strong><div class="row-actions"><button class="button outline small" data-action="flush" ${pending === 0n ? "disabled" : ""}>소각 재원으로 이동</button></div></article><article class="card"><span class="sub">모의 매입 대기 · USDT</span><strong>${fmt(ready, 18, 8)}</strong><div class="row-actions"><button class="button primary small" data-action="burn" ${ready < 10n ** 12n ? "disabled" : ""}>모의 매입·소각</button></div></article><article class="card"><span class="sub">모의 WBMB 소각량</span><strong>${fmt(burned, 8, 8)}</strong><p class="sub">사용한 모의 USDT ${fmt(used, 18, 8)}</p></article></div><p class="burn-description">이 화면의 소각은 로컬 모의 토큰의 공급량을 줄이는 실험입니다. 실제 Uniswap 매입이나 실제 WBMB·원본 BMB 소각이 아닙니다. 소각 처리에 실패해도 대출 상환·담보 수령은 영향을 받지 않습니다.</p>`;
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
  dropTyped = false;
  if (busy) lock(true);
}

async function handleAction(action, id) {
  if (!signer) {
    status("먼저 지갑을 연결하거나 체험 지갑을 선택하세요.", "error");
    return;
  }
  if (action === "fill") {
    // Before any amount check, so an empty field on an expired price still explains the real reason.
    if (council() && !priceSet)
      throw new Error(
        "첫 카운슬 가격이 아직 등록되지 않아 체결할 수 없습니다. 가격이 올라온 뒤 다시 시도하세요.",
      );
    if (council() && !priceLive)
      throw new Error("카운슬 가격이 만료되어 지금은 체결할 수 없습니다.");
    const input = amount($(`[data-fill-amount="${id}"]`).value),
      o = await contracts.lending.getOffer(id);
    if (council() && !standardCouncilOffer(o))
      throw new Error(
        "이 게시글은 화면의 표준 조건과 달라 여기서 체결할 수 없습니다.",
      );
    const collateral = await contracts.lending.quoteFill(id, input);
    const interest =
      (input * BigInt(o.terms.aprBps) * BigInt(o.terms.duration)) /
      (10000n * 31536000n);
    // Filling a borrow request makes me the lender; filling a lend offer makes me the borrower.
    const lending_ = Number(o.side) === 0;
    const token = lending_ ? contracts.usdt : contracts.wbmb;
    const repayBy = latest + Number(o.terms.duration) + Number(o.terms.grace);
    // In the council market a settled lender receives debt plus the bonus, never "the collateral",
    // and the borrower must see where this very fill would be liquidated before confirming.
    const lenderGets = council()
      ? `상환되면 원금과 이자(USDT), 정산되면 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB(담보가 모자라면 담보 전부)`
      : "상환되면 원금과 이자(USDT), 미상환이면 담보 WBMB";
    const liquidationLine = council()
      ? `\n청산선 ${percent(o.terms.liquidationBps)}% · 청산 가격: ${priceUp(liquidationPrice({ debt: input, collateral, terms: o.terms }))} USDT 이하 (지금 카운슬 가격 ${fmt(currentPrice)} USDT · 이자가 쌓이면 청산 가격도 올라갑니다)`
      : "";
    const settlementLine = council()
      ? `카운슬 가격이 청산 가격 이하로 내려가거나 상환 기한까지 갚지 않으면 정산됩니다. 정산되면 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB가 대출자에게 가고 나머지 담보는 차입자에게 돌아갑니다. 대출자는 USDT 대신 WBMB를 받습니다. ${staleNote()}`
      : "담보 정산 시 대출자는 USDT 대신 WBMB를 받습니다.";
    await txAction(
      "부분 체결",
      `${lending_ ? "USDT를 빌려줍니다" : "WBMB를 맡기고 USDT를 빌립니다"} · 게시글 #${id}\n내가 보내는 것: ${lending_ ? full(input) + " USDT" : full(collateral, 8) + " WBMB (담보)"}\n내가 받는 것: ${lending_ ? lenderGets : full(input) + " USDT"}\n배정 담보: ${fmt(collateral, 8, 8)} WBMB\n담보 비율: ${ratioText({ total: input, collateralTotal: collateral })}${liquidationLine}\nAPR ${percent(o.terms.aprBps)}% · 기간 ${durationText(o.terms.duration)} · 유예 ${durationText(o.terms.grace)}\n상환 기한(유예 포함): ${date(repayBy)} 무렵\n만기까지 예상 이자 ${fmt(interest, 18, 8)} USDT (${feeWord()} 별도)\n${modeText(o.terms.mode)}\n${settlementLine}\n${spenderLine()}`,
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
      `상환 원금 ${full(value)} USDT\n발생 이자 ${fmt(q.interest, 18, 8)} USDT\n${feeWord()} ${fmt(q.fee, 18, 8)} USDT\n현재 합계 ${fmt(q.total, 18, 8)} USDT\n확정 대기 중 이자를 포함한 최대 승인액 ${fmt(max, 18, 10)} USDT\n${value < l.principal ? (council() && Number(l.terms.mode) === 0 ? `일부만 갚으면 담보는 풀리지 않습니다. 카운슬 가격이 청산 가격 이하로 내려가거나 유예가 끝날 때까지 남은 원금을 갚지 않으면, 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB가 대출자에게 가고 나머지는 돌려받습니다. ${staleNote()}` : "일부만 갚으면 담보는 풀리지 않습니다. 유예가 끝날 때까지 남은 원금을 갚지 않으면 담보 전부가 대출자에게 넘어갑니다.") : "전액 상환하면 담보 WBMB를 수령할 수 있습니다."}\n${spenderLine()}`,
      async (ctx) => {
        await ctx.approve(contracts.usdt, max);
        await ctx.send(ctx.lending.repay(id, value, max));
      },
    );
  } else if (action === "settle") {
    const q = await contracts.lending.quoteSettlement(id);
    // quoteSettlement also reports price 0 for maturity-only loans, so the stale-price wording needs the loan's mode.
    const priced =
      council() &&
      Number((await contracts.lending.getLoan(id)).terms.mode) === 0;
    await txAction(
      "WBMB 정산",
      `대출 #${id}를 WBMB로 종료합니다.\n대출자 귀속 ${fmt(q.toLender, 8, 8)} WBMB\n차입자 반환 ${fmt(q.toBorrower, 8, 8)} WBMB\n종료 부채 ${fmt(q.debt, 18, 8)} USDT${council() ? (priced ? (q.price === 0n ? "\n쓸 수 있는 가격이 없어 담보 전부가 대출자에게 갑니다." : `\n적용 가격 ${fmt(q.price)} USDT${priceLive ? "" : " (가격 갱신이 끊겨 마지막 가격을 씁니다)"} · 보너스 ${bonusPct}% 포함`) : `\n${modeText(1)}`) : ""}\nUSDT가 지급되는 것이 아니며 이 대출의 채권은 컨트랙트에서 종료됩니다.`,
      (ctx) => ctx.send(ctx.lending.settle(id)),
    );
  } else if (action === "claimUSDT" || action === "claimWBMB") {
    const unit = action === "claimUSDT" ? "USDT" : "WBMB";
    const value =
      await contracts.lending[
        action === "claimUSDT" ? "claimableUSDT" : "claimableWBMB"
      ](address);
    await txAction(
      `${unit} 수령`,
      `${fmt(value, unit === "USDT" ? 18 : 8, 8)} ${unit}를 현재 연결한 지갑으로 수령합니다.`,
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
    let value = await contracts.usdt.balanceOf(config.addresses.burner);
    if (value > parseUnits("1000", 18)) value = parseUnits("1000", 18);
    const [, price] = await contracts.oracle.prices(),
      out = (value * 100000000n) / price;
    await txAction(
      "모의 매입·소각",
      `${fmt(value, 18, 8)} 모의 USDT로 ${fmt(out, 8, 8)} 모의 WBMB를 소각합니다. 실제 시장 매입이 아닙니다.`,
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
  handleAction(button.dataset.action, Number(button.dataset.id)).catch((e) =>
    status(errorMessage(e), "error"),
  );
});
document.querySelectorAll("[data-tab]").forEach((button) =>
  button.addEventListener("click", () => {
    if (busy) return;
    tab = button.dataset.tab;
    render().catch((e) => status(errorMessage(e), "error"));
  }),
);
$("#connect").onclick = () =>
  connectWallet().catch((e) => status(errorMessage(e), "error"));
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
    if (wallet?.removeListener) {
      wallet.removeListener("accountsChanged", invalidateWallet);
      wallet.removeListener("chainChanged", invalidateWallet);
      wallet = null;
    }
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
  $("#offer-dialog").showModal();
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
form.elements.side.onchange = syncOfferForm;
form.elements.mode.onchange = () => {
  $("#mode-warning").hidden = form.elements.mode.value !== "1";
};
form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const side = Number(form.elements.side.value),
      total = amount(form.elements.total.value);
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
    $("#offer-dialog").close();
    await txAction(
      "거래 게시",
      `${side === 0 ? "USDT 빌리기" : "USDT 빌려주기"} · 한도 ${fmt(total)} USDT\n최소 참여 ${fmt(minFill)} USDT · APR ${percent(apr)}% · ${days}일\n${modeText(mode)}\n내가 보내는 것: ${side === 0 ? full(collateral, 8) + " WBMB" : full(total) + " USDT"} (미체결 주문에 잠기며, 미체결분은 취소 후 수령할 수 있습니다)${needsCollateral ? `\n담보 비율: ${ratioText({ total, collateralTotal: collateral })} — 한도 전체 ${full(total)} USDT에 담보 ${full(collateral, 8)} WBMB. 숫자와 단위를 다시 확인하세요.` : ""}${side === 1 && fixed() ? "\n차입자는 이 비율대로만 담보를 맡기고 빌릴 수 있습니다. 담보를 너무 적게 적으면 누구나 즉시 전액을 빌려갈 수 있습니다." : ""}\n${council() ? `카운슬 가격이 청산 가격 이하로 내려가거나 만기 후 유예 ${councilGrace()}이 지나면, 부채에 보너스 ${bonusPct}%를 더한 만큼의 WBMB가 대출자에게 가고 나머지는 차입자에게 돌아갑니다. ${staleNote()}` : "만기 후 유예 1일이 지나면 미상환 대출의 담보는 대출자에게 넘어갑니다."}\n이자 지급액의 ${feePct}% 수수료가 별도로 부과됩니다.\n${spenderLine()}`,
      async (ctx) => {
        await ctx.approve(
          side === 0 ? contracts.wbmb : contracts.usdt,
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
    ["lending", "usdt", "wbmb"].every((k) =>
      sameAddress(config.addresses?.[k], PINNED[k]),
    ) &&
    sameAddress(config.feeWallet, PINNED.feeWallet);
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
    ? { lending: "P2PLending", usdt: null, wbmb: null }
    : council()
      ? {
          lending: "P2PLending",
          usdt: null,
          wbmb: null,
          oracle: "CouncilPricePolicy",
        }
      : {
          lending: "P2PLending",
          usdt: "MockToken",
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
    const [policy, feeVault, onchainUsdt, onchainWbmb, feeBps] =
      await Promise.all([
        contracts.lending.pricePolicy(),
        contracts.lending.feeVault(),
        contracts.lending.usdt(),
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
      !same(onchainUsdt, config.addresses.usdt) ||
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
  syncOfferForm();
  if (!config.demo) {
    $("#demo-account").hidden = true;
    $(".lab").hidden = true;
    $(".demo-banner").innerHTML =
      '<span class="dot"></span> 실제 자금 · BNB Smart Chain · 감사받지 않은 컨트랙트입니다. 잃어도 되는 금액만 사용하세요';
    $(".demo-banner").classList.add("live");
  }
  $("#demo-account").innerHTML =
    '<option value="">체험 지갑 선택</option>' +
    (config.demoAccounts || [])
      .map(
        (a, i) =>
          `<option value="${i + 1}">체험 ${i + 1} · ${esc(short(a))}</option>`,
      )
      .join("");
  if (window.ethereum && !wallets.some((w) => w.provider === window.ethereum))
    wallets.push({
      info: { name: "브라우저 지갑" },
      provider: window.ethereum,
    });
  renderWallets();
  await refresh();
  status(
    config.demo
      ? "로컬 체인 준비 완료 · 체험 지갑을 선택하면 바로 거래할 수 있습니다."
      : "BNB Smart Chain 연결 완료 · 지갑을 연결하면 거래할 수 있습니다.",
    "success",
  );
}
init().catch((e) => {
  status(errorMessage(e), "error");
  $("#cards").innerHTML =
    '<div class="empty">체인에 연결하지 못했습니다.<small>잠시 후 새로고침하세요. 로컬 체험은 npm run dev로 시작합니다.</small></div>';
});
