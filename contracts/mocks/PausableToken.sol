// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {MockToken} from "./MockToken.sol";

/// Local stand-in for a quote token whose issuer can pause transfers or block an address
/// (the real MOVN has both). Reverts, like the real token, instead of returning false.
contract PausableToken is MockToken {
    bool public paused;
    mapping(address => bool) public blocked;
    constructor(uint8 precision) MockToken("Pausable", "PAUSE", precision) {}
    function setPaused(bool value) external { paused = value; }
    function setBlocked(address who, bool value) external { blocked[who] = value; }
    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "PAUSED");
        require(!blocked[from] && !blocked[to], "BLOCKED");
        super._update(from, to, value);
    }
}
