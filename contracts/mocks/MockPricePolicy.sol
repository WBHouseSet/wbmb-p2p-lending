// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPricePolicy} from "../IPricePolicy.sol";

/// Test-only policy whose live price, expiry and last price are set freely; `current()` can be made to revert.
contract MockPricePolicy is IPricePolicy {
    uint256 public live;
    uint64 public validUntil;
    uint256 private last;
    bool public broken;

    function set(uint256 live_, uint64 validUntil_, uint256 current_) external {
        live = live_; validUntil = validUntil_; last = current_;
    }

    function setBroken(bool broken_) external { broken = broken_; }

    function current() external view returns (uint256) {
        require(!broken, "BROKEN");
        return last;
    }

    function prices() external view returns (uint256, uint256) {
        require(live != 0, "STALE_PRICE");
        return (live, live);
    }
}
