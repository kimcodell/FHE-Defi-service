// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, euint128, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

import {IPriceOracle} from "./oracle/IPriceOracle.sol";

/// @title PrivateLendingPool — 금액이 암호화된 담보 대출 풀
/// @author FHE Private Lending Team
/// @notice mETH를 담보로 맡기고 mUSDC를 빌린다. 담보·부채·대출 결과·청산 여부는 모두 암호문이고 본인만 복호화할 수 있다.
/// @dev 정보 누출 방지 규칙
///      1. 암호문 결과에는 이 컨트랙트와 본인(user)에게만 권한을 준다. 공개 복호화는 쓰지 않는다.
///      2. 결과(승인/거절, 청산/비청산)에 따라 이벤트를 다르게 내지 않는다. 이벤트에는 금액·결과가 없다.
///      3. 결과와 상관없이 항상 같은 코드 경로를 탄다 (FHE.select, 거절·비청산이어도 0을 처리).
///      4. 결과를 평문으로 저장하거나 반환하지 않는다.
///
///      이자: 공개 이자 지수(borrowIndex)와 암호화된 "scaled 부채" (Compound/Aave 방식).
///        현재 부채 = scaledDebt × borrowIndex / 2^40
///      가격 비율(대출 한도 70%, 청산 기준 80%, 벌금 5%)도 평문에서 2^40 고정소수점 계수로 미리 계산해,
///      암호문 나눗셈(128비트 1,225,000 HCU) 대신 곱셈 + 비트 시프트(37,000 HCU)로 처리한다.
///
///      청산: 블라인드 부분 청산 + 순번 점검.
///        - 판단(위험한가)과 실행(빚 50%를 담보로 상계, 벌금 5%)을 모두 암호문 안에서 처리한다.
///          청산자가 돈을 대지 않고 풀이 스스로 상계하므로, 누구도 금액이나 결과를 알 수 없다.
///        - 점검은 poke()로 다음 순번 포지션을 차례로 진행한다. 누구나 호출할 수 있고(청산 점검 봇이 주기적으로 호출),
///          반환값이 없으며 이벤트에도 결과가 없어서, 호출한 쪽도 청산 여부를 알 수 없다.
///        - 보상이 없으므로 보상으로 결과가 드러나지 않고, 보상을 노린 시빌 공격도 성립하지 않는다.
contract PrivateLendingPool is ZamaEthereumConfig {
    // ---------------------------------------------------------------------
    // 파라미터 (기획안)
    // ---------------------------------------------------------------------

    /// @notice 대출 한도: 담보 가치의 70%
    uint64 internal constant LTV_PCT = 70;
    /// @notice 청산 기준: 빚이 담보 가치의 80%를 넘으면 청산
    uint64 internal constant LIQUIDATION_THRESHOLD_PCT = 80;
    /// @notice 한 번 청산할 때 상계하는 빚의 비율 (50% = 비트 시프트 1)
    uint64 internal constant CLOSE_FACTOR_PCT = 50;
    /// @notice 청산 벌금: 상계한 빚의 105%만큼 담보를 가져간다
    uint64 internal constant LIQUIDATION_PENALTY_PCT = 5;
    /// @notice 연 이자율 10% (basis points)
    uint64 internal constant APR_BPS = 1000;
    uint64 private constant BPS = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    /// @notice poke() 한 번에 점검할 수 있는 최대 포지션 수 (트랜잭션당 HCU 한도 20M 안에 들도록)
    uint256 internal constant MAX_CHECKS_PER_POKE = 3;
    /// @notice 128비트 곱셈이 넘치지 않도록 허용하는 최대 가격 (담보 ≤ 2^64, 계수 ≤ 가격 × 2^40)
    uint64 internal constant MAX_PRICE = (uint64(1) << 24) - 1;

    /// @notice 고정소수점 자릿수 (2^40 = 1.0). 이자 지수와 가격 계수에 쓴다.
    uint8 internal constant INDEX_BITS = 40;
    /// @notice 이자 지수 1.0 (= 2^40)
    uint256 internal constant INDEX_ONE = uint256(1) << INDEX_BITS;

    // ---------------------------------------------------------------------
    // 상태
    // ---------------------------------------------------------------------

    /// @notice 담보 토큰 (mETH)
    IERC7984 public immutable COLLATERAL_TOKEN;
    /// @notice 대출 토큰 (mUSDC)
    IERC7984 public immutable DEBT_TOKEN;
    /// @notice mETH 가격 오라클
    IPriceOracle public immutable ORACLE;

    /// @notice 공개 이자 지수 (2^40 = 1.0). 금리가 고정이라 시간만의 함수이고 개인 정보가 없다.
    uint256 public borrowIndex;
    /// @notice borrowIndex를 마지막으로 갱신한 시각
    uint256 public lastAccrual;

    mapping(address user => euint64 collateral) private _collateral;
    mapping(address user => euint128 scaledDebt) private _scaledDebt;
    mapping(address user => euint64 lastBorrowed) private _lastBorrowed;
    mapping(address user => euint64 amount) private _liquidatedDebt;
    mapping(address user => euint64 amount) private _seizedCollateral;

    /// @dev 청산으로 몰수한 담보(mETH) 누적. 이 컨트랙트만 접근할 수 있다 (규모도 비공개).
    euint64 private _reserve;

    /// @dev 점검 순번 목록. 한 번 등록되면 빼지 않는다 (빼면 청산 사실이 드러남).
    address[] private _positions;
    /// @notice 점검 순번 목록에 등록됐는지
    mapping(address user => bool registered) public isRegistered;
    /// @notice 다음에 점검할 순번 (목록 길이로 나눈 나머지를 쓴다)
    uint256 public nextCheckIndex;

    // 이벤트에는 금액·결과가 없다 (규칙 2)

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
    /// @notice 포지션이 점검 순번 목록에 등록됨
    /// @param user 포지션 주인
    event PositionRegistered(address indexed user);
    /// @notice 포지션이 블라인드 청산 점검을 받음 (청산 여부·금액 없음)
    /// @param user 포지션 주인
    event PositionChecked(address indexed user);

    /// @notice 오라클 가격이 0이거나 너무 큼
    /// @param price 오라클이 준 가격
    error InvalidPrice(uint64 price);

    /// @dev 가격에서 미리 계산한 2^40 고정소수점 계수들 (평문)
    struct PriceFactors {
        uint128 threshold; // 담보 × threshold >> 40 = 담보 가치의 80%
        uint128 seize; // 상계액 × seize >> 40 = 가져갈 담보 (벌금 포함)
        uint128 cap; // 담보 × cap >> 40 = 그 담보로 상계할 수 있는 최대 빚 (벌금 감안)
    }

    constructor(IERC7984 collateralToken_, IERC7984 debtToken_, IPriceOracle oracle_) {
        COLLATERAL_TOKEN = collateralToken_;
        DEBT_TOKEN = debtToken_;
        ORACLE = oracle_;
        borrowIndex = INDEX_ONE;
        lastAccrual = block.timestamp;
        _reserve = FHE.asEuint64(0);
        FHE.allowThis(_reserve);
    }

    // ---------------------------------------------------------------------
    // 가격·이자
    // ---------------------------------------------------------------------

    /// @notice 고정 파라미터 (getter를 하나로 묶어 바이트코드를 줄였다 — Sepolia 트랜잭션당 가스 상한 때문)
    /// @return ltvPct 대출 한도 (%)
    /// @return liquidationThresholdPct 청산 기준 (%)
    /// @return closeFactorPct 한 번에 상계하는 빚 비율 (%)
    /// @return liquidationPenaltyPct 청산 벌금 (%)
    /// @return aprBps 연 이자율 (basis points)
    /// @return maxChecksPerPoke poke() 한 번 최대 점검 수
    function parameters()
        external
        pure
        returns (
            uint64 ltvPct,
            uint64 liquidationThresholdPct,
            uint64 closeFactorPct,
            uint64 liquidationPenaltyPct,
            uint64 aprBps,
            uint256 maxChecksPerPoke
        )
    {
        return (
            LTV_PCT,
            LIQUIDATION_THRESHOLD_PCT,
            CLOSE_FACTOR_PCT,
            LIQUIDATION_PENALTY_PCT,
            APR_BPS,
            MAX_CHECKS_PER_POKE
        );
    }

    /// @notice 현재 오라클 가격 (1 mETH = ? mUSDC)
    /// @return price 검증된 가격
    function currentPrice() public view returns (uint64 price) {
        price = ORACLE.price();
        if (price == 0 || price > MAX_PRICE) revert InvalidPrice(price);
    }

    /// @notice 지금 시각 기준 이자 지수 (저장하지 않음). 프론트에서 현재 부채를 계산할 때 쓴다.
    /// @return 2^40 = 1.0 기준 이자 지수
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
    ///      첫 예치 때 점검 순번 목록에 등록한다.
    /// @param encryptedAmount 예치할 mETH (클라이언트에서 암호화)
    /// @param inputProof 암호화 입력 증명
    function deposit(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        accrue();
        if (!isRegistered[msg.sender]) _register(msg.sender);

        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        euint64 received = _pull(COLLATERAL_TOKEN, msg.sender, amount);

        _store(_collateral, msg.sender, FHE.add(_collateral[msg.sender], received));

        emit Deposited(msg.sender);
    }

    // ---------------------------------------------------------------------
    // ③ 대출
    // ---------------------------------------------------------------------

    /// @notice 암호화된 금액의 mUSDC를 빌린다. 한도 안이면 전액, 넘으면 0을 지급한다 (all-or-nothing).
    /// @dev 한도: (현재 부채 + 요청액) ≤ 담보 × 가격 × 70%. 결과는 lastBorrowedOf로 본인만 확인한다.
    /// @param encryptedAmount 빌릴 mUSDC (클라이언트에서 암호화)
    /// @param inputProof 암호화 입력 증명
    function borrow(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        accrue();
        uint64 price = currentPrice();
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        euint128 debtAfter = FHE.add(_currentDebt(msg.sender), FHE.asEuint128(amount));
        euint128 limit = _scale(FHE.asEuint128(_collateral[msg.sender]), _ratio(price, LTV_PCT, 100));
        ebool withinLimit = FHE.le(debtAfter, limit);

        euint64 approved = FHE.select(withinLimit, amount, FHE.asEuint64(0));

        // 풀 유동성이 부족하면 토큰이 0을 보낸다 → 실제로 보낸 금액만 부채로 기록
        FHE.allowTransient(approved, address(DEBT_TOKEN));
        euint64 sent = DEBT_TOKEN.confidentialTransfer(msg.sender, approved);

        _storeDebt(msg.sender, FHE.add(_scaledDebt[msg.sender], _toScaledRoundUp(sent)));
        _store(_lastBorrowed, msg.sender, sent);

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
        _storeDebt(msg.sender, FHE.select(fullyRepaid, FHE.asEuint128(0), reduced));

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

        _store(_collateral, msg.sender, FHE.sub(collateral, amount));

        FHE.allowTransient(amount, address(COLLATERAL_TOKEN));
        COLLATERAL_TOKEN.confidentialTransfer(msg.sender, amount);

        emit WithdrawRequested(msg.sender);
    }

    // ---------------------------------------------------------------------
    // ⑧ 청산 점검
    // ---------------------------------------------------------------------

    /// @notice 다음 순번 포지션들을 블라인드 청산 점검한다. 누구나 호출할 수 있고 보상은 없다.
    /// @dev 청산 점검 봇(keeper/)이 주기적으로 호출한다. 반환값이 없고 이벤트(PositionChecked)에도 결과가 없어서,
    ///      호출한 쪽은 청산 대상이었는지 알 수 없다. 청산 대상이면 같은 트랜잭션 안에서 암호문으로 청산까지 끝난다.
    /// @param count 점검할 포지션 수 (최대 MAX_CHECKS_PER_POKE)
    function poke(uint256 count) external {
        accrue();
        _sweep(count > MAX_CHECKS_PER_POKE ? MAX_CHECKS_PER_POKE : count);
    }

    // ---------------------------------------------------------------------
    // 조회 (암호문 핸들 — 본인만 복호화 가능)
    // ---------------------------------------------------------------------

    /// @notice 맡긴 담보 (mETH, 암호문)
    /// @param user 조회할 주소
    /// @return 암호문 핸들
    function collateralOf(address user) external view returns (euint64) {
        return _collateral[user];
    }

    /// @notice scaled 부채 (암호문). 현재 부채 = 복호화값 × previewBorrowIndex() / 2^40
    /// @param user 조회할 주소
    /// @return 암호문 핸들
    function scaledDebtOf(address user) external view returns (euint128) {
        return _scaledDebt[user];
    }

    /// @notice 마지막 대출 요청에서 실제로 지급된 금액 (암호문). 0이면 거절.
    /// @param user 조회할 주소
    /// @return 암호문 핸들
    function lastBorrowedOf(address user) external view returns (euint64) {
        return _lastBorrowed[user];
    }

    /// @notice 지금까지 청산으로 상계된 빚 누적 (mUSDC, 암호문)
    /// @param user 조회할 주소
    /// @return 암호문 핸들
    function liquidatedDebtOf(address user) external view returns (euint64) {
        return _liquidatedDebt[user];
    }

    /// @notice 지금까지 청산으로 몰수된 담보 누적 (mETH, 암호문)
    /// @param user 조회할 주소
    /// @return 암호문 핸들
    function seizedCollateralOf(address user) external view returns (euint64) {
        return _seizedCollateral[user];
    }

    /// @notice 점검 순번 목록에 등록된 포지션 수
    /// @return 포지션 수
    function positionCount() external view returns (uint256) {
        return _positions.length;
    }

    /// @notice 점검 순번 목록의 i번째 포지션
    /// @param i 순번
    /// @return 포지션 주인
    function positionAt(uint256 i) external view returns (address) {
        return _positions[i];
    }

    // ---------------------------------------------------------------------
    // 내부: 청산
    // ---------------------------------------------------------------------

    /// @dev 다음 순번 포지션 count개를 점검한다 (포지션 수보다 많이 요청하면 한 바퀴만).
    function _sweep(uint256 count) private {
        uint256 n = _positions.length;
        if (count > n) count = n;
        if (count == 0) return;

        PriceFactors memory f = _priceFactors(currentPrice());
        for (uint256 i = 0; i < count; ++i) {
            address user = _positions[nextCheckIndex % n];
            ++nextCheckIndex;
            _checkPosition(user, f);
        }
    }

    /// @dev 블라인드 부분 청산. 위험하면 빚 50%를 담보로 상계(벌금 5%), 안전하면 0을 처리한다.
    ///      두 경우 모두 같은 연산을 하고 모든 값을 새 암호문으로 다시 저장한다.
    function _checkPosition(address user, PriceFactors memory f) private {
        (euint128 repayEffective, euint64 seize) = _liquidationAmounts(user, f);

        _storeDebt(user, FHE.sub(_scaledDebt[user], _toScaledRoundDown(repayEffective)));

        _store(_collateral, user, FHE.sub(_collateral[user], seize));
        _store(_liquidatedDebt, user, FHE.add(_liquidatedDebt[user], FHE.asEuint64(repayEffective)));
        _store(_seizedCollateral, user, FHE.add(_seizedCollateral[user], seize));

        _reserve = FHE.add(_reserve, seize);
        FHE.allowThis(_reserve);

        emit PositionChecked(user);
    }

    /// @notice 청산 금액 계산 (모두 암호문). 안전한 포지션이면 둘 다 0이 나온다.
    /// @param user 점검할 포지션 주인
    /// @param f 현재 가격에서 미리 계산한 계수
    /// @return repayEffective 상계할 빚 (mUSDC)
    /// @return seize 가져갈 담보 (mETH)
    function _liquidationAmounts(
        address user,
        PriceFactors memory f
    ) private returns (euint128 repayEffective, euint64 seize) {
        euint128 collateral = FHE.asEuint128(_collateral[user]);
        euint128 debt = _currentDebt(user);

        // 위험한가: 빚 > 담보 가치 × 80%
        ebool unhealthy = FHE.gt(debt, _scale(collateral, f.threshold));
        // 상계할 빚 = 위험하면 빚의 50%, 아니면 0
        euint128 halfDebt = FHE.select(unhealthy, FHE.shr(debt, 1), FHE.asEuint128(0));
        // 가져갈 담보 = 상계액 × 1.05 ÷ 가격, 단 맡긴 담보를 넘지 않게
        seize = FHE.asEuint64(FHE.min(_scale(halfDebt, f.seize), collateral));
        // 담보가 모자라면(가격 급락) 상계액도 그 담보로 갚을 수 있는 만큼으로 줄인다. 나머지 빚은 남는다.
        repayEffective = FHE.min(halfDebt, _scale(collateral, f.cap));
    }

    /// @dev 암호문을 저장하고 이 컨트랙트와 본인에게만 권한을 준다 (규칙 1)
    function _store(mapping(address => euint64) storage slot, address user, euint64 value) private {
        slot[user] = value;
        FHE.allowThis(value);
        FHE.allow(value, user);
    }

    /// @dev scaled 부채를 저장하고 이 컨트랙트와 본인에게만 권한을 준다 (규칙 1)
    function _storeDebt(address user, euint128 value) private {
        _scaledDebt[user] = value;
        FHE.allowThis(value);
        FHE.allow(value, user);
    }

    /// @dev 점검 순번 목록에 등록하고, 모든 암호문 필드를 0으로 초기화한다.
    ///      초기화해 두면 점검이 항상 같은 연산 순서로 실행되어, "대출한 적이 있는지"도 연산 흔적으로 드러나지 않는다.
    function _register(address user) private {
        isRegistered[user] = true;
        _positions.push(user);

        euint64 zero64 = FHE.asEuint64(0);
        FHE.allowThis(zero64);
        FHE.allow(zero64, user);
        _collateral[user] = zero64;
        _lastBorrowed[user] = zero64;
        _liquidatedDebt[user] = zero64;
        _seizedCollateral[user] = zero64;

        euint128 zero128 = FHE.asEuint128(0);
        FHE.allowThis(zero128);
        FHE.allow(zero128, user);
        _scaledDebt[user] = zero128;

        emit PositionRegistered(user);
    }

    /// @dev 가격에서 청산용 계수를 평문으로 미리 계산한다 (암호문 나눗셈 회피)
    function _priceFactors(uint64 price) private pure returns (PriceFactors memory f) {
        f.threshold = _ratio(price, LIQUIDATION_THRESHOLD_PCT, 100);
        f.seize = uint128((uint256(100 + LIQUIDATION_PENALTY_PCT) << INDEX_BITS) / (uint256(price) * 100));
        f.cap = _ratio(price, 100, 100 + LIQUIDATION_PENALTY_PCT);
    }

    /// @dev price × num / den 을 2^40 고정소수점으로 (내림)
    function _ratio(uint64 price, uint64 num, uint64 den) private pure returns (uint128) {
        return uint128(((uint256(price) * num) << INDEX_BITS) / den);
    }

    /// @dev value × factor >> 40
    function _scale(euint128 value, uint128 factor) private returns (euint128) {
        return FHE.shr(FHE.mul(value, factor), INDEX_BITS);
    }

    // ---------------------------------------------------------------------
    // 내부: 토큰·이자
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

    /// @dev 금액 → scaled (내림). 상환·청산 차감용: 부채가 실제보다 많이 줄지 않도록.
    function _toScaledRoundDown(euint128 amount) private returns (euint128) {
        uint256 inverse = (uint256(1) << (2 * INDEX_BITS)) / borrowIndex;
        return FHE.shr(FHE.mul(amount, uint128(inverse)), INDEX_BITS);
    }
}
