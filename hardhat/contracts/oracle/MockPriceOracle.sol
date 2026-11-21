// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IPriceOracle} from "./IPriceOracle.sol";

/// @title MockPriceOracle — 데모용 모의 가격 오라클
/// @author FHE Private Lending Team
/// @notice 가격 하락(청산)을 시연하기 위해 owner가 가격을 정한다. 실서비스에서는 탈중앙 오라클로 교체한다.
/// @dev 청산 판단 로직에는 관리자 권한이 없고, 이 컨트랙트는 가격이라는 외부 입력만 대신한다.
contract MockPriceOracle is IPriceOracle, Ownable {
    /// @notice 허용하는 최대 가격 (2^24 - 1). PrivateLendingPool.MAX_PRICE와 같아야 한다.
    /// @dev 대출 풀은 이보다 큰 가격을 거부하므로(128비트 암호문 곱셈이 넘치지 않게), 그런 가격이 들어가면
    ///      풀의 모든 함수가 실패한다. 오라클에서 미리 막는다.
    uint64 public constant MAX_PRICE = (uint64(1) << 24) - 1;

    uint64 private _price;

    /// @notice 가격이 바뀜 (공개 정보)
    /// @param oldPrice 이전 가격
    /// @param newPrice 새 가격
    event PriceUpdated(uint64 indexed oldPrice, uint64 indexed newPrice);

    /// @notice 0 가격은 허용하지 않는다
    error ZeroPrice();

    /// @notice MAX_PRICE보다 큰 가격은 허용하지 않는다
    /// @param price 요청한 가격
    /// @param max 허용 최대 가격
    error PriceTooHigh(uint64 price, uint64 max);

    constructor(address initialOwner, uint64 initialPrice) Ownable(initialOwner) {
        _checkPrice(initialPrice);
        _price = initialPrice;
        emit PriceUpdated(0, initialPrice);
    }

    /// @inheritdoc IPriceOracle
    function price() external view returns (uint64) {
        return _price;
    }

    /// @notice 가격을 바꾼다 (데모용)
    /// @param newPrice 1 mETH = newPrice mUSDC (1 ~ MAX_PRICE 정수)
    function setPrice(uint64 newPrice) external onlyOwner {
        _checkPrice(newPrice);
        emit PriceUpdated(_price, newPrice);
        _price = newPrice;
    }

    /// @dev 1 ≤ 가격 ≤ MAX_PRICE
    function _checkPrice(uint64 newPrice) private pure {
        if (newPrice == 0) revert ZeroPrice();
        if (newPrice > MAX_PRICE) revert PriceTooHigh(newPrice, MAX_PRICE);
    }
}
