# FHE Private Lending

금액이 암호화된 담보 대출 서비스. Zama fhEVM + OpenZeppelin ERC-7984 기밀 토큰 기반 (수업 프로젝트, 2026-12-07 제출).

## 폴더 구조

| 폴더 | 내용 | 상태 |
|---|---|---|
| [`hardhat/`](hardhat/README.md) | 스마트 컨트랙트, 테스트, 배포 스크립트 | 1~2주차 완료 (토큰, 대출 풀) |
| [`frontend/`](frontend/README.md) | React 웹 화면 (Sepolia 전용) | 3주차 화면 완성, Sepolia 배포 후 연동 테스트 예정 |

두 폴더는 각자 `package.json`과 `node_modules`를 가진다. 작업할 폴더로 들어가서 `npm install` 한다.

```bash
cd hardhat
npm install
npm test
```

## 두 폴더의 연결

웹 화면은 컨트랙트를 호출하기 위해 `hardhat/`에서 만들어지는 두 가지가 필요하다.

- **ABI**: 컨트랙트 함수 목록 (`hardhat/artifacts/`)
- **배포 주소**: 네트워크별 컨트랙트 위치 (`hardhat/deployments/`)

`hardhat/`에서 배포 후 `npx hardhat frontend:export --network sepolia`를 실행하면 둘을
`frontend/src/contracts/`로 복사한다.

## Sepolia 배포 준비

배포 지갑의 개인키는 저장소가 아니라 Hardhat 설정 파일(`~/Library/Preferences/hardhat-nodejs/vars.json`)에 저장한다.

```bash
cd hardhat
npx hardhat vars set SEPOLIA_PRIVATE_KEY   # 테스트 ETH가 있는 개발용 지갑
npx hardhat deploy --network sepolia
npx hardhat frontend:export --network sepolia
```

RPC는 기본으로 무료 공개 노드(`ethereum-sepolia-rpc.publicnode.com`)를 쓴다. `INFURA_API_KEY`나 `SEPOLIA_RPC_URL`을 설정하면 그쪽을 쓴다.

## CI

`hardhat/` 변경이 main에 푸시되거나 PR이 열리면 GitHub Actions가 린트·컴파일·테스트를 돌린다 ([.github/workflows/contracts.yml](.github/workflows/contracts.yml)).
