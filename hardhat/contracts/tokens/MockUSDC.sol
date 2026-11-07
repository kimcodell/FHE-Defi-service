// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {MockConfidentialToken} from "./MockConfidentialToken.sol";

/// @title mUSDC — 대출해 주는 가상 달러 (기밀 토큰)
/// @author FHE Private Lending Team
/// @notice 대출 풀이 빌려주는 토큰. 잔고와 전송 금액이 암호화된다.
contract MockUSDC is MockConfidentialToken {
    constructor(address initialOwner) MockConfidentialToken("Mock USD Coin", "mUSDC", initialOwner) {}
}
