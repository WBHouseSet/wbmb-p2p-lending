// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPricePolicy} from "./IPricePolicy.sol";

/// Isolated fixed-term P2P loans. Not audited.
/// No owner, upgrade, sweep, arbitrary recipient or fee-change function.
/// With no price policy (address(0)) the market is oracle-free: the maker fixes the
/// collateral amount for the whole offer and loans settle only after maturity + grace.
contract P2PLending is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;
    uint256 public constant WBMB_UNIT = 1e8;
    uint256 public constant MAX_AMOUNT = 1e30;
    uint256 public constant MIN_OFFER = 1e12; // 0.000001 USDT; economic minimum chosen by maker

    enum Side { Borrow, Lend }
    enum Mode { PriceAndMaturity, MaturityOnlyAllCollateral }
    enum Status { None, Active, Repaid, SettledInWBMB }
    struct Terms {
        uint32 aprBps;
        uint32 haircutBps;
        uint32 liquidationBps;
        uint32 duration;
        uint32 grace;
        Mode mode;
    }
    struct Offer {
        address maker;
        Side side;
        bool closed;
        uint64 expiresAt;
        uint256 total;
        uint256 remaining;
        uint256 minFill;
        uint256 collateralTotal;
        uint256 collateralRemaining;
        Terms terms;
    }
    struct Loan {
        address borrower;
        address lender;
        uint256 offerId;
        uint256 principal;
        uint256 collateral;
        uint256 interest;
        uint256 interestRemainder;
        uint256 feeRemainder;
        uint64 startedAt;
        uint64 maturity;
        uint64 lastAccrued;
        Status status;
        Terms terms;
    }

    IERC20 public immutable usdt;
    IERC20 public immutable wbmb;
    IPricePolicy public immutable pricePolicy;
    address public immutable feeVault;
    uint256 public immutable feeBps;
    /// Shortest loan and (oracle-free) shortest grace this deployment accepts, in seconds.
    uint256 public immutable minDuration;
    uint256 public immutable minGrace;
    /// Extra share of the debt a lender receives in WBMB when a priced loan is settled.
    uint256 public immutable liquidationBonusBps;
    /// How long past maturity + grace a priced loan waits for a price before the lender takes all.
    uint256 public immutable staleSettleDelay;
    uint256 public offerCount;
    uint256 public loanCount;
    mapping(uint256 => Offer) private offers;
    mapping(uint256 => Loan) private loans;
    // Per-account ids so a wallet's positions stay findable however many others exist.
    mapping(address => uint256[]) private offerIds;
    mapping(address => uint256[]) private loanIds;
    mapping(address => uint256) public claimableUSDT;
    mapping(address => uint256) public claimableWBMB;
    uint256 public escrowUSDT;
    uint256 public escrowWBMB;
    uint256 public activeCollateral;
    uint256 public totalClaimUSDT;
    uint256 public totalClaimWBMB;
    uint256 public feeBalance;

    event OfferCreated(uint256 indexed id, address indexed maker, Side side, uint256 total);
    event OfferClosed(uint256 indexed id);
    event LoanCreated(uint256 indexed id, address indexed borrower, address indexed lender, uint256 offerId, uint256 principal, uint256 collateral);
    event CollateralAdded(uint256 indexed id, uint256 amount);
    event Repaid(uint256 indexed id, uint256 principal, uint256 interest, uint256 fee);
    event Settled(uint256 indexed id, uint256 lenderWBMB, uint256 borrowerWBMB, uint256 debt, uint256 price);
    event Claimed(address indexed account, address indexed token, uint256 amount);
    event FeesFlushed(uint256 amount);

    constructor(
        address usdt_, address wbmb_, address policy_, address vault_, uint256 feeBps_, uint256 minDuration_, uint256 minGrace_,
        uint256 bonusBps_, uint256 staleDelay_
    ) {
        require(usdt_ != wbmb_ && vault_ != address(0) && (policy_ == address(0) || policy_.code.length > 0), "BAD_CONFIG");
        require(IERC20Metadata(usdt_).decimals() == 18 && IERC20Metadata(wbmb_).decimals() == 8, "DECIMALS");
        require(feeBps_ <= 1000, "FEE_TOO_HIGH");
        usdt = IERC20(usdt_); wbmb = IERC20(wbmb_); pricePolicy = IPricePolicy(policy_);
        require(minDuration_ >= 1 minutes && minDuration_ <= 30 days && minGrace_ >= 1 minutes && minGrace_ <= 7 days, "BAD_LIMITS");
        // The stale delay only matters with a price policy; there it must leave time to restart a relay.
        require(bonusBps_ <= 1000 && staleDelay_ <= 30 days && (policy_ == address(0) || staleDelay_ >= 1 minutes), "BAD_LIMITS");
        feeVault = vault_; feeBps = feeBps_; minDuration = minDuration_; minGrace = minGrace_;
        liquidationBonusBps = bonusBps_; staleSettleDelay = staleDelay_;
    }

    function oracleFree() public view returns (bool) { return address(pricePolicy) == address(0); }
    function getOffer(uint256 id) external view returns (Offer memory) { return offers[id]; }
    function getLoan(uint256 id) external view returns (Loan memory) { return loans[id]; }
    function offerIdsOf(address account) external view returns (uint256[] memory) { return offerIds[account]; }
    function loanIdsOf(address account) external view returns (uint256[] memory) { return loanIds[account]; }

    function createOffer(Side side, uint256 total, uint256 collateral, uint256 minFill, uint64 expiresAt, Terms calldata t)
        external nonReentrant returns (uint256 id)
    {
        require(total >= MIN_OFFER && total <= MAX_AMOUNT && minFill >= MIN_OFFER && minFill <= total, "BAD_AMOUNT");
        require(expiresAt > block.timestamp && expiresAt <= block.timestamp + 90 days, "BAD_EXPIRY");
        require(t.aprBps <= BPS && t.duration >= minDuration && t.duration <= YEAR && t.grace <= 7 days, "BAD_TERM");
        bool fixedRatio = oracleFree();
        // Without price liquidation a late borrower loses everything, so a minimum grace is mandatory.
        if (fixedRatio) require(t.mode == Mode.MaturityOnlyAllCollateral && t.haircutBps == 0 && t.liquidationBps == 0 && t.grace >= minGrace, "ORACLE_FREE_TERMS");
        else {
            require(t.haircutBps >= 100 && t.haircutBps <= 9000 && t.liquidationBps < BPS && BPS - t.haircutBps < t.liquidationBps, "BAD_MARGIN");
            // Settlement costs the borrower the bonus, so a late payment needs the same minimum grace.
            require(t.grace >= minGrace, "BAD_GRACE");
        }
        // Borrow: collateral is escrowed now. Oracle-free Lend: collateral is what borrowers must post for the full offer.
        if (side == Side.Borrow || fixedRatio) require(collateral > 0 && collateral <= MAX_AMOUNT, "BAD_COLLATERAL");
        else require(collateral == 0, "LEND_NO_COLLATERAL");
        id = ++offerCount;
        offerIds[msg.sender].push(id);
        offers[id] = Offer(msg.sender, side, false, expiresAt, total, total, minFill, collateral, collateral, t);
        if (side == Side.Borrow) { escrowWBMB += collateral; _pull(wbmb, msg.sender, collateral); }
        else { escrowUSDT += total; _pull(usdt, msg.sender, total); }
        emit OfferCreated(id, msg.sender, side, total);
    }

    /// Maker may cancel immediately; anyone may close expired offers, always crediting the maker.
    function closeOffer(uint256 id) external nonReentrant {
        Offer storage o = offers[id];
        require(o.maker != address(0) && !o.closed && o.remaining > 0, "OFFER_CLOSED");
        require(msg.sender == o.maker || block.timestamp >= o.expiresAt, "NOT_MAKER");
        o.closed = true;
        if (o.side == Side.Borrow) {
            uint256 amount = o.collateralRemaining;
            o.collateralRemaining = 0; escrowWBMB -= amount; _creditWBMB(o.maker, amount);
        } else { o.collateralRemaining = 0; escrowUSDT -= o.remaining; _creditUSDT(o.maker, o.remaining); }
        o.remaining = 0;
        emit OfferClosed(id);
    }

    function quoteFill(uint256 id, uint256 amount) public view returns (uint256 collateral) {
        Offer storage o = offers[id];
        require(o.maker != address(0) && !o.closed && block.timestamp < o.expiresAt, "OFFER_CLOSED");
        require(amount > 0 && amount <= o.remaining && (amount >= o.minFill || amount == o.remaining), "BAD_FILL");
        bool fixedRatio = oracleFree();
        uint256 opening; uint256 current;
        if (!fixedRatio) {
            (opening, current) = pricePolicy.prices();
            require(opening > 0 && current > 0 && opening <= 1e30 && current <= 1e30, "BAD_PRICE");
        }
        if (o.side == Side.Borrow || fixedRatio) {
            // Cumulative rounding preserves the original escrow exactly across many fills.
            uint256 usedAfter = Math.mulDiv(o.collateralTotal, o.total - o.remaining + amount, o.total, Math.Rounding.Ceil);
            collateral = usedAfter - (o.collateralTotal - o.collateralRemaining);
        } else {
            collateral = Math.mulDiv(amount, WBMB_UNIT * BPS, opening * (BPS - o.terms.haircutBps), Math.Rounding.Ceil);
        }
        require(collateral > 0 && collateral <= MAX_AMOUNT, "BAD_COLLATERAL");
        if (fixedRatio) return collateral;
        uint256 valueOpen = Math.mulDiv(collateral, opening, WBMB_UNIT);
        require(amount <= Math.mulDiv(valueOpen, BPS - o.terms.haircutBps, BPS), "INSUFFICIENT_COLLATERAL");
        uint256 atMaturity = amount + Math.mulDiv(amount, uint256(o.terms.aprBps) * o.terms.duration, BPS * YEAR, Math.Rounding.Ceil);
        require(atMaturity < Math.mulDiv(Math.mulDiv(collateral, current, WBMB_UNIT), o.terms.liquidationBps, BPS), "NO_INTEREST_BUFFER");
    }

    function fillOffer(uint256 id, uint256 amount, uint256 maxCollateral, uint256 deadline) external nonReentrant returns (uint256 loanId) {
        require(block.timestamp <= deadline, "DEADLINE");
        Offer storage o = offers[id];
        require(msg.sender != o.maker, "SELF_FILL");
        uint256 collateral = quoteFill(id, amount);
        require(collateral <= maxCollateral, "COLLATERAL_SLIPPAGE");
        address borrower = o.side == Side.Borrow ? o.maker : msg.sender;
        address lender = o.side == Side.Lend ? o.maker : msg.sender;
        o.remaining -= amount;
        if (o.remaining == 0) o.closed = true;
        if (o.side == Side.Borrow) { o.collateralRemaining -= collateral; escrowWBMB -= collateral; }
        else { if (oracleFree()) o.collateralRemaining -= collateral; escrowUSDT -= amount; }
        activeCollateral += collateral;
        loanId = ++loanCount;
        loanIds[borrower].push(loanId); loanIds[lender].push(loanId);
        Loan storage l = loans[loanId];
        l.borrower = borrower; l.lender = lender; l.offerId = id;
        l.principal = amount; l.collateral = collateral; l.startedAt = uint64(block.timestamp);
        l.lastAccrued = uint64(block.timestamp); l.maturity = uint64(block.timestamp + o.terms.duration);
        l.status = Status.Active; l.terms = o.terms;
        if (o.side == Side.Borrow) _pull(usdt, lender, amount);
        else _pull(wbmb, borrower, collateral);
        _send(usdt, borrower, amount);
        emit LoanCreated(loanId, borrower, lender, id, amount, collateral);
    }

    function addCollateral(uint256 id, uint256 amount) external nonReentrant {
        Loan storage l = loans[id];
        require(l.status == Status.Active && msg.sender == l.borrower, "NOT_ACTIVE_BORROWER");
        require(amount > 0 && l.collateral + amount <= MAX_AMOUNT, "BAD_AMOUNT");
        l.collateral += amount; activeCollateral += amount;
        _pull(wbmb, msg.sender, amount);
        emit CollateralAdded(id, amount);
    }

    function _pending(Loan storage l) internal view returns (uint256 interest, uint256 remainder) {
        uint256 end = block.timestamp < l.maturity ? block.timestamp : l.maturity;
        uint256 numerator = l.principal * l.terms.aprBps * (end - l.lastAccrued) + l.interestRemainder;
        return (l.interest + numerator / (BPS * YEAR), numerator % (BPS * YEAR));
    }

    function debtOf(uint256 id) public view returns (uint256) {
        Loan storage l = loans[id];
        if (l.status != Status.Active) return 0;
        (uint256 interest, uint256 rem) = _pending(l);
        return l.principal + interest + (rem > 0 ? 1 : 0);
    }

    function quoteRepay(uint256 id, uint256 principal) public view returns (uint256 interest, uint256 fee, uint256 total) {
        Loan storage l = loans[id];
        require(l.status == Status.Active && principal <= l.principal, "BAD_REPAY");
        uint256 rem;
        (interest, rem) = _pending(l);
        bool finalPayment = principal == l.principal;
        if (finalPayment && rem > 0) interest++;
        uint256 feeNumerator = interest * feeBps + l.feeRemainder;
        fee = feeNumerator / BPS;
        if (finalPayment && feeNumerator % BPS > 0) fee++;
        total = principal + interest + fee;
    }

    /// Pay all accrued interest plus chosen principal; principal=0 is an interest-only payment.
    function repay(uint256 id, uint256 principal, uint256 maxTotal) external nonReentrant {
        Loan storage l = loans[id];
        require(msg.sender == l.borrower, "NOT_BORROWER");
        (uint256 interest, uint256 fee, uint256 total) = quoteRepay(id, principal);
        require(total > 0 && total <= maxTotal, "REPAY_SLIPPAGE");
        (, uint256 rem) = _pending(l);
        l.lastAccrued = uint64(block.timestamp < l.maturity ? block.timestamp : l.maturity);
        l.interest = 0; l.interestRemainder = rem;
        l.feeRemainder = (interest * feeBps + l.feeRemainder) % BPS;
        l.principal -= principal;
        _creditUSDT(l.lender, principal + interest); feeBalance += fee;
        if (l.principal == 0) {
            l.status = Status.Repaid; l.interestRemainder = 0; l.feeRemainder = 0;
            activeCollateral -= l.collateral; _creditWBMB(l.borrower, l.collateral); l.collateral = 0;
        }
        _pull(usdt, msg.sender, total);
        emit Repaid(id, principal, interest, fee);
    }

    function quoteSettlement(uint256 id) public view returns (uint256 toLender, uint256 toBorrower, uint256 debt, uint256 price) {
        Loan storage l = loans[id];
        require(l.status == Status.Active, "NOT_ACTIVE");
        debt = debtOf(id);
        bool overdue = block.timestamp >= uint256(l.maturity) + l.terms.grace;
        if (l.terms.mode == Mode.MaturityOnlyAllCollateral) {
            require(overdue, "NOT_OVERDUE");
            // Explicit distinct product: EVERY remaining collateral unit, including top-ups.
            return (l.collateral, 0, debt, 0);
        }
        bool ok;
        try pricePolicy.prices() returns (uint256, uint256 p) { price = p; ok = p > 0 && p <= 1e30; } catch {}
        if (!ok) {
            // A dead price relay must not lock an overdue loan forever.
            require(block.timestamp >= uint256(l.maturity) + l.terms.grace + staleSettleDelay, "STALE_PRICE");
            return (l.collateral, 0, debt, 0);
        }
        uint256 threshold = Math.mulDiv(Math.mulDiv(l.collateral, price, WBMB_UNIT), l.terms.liquidationBps, BPS);
        require(overdue || debt >= threshold, "HEALTHY");
        toLender = Math.min(l.collateral, Math.mulDiv(debt * (BPS + liquidationBonusBps), WBMB_UNIT, price * BPS, Math.Rounding.Ceil));
        toBorrower = l.collateral - toLender;
    }

    function settle(uint256 id) external nonReentrant {
        (uint256 a, uint256 b, uint256 debt, uint256 price) = quoteSettlement(id);
        Loan storage l = loans[id];
        l.status = Status.SettledInWBMB;
        activeCollateral -= l.collateral;
        l.principal = 0; l.collateral = 0; l.interest = 0; l.interestRemainder = 0; l.feeRemainder = 0;
        _creditWBMB(l.lender, a); _creditWBMB(l.borrower, b);
        emit Settled(id, a, b, debt, price);
    }

    function claimUSDT() external nonReentrant {
        uint256 a = claimableUSDT[msg.sender]; require(a > 0, "NOTHING_TO_CLAIM");
        claimableUSDT[msg.sender] = 0; totalClaimUSDT -= a;
        _send(usdt, msg.sender, a); emit Claimed(msg.sender, address(usdt), a);
    }
    function claimWBMB() external nonReentrant {
        uint256 a = claimableWBMB[msg.sender]; require(a > 0, "NOTHING_TO_CLAIM");
        claimableWBMB[msg.sender] = 0; totalClaimWBMB -= a;
        _send(wbmb, msg.sender, a); emit Claimed(msg.sender, address(wbmb), a);
    }
    function flushFees() external nonReentrant {
        uint256 a = feeBalance; require(a > 0, "NO_FEES"); feeBalance = 0;
        _send(usdt, feeVault, a); emit FeesFlushed(a);
    }
    function liabilities() external view returns (uint256 usdtTotal, uint256 wbmbTotal) {
        return (escrowUSDT + totalClaimUSDT + feeBalance, escrowWBMB + activeCollateral + totalClaimWBMB);
    }
    function _creditUSDT(address who, uint256 amount) internal { claimableUSDT[who] += amount; totalClaimUSDT += amount; }
    function _creditWBMB(address who, uint256 amount) internal { claimableWBMB[who] += amount; totalClaimWBMB += amount; }
    function _pull(IERC20 token, address from, uint256 amount) internal {
        uint256 before_ = token.balanceOf(address(this));
        uint256 senderBefore = token.balanceOf(from);
        token.safeTransferFrom(from, address(this), amount);
        require(token.balanceOf(address(this)) == before_ + amount && token.balanceOf(from) + amount == senderBefore, "NON_EXACT_TOKEN");
    }
    function _send(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 before_ = token.balanceOf(to);
        uint256 senderBefore = token.balanceOf(address(this));
        token.safeTransfer(to, amount);
        require(token.balanceOf(to) == before_ + amount && token.balanceOf(address(this)) + amount == senderBefore, "NON_EXACT_TOKEN");
    }
}
