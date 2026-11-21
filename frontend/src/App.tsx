import { sepolia } from "wagmi/chains";
import { useConnect, useConnection, useConnectors, useSwitchChain } from "wagmi";

import { ActionsCard } from "./components/ActionsCard";
import { ActivityCard } from "./components/ActivityCard";
import { useActivityLog } from "./hooks/useActivityLog";
import { Header } from "./components/Header";
import { LiquidationCheckCard } from "./components/LiquidationCheckCard";
import { OraclePage } from "./components/OraclePage";
import { PositionCard } from "./components/PositionCard";
import { getAddresses } from "./contracts";
import { usePosition } from "./hooks/usePosition";
import { Icon, TokenDot } from "./components/Icon";
import { addressUrl } from "./lib/explorer";
import { useRoute } from "./lib/route";
import { hasBrowserWallet } from "./lib/wallet";

export default function App() {
  const { isConnected, chainId, address } = useConnection();
  const addresses = getAddresses(chainId);
  const position = usePosition(addresses);
  const activityLog = useActivityLog(chainId, address);
  const route = useRoute();

  return (
    <div className="page">
      <Header route={route} />
      <main>
        {route === "oracle" ? (
          <OraclePage addresses={getAddresses(chainId ?? sepolia.id)} position={position} />
        ) : !isConnected ? (
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
            <LiquidationCheckCard position={position} onActivity={activityLog.add} />
            <ActivityCard activities={activityLog.activities} onClear={activityLog.clear} />
            <section className="contracts">
              <span className="muted small">컨트랙트 (Etherscan)</span>
              {(
                [
                  ["대출 풀", addresses.PrivateLendingPool],
                  ["mETH 토큰", addresses.MockETH],
                  ["mUSDC 토큰", addresses.MockUSDC],
                  ["가격 오라클", addresses.MockPriceOracle],
                ] as const
              ).map(
                ([label, addr]) =>
                  addr && (
                    <a key={label} className="pill" href={addressUrl(addr)} target="_blank" rel="noreferrer">
                      {label} <Icon name="external" size={12} />
                    </a>
                  ),
              )}
              <span className="muted small">토큰 페이지에서도 누가 얼마를 가졌는지는 보이지 않아요</span>
            </section>
          </>
        )}
      </main>
      <footer className="muted small">
        수업 프로젝트 데모 · 테스트넷 전용 · 대출 한도 70% · 청산 기준 80% (빚 절반 상계, 벌금 5%) · 연 10% 고정 이자 ·
        가격은 데모용 모의 오라클
      </footer>
    </div>
  );
}

function Welcome() {
  const connectors = useConnectors();
  const connect = useConnect();
  const injected = hasBrowserWallet() ? connectors[0] : undefined;
  return (
    <section className="hero">
      <div className="hero-copy">
        <span className="eyebrow">
          <Icon name="shield" size={14} /> Zama FHE · Sepolia 테스트넷
        </span>
        <h2>
          누가 얼마를 빌렸는지,
          <br />
          <span className="grad-text">아무도 모르는 대출</span>
        </h2>
        <p>
          금액은 내 브라우저에서 암호화돼서 보내지고, 컨트랙트는 암호를 풀지 않은 채 대출 한도를 계산해요. 결과는 나만
          열어 볼 수 있어요.
        </p>
        <ol className="steps">
          <li>MetaMask 연결</li>
          <li>mETH 담보 맡기기</li>
          <li>담보의 70%까지 빌리기</li>
          <li>갚고 담보 돌려받기</li>
        </ol>
        <div className="row">
          {injected ? (
            <button className="btn primary" onClick={() => connect.mutate({ connector: injected })}>
              <Icon name="wallet" />
              {connect.isPending ? "연결 중…" : "지갑 연결하고 시작하기"}
            </button>
          ) : (
            <p className="warn">브라우저 지갑이 없어요. MetaMask를 설치한 뒤 새로고침하세요.</p>
          )}
        </div>
        {connect.error && <p className="error">{connect.error.message}</p>}
      </div>

      <div className="preview" aria-label="다른 사람에게 보이는 내 포지션 예시">
        <div className="card-head">
          <strong>내 포지션</strong>
          <span className="badge good">본인만 열람</span>
        </div>
        <div className="preview-row">
          <span className="who">
            <TokenDot symbol="mETH" /> 맡긴 담보
          </span>
          <span className="masked">
            <Icon name="lock" size={14} />
            ••••••
          </span>
        </div>
        <div className="preview-row">
          <span className="who">
            <TokenDot symbol="mUSDC" /> 빌린 금액
          </span>
          <span className="masked">
            <Icon name="lock" size={14} />
            ••••••
          </span>
        </div>
        <p className="muted small">블록체인에는 금액 대신 암호문만 남아요.</p>
      </div>
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
