// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPricePolicy {
    /// Prices are USDT base units (18 decimals) per whole WBMB (8 decimals).
    /// A production policy must authenticate reports and enforce freshness/coverage.
    function prices() external view returns (uint256 openingPrice, uint256 currentPrice);
    /// Timestamp after which prices() fails until a new report arrives (0 before the first report).
    function validUntil() external view returns (uint64);
    /// Last accepted current price, readable after it expired (0 before the first report).
    function current() external view returns (uint256);
}
