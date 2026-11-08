import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";

import { shortHex } from "../lib/units";
import { hasBrowserWallet } from "../lib/wallet";

export function Header() {
  const { address, isConnected } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  // 브라우저 지갑이 없으면 연결 버튼을 비활성화한다
  const injected = hasBrowserWallet() ? connectors[0] : undefined;

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          🔒
        </span>
        <div>
          <h1>Private Lending</h1>
          <p className="muted small">금액이 암호화된 담보 대출 · Zama FHE · Sepolia</p>
        </div>
      </div>

      {isConnected && address ? (
        <div className="wallet">
          <span className="pill mono" title={address}>
            {shortHex(address)}
          </span>
          <button className="btn ghost" onClick={() => disconnect.mutate()}>
            연결 해제
          </button>
        </div>
      ) : (
        <button
          className="btn primary"
          disabled={!injected || connect.isPending}
          onClick={() => injected && connect.mutate({ connector: injected })}
        >
          {connect.isPending ? "연결 중…" : "지갑 연결"}
        </button>
      )}
    </header>
  );
}
