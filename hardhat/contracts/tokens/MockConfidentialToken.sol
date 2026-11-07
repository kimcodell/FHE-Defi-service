// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title 테스트용 기밀 토큰 공통 베이스
/// @author FHE Private Lending Team
/// @notice ERC-7984 기밀 토큰. 잔고와 전송 금액이 euint64 암호문으로 저장된다.
/// @dev 소수점은 ERC7984 기본값인 6자리. euint64 최대값(약 1.8e19) 안에서 충분한 금액을 표현하기 위해서다.
///      잔고가 부족한 전송은 revert하지 않고 0을 전송한다 (ERC7984 동작).
abstract contract MockConfidentialToken is ERC7984, ZamaEthereumConfig, Ownable {
    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner
    ) ERC7984(name_, symbol_, "") Ownable(initialOwner) {}

    /// @notice 평문 금액으로 발행한다. 금액이 calldata로 공개된다.
    /// @dev 대출 풀 유동성 공급처럼 공개돼도 되는 발행에만 사용한다.
    /// @param to 받는 주소
    /// @param amount 발행량 (6 decimals 기본 단위)
    function mint(address to, uint64 amount) external onlyOwner returns (euint64) {
        return _mint(to, FHE.asEuint64(amount));
    }

    /// @notice 암호화된 금액으로 발행한다. 받는 주소만 공개되고 금액은 숨겨진다.
    /// @dev 팀원 분배처럼 초기 보유량을 숨겨야 할 때 사용한다.
    /// @param to 받는 주소
    /// @param encryptedAmount 클라이언트에서 암호화한 발행량
    /// @param inputProof 암호화 입력 증명
    function confidentialMint(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external onlyOwner returns (euint64) {
        return _mint(to, FHE.fromExternal(encryptedAmount, inputProof));
    }
}
