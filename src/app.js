import {
  BrowserProvider,
  JsonRpcProvider,
  Contract,
  parseUnits,
  formatUnits,
} from "ethers";
import "./style.css";

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
    STALE_PRICE:
      "모의 가격이 만료됐습니다. 실험실에서 가격을 갱신하세요. 상환·담보 추가·수령은 계속 가능합니다.",
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
  if (BigInt(id) !== 31337n)
    throw new Error(
      "이 프로젝트는 로컬 체인 31337에서만 거래합니다. 실제 BSC 자금은 사용할 수 없습니다.",
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
      "설치된 지갑이 없습니다. ‘체험 지갑 선택’으로 로컬 모의 거래를 해보세요.",
    );
  await selected.request({ method: "eth_requestAccounts" });
  if (BigInt(await selected.request({ method: "eth_chainId" })) !== 31337n) {
    try {
      await selected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x7a69" }],
      });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await selected.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x7a69",
            chainName: "WBMB Local Demo",
            rpcUrls: [config.rpcUrl],
            nativeCurrency: { name: "Test ETH", symbol: "ETH", decimals: 18 },
          },
        ],
      });
      await selected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x7a69" }],
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
  provider.pollingInterval = 100;
  $("#demo-account").value = "";
  await useSigner(await provider.getSigner(), "연결된 지갑");
}
async function txAction(title, message, action) {
  if (busy) return;
  if (!signer || !address) {
    status("먼저 체험 지갑을 선택하거나 지갑을 연결하세요.", "error");
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
    const [oc, lc, low, current, observed, block] = await Promise.all([
      contracts.lending.offerCount(),
      contracts.lending.loanCount(),
      contracts.oracle.weekLow(),
      contracts.oracle.current(),
      contracts.oracle.observedAt(),
      read.getBlock("latest"),
    ]);
    latest = block.timestamp;
    $("#offer-count").textContent = oc.toString();
    $("#loan-count").textContent = lc.toString();
    $("#week-price").textContent = fmt(low);
    $("#current-price").textContent = fmt(current);
    $("#price-state").textContent =
      latest - Number(observed) > 7200
        ? "가격 만료 · 신규 체결 중단"
        : `갱신 ${date(observed)}`;
    const ids = (n) =>
      Array.from(
        { length: Math.min(Number(n), limit) },
        (_, i) => Number(n) - i,
      );
    [offers, loans] = await Promise.all([
      Promise.all(
        ids(oc).map(async (id) => ({
          id,
          ...(await contracts.lending
            .getOffer(id)
            .then((o) => ({
              maker: o.maker,
              side: Number(o.side),
              closed: o.closed,
              expiresAt: o.expiresAt,
              total: o.total,
              remaining: o.remaining,
              minFill: o.minFill,
              collateralRemaining: o.collateralRemaining,
              terms: o.terms,
            }))),
        })),
      ),
      Promise.all(
        ids(lc).map(async (id) => {
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
        }),
      ),
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
  return `<article class="card" data-offer="${o.id}"><div class="card-top"><span class="badge ${o.side === 0 ? "neutral" : ""}">${o.side === 0 ? "빌리고 싶어요" : "빌려드려요"}</span><span class="card-id">#${o.id} · ${esc(short(o.maker))}</span></div><h3>${fmt(o.remaining)} <small>USDT</small></h3><span class="sub">${active ? "남은 참여 가능 금액" : o.closed ? "종료된 게시글" : "게시기간 만료"}</span><dl><div><dt>고정 연이율</dt><dd>${percent(o.terms.aprBps)}% APR</dd></div><div><dt>대출 기간</dt><dd>${Number(o.terms.duration) / 86400}일</dd></div><div><dt>최소 참여</dt><dd>${fmt(minimum)} USDT</dd></div><div><dt>헤어컷</dt><dd>${percent(o.terms.haircutBps)}%</dd></div></dl><div class="mode">${modeText(o.terms.mode)}<br>게시 만료 ${date(o.expiresAt)}</div>${active && !own ? `<div class="input-row"><input data-fill-amount="${o.id}" aria-label="거래 ${o.id} 참여 금액" value="${formatUnits(minimum, 18)}" inputmode="decimal" /><button class="button primary" data-action="fill" data-id="${o.id}">${o.side === 0 ? "빌려주기" : "빌리기"}</button></div>` : ""}${own && !o.closed ? `<div class="row-actions"><button class="button outline small" data-action="close" data-id="${o.id}">미체결분 회수</button></div>` : ""}</article>`;
}
function loanCard(l) {
  const isBorrower = address?.toLowerCase() === l.borrower.toLowerCase();
  const state = ["없음", "진행 중", "USDT 상환 완료", "WBMB 정산 완료"][
    l.status
  ];
  const due = l.maturity + BigInt(l.terms.grace);
  return `<article class="card" data-loan="${l.id}"><div class="card-top"><span class="badge">${isBorrower ? "빌린 거래" : "빌려준 거래"} · ${state}</span><span class="card-id">대출 #${l.id}</span></div><h3>${fmt(l.debt, 18, 6)} <small>USDT</small></h3><span class="sub">${l.status === 1 ? "미상환 원금 + 발생 이자 (수수료 별도)" : "현재 남은 부채"}</span><dl><div><dt>배정 담보</dt><dd>${fmt(l.collateral, 8, 8)} WBMB</dd></div><div><dt>고정 연이율</dt><dd>${percent(l.terms.aprBps)}% APR</dd></div></dl><div class="mode">${modeText(l.terms.mode)}<br>만기 ${date(l.maturity)} · 유예 종료 ${date(due)}</div>${l.status === 1 && isBorrower ? `<div class="input-row"><input data-topup-amount="${l.id}" aria-label="대출 ${l.id} 추가 담보" value="0.1" inputmode="decimal" /><button class="button outline small" data-action="topup" data-id="${l.id}">담보 추가</button></div><div class="input-row"><input data-repay-amount="${l.id}" aria-label="대출 ${l.id} 상환 원금" value="${formatUnits(l.principal, 18)}" inputmode="decimal" /><button class="button primary small" data-action="repay" data-id="${l.id}">상환</button></div><div class="row-actions"><button class="text-button" data-action="interest" data-id="${l.id}">이자만 납부</button></div>` : ""}${l.status === 1 ? `<div class="row-actions"><button class="button outline small" data-action="settle" data-id="${l.id}">WBMB 정산 조건 확인</button></div>` : ""}<p class="loan-detail">${l.status === 3 ? "USDT로 상환된 것이 아닙니다. 수령 가능한 WBMB는 위 잔액에서 확인하세요." : "담보 추가는 만기 연장이 아닙니다. 체결된 원금은 대출자가 임의 회수할 수 없습니다."}</p></article>`;
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
    burn: "지급된 이자의 별도 수수료만 소각 재원으로 사용합니다. 개발자에게 배분하지 않습니다.",
  };
  $("#tab-description").textContent = descriptions[tab];
  $("#load-more").hidden = !more || tab === "burn";
  let html = "";
  if (tab === "borrow" || tab === "lend") {
    const side = tab === "borrow" ? 1 : 0;
    const filtered = offers.filter(
      (o) => o.side === side && !o.closed && Number(o.expiresAt) > latest,
    );
    html =
      filtered.map(offerCard).join("") ||
      '<div class="empty">아직 열린 거래가 없습니다.<small>원하는 조건으로 첫 제안을 올려보세요.</small></div>';
  } else if (tab === "mine") {
    if (!address)
      html =
        '<div class="empty">지갑을 연결하면 내 거래가 보입니다.<small>상단에서 체험 지갑을 선택해 볼 수 있습니다.</small></div>';
    else {
      const a = address.toLowerCase();
      const [u, w] = await Promise.all([
        contracts.lending.claimableUSDT(address),
        contracts.lending.claimableWBMB(address),
      ]);
      html = `<div class="claim-box"><p>지금 수령 가능<br><strong>${fmt(u, 18, 8)} USDT · ${fmt(w, 8, 8)} WBMB</strong></p><div class="row-actions"><button class="button primary small" data-action="claimUSDT" ${u === 0n ? "disabled" : ""}>USDT 수령</button> <button class="button outline small" data-action="claimWBMB" ${w === 0n ? "disabled" : ""}>WBMB 수령</button></div></div>`;
      const mine = loans.filter(
        (l) => l.borrower.toLowerCase() === a || l.lender.toLowerCase() === a,
      );
      html +=
        '<h3 class="section-title">체결된 대출</h3>' +
        (mine.map(loanCard).join("") ||
          '<div class="empty">아직 체결된 대출이 없습니다.</div>');
      html +=
        '<h3 class="section-title">내 게시글</h3>' +
        offers
          .filter((o) => o.maker.toLowerCase() === a)
          .map(offerCard)
          .join("");
    }
  } else {
    const [pending, ready, burned, used] = await Promise.all([
      contracts.lending.feeBalance(),
      contracts.usdt.balanceOf(config.addresses.burner),
      contracts.burner.totalWBMBBurned(),
      contracts.burner.totalUSDTUsed(),
    ]);
    html = `<div class="burn-stats"><article class="card"><span class="sub">수수료 적립 · USDT</span><strong>${fmt(pending, 18, 8)}</strong><div class="row-actions"><button class="button outline small" data-action="flush" ${pending === 0n ? "disabled" : ""}>소각 재원으로 이동</button></div></article><article class="card"><span class="sub">모의 매입 대기 · USDT</span><strong>${fmt(ready, 18, 8)}</strong><div class="row-actions"><button class="button primary small" data-action="burn" ${ready < 10n ** 12n ? "disabled" : ""}>모의 매입·소각</button></div></article><article class="card"><span class="sub">모의 WBMB 소각량</span><strong>${fmt(burned, 8, 8)}</strong><p class="sub">사용한 모의 USDT ${fmt(used, 18, 8)}</p></article></div><p class="burn-description">이 화면의 소각은 로컬 모의 토큰의 공급량을 줄이는 실험입니다. 실제 Uniswap 매입이나 실제 WBMB·원본 BMB 소각이 아닙니다. 소각 처리에 실패해도 대출 상환·담보 수령은 영향을 받지 않습니다.</p>`;
  }
  $("#cards").innerHTML = html;
  if (busy) lock(true);
}

async function handleAction(action, id) {
  if (!signer) {
    status("먼저 지갑을 연결하거나 체험 지갑을 선택하세요.", "error");
    return;
  }
  if (action === "fill") {
    const input = amount($(`[data-fill-amount="${id}"]`).value),
      o = await contracts.lending.getOffer(id);
    const collateral = await contracts.lending.quoteFill(id, input);
    const interest =
      (input * BigInt(o.terms.aprBps) * BigInt(o.terms.duration)) /
      (10000n * 31536000n);
    const token = Number(o.side) === 0 ? contracts.usdt : contracts.wbmb;
    await txAction(
      "부분 체결",
      `${fmt(input)} USDT를 체결합니다.\n배정 담보: ${fmt(collateral, 8, 8)} WBMB\nAPR ${percent(o.terms.aprBps)}% · ${Number(o.terms.duration) / 86400}일\n만기까지 예상 이자 ${fmt(interest, 18, 8)} USDT (소각 수수료 별도)\n${modeText(o.terms.mode)}\n담보 정산 시 대출자는 USDT 대신 WBMB를 받습니다.`,
      async (ctx) => {
        await ctx.approve(token, Number(o.side) === 0 ? input : collateral);
        const block = await read.getBlock("latest");
        await ctx.assertSession();
        await ctx.send(
          ctx.lending.fillOffer(id, input, collateral, block.timestamp + 300),
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
      `상환 원금 ${fmt(value)} USDT\n발생 이자 ${fmt(q.interest, 18, 8)} USDT\n소각 수수료 ${fmt(q.fee, 18, 8)} USDT\n현재 합계 ${fmt(q.total, 18, 8)} USDT\n확정 대기 중 이자를 포함한 최대 승인액 ${fmt(max, 18, 10)} USDT\n전액 상환하면 WBMB를 수령할 수 있습니다.`,
      async (ctx) => {
        await ctx.approve(contracts.usdt, max);
        await ctx.send(ctx.lending.repay(id, value, max));
      },
    );
  } else if (action === "settle") {
    const q = await contracts.lending.quoteSettlement(id);
    await txAction(
      "WBMB 정산",
      `대출 #${id}를 WBMB로 종료합니다.\n대출자 귀속 ${fmt(q.toLender, 8, 8)} WBMB\n차입자 반환 ${fmt(q.toBorrower, 8, 8)} WBMB\n종료 부채 ${fmt(q.debt, 18, 8)} USDT\nUSDT가 지급되는 것이 아니며 이 대출의 채권은 컨트랙트에서 종료됩니다.`,
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
      "적립된 수수료만 고정된 모의 소각 컨트랙트로 이동합니다. 대출자 원금과 담보는 사용하지 않습니다.",
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
form.elements.side.onchange = () => {
  $("#collateral-field").hidden = form.elements.side.value === "1";
};
form.elements.mode.onchange = () => {
  $("#mode-warning").hidden = form.elements.mode.value !== "1";
};
form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    const side = Number(form.elements.side.value),
      total = amount(form.elements.total.value);
    const collateral =
        side === 0 ? amount(form.elements.collateral.value, 8) : 0n,
      minFill = amount(form.elements.minFill.value);
    const days = Number(form.elements.duration.value),
      expiry = Number(form.elements.expiry.value),
      mode = Number(form.elements.mode.value);
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
      (side === 0 && collateral <= 0n)
    )
      throw new Error("금액·담보·금리 범위를 확인하세요.");
    const terms = {
      aprBps: apr,
      haircutBps: 1000,
      liquidationBps: 9500,
      duration: days * 86400,
      grace: 86400,
      mode,
    };
    $("#offer-dialog").close();
    await txAction(
      "거래 게시",
      `${side === 0 ? "USDT 빌리기" : "USDT 빌려주기"} · 한도 ${fmt(total)} USDT\n최소 참여 ${fmt(minFill)} USDT · APR ${percent(apr)}% · ${days}일\n${modeText(mode)}\n${side === 0 ? fmt(collateral, 8, 8) + " WBMB" : fmt(total) + " USDT"}가 미체결 주문에 잠깁니다. 미체결분은 취소 후 수령할 수 있습니다.\n이자 지급액의 5% 수수료가 별도로 부과됩니다.`,
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

async function labAction(seconds) {
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
    const current = seconds
      ? await contracts.oracle.current()
      : amount($("#lab-price").value);
    const oldLow = await contracts.oracle.weekLow(),
      low = current < oldLow ? current : oldLow;
    if (seconds) {
      await read.send("evm_increaseTime", [seconds]);
      await read.send("evm_mine", []);
    }
    const reporter = await read.getSigner(0);
    await (
      await contracts.oracle.connect(reporter).setPrices(low, current)
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

async function init() {
  const responses = await Promise.all([
    fetch("/deployment.json", { cache: "no-store" }),
    fetch("/abis.json", { cache: "no-store" }),
  ]);
  if (responses.some((r) => !r.ok))
    throw new Error(
      "로컬 체인이 실행되지 않았습니다. 프로젝트 폴더에서 npm run dev를 실행하세요.",
    );
  [config, abis] = await Promise.all(responses.map((r) => r.json()));
  if (
    config.chainId !== 31337 ||
    config.demo !== true ||
    !localHost(new URL(config.rpcUrl).hostname)
  )
    throw new Error(
      "허용되지 않은 배포 설정입니다. 이 화면은 로컬 체험용입니다.",
    );
  read = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  read.pollingInterval = 100;
  await validateChain();
  await read.send("hardhat_metadata", []);
  contracts = {};
  const names = {
    lending: "P2PLending",
    usdt: "MockToken",
    wbmb: "MockToken",
    oracle: "MockPricePolicy",
    burner: "MockFeeBurner",
  };
  for (const [key, name] of Object.entries(names)) {
    if ((await read.getCode(config.addresses[key])) === "0x")
      throw new Error(
        "로컬 배포 주소에 컨트랙트가 없습니다. npm run dev로 다시 시작하세요.",
      );
    contracts[key] = new Contract(config.addresses[key], abis[name], read);
  }
  $("#demo-account").innerHTML =
    '<option value="">체험 지갑 선택</option>' +
    config.demoAccounts
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
    "로컬 체인 준비 완료 · 체험 지갑을 선택하면 바로 거래할 수 있습니다.",
    "success",
  );
}
init().catch((e) => {
  status(errorMessage(e), "error");
  $("#cards").innerHTML =
    '<div class="empty">체인 연결을 기다리고 있습니다.<small>npm run dev로 로컬 환경을 시작한 뒤 새로고침하세요.</small></div>';
});
