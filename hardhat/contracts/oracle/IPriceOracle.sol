// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IPriceOracle — 담보(mETH) 가격 제공자
/// @author FHE Private Lending Team
/// @notice 대출 풀은 이 인터페이스만 본다. 데모는 MockPriceOracle, 실서비스는 Chainlink 어댑터로 교체한다.
interface IPriceOracle {
    /// @notice 1 mETH의 가격 (mUSDC 기준). 두 토큰 모두 6 decimals라 기본 단위끼리도 같은 비율이다.
    /// @return 1 mETH = price mUSDC
    function price() external view returns (uint64);
}
