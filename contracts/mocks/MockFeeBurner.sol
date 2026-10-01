// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPricePolicy} from "../IPricePolicy.sol";
import {MockToken} from "./MockToken.sol";

/// Synthetic local exchange + burn, NOT a Uniswap adapter or evidence of a real WBMB burn.
/// Reserves are prefunded with mock WBMB. Fees are paid into an immutable sink.
contract MockFeeBurner is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable usdt;
    MockToken public immutable wbmb;
    IPricePolicy public immutable policy;
    address public constant SINK = address(0xdead);
    uint256 public totalUSDTUsed;
    uint256 public totalWBMBBurned;
    event MockBuybackBurn(uint256 usdt, uint256 wbmb);
    constructor(address u, address w, address p) {
        require(block.chainid == 31337, "LOCAL_ONLY");
        usdt = IERC20(u); wbmb = MockToken(w); policy = IPricePolicy(p);
    }
    function burnFees(uint256 amount, uint256 minWBMB, uint256 deadline) external nonReentrant {
        require(block.timestamp <= deadline && amount >= 1e12 && amount <= 1000e18, "BAD_BATCH");
        (, uint256 price) = policy.prices();
        uint256 out = Math.mulDiv(amount, 1e8, price);
        require(out > 0 && out >= minWBMB && wbmb.balanceOf(address(this)) >= out, "BAD_OUTPUT");
        totalUSDTUsed += amount; totalWBMBBurned += out;
        usdt.safeTransfer(SINK, amount);
        wbmb.burn(out);
        emit MockBuybackBurn(amount, out);
    }
}
