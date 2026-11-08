# FHE Private Lending — 웹 화면 (frontend)

React + Vite + TypeScript. 지갑 연결은 wagmi/viem, 암호화·복호화는 Zama 공식 SDK(`@zama-fhe/sdk`, `@zama-fhe/react-sdk`)를 쓴다.
대상 네트워크는 **Sepolia 테스트넷**뿐이다 (Sepolia 릴레이어는 API 키 없이 열려 있다).

## 실행

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 타입 체크 + 프로덕션 빌드
npm run lint
```

브라우저에 MetaMask가 있어야 하고, 지갑 네트워크는 Sepolia여야 한다.

## 컨트랙트 주소·ABI 갱신

`src/contracts/abis.ts`와 `src/contracts/deployments.json`은 자동 생성 파일이다. 컨트랙트를 다시 배포하면 `hardhat/`에서:

```bash
npx hardhat deploy --network sepolia
npx hardhat frontend:export --network sepolia
```

`deployments.json`에 Sepolia(11155111) 주소가 없으면 화면에 "아직 배포되지 않았어요"가 뜬다.

## 화면 구성

| 영역 | 하는 일 |
|---|---|
| 내 포지션 | 담보·빚(이자 포함)·대출 한도·지갑 잔고·마지막 대출 결과를 **본인만** 복호화해서 보여준다. 처음 한 번 지갑 서명(permit, 30일 유지)이 필요하다. "다른 사람에게는 이렇게 보여요"를 펼치면 온체인에 저장된 암호문 핸들을 보여준다. |
| 거래하기 | 담보 맡기기 / 빌리기 / 갚기 / 담보 돌려받기. 금액은 브라우저에서 암호화된 뒤 암호문과 증명만 전송된다. 처음 예치·상환 때 대출 풀에 토큰 사용 권한(operator)을 준다. |
| 거래 기록 | 이번 세션에서 보낸 거래의 "내가 입력한 금액"과 "블록체인에 기록된 암호문"을 나란히 보여주고 Etherscan으로 연결한다. 발표 데모용. |

## 구조

```
src/
  config.ts               # wagmi(Sepolia, MetaMask) + Zama SDK 설정
  main.tsx                # Provider 구성
  App.tsx                 # 연결 전 / 네트워크 다름 / 배포 전 / 메인 화면 분기
  hooks/usePosition.ts    # 핸들 읽기 → permit 후 복호화 → 빚·한도 계산
  components/
    Header.tsx            # 지갑 연결
    PositionCard.tsx      # 내 포지션 (복호화)
    ActionsCard.tsx       # 예치·대출·상환·반환 (암호화 → 전송 → 대기 → 결과)
    ActivityCard.tsx      # 거래 기록
  contracts/              # 자동 생성 ABI·주소
  lib/units.ts            # 6 decimals 변환, 금액 검증
```

## 동작 원리 메모

- **암호화**: `sdk.encrypt({ values: [{ type: "euint64", value }], contractAddress: 대출풀, userAddress: 나 })`.
  결과 암호문은 (대출 풀, 내 주소)에 묶여 있어서 다른 컨트랙트나 다른 사람이 재사용할 수 없다.
- **복호화**: `useDecryptValues`. 서명한 permit이 있을 때만 실행해서 화면을 열자마자 지갑 팝업이 뜨지 않게 했다.
- **현재 빚** = 복호화한 scaled 부채 × 공개 이자 지수(`previewBorrowIndex`) / 2^40. 컨트랙트와 같은 계산을 브라우저에서 한다.
- **실패해도 에러가 없다**: 한도 초과 대출은 0원 지급으로 끝난다. 그래서 대출 후 "마지막 대출 결과"를 복호화해서 승인/거절을 보여준다.
- 빌드 시 "큰 청크" 경고는 FHE 엔진(TFHE WASM, 약 1.7MB)이 번들에 들어가서 생기는 것으로 정상이다.
