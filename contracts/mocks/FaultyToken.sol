// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MockToken} from "./MockToken.sol";

/// Adversarial local test token, never part of the interactive deployment.
contract FaultyToken is MockToken {
    bool public fail;
    bool public taxed;
    bool public reentryBlocked;
    bytes4 public reentryError;
    address public callbackTarget;
    bytes public callbackData;
    constructor(uint8 precision) MockToken("Fault injection", "FAULT", precision) {}
    function setFaults(bool fail_, bool taxed_, address target, bytes calldata data) external {
        fail = fail_; taxed = taxed_; callbackTarget = target; callbackData = data;
    }
    function transfer(address to, uint256 value) public override returns (bool) {
        if (fail) return false;
        return super.transfer(to, value);
    }
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (fail) return false;
        return super.transferFrom(from, to, value);
    }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            if (callbackTarget != address(0)) {
                (bool ok, bytes memory reason) = callbackTarget.call(callbackData);
                reentryBlocked = !ok;
                reentryError = reason.length >= 4 ? bytes4(reason) : bytes4(0);
            }
            if (taxed) {
                uint256 tax = value / 100;
                super._update(from, address(0xdead), tax);
                value -= tax;
            }
        }
        super._update(from, to, value);
    }
}
