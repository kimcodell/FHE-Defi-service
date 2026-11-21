# FHE Private Lending — 컨트랙트 (hardhat)

금액이 암호화된 담보 대출 서비스. Zama fhEVM + OpenZeppelin ERC-7984 기밀 토큰 기반.
[Zama fhevm-hardhat-template](https://github.com/zama-ai/fhevm-hardhat-template)에서 시작했다.

저장소 전체 구조는 [../README.md](../README.md), 기획 전체는 [../../README.md](../../README.md)를 본다. 이
폴더(`hardhat/`)에서 명령을 실행한다.

## 진행 상황

| 단계  | 내용                                                        | 상태                       |
| ----- | ----------------------------------------------------------- | -------------------------- |
| 1주차 | mETH / mUSDC 기밀 토큰, 팀원 분배 태스크                    | ✅ 완료                    |
| 2주차 | 대출 풀 (예치·대출·상환·반환·이자)                          | ✅ 완료                    |
| 3주차 | Sepolia 배포, 웹 화면, Etherscan 검증                       | ✅ 완료                    |
| 추가  | **가격 오라클 + 블라인드 부분 청산 + 청산 점검 봇(keeper)** | ✅ 완료 (테스트 50개 통과) |

## 준비물

- **Node.js 22 이상**. 웹 화면에서 쓰는 Zama SDK가 22 이상을 요구한다. nvm 사용 시:
  `nvm install 22 && nvm alias default 22`
- 처음 한 번: `npm install`

## 자주 쓰는 명령

```bash
npm run compile        # 컴파일 + 타입 생성
npm test               # 로컬 mock 모드 테스트 (진짜 암호화 대신 흉내, 빠름)
npm run lint           # 코드 스타일 점검
```

### 로컬 블록체인에서 직접 써보기 (터미널 2개)

```bash
# 터미널 1: 내 컴퓨터 안의 가상 블록체인
npx hardhat node

# 터미널 2
npx hardhat deploy --network localhost                       # 토큰, 가격 오라클(3,000), 대출 풀 + 풀에 1,000만 mUSDC
npx hardhat team:fund --network localhost --to 0xA,0xB,0xC   # 팀원마다 10 mETH + 1,000 mUSDC (금액 암호화)
npx hardhat token:balance --network localhost --token mETH --signer 1   # 본인 잔고 복호화
npx hardhat token:address --network localhost                # 배포 주소 확인
```

`team:fund`의 `--to`를 생략하면 `npx hardhat vars set TEAM_ADDRESSES 0xA,0xB,0xC`로 저장한 주소를 쓴다.

### 대출 시나리오 (`--signer 1` = 두 번째 계정)

```bash
npx hardhat pool:authorize --network localhost --signer 1                 # 처음 한 번: 풀에 토큰 이동 권한
npx hardhat pool:deposit   --network localhost --signer 1 --amount 5      # 5 mETH 예치 → 한도 10,500
npx hardhat pool:borrow    --network localhost --signer 1 --amount 10000  # → APPROVED
npx hardhat pool:borrow    --network localhost --signer 1 --amount 1000   # → REJECTED (한도 초과)
npx hardhat pool:position  --network localhost --signer 1                 # 담보·부채·한도·청산 가격·청산 기록 복호화
npx hardhat pool:repay     --network localhost --signer 1 --amount 10100  # 부채만큼만 가져감
npx hardhat pool:withdraw  --network localhost --signer 1                 # 부채 0이면 담보 전액 반환
```

### 청산 시나리오

```bash
# signer 1: 5 mETH로 10,000 빌린 상태 (청산 가격 2,500), signer 2: 예치만 한 안전한 포지션
npx hardhat oracle:set-price --network localhost --price 2400    # 가격 하락 (오라클 owner만)
npx hardhat pool:position    --network localhost --signer 1      # → "UNHEALTHY now"
npx hardhat pool:poke        --network localhost --signer 3      # 다음 순번 포지션 블라인드 점검 (누구나, 보상 없음)
npx hardhat pool:position    --network localhost --signer 1      # → 빚 5,000 / 담보 2.8125 mETH, "liquidated so far" 표시
```

`pool:poke` 출력에는 **누구를 점검했는지만** 나오고 결과는 나오지 않는다. 결과는 각 포지션 주인만 `pool:position`으로
확인할 수 있다. 실제 네트워크에서는 청산 점검 봇([`../keeper/`](../keeper/README.md))이 `poke(1)`을 주기적으로 호출한다.

가격은 1~16,777,215(2^24 − 1) 사이 정수만 된다. 대출 풀이 이 범위 밖의 가격을 거부해서(128비트 암호문 곱셈이 넘치지
않게), 오라클에 그런 값이 들어가면 풀의 모든 함수가 실패하기 때문이다. 그래서 오라클 컨트랙트(`ZeroPrice`,
`PriceTooHigh`)와 `oracle:set-price` 태스크가 둘 다 미리 막는다.

## 구조

```
contracts/
  PrivateLendingPool.sol       # 대출 풀: deposit / borrow / repay / withdrawCollateral / poke / accrue
  oracle/
    IPriceOracle.sol           # 가격 인터페이스 (실서비스는 Chainlink 어댑터로 교체)
    MockPriceOracle.sol        # 데모용 모의 오라클 (owner가 가격 설정)
  tokens/
    MockConfidentialToken.sol  # 공통 베이스: ERC-7984 + owner 전용 mint / confidentialMint
    MockETH.sol                # 담보 토큰 mETH
    MockUSDC.sol               # 대출 토큰 mUSDC
deploy/01_tokens.ts            # 토큰 배포
deploy/02_oracle.ts            # 모의 오라클 배포 (시작 가격 3,000)
deploy/03_pool.ts              # 대출 풀 배포 + 1,000만 mUSDC 유동성
tasks/tokens.ts                # token:distribute, team:fund, token:balance, token:address
tasks/pool.ts                  # pool:authorize, deposit, borrow, repay, withdraw, position, poke / oracle:price, set-price
tasks/frontend.ts              # frontend:export (ABI·배포 주소 → ../frontend)
test/tokens.ts                 # 토큰 테스트 (10)
test/lendingPool.ts            # 대출 풀·청산 테스트 (38)
```

## 대출 풀 설계 메모

| 기능                 | 동작                                                               | 실패 시                    |
| -------------------- | ------------------------------------------------------------------ | -------------------------- |
| `deposit`            | 암호화된 mETH를 담보로 가져옴. 첫 예치 때 점검 순번 목록에 등록    | 지갑 잔고 부족 → 0 예치    |
| `borrow`             | `(현재 부채 + 요청액) ≤ 담보 × 가격 × 70%`이면 전액 지급           | 0 지급 (revert 없음)       |
| `repay`              | `min(상환액, 현재 부채)`만 가져감. 다 갚으면 부채를 정확히 0으로   | 지갑 잔고 부족 → 변화 없음 |
| `withdrawCollateral` | 부채가 0이면 담보 전액 반환                                        | 0 반환                     |
| `poke(n)`            | 다음 순번 포지션 n개(최대 3) 블라인드 청산 점검. 누구나, 보상 없음 | -                          |
| `accrue`             | 공개 이자 지수 갱신 (연 10%). 위 함수들이 자동 호출                | -                          |

사용자 함수(예치·대출·상환·반환)는 다른 포지션을 점검하지 않는다. 점검은 `poke`로만 진행하고, 청산 점검 봇
([`../keeper/`](../keeper/README.md))이 주기적으로 호출한다. 사용자가 적어 거래가 뜸해도 점검이 멈추지 않게 하기
위해서다.

- **조회는 본인만**: `collateralOf`, `scaledDebtOf`, `lastBorrowedOf`, `liquidatedDebtOf`, `seizedCollateralOf`는 암호문
  핸들을 돌려주고 본인만 복호화할 수 있다. 현재 부채 = `scaledDebt × previewBorrowIndex() / 2^40` (프론트에서 계산).
- **파라미터**: `parameters()` 하나로 조회 (대출 한도 70%, 청산 기준 80%, 청산 비율 50%, 벌금 5%, 연 10%, poke 최대
  3개). 가격은 `currentPrice()`.
- **이자 = 공개 지수 × 암호화 원금**: 지수(`borrowIndex`)는 시간만의 함수라 공개해도 개인 정보가 없다.
- **나눗셈 대신 곱셈 + 비트 시프트**: 암호문 나눗셈(128비트)은 1,225,000 HCU, 시프트는 37,000 HCU로 33배 차이가 난다.
  이자 지수와 가격 비율(70%, 80%, 105% ÷ 가격, 가격 ÷ 1.05)을 모두 평문에서 2^40 고정소수점 계수로 미리 계산해 쓴다.
- **반올림 방향**: 대출 기록은 올림, 상환·청산 차감은 내림 (풀에 불리하지 않게). 전액 상환은 정확히 0으로 처리한다.

### 블라인드 부분 청산

```
unhealthy = 현재 부채 > 담보 × 가격 × 80%                          (암호문 참/거짓)
상계할 빚  = select(unhealthy, 현재 부채 ÷ 2, 0)
가져갈 담보 = min(상계할 빚 × 1.05 ÷ 가격, 담보)
실제 상계  = min(상계할 빚, 담보 × 가격 ÷ 1.05)     ← 담보가 모자라면(급락) 그만큼만 상계, 나머지는 부실 채권
부채 -= 실제 상계, 담보 -= 가져갈 담보, 가져간 담보 → 프로토콜 준비금 (이 컨트랙트만 접근, 규모도 비공개)
```

- 판단부터 실행까지 전부 암호문이고, 청산자가 돈을 대지 않는다 (청산자가 갚으면 갚을 금액 = 남의 빚을 알게 됨).
- 안전한 포지션도 똑같은 연산을 거쳐 0을 처리하고, 모든 값을 새 암호문으로 다시 저장한다.
- 포지션을 등록할 때 모든 암호문 필드를 0으로 초기화해 둔다. 그래야 점검이 항상 같은 연산 순서로 실행되어 "대출한 적이
  있는지"도 연산 흔적으로 드러나지 않는다.
- 청산된 포지션도 순번 목록에서 빼지 않는다 (빼면 청산 사실이 드러남).
- `poke`는 반환값이 없고 이벤트도 `PositionChecked(user)`뿐이라, 호출한 쪽(봇 포함)은 청산 여부를 알 수 없다.
- 한 번의 `poke`에서 같은 포지션을 두 번 점검하지 않는다 (요청 수가 포지션 수보다 많으면 한 바퀴만).

### 트랜잭션당 연산 비용 (HCU, 테스트로 측정)

fhEVM은 트랜잭션마다 총 20M HCU, 순차 깊이 5M HCU 한도가 있다. 사용자 함수는 점검을 하지 않으므로 가볍다.

| 함수               | 점검 | 총 HCU (한도 대비) | 깊이 HCU (한도 대비) |
| ------------------ | ---: | -----------------: | -------------------: |
| deposit            |    0 |       748,096 (4%) |         369,000 (7%) |
| borrow             |    0 |    3,748,160 (19%) |      2,636,032 (53%) |
| repay              |    0 |    2,868,160 (14%) |      2,279,064 (46%) |
| withdrawCollateral |    0 |       920,064 (5%) |        541,000 (11%) |
| poke(1)            |    1 |    5,463,128 (27%) |      2,290,032 (46%) |
| poke(3)            |    3 |   16,389,384 (82%) |      2,516,064 (50%) |

점검 1건은 약 4.5~5.5M HCU다. 4건이면 20M에 너무 가까워서 `poke`는 최대 3건으로 제한한다. 이전에는 사용자 거래마다 2건씩
점검해서 borrow가 14.7M(73%)이었다.

### 정보 누출 방지 (테스트로 확인한 것)

- 다른 사용자는 남의 담보·부채·대출 결과·청산 기록을 복호화할 수 없다 (ACL 거부).
- **대출 승인과 거절이 온체인에서 똑같아 보인다**: 이벤트 종류와 순서가 완전히 같다.
- **청산과 비청산이 온체인에서 똑같아 보인다**: 같은 배포·같은 거래 순서에서 가격만 달리해(3,000 = 안전, 2,400 = 청산)
  같은 점검 트랜잭션을 비교하면 **이벤트 순서와 gasUsed가 정확히 같다.**
  - 주의: 가스는 호출 순서(저장 슬롯을 처음 쓰는지 등)에 따라서도 달라진다. 서로 다른 시점의 두 트랜잭션을 비교하면
    결과와 무관한 차이가 생기므로, 반드시 "결과만 다른" 조건에서 비교해야 한다.
- 남는 한계: 사용자의 첫 예치(등록)는 초기화 연산이 추가된다. 등록 사실은 원래 공개라 새로운 정보는 아니다.

## 토큰 설계 메모

- **소수점 6자리**: 암호문 정수(`euint64`) 최대값이 약 1.8×10¹⁹라서, 18자리를 쓰면 약 18 ETH밖에 표현하지 못한다.
- **발행 두 가지**
  - `mint(to, amount)`: 평문 금액. calldata에 금액이 보인다. 대출 풀 유동성 공급용.
  - `confidentialMint(to, 암호문, 증명)`: 금액이 숨겨진다. 팀원 분배용.
- **잔고 부족 전송은 revert하지 않고 0을 보낸다.** 실패 여부로 잔고 정보가 새지 않게 하는 FHE 패턴이다 (테스트로 확인).
- **approve 대신 operator**: `setOperator(풀 주소, 만료시각)`을 한 번 해두면 풀이 `confidentialTransferFrom`으로 담보를
  가져갈 수 있다 (`pool:authorize`). 풀 주소가 바뀌면(재배포) 다시 해야 한다.
- 잔고 암호문은 **본인만 복호화**할 수 있다. 다른 주소의 복호화 요청은 ACL에서 거부된다 (테스트로 확인).

## Sepolia 배포

```bash
npx hardhat vars set SEPOLIA_PRIVATE_KEY      # 실행 후 "Enter value:"에 키를 붙여 넣는다 (명령줄에 키를 쓰지 않기)
npx hardhat clean && npx hardhat compile --network sepolia
npx hardhat deploy --network sepolia
npx hardhat frontend:export --network sepolia  # 웹 화면에 주소·ABI 복사
```

RPC는 기본으로 무료 공개 노드를 쓴다 (`INFURA_API_KEY` 또는 `SEPOLIA_RPC_URL`로 바꿀 수 있음). 토큰 바이트코드가 같으면
hardhat-deploy가 기존 토큰을 재사용한다 (잔고 유지).

### ⚠️ 배포 크기: 트랜잭션당 가스 상한

Sepolia는 컨트랙트 생성 비용이 로컬보다 훨씬 크다 (코드 1바이트당 약 2,000 gas). 트랜잭션 하나의 가스 상한은
16,777,216(2^24)이라, 청산 기능을 넣은 대출 풀은 처음에 **17.75M gas(상한의 106%)로 배포 자체가 불가능**했다.

| 조치                                                              | 런타임 바이트코드 | Sepolia 배포 가스 추정 |
| ----------------------------------------------------------------- | ----------------: | ---------------------: |
| 처음 (optimizer runs 800)                                         |           8,809 B |   17,752,968 (106%) ❌ |
| 대출 풀만 runs 1 (코드 크기 우선)                                 |           8,325 B |                      - |
| + 상수 getter 10개 → `parameters()` 1개, 저장·권한 부여 공통 함수 |           8,013 B |    16,262,524 (97%) ✅ |
| (viaIR 시도)                                                      |           8,973 B |     오히려 커져서 제외 |

실제 배포 gasUsed는 13,444,236. 토큰 바이트코드는 그대로라 재사용됐다. 이후 거래 중 점검을 없애면서 코드가 줄어,
2026-11-21 재배포는 13,322,814 gas였다.

- Hardhat의 파일별 컴파일러 설정(`overrides`)은 `solidity: { compilers: [...], overrides: {...} }` 형식에서만 적용된다.
  `solidity: { version, settings }` 형식에서는 **조용히 무시**된다.
- 기능을 더 넣으면 이 상한에 걸린다. 그때는 청산 로직을 별도 라이브러리 컨트랙트로 분리하는 방법을 검토한다.
- 배포 전에 가스를 미리 추정해 보는 것을 권장한다 (`provider.estimateGas`).

### Etherscan 소스 검증

검증하면 Etherscan 거래 화면에 `borrow(bytes32 encryptedAmount, bytes inputProof)`처럼 함수와 입력값이 풀어서 보인다.

```bash
npx hardhat vars set ETHERSCAN_API_KEY            # etherscan.io 키 하나로 Sepolia까지 (API V2)
npx hardhat clean && npx hardhat compile --network sepolia   # ⚠️ 반드시 Sepolia용으로 다시 컴파일
npx hardhat verify --network sepolia --contract contracts/tokens/MockETH.sol:MockETH <mETH 주소> <owner 주소>
npx hardhat verify --network sepolia --contract contracts/tokens/MockUSDC.sol:MockUSDC <mUSDC 주소> <owner 주소>
npx hardhat verify --network sepolia --contract contracts/oracle/MockPriceOracle.sol:MockPriceOracle <오라클 주소> <owner 주소> 3000
npx hardhat verify --network sepolia --contract contracts/PrivateLendingPool.sol:PrivateLendingPool <풀 주소> <mETH 주소> <mUSDC 주소> <오라클 주소>
npx hardhat clean && npx hardhat compile          # 끝나면 로컬용으로 되돌리기 (안 하면 로컬 테스트가 깨질 수 있음)
```

**주의**: Zama Hardhat 플러그인은 컴파일할 때 **대상 네트워크에 따라 FHE 인프라 주소 설정을 바꿔 넣는다.** 로컬용으로
컴파일된 상태에서 검증하면 생성 바이트코드의 주소 20바이트가 달라서 `bytecode does NOT match`로 실패한다. (이 주소는
로컬 체인에서만 실행되는 생성자 분기라 Sepolia 동작에는 영향이 없고, 런타임 코드는 같다.)

### 현재 배포 (2026-11-21, 배포자 `0xb02596cB4da7284493500899266e9715d3c88F94`, 모두 소스 검증 완료)

| 컨트랙트           | 주소                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| MockETH (mETH)     | [`0xdccC0D5CD41F9bac0fBaD9c2e82d23d5C8Cd0883`](https://sepolia.etherscan.io/address/0xdccC0D5CD41F9bac0fBaD9c2e82d23d5C8Cd0883) |
| MockUSDC (mUSDC)   | [`0xAeBe6483077e0531a9353CF40907F25b81AA698F`](https://sepolia.etherscan.io/address/0xAeBe6483077e0531a9353CF40907F25b81AA698F) |
| MockPriceOracle    | [`0xaaeC3d990A8940b234674975a0fcFB9a9DB8D619`](https://sepolia.etherscan.io/address/0xaaeC3d990A8940b234674975a0fcFB9a9DB8D619) |
| PrivateLendingPool | [`0xA52a2382C25a44A2e833A533C1E85439398e075e`](https://sepolia.etherscan.io/address/0xA52a2382C25a44A2e833A533C1E85439398e075e) |

토큰은 처음 배포(11-08) 그대로이고, 오라클(가격 범위 검사 추가)과 대출 풀(거래 중 점검 제거)만 새로 배포했다. 더 이상
쓰지 않는 이전 배포:

| 컨트랙트                                    | 주소                                         |
| ------------------------------------------- | -------------------------------------------- |
| 대출 풀 v1 (청산 기능 없음)                 | `0xaCC16981e75BD26e6725F066eC5a2C42b35E8807` |
| 대출 풀 v2 (거래마다 2건 점검, 본인 건너뜀) | `0x159F8BCFEeFe26083f0D7E2b3011418327a59e7D` |
| 오라클 v1 (0만 막음)                        | `0xe6aa46e52e0cCdE5769d9d34dBf4C1333B490D7C` |

### Sepolia 실제 FHE 검증 결과 (CLI 태스크)

실제 Zama 릴레이어·KMS를 거쳐 암호화 입력과 본인 복호화가 동작함을 확인했다.

| 단계                                             | 결과                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| 암호화 발행 (10 mETH, 1,000 mUSDC) → 잔고 복호화 | 10.0 mETH, 1000.0 mUSDC                                      |
| 5 mETH 예치 → 10,000 mUSDC 대출                  | 승인                                                         |
| 1,000 mUSDC 추가 대출 (한도 초과)                | 거절, 0 지급                                                 |
| 포지션 복호화                                    | 빚 10,000.0019 (몇 분치 이자), 남은 한도 499.99              |
| (풀 v2) 등록·예치·대출, 청산 기록 필드 복호화    | 동작, 청산 가격 2,500 표시                                   |
| (풀 v2) 가격 2,400 → 포지션 상태                 | UNHEALTHY 표시                                               |
| (풀 v2) **봇 지갑으로 poke(1)** → 포지션 복호화  | **실제 청산**: 빚 약 10,035 → 5,017.84, 담보 5 → 2.8047 mETH |
| (현재 풀) 예치 5 → 대출 10,000, 가격 3,000       | 승인, 청산 가격 2,500 표시                                   |
| (현재 풀) 봇 지갑으로 poke(1)                    | 안전한 포지션이라 그대로 (빚·담보 변화 없음)                 |

청산 점검 봇의 첫 실제 점검 트랜잭션:
[`0xf401…9593`](https://sepolia.etherscan.io/tx/0xf401476ccfabb84e5eb80a5c083e5dc64a673eb2e468851f59882ac4fa299593)
(가스 1,574,235). 봇 쪽에는 청산 여부가 전혀 남지 않고, 결과는 포지션 주인만 복호화로 확인했다. 현재 풀에서의 봇 점검:
[`0x433e…5cfe`](https://sepolia.etherscan.io/tx/0x433e3a32a1198d8683ba52acbea5989ded6bdcd0927bb3ad74f05e2dfa4a5cfe)
(가스 1,671,927).

**데모 준비 상태 (2026-11-21)**: 배포자 지갑에 예치 5 mETH / 대출 10,000 mUSDC 포지션이 있고, 가격은 3,000이다.
`oracle:set-price --price 2400` 후 봇을 한 번 돌리면 청산이 시연된다. 끝나면 가격을 3,000으로 되돌린다.

| 트랜잭션 (청산 기능 이전 풀) |   gasUsed |     수수료 |
| ---------------------------- | --------: | ---------: |
| deposit                      | 1,560,028 | 0.0016 ETH |
| borrow (승인)                | 1,692,649 | 0.0017 ETH |
| borrow (거절)                | 1,692,613 | 0.0017 ETH |

**승인/거절 구분 불가 (실제 네트워크에서 확인)**: 두 번째 이후 대출에서 승인 트랜잭션과 거절 트랜잭션의 이벤트 순서
(컨트랙트 + 이벤트 종류)가 완전히 같았다. 가스 차이 36은 실행 비용이 아니라 입력 암호문의 무작위 바이트 차이 (0인 바이트
3개 × 12 gas)에서 온다.

## 라이선스

템플릿 라이선스(BSD-3-Clause-Clear)를 따른다. [LICENSE](LICENSE) 참고.
