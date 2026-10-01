// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPricePolicy} from "./IPricePolicy.sol";

/// Threshold-signed 7-day price reports. Reporter set, threshold and policy are immutable:
/// replacing them means deploying a new policy and a new lending market.
/// Verifies signatures, freshness, coverage, min and source divergence; it cannot prove source data is genuine.
contract SignedPricePolicy is IPricePolicy, EIP712 {
    struct Report {
        bytes32 policyId;
        uint64 roundId;
        uint64 windowStart;
        uint64 windowEnd;
        uint64 validUntil;
        uint16 bucketCount;
        uint256 dexLow;
        uint256 dexCurrent;
        uint256 cexLow;     // raw BMB/USDT, before conversionBps
        uint256 cexCurrent; // raw BMB/USDT, before conversionBps
        bytes32 rawDataHash;
    }

    bytes32 public constant REPORT_TYPEHASH = keccak256(
        "Report(bytes32 policyId,uint64 roundId,uint64 windowStart,uint64 windowEnd,uint64 validUntil,uint16 bucketCount,uint256 dexLow,uint256 dexCurrent,uint256 cexLow,uint256 cexCurrent,bytes32 rawDataHash)"
    );
    uint256 public constant BUCKET_SECONDS = 1800;
    uint256 public constant BUCKET_COUNT = 336;
    uint256 public constant WINDOW = BUCKET_SECONDS * BUCKET_COUNT;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_PRICE = 1e30;

    bytes32 public immutable policyId;
    uint256 public immutable threshold;
    uint256 public immutable conversionBps;
    uint256 public immutable maxDivergenceBps;
    uint256 public immutable maxAge;
    address[] private reporterList;
    mapping(address => bool) public isReporter;

    uint256 public weekLow;
    uint256 public current;
    uint64 public validUntil;
    uint64 public windowEnd;
    uint64 public lastRoundId;
    bytes32 public rawDataHash;

    event ReportAccepted(
        uint64 indexed roundId, uint256 weekLow, uint256 current, uint64 windowEnd, uint64 validUntil, bytes32 rawDataHash, uint256 signerCount
    );

    constructor(
        address[] memory reporters_,
        uint256 threshold_,
        bytes32 policyId_,
        uint256 conversionBps_,
        uint256 maxDivergenceBps_,
        uint256 maxAge_
    ) EIP712("WBMB Price Report", "1") {
        require(reporters_.length >= 1 && reporters_.length <= 16, "BAD_REPORTERS");
        require(threshold_ >= 1 && threshold_ <= reporters_.length, "BAD_THRESHOLD");
        require(policyId_ != bytes32(0), "BAD_POLICY");
        require(conversionBps_ >= 1 && conversionBps_ <= BPS, "BAD_CONVERSION");
        require(maxDivergenceBps_ <= BPS, "BAD_DIVERGENCE");
        require(maxAge_ >= 1 hours && maxAge_ <= 7 days, "BAD_MAX_AGE");
        for (uint256 i; i < reporters_.length; i++) {
            address r = reporters_[i];
            require(r != address(0) && !isReporter[r], "BAD_REPORTERS");
            isReporter[r] = true;
            reporterList.push(r);
        }
        threshold = threshold_; policyId = policyId_; conversionBps = conversionBps_;
        maxDivergenceBps = maxDivergenceBps_; maxAge = maxAge_;
    }

    function reporters() external view returns (address[] memory) { return reporterList; }

    function hashReport(Report calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            REPORT_TYPEHASH, r.policyId, r.roundId, r.windowStart, r.windowEnd, r.validUntil, r.bucketCount,
            r.dexLow, r.dexCurrent, r.cexLow, r.cexCurrent, r.rawDataHash
        )));
    }

    /// Anyone may submit; only the reporters' signatures matter. Signatures must be sorted by signer address.
    function submit(Report calldata r, bytes[] calldata sigs) external {
        require(r.policyId == policyId, "BAD_POLICY");
        require(r.roundId > lastRoundId, "OLD_ROUND");
        // Sequential rounds: one mistyped huge roundId must not freeze this immutable policy.
        require(r.roundId == uint256(lastRoundId) + 1, "ROUND_GAP");
        require(
            r.windowEnd >= WINDOW && r.windowEnd % BUCKET_SECONDS == 0 && r.windowEnd <= block.timestamp
                && r.windowStart == r.windowEnd - WINDOW,
            "BAD_WINDOW"
        );
        require(r.validUntil > block.timestamp && r.validUntil <= uint256(r.windowEnd) + maxAge, "BAD_VALIDITY");
        require(r.bucketCount == BUCKET_COUNT, "BAD_COVERAGE");
        require(_valid(r.dexLow) && _valid(r.dexCurrent) && _valid(r.cexLow) && _valid(r.cexCurrent), "BAD_PRICE");
        require(sigs.length >= threshold, "NOT_ENOUGH_SIGNATURES");
        bytes32 digest = hashReport(r);
        address last;
        for (uint256 i; i < sigs.length; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            require(signer > last && isReporter[signer], "BAD_SIGNER");
            last = signer;
        }
        uint256 cexLowAdj = r.cexLow * conversionBps / BPS;
        uint256 cexCurrentAdj = r.cexCurrent * conversionBps / BPS;
        require(cexLowAdj > 0 && cexCurrentAdj > 0, "BAD_PRICE");
        uint256 low = _agreedMin(r.dexLow, cexLowAdj);
        uint256 cur = _agreedMin(r.dexCurrent, cexCurrentAdj);
        weekLow = low; current = cur; validUntil = r.validUntil; windowEnd = r.windowEnd;
        lastRoundId = r.roundId; rawDataHash = r.rawDataHash;
        emit ReportAccepted(r.roundId, low, cur, r.windowEnd, r.validUntil, r.rawDataHash, sigs.length);
    }

    function prices() external view returns (uint256, uint256) {
        require(validUntil != 0 && block.timestamp <= validUntil, "STALE_PRICE");
        return (weekLow < current ? weekLow : current, current);
    }

    function _valid(uint256 p) internal pure returns (bool) { return p > 0 && p <= MAX_PRICE; }

    /// Never silently falls back to the higher source: both must agree within maxDivergenceBps.
    function _agreedMin(uint256 a, uint256 b) internal view returns (uint256 lo) {
        uint256 hi;
        (lo, hi) = a < b ? (a, b) : (b, a);
        require((hi - lo) * BPS <= lo * maxDivergenceBps, "DIVERGENCE");
    }
}
