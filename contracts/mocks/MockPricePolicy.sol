// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IPricePolicy} from "../IPricePolicy.sol";

/// LOCAL TEST ONLY: one reporter, synthetic 7-day low; not a production oracle.
contract MockPricePolicy is IPricePolicy {
    address public immutable reporter;
    uint256 public constant MAX_AGE = 2 hours;
    uint256 public weekLow;
    uint256 public current;
    uint256 public observedAt;
    event PriceUpdated(uint256 weekLow, uint256 current, uint256 observedAt);

    constructor() {
        require(block.chainid == 31337, "LOCAL_ONLY");
        reporter = msg.sender;
    }
    function setPrices(uint256 low_, uint256 current_) external {
        require(msg.sender == reporter, "REPORTER_ONLY");
        require(low_ > 0 && current_ > 0 && low_ <= 1e30 && current_ <= 1e30, "BAD_PRICE");
        weekLow = low_;
        current = current_;
        observedAt = block.timestamp;
        emit PriceUpdated(low_, current_, block.timestamp);
    }
    function prices() external view returns (uint256, uint256) {
        require(observedAt > 0 && block.timestamp <= observedAt + MAX_AGE, "STALE_PRICE");
        return (weekLow < current ? weekLow : current, current);
    }
}
