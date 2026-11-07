// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/// @title PrivateLendingPool — 금액이 암호화된 담보 대출 풀
/// @author FHE Private Lending Team
/// @notice mETH를 담보로 맡기고 mUSDC를 빌린다. 담보·부채·대출 결과는 모두 암호문이고 본인만 복호화할 수 있다.
/// @dev 정보 누출 방지 규칙
///      1. 암호문 결과에는 이 컨트랙트와 본인(user)에게만 권한을 준다. 공개 복호화는 쓰지 않는다.
///      2. 승인/거절에 따라 이벤트를 다르게 내지 않는다. 이벤트에는 금액·결과가 없다.
///      3. 승인/거절과 상관없이 항상 같은 코드 경로를 탄다 (FHE.select, 거절이어도 0을 전송).
///      4. 승인 여부를 평문으로 저장하거나 반환하지 않는다.
///
///      이자: 공개 이자 지수(borrowIndex)와 암호화된 "scaled 부채"를 쓴다 (Compound/Aave 방식).
///        현재 부채 = scaledDebt × borrowIndex / 2^40
///      암호문 나눗셈(128비트 1,225,000 HCU)이 비트 시프트(37,000 HCU)보다 훨씬 비싸서,
///      지수를 2^40 고정소수점으로 두고 나눗셈 대신 시프트를 쓴다.
contract PrivateLendingPool is ZamaEthereumConfig {
    // ---------------------------------------------------------------------
    // 고정 파라미터 (기획안)
    // ---------------------------------------------------------------------

    /// @notice 1 mETH = 3,000 mUSDC (두 토큰 모두 6 decimals라 기본 단위끼리도 같은 비율)
    uint64 public constant PRICE = 3000;
    /// @notice 담보비율 70% (basis points)
    uint64 public constant LTV_BPS = 7000;
    /// @notice 연 이자율 10% (basis points)
    uint64 public constant APR_BPS = 1000;
    uint64 private constant BPS = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    /// @notice 담보 1단위당 빌릴 수 있는 mUSDC 단위 = 3000 × 0.7 = 2100
    uint64 public constant MAX_BORROW_PER_COLLATERAL = (PRICE * LTV_BPS) / BPS;

    /// @notice 이자 지수 고정소수점 자릿수 (2^40 = 1.0)
    uint8 public constant INDEX_BITS = 40;
    /// @notice 이자 지수 1.0 (= 2^40)
    uint256 public constant INDEX_ONE = uint256(1) << INDEX_BITS;

    // ---------------------------------------------------------------------
    // 상태
    // ---------------------------------------------------------------------

    /// @notice 담보 토큰 (mETH)
    IERC7984 public immutable COLLATERAL_TOKEN;
    /// @notice 대출 토큰 (mUSDC)
    IERC7984 public immutable DEBT_TOKEN;

    /// @notice 공개 이자 지수 (2^40 = 1.0). 금리가 고정이라 시간만의 함수이고 개인 정보가 없다.
    uint256 public borrowIndex;
    /// @notice borrowIndex를 마지막으로 갱신한 시각
    uint256 public lastAccrual;

    mapping(address user => euint64 collateral) private _collateral;
    mapping(address user => euint128 scaledDebt) private _scaledDebt;
    mapping(address user => euint64 lastBorrowed) private _lastBorrowed;

    // 이벤트에는 금액·승인 여부가 없다 (규칙 2)

    /// @notice 담보 예치 요청이 처리됨 (금액 없음)
    /// @param user 호출자
    event Deposited(address indexed user);
    /// @notice 대출 요청이 처리됨 (승인 여부·금액 없음)
    /// @param user 호출자
    event BorrowRequested(address indexed user);
    /// @notice 상환 요청이 처리됨 (금액 없음)
    /// @param user 호출자
    event Repaid(address indexed user);
    /// @notice 담보 반환 요청이 처리됨 (반환 여부·금액 없음)
    /// @param user 호출자
    event WithdrawRequested(address indexed user);
    /// @notice 이자 지수가 갱신됨 (공개 정보)
    /// @param borrowIndex 새 이자 지수 (2^40 = 1.0)
    /// @param timestamp 갱신 시각
    event Accrued(uint256 indexed borrowIndex, uint256 indexed timestamp);

    constructor(IERC7984 collateralToken_, IERC7984 debtToken_) {
        COLLATERAL_TOKEN = collateralToken_;
        DEBT_TOKEN = debtToken_;
        borrowIndex = INDEX_ONE;
        lastAccrual = block.timestamp;
    }

    // ---------------------------------------------------------------------
    // 이자
    // ---------------------------------------------------------------------

    /// @notice 지금 시각 기준 이자 지수 (저장하지 않음). 프론트에서 현재 부채를 계산할 때 쓴다.
    function previewBorrowIndex() public view returns (uint256) {
        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0) return borrowIndex;
        return borrowIndex + (borrowIndex * APR_BPS * elapsed) / (uint256(BPS) * SECONDS_PER_YEAR);
    }

    /// @notice 경과 시간만큼 이자 지수를 갱신한다. 누구나 호출할 수 있다.
    function accrue() public {
        if (block.timestamp == lastAccrual) return;
        borrowIndex = previewBorrowIndex();
        lastAccrual = block.timestamp;
        emit Accrued(borrowIndex, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // ② 담보 예치
    // ---------------------------------------------------------------------

    /// @notice 암호화된 금액의 mETH를 담보로 맡긴다.
    /// @dev 사전 조건: 사용자가 mETH에서 이 풀을 operator로 등록 (setOperator).
    ///      잔고가 부족하면 토큰이 0을 보내고, 담보에는 실제로 받은 금액만 더한다.
    /// @param encryptedAmount 예치할 mETH (클라이언트에서 암호화)
    /// @param inputProof 암호화 입력 증명
    function deposit(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        euint64 received = _pull(COLLATERAL_TOKEN, msg.sender, amount);

        euint64 collateral = FHE.add(_collateral[msg.sender], received);
        _collateral[msg.sender] = collateral;
        FHE.allowThis(collateral);
        FHE.allow(collateral, msg.sender);

        emit Deposited(msg.sender);
    }

    // ---------------------------------------------------------------------
    // ③ 대출
    // ---------------------------------------------------------------------

    /// @notice 암호화된 금액의 mUSDC를 빌린다. 한도 안이면 전액, 넘으면 0을 지급한다 (all-or-nothing).
    /// @dev 한도: (현재 부채 + 요청액) ≤ 담보 × 2100. 결과는 lastBorrowedOf로 본인만 확인한다.
    /// @param encryptedAmount 빌릴 mUSDC (클라이언트에서 암호화)
    /// @param inputProof 암호화 입력 증명
    function borrow(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        accrue();
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        euint128 debtAfter = FHE.add(_currentDebt(msg.sender), FHE.asEuint128(amount));
        euint128 limit = FHE.mul(FHE.asEuint128(_collateral[msg.sender]), uint128(MAX_BORROW_PER_COLLATERAL));
        ebool withinLimit = FHE.le(debtAfter, limit);

        euint64 approved = FHE.select(withinLimit, amount, FHE.asEuint64(0));

        // 풀 유동성이 부족하면 토큰이 0을 보낸다 → 실제로 보낸 금액만 부채로 기록
        FHE.allowTransient(approved, address(DEBT_TOKEN));
        euint64 sent = DEBT_TOKEN.confidentialTransfer(msg.sender, approved);

        euint128 scaled = FHE.add(_scaledDebt[msg.sender], _toScaledRoundUp(sent));
        _scaledDebt[msg.sender] = scaled;
        FHE.allowThis(scaled);
        FHE.allow(scaled, msg.sender);

        _lastBorrowed[msg.sender] = sent;
        FHE.allowThis(sent);
        FHE.allow(sent, msg.sender);

        emit BorrowRequested(msg.sender);
    }

    // ---------------------------------------------------------------------
    // ④ 상환
    // ---------------------------------------------------------------------

    /// @notice 암호화된 금액의 mUSDC로 갚는다. 남은 부채(이자 포함)보다 많이 보내도 부채만큼만 받는다.
    /// @dev 사전 조건: 사용자가 mUSDC에서 이 풀을 operator로 등록 (setOperator).
    /// @param encryptedAmount 갚을 mUSDC (클라이언트에서 암호화)
    /// @param inputProof 암호화 입력 증명
    function repay(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        accrue();
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        euint128 debt = _currentDebt(msg.sender);
        // pay ≤ amount 이므로 64비트로 줄여도 값이 잘리지 않는다
        euint64 pay = FHE.asEuint64(FHE.min(FHE.asEuint128(amount), debt));
        euint64 paid = _pull(DEBT_TOKEN, msg.sender, pay);
        euint128 paid128 = FHE.asEuint128(paid);

        // 전액 상환이면 정확히 0으로 (반올림 찌꺼기 방지), 아니면 받은 만큼 scaled 차감 (내림)
        ebool fullyRepaid = FHE.ge(paid128, debt);
        euint128 reduced = FHE.sub(_scaledDebt[msg.sender], _toScaledRoundDown(paid128));
        euint128 scaled = FHE.select(fullyRepaid, FHE.asEuint128(0), reduced);
        _scaledDebt[msg.sender] = scaled;
        FHE.allowThis(scaled);
        FHE.allow(scaled, msg.sender);

        emit Repaid(msg.sender);
    }

    // ---------------------------------------------------------------------
    // ⑤ 담보 반환
    // ---------------------------------------------------------------------

    /// @notice 부채가 0이면 맡긴 담보 전액을 돌려준다. 부채가 남아 있으면 0을 돌려준다.
    function withdrawCollateral() external {
        accrue();
        ebool debtFree = FHE.eq(_scaledDebt[msg.sender], uint128(0));
        euint64 collateral = _collateral[msg.sender];
        euint64 amount = FHE.select(debtFree, collateral, FHE.asEuint64(0));

        euint64 remaining = FHE.sub(collateral, amount);
        _collateral[msg.sender] = remaining;
        FHE.allowThis(remaining);
        FHE.allow(remaining, msg.sender);

        FHE.allowTransient(amount, address(COLLATERAL_TOKEN));
        COLLATERAL_TOKEN.confidentialTransfer(msg.sender, amount);

        emit WithdrawRequested(msg.sender);
    }

    // ---------------------------------------------------------------------
    // 조회 (암호문 핸들 — 본인만 복호화 가능)
    // ---------------------------------------------------------------------

    /// @notice 맡긴 담보 (mETH, 암호문)
    /// @param user 조회할 주소
    function collateralOf(address user) external view returns (euint64) {
        return _collateral[user];
    }

    /// @notice scaled 부채 (암호문). 현재 부채 = 복호화값 × previewBorrowIndex() / 2^40
    /// @param user 조회할 주소
    function scaledDebtOf(address user) external view returns (euint128) {
        return _scaledDebt[user];
    }

    /// @notice 마지막 대출 요청에서 실제로 지급된 금액 (암호문). 0이면 거절.
    /// @param user 조회할 주소
    function lastBorrowedOf(address user) external view returns (euint64) {
        return _lastBorrowed[user];
    }

    // ---------------------------------------------------------------------
    // 내부
    // ---------------------------------------------------------------------

    /// @dev 사용자의 토큰을 풀로 가져온다. 실제로 받은 금액을 돌려준다 (잔고 부족이면 0).
    function _pull(IERC7984 token, address from, euint64 amount) private returns (euint64) {
        FHE.allowTransient(amount, address(token));
        return token.confidentialTransferFrom(from, address(this), amount);
    }

    /// @dev 현재 부채 = scaled × index >> 40 (내림)
    function _currentDebt(address user) private returns (euint128) {
        return FHE.shr(FHE.mul(_scaledDebt[user], uint128(borrowIndex)), INDEX_BITS);
    }

    /// @dev 금액 → scaled (올림). 대출 기록용: 부채가 실제보다 작게 잡히지 않도록.
    ///      scaled = ceil(amount × ceil(2^80 / index) / 2^40)
    function _toScaledRoundUp(euint64 amount) private returns (euint128) {
        uint256 inverse = ((uint256(1) << (2 * INDEX_BITS)) + borrowIndex - 1) / borrowIndex;
        euint128 product = FHE.mul(FHE.asEuint128(amount), uint128(inverse));
        return FHE.shr(FHE.add(product, uint128(INDEX_ONE - 1)), INDEX_BITS);
    }

    /// @dev 금액 → scaled (내림). 상환 차감용: 부채가 실제보다 많이 줄지 않도록.
    function _toScaledRoundDown(euint128 amount) private returns (euint128) {
        uint256 inverse = (uint256(1) << (2 * INDEX_BITS)) / borrowIndex;
        return FHE.shr(FHE.mul(amount, uint128(inverse)), INDEX_BITS);
    }
}
