// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {MockConfidentialToken} from "./MockConfidentialToken.sol";

/// @title mETH — 담보로 쓰는 가상 ETH (기밀 토큰)
/// @author FHE Private Lending Team
/// @notice 대출 풀에 담보로 맡기는 토큰. 잔고와 전송 금액이 암호화된다.
contract MockETH is MockConfidentialToken {
    constructor(address initialOwner) MockConfidentialToken("Mock Ether", "mETH", initialOwner) {}
}
