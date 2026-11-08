import { sepolia } from "wagmi/chains";
import { useConnect, useConnection, useConnectors, useSwitchChain } from "wagmi";

import { ActionsCard } from "./components/ActionsCard";
import { ActivityCard } from "./components/ActivityCard";
import { useActivityLog } from "./hooks/useActivityLog";
import { Header } from "./components/Header";
import { PositionCard } from "./components/PositionCard";
import { getAddresses } from "./contracts";
import { usePosition } from "./hooks/usePosition";
import { hasBrowserWallet } from "./lib/wallet";

export default function App() {
  const { isConnected, chainId, address } = useConnection();
  const addresses = getAddresses(chainId);
  const position = usePosition(addresses);
  const activityLog = useActivityLog(chainId, address);

  return (
    <div className="page">
      <Header />
      <main>
        {!isConnected ? (
          <Welcome />
        ) : chainId !== sepolia.id ? (
          <WrongNetwork />
        ) : !addresses ? (
          <Notice title="아직 Sepolia에 배포되지 않았어요">
            <code>hardhat/</code>에서 <code>npx hardhat deploy --network sepolia</code> 후{" "}
            <code>npx hardhat frontend:export --network sepolia</code>를 실행하면 이 화면이 열립니다.
          </Notice>
        ) : (
          <>
            <div className="grid">
              <PositionCard position={position} />
              <ActionsCard position={position} onActivity={activityLog.add} />
            </div>
            <ActivityCard activities={activityLog.activities} onClear={activityLog.clear} />
          </>
        )}
      </main>
      <footer className="muted small">
        수업 프로젝트 데모 · 테스트넷 전용 · 환율 1 mETH = 3,000 mUSDC · 담보비율 70% · 연 10% 고정 이자
      </footer>
    </div>
  );
}

function Welcome() {
  const connectors = useConnectors();
  const connect = useConnect();
  const injected = hasBrowserWallet() ? connectors[0] : undefined;
  return (
    <section className="card hero">
      <h2>누가 얼마를 빌렸는지, 아무도 모르는 대출</h2>
      <p>
        일반 DeFi에서는 담보와 대출 금액이 블록체인에 그대로 공개됩니다. 이 서비스는 금액을 <strong>내 브라우저에서
        암호화</strong>해서 보내고, 컨트랙트는 <strong>암호를 풀지 않은 채</strong> 대출 한도를 계산합니다. 결과는 나만
        복호화해서 볼 수 있어요.
      </p>
      <ol className="steps">
        <li>MetaMask를 Sepolia 테스트넷에 연결</li>
        <li>mETH를 담보로 맡기기</li>
        <li>담보의 70%까지 mUSDC 빌리기</li>
        <li>이자와 함께 갚고 담보 돌려받기</li>
      </ol>
      {injected ? (
        <button className="btn primary" onClick={() => connect.mutate({ connector: injected })}>
          {connect.isPending ? "연결 중…" : "지갑 연결하고 시작하기"}
        </button>
      ) : (
        <p className="warn">브라우저 지갑이 없어요. MetaMask를 설치한 뒤 새로고침하세요.</p>
      )}
      {connect.error && <p className="error">{connect.error.message}</p>}
    </section>
  );
}

function WrongNetwork() {
  const switchChain = useSwitchChain();
  return (
    <Notice title="Sepolia 테스트넷으로 바꿔 주세요">
      이 서비스는 Sepolia(테스트넷)에서만 동작해요.
      <div className="row">
        <button
          className="btn primary"
          disabled={switchChain.isPending}
          onClick={() => switchChain.mutate({ chainId: sepolia.id })}
        >
          {switchChain.isPending ? "전환 중…" : "Sepolia로 전환"}
        </button>
      </div>
    </Notice>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card notice">
      <h2>{title}</h2>
      <div className="muted">{children}</div>
    </section>
  );
}
