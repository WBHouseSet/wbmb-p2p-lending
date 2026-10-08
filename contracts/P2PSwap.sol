// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Direct WBMB <-> MOVN trade board. Not audited.
/// No owner, upgrade, sweep, arbitrary recipient or fee-change function.
/// A maker escrows what they sell, anyone fills any part at the maker's price, and both tokens move in the fill
/// itself. The contract never reads a price feed.
contract P2PSwap is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant BPS = 10_000;
    uint256 public constant WBMB_UNIT = 1e8;
    uint256 public constant MAX_AMOUNT = 1e30;
    uint256 public constant MAX_PRICE = 1e30;

    /// Sell: the maker sells WBMB. Buy: the maker buys WBMB with MOVN.
    enum Side { Sell, Buy }
    struct Offer {
        address maker;
        Side side;
        bool closed;
        uint64 expiresAt;
        uint256 price; // MOVN base units per 1 WBMB (1e8 units)
        uint256 total; // WBMB
        uint256 remaining; // WBMB
        uint256 minFill; // WBMB
        uint256 movnRemaining; // Buy only: escrowed MOVN not yet paid out
    }

    IERC20 public immutable movn;
    IERC20 public immutable wbmb;
    /// Receives the MOVN fees through flushFees.
    address public immutable feeVault;
    uint256 public immutable feeBps;
    uint256 public offerCount;
    mapping(uint256 => Offer) private offers;
    // Per-account ids so a wallet's offers stay findable however many others exist.
    mapping(address => uint256[]) private offerIds;
    uint256 public escrowMOVN;
    uint256 public escrowWBMB;
    uint256 public feeBalance;

    event OfferCreated(uint256 indexed id, address indexed maker, Side side, uint256 total, uint256 price);
    event OfferClosed(uint256 indexed id);
    event Filled(uint256 indexed id, address indexed taker, uint256 wbmbAmount, uint256 movnAmount, uint256 fee);
    event FeesFlushed(uint256 amount);

    constructor(address movn_, address wbmb_, address vault_, uint256 feeBps_) {
        require(movn_ != wbmb_ && vault_ != address(0) && vault_ != movn_ && vault_ != wbmb_, "BAD_CONFIG");
        require(IERC20Metadata(movn_).decimals() == 18 && IERC20Metadata(wbmb_).decimals() == 8, "DECIMALS");
        require(feeBps_ <= 100, "FEE_TOO_HIGH");
        movn = IERC20(movn_); wbmb = IERC20(wbmb_); feeVault = vault_; feeBps = feeBps_;
    }

    function getOffer(uint256 id) external view returns (Offer memory) { return offers[id]; }
    function offerIdsOf(address account) external view returns (uint256[] memory) { return offerIds[account]; }

    /// Price and amounts are final: to change them the maker closes the offer and posts a new one, so a taker can
    /// never be filled at terms that changed under them.
    function createOffer(Side side, uint256 total, uint256 price, uint256 minFill, uint64 expiresAt)
        external nonReentrant returns (uint256 id)
    {
        require(minFill > 0 && minFill <= total && total <= MAX_AMOUNT, "BAD_AMOUNT");
        require(price > 0 && price <= MAX_PRICE, "BAD_PRICE");
        require(expiresAt > block.timestamp && expiresAt <= block.timestamp + 90 days, "BAD_EXPIRY");
        // A Buy offer escrows the rounded-up cost of the whole amount; fills pay rounded down, the rest goes back.
        uint256 deposit = side == Side.Buy ? Math.mulDiv(total, price, WBMB_UNIT, Math.Rounding.Ceil) : 0;
        id = ++offerCount;
        offerIds[msg.sender].push(id);
        offers[id] = Offer(msg.sender, side, false, expiresAt, price, total, total, minFill, deposit);
        if (side == Side.Sell) { escrowWBMB += total; _pull(wbmb, msg.sender, total); }
        else { escrowMOVN += deposit; _pull(movn, msg.sender, deposit); }
        emit OfferCreated(id, msg.sender, side, total, price);
    }

    /// Maker may cancel immediately; anyone may close expired offers. What is left always goes to the maker.
    function closeOffer(uint256 id) external nonReentrant {
        Offer storage o = offers[id];
        require(o.maker != address(0) && !o.closed, "OFFER_CLOSED");
        require(msg.sender == o.maker || block.timestamp >= o.expiresAt, "NOT_MAKER");
        o.closed = true;
        uint256 amount;
        if (o.side == Side.Sell) {
            amount = o.remaining; escrowWBMB -= amount; o.remaining = 0;
            _send(wbmb, o.maker, amount);
        } else {
            amount = o.movnRemaining; escrowMOVN -= amount; o.movnRemaining = 0; o.remaining = 0;
            _send(movn, o.maker, amount);
        }
        emit OfferClosed(id);
    }

    /// What filling `amount` WBMB of an offer moves: the MOVN paid for it and the fee taken from the seller's part.
    function quoteFill(uint256 id, uint256 amount) public view returns (uint256 gross, uint256 fee) {
        Offer storage o = offers[id];
        require(o.maker != address(0) && !o.closed && block.timestamp < o.expiresAt, "OFFER_CLOSED");
        require(amount > 0 && amount <= o.remaining && (amount >= o.minFill || amount == o.remaining), "BAD_FILL");
        // Rounding never favours the taker: a buyer pays rounded up, a seller is paid rounded down.
        gross = Math.mulDiv(amount, o.price, WBMB_UNIT, o.side == Side.Sell ? Math.Rounding.Ceil : Math.Rounding.Floor);
        require(gross > 0, "ZERO_PAYMENT");
        fee = Math.mulDiv(gross, feeBps, BPS, Math.Rounding.Ceil);
    }

    /// `amount` is WBMB. `price` must equal the offer's price, so a fill cannot land on an offer other than the one
    /// the taker looked at.
    function fillOffer(uint256 id, uint256 amount, uint256 price, uint256 deadline) external nonReentrant {
        require(block.timestamp <= deadline, "DEADLINE");
        (uint256 gross, uint256 fee) = quoteFill(id, amount);
        Offer storage o = offers[id];
        require(msg.sender != o.maker, "SELF_FILL");
        require(price == o.price, "PRICE_MISMATCH");
        address maker = o.maker;
        o.remaining -= amount;
        if (o.remaining == 0) o.closed = true;
        feeBalance += fee;
        if (o.side == Side.Sell) {
            escrowWBMB -= amount;
            _pull(movn, msg.sender, gross);
            _send(wbmb, msg.sender, amount);
            _send(movn, maker, gross - fee);
        } else {
            uint256 leftover;
            o.movnRemaining -= gross;
            if (o.closed) { leftover = o.movnRemaining; o.movnRemaining = 0; }
            escrowMOVN -= gross + leftover;
            _pull(wbmb, msg.sender, amount);
            _send(wbmb, maker, amount);
            _send(movn, msg.sender, gross - fee);
            _send(movn, maker, leftover);
        }
        emit Filled(id, msg.sender, amount, gross, fee);
    }

    /// Fees stay here until someone moves them, so a fee wallet that cannot receive MOVN never stops a trade.
    function flushFees() external nonReentrant {
        uint256 a = feeBalance; require(a > 0, "NO_FEES"); feeBalance = 0;
        _send(movn, feeVault, a); emit FeesFlushed(a);
    }
    function liabilities() external view returns (uint256 movnTotal, uint256 wbmbTotal) {
        return (escrowMOVN + feeBalance, escrowWBMB);
    }
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
