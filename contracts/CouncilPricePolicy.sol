// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPricePolicy} from "./IPricePolicy.sol";

/// Threshold-signed relay of the Mobick council price. Reporter set and limits are immutable:
/// replacing them means deploying a new policy and a new lending market.
/// Verifies signatures, freshness and a bounded change per report; it cannot prove the
/// reporters copied the council's number faithfully.
contract CouncilPricePolicy is IPricePolicy, EIP712 {
    struct Report {
        bytes32 policyId;
        uint64 roundId;
        uint256 price;
        uint64 confirmedAt;
        uint64 validUntil;
    }

    bytes32 public constant REPORT_TYPEHASH =
        keccak256("Report(bytes32 policyId,uint64 roundId,uint256 price,uint64 confirmedAt,uint64 validUntil)");
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_PRICE = 1e30;

    bytes32 public immutable policyId;
    uint256 public immutable threshold;
    uint256 public immutable maxAge;
    uint256 public immutable maxChangeBps;
    uint256 public immutable minInterval;
    address[] private reporterList;
    mapping(address => bool) public isReporter;

    uint256 public previous;
    uint256 public current;
    uint64 public confirmedAt;
    uint64 public validUntil;
    uint64 public changedAt;
    uint64 public lastRoundId;

    event ReportAccepted(uint64 indexed roundId, uint256 price, uint64 confirmedAt, uint64 validUntil, uint256 signerCount);

    constructor(
        address[] memory reporters_,
        uint256 threshold_,
        bytes32 policyId_,
        uint256 maxAge_,
        uint256 maxChangeBps_,
        uint256 minInterval_
    ) EIP712("WBMB Council Price", "1") {
        require(reporters_.length >= 1 && reporters_.length <= 16, "BAD_REPORTERS");
        require(threshold_ >= 1 && threshold_ <= reporters_.length, "BAD_THRESHOLD");
        require(policyId_ != bytes32(0), "BAD_POLICY");
        require(
            maxAge_ >= 1 hours && maxAge_ <= 14 days && maxChangeBps_ >= 1 && maxChangeBps_ < BPS && minInterval_ <= 7 days,
            "BAD_LIMITS"
        );
        for (uint256 i; i < reporters_.length; i++) {
            address r = reporters_[i];
            require(r != address(0) && !isReporter[r], "BAD_REPORTERS");
            isReporter[r] = true;
            reporterList.push(r);
        }
        threshold = threshold_; policyId = policyId_; maxAge = maxAge_;
        maxChangeBps = maxChangeBps_; minInterval = minInterval_;
    }

    function reporters() external view returns (address[] memory) { return reporterList; }

    function hashReport(Report calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REPORT_TYPEHASH, r.policyId, r.roundId, r.price, r.confirmedAt, r.validUntil)));
    }

    /// Anyone may submit; only the reporters' signatures matter. Signatures must be sorted by signer address.
    function submit(Report calldata r, bytes[] calldata sigs) external {
        require(r.policyId == policyId, "BAD_POLICY");
        // Sequential rounds: one mistyped huge roundId must not freeze this immutable policy.
        require(r.roundId == uint256(lastRoundId) + 1, "ROUND_GAP");
        require(
            r.validUntil > block.timestamp && r.validUntil <= block.timestamp + maxAge
                && r.confirmedAt <= block.timestamp && r.confirmedAt >= confirmedAt,
            "BAD_VALIDITY"
        );
        require(r.price > 0 && r.price <= MAX_PRICE, "BAD_PRICE");
        require(sigs.length >= threshold, "NOT_ENOUGH_SIGNATURES");
        bytes32 digest = hashReport(r);
        address last;
        for (uint256 i; i < sigs.length; i++) {
            address signer = ECDSA.recover(digest, sigs[i]);
            require(signer > last && isReporter[signer], "BAD_SIGNER");
            last = signer;
        }
        if (lastRoundId == 0) {
            previous = r.price; changedAt = uint64(block.timestamp);
        } else if (r.price != current) {
            // A leaked key can still walk the price, but only this far per step and this often.
            uint256 diff = r.price > current ? r.price - current : current - r.price;
            require(diff * BPS <= current * maxChangeBps, "PRICE_JUMP");
            require(block.timestamp >= uint256(changedAt) + minInterval, "TOO_SOON");
            previous = current; changedAt = uint64(block.timestamp);
        }
        current = r.price; confirmedAt = r.confirmedAt; validUntil = r.validUntil; lastRoundId = r.roundId;
        emit ReportAccepted(r.roundId, r.price, r.confirmedAt, r.validUntil, sigs.length);
    }

    /// Opening price stays at the lower of the last two prices for minInterval after a change,
    /// so a fresh rise cannot be borrowed against immediately.
    function prices() external view returns (uint256, uint256) {
        require(validUntil != 0 && block.timestamp <= validUntil, "STALE_PRICE");
        bool held = block.timestamp < uint256(changedAt) + minInterval;
        return (held && previous < current ? previous : current, current);
    }
}
