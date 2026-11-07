# FHE Private Lending — 컨트랙트 (hardhat)

금액이 암호화된 담보 대출 서비스. Zama fhEVM + OpenZeppelin ERC-7984 기밀 토큰 기반.
[Zama fhevm-hardhat-template](https://github.com/zama-ai/fhevm-hardhat-template)에서 시작했다.

저장소 전체 구조는 [../README.md](../README.md), 기획 전체는 [../../README.md](../../README.md)를 본다. 이
폴더(`hardhat/`)에서 명령을 실행한다.

## 진행 상황

| 주차  | 내용                                             | 상태                       |
| ----- | ------------------------------------------------ | -------------------------- |
| 1주차 | mETH / mUSDC 기밀 토큰, 팀원 분배 태스크, 테스트 | ✅ 완료 (테스트 10개 통과) |
| 2주차 | 대출 풀 (예치·대출·상환·반환·이자), 태스크       | ✅ 완료 (테스트 26개 통과) |
| 3주차 | Sepolia 배포, 웹 화면                            | 예정                       |

## 준비물

- **Node.js 22 이상**. 웹 화면에서 쓰는 `@zama-fhe/relayer-sdk`가 22 이상을 요구한다. nvm 사용 시:
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
npx hardhat deploy --network localhost                       # mETH, mUSDC, 대출 풀 배포 + 풀에 1,000만 mUSDC
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
npx hardhat pool:position  --network localhost --signer 1                 # 담보·부채(이자 포함)·한도 복호화
npx hardhat pool:repay     --network localhost --signer 1 --amount 10100  # 부채만큼만 가져감
npx hardhat pool:withdraw  --network localhost --signer 1                 # 부채 0이면 담보 전액 반환
```

## 구조

```
contracts/
  PrivateLendingPool.sol       # 대출 풀: deposit / borrow / repay / withdrawCollateral / accrue
  tokens/
    MockConfidentialToken.sol  # 공통 베이스: ERC-7984 + owner 전용 mint / confidentialMint
    MockETH.sol                # 담보 토큰 mETH
    MockUSDC.sol               # 대출 토큰 mUSDC
deploy/01_tokens.ts            # 토큰 배포
deploy/02_pool.ts              # 대출 풀 배포 + 1,000만 mUSDC 유동성
tasks/tokens.ts                # token:distribute, team:fund, token:balance, token:address
tasks/pool.ts                  # pool:authorize, deposit, borrow, repay, withdraw, position
test/tokens.ts                 # 토큰 테스트 (10)
test/lendingPool.ts            # 대출 풀 테스트 (26)
```

## 대출 풀 설계 메모

| 기능                 | 동작                                                             | 실패 시                    |
| -------------------- | ---------------------------------------------------------------- | -------------------------- |
| `deposit`            | 암호화된 mETH를 담보로 가져옴                                    | 지갑 잔고 부족 → 0 예치    |
| `borrow`             | `(현재 부채 + 요청액) ≤ 담보 × 2100`이면 전액 지급               | 0 지급 (revert 없음)       |
| `repay`              | `min(상환액, 현재 부채)`만 가져감. 다 갚으면 부채를 정확히 0으로 | 지갑 잔고 부족 → 변화 없음 |
| `withdrawCollateral` | 부채가 0이면 담보 전액 반환                                      | 0 반환                     |
| `accrue`             | 공개 이자 지수 갱신 (연 10%). 위 함수들이 자동 호출              | -                          |

- **조회는 본인만**: `collateralOf`, `scaledDebtOf`, `lastBorrowedOf`는 암호문 핸들을 돌려주고, 본인만 복호화할 수 있다.
  현재 부채 = `scaledDebt × previewBorrowIndex() / 2^40` (프론트에서 계산).
- **대출 결과 피드백**: `lastBorrowedOf`가 0이면 거절, 0보다 크면 승인된 금액.
- **이자 = 공개 지수 × 암호화 원금**: 지수(`borrowIndex`)는 시간만의 함수라 공개해도 개인 정보가 없다.
- **나눗셈 대신 비트 시프트**: 암호문 나눗셈(128비트)은 1,225,000 HCU, 시프트는 37,000 HCU로 33배 차이가 난다. 그래서
  지수를 2^40 고정소수점으로 두고 나눗셈을 시프트로 바꿨다.
- **반올림 방향**: 대출 기록은 올림, 상환 차감은 내림 (풀에 불리하지 않게). 전액 상환은 정확히 0으로 처리한다.

### 트랜잭션당 연산 비용 (HCU, 테스트로 측정)

fhEVM은 트랜잭션마다 총 20M HCU, 순차 깊이 5M HCU 한도가 있다.

| 함수               |    총 HCU |  깊이 HCU | 깊이 한도 대비 |
| ------------------ | --------: | --------: | -------------: |
| deposit            |   748,096 |   369,000 |             7% |
| borrow             | 3,711,224 | 2,636,064 |            53% |
| repay              | 2,868,160 | 2,279,064 |            46% |
| withdrawCollateral |   920,064 |   541,000 |            11% |

### 정보 누출 방지 (테스트로 확인한 것)

- 다른 사용자는 남의 담보·부채·대출 결과를 복호화할 수 없다 (ACL 거부).
- **승인과 거절이 온체인에서 똑같아 보인다.** fhEVM은 암호 연산마다 이벤트(연산 종류만, 값 없음)를 남기는데, 승인/거절
  트랜잭션의 이벤트 종류와 순서가 완전히 같다.
  - 단, 사용자의 **첫** 대출은 비어 있던 부채 기록을 초기화하는 연산이 추가된다. "처음 대출했다"는 것은 드러나지만
    금액과 승인 여부는 드러나지 않는다 (보고서의 한계 항목).

## 토큰 설계 메모

- **소수점 6자리**: 암호문 정수(`euint64`) 최대값이 약 1.8×10¹⁹라서, 18자리를 쓰면 약 18 ETH밖에 표현하지 못한다.
- **발행 두 가지**
  - `mint(to, amount)`: 평문 금액. calldata에 금액이 보인다. 대출 풀 유동성 공급용.
  - `confidentialMint(to, 암호문, 증명)`: 금액이 숨겨진다. 팀원 분배용.
- **잔고 부족 전송은 revert하지 않고 0을 보낸다.** 실패 여부로 잔고 정보가 새지 않게 하는 FHE 패턴이다 (테스트로 확인).
- **approve 대신 operator**: `setOperator(풀 주소, 만료시각)`을 한 번 해두면 풀이 `confidentialTransferFrom`으로 담보를
  가져갈 수 있다. 대출 풀이 이 방식을 쓴다 (`pool:authorize`).
- 잔고 암호문은 **본인만 복호화**할 수 있다. 다른 주소의 복호화 요청은 ACL에서 거부된다 (테스트로 확인).

## Sepolia 배포 (3주차)

```bash
npx hardhat vars set MNEMONIC          # 개발 전용 지갑의 시드 문구
npx hardhat vars set INFURA_API_KEY
npx hardhat deploy --network sepolia
```

## 라이선스

템플릿 라이선스(BSD-3-Clause-Clear)를 따른다. [LICENSE](LICENSE) 참고.
