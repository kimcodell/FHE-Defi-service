import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { sepolia } from "wagmi/chains";

import { addressUrl } from "../lib/explorer";
import { shortHex } from "../lib/units";
import { hasBrowserWallet } from "../lib/wallet";
import { BrandMark, Icon } from "./Icon";

export function Header() {
  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  // 브라우저 지갑이 없으면 연결 버튼을 비활성화한다
  const injected = hasBrowserWallet() ? connectors[0] : undefined;

  return (
    <header className="header">
      <div className="brand">
        <BrandMark />
        <div>
          <h1>FHE-DeFi</h1>
          <p className="brand-sub">금액이 암호화된 담보 대출 · Zama FHE</p>
        </div>
      </div>

      {isConnected && address ? (
        <div className="wallet">
          {chainId === sepolia.id && <span className="pill net">Sepolia</span>}
          <a
            className="pill mono"
            href={addressUrl(address)}
            target="_blank"
            rel="noreferrer"
            title={`${address} — Etherscan에서 내 거래 전체 보기`}
          >
            <Icon name="wallet" size={14} />
            {shortHex(address)}
          </a>
          <button className="btn ghost small" onClick={() => disconnect.mutate()}>
            연결 해제
          </button>
        </div>
      ) : (
        <button
          className="btn primary"
          disabled={!injected || connect.isPending}
          onClick={() => injected && connect.mutate({ connector: injected })}
        >
          <Icon name="wallet" />
          {connect.isPending ? "연결 중…" : "지갑 연결"}
        </button>
      )}
    </header>
  );
}
