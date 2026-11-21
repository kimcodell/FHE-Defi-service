import { useState } from "react";
import type { Hex } from "viem";
import { BaseError, zeroAddress } from "viem";
import { useConfig, useConnection, useReadContracts, useWriteContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { waitForTransactionReceipt } from "wagmi/actions";

import { type ContractAddresses, oracleAbi } from "../contracts";
import { LIQUIDATION_THRESHOLD_PCT, LTV_PCT, type Position } from "../hooks/usePosition";
import { addressUrl, txUrl } from "../lib/explorer";
import { shortHex } from "../lib/units";
import { Icon, TokenDot } from "./Icon";

/** 대출 풀이 받아들이는 최대 가격 (2^24 - 1). 이전 오라클에는 MAX_PRICE 함수가 없어서 기본값으로 쓴다. */
const DEFAULT_MAX_PRICE = 2n ** 24n - 1n;
/** 청산 점검 봇이 한 바퀴를 도는 하락 기준 */
const BOT_TRIGGER_BPS = 200n;

/**
 * 가격 오라클 화면 (데모용).
 * 누구나 현재 가격과 소유자를 볼 수 있고, 오라클 소유자 지갑만 가격을 바꿀 수 있다.
 * 실서비스에서는 이 화면 대신 Chainlink 같은 탈중앙 오라클이 가격을 정한다.
 */
export function OraclePage({ addresses, position }: { addresses: ContractAddresses | undefined; position: Position }) {
  const oracle = addresses?.MockPriceOracle;
  const { address: user, isConnected, chainId } = useConnection();
  const config = useConfig();
  const write = useWriteContract();

  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: oracle ?? zeroAddress, abi: oracleAbi, functionName: "price", chainId: sepolia.id },
      { address: oracle ?? zeroAddress, abi: oracleAbi, functionName: "owner", chainId: sepolia.id },
      { address: oracle ?? zeroAddress, abi: oracleAbi, functionName: "MAX_PRICE", chainId: sepolia.id },
    ],
    query: { enabled: Boolean(oracle), refetchInterval: 12_000 },
  });
  const price = reads.data?.[0]?.result as bigint | undefined;
  const owner = reads.data?.[1]?.result as `0x${string}` | undefined;
  const maxPrice = (reads.data?.[2]?.result as bigint | undefined) ?? DEFAULT_MAX_PRICE;
  const isOwner = Boolean(user && owner && user.toLowerCase() === owner.toLowerCase());

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastTx, setLastTx] = useState<{ hash: Hex; from: bigint; to: bigint }>();

  if (!oracle) {
    return (
      <section className="card notice">
        <h2>가격 오라클이 없어요</h2>
        <p className="muted">이 네트워크의 배포 정보에 오라클 주소가 없어요. Sepolia에 연결했는지 확인해 주세요.</p>
      </section>
    );
  }

  const parsed = parsePrice(input, maxPrice);
  const next = parsed && "value" in parsed ? parsed.value : undefined;
  const changeBps =
    price !== undefined && next !== undefined && price > 0n ? ((next - price) * 10_000n) / price : undefined;

  const presets: { label: string; value: bigint }[] = [
    { label: "3,000 (기본)", value: 3000n },
    { label: "2,400 (청산 시연)", value: 2400n },
    ...(price !== undefined
      ? [
          { label: "−2%", value: (price * 98n) / 100n },
          { label: "−10%", value: (price * 90n) / 100n },
          { label: "+5%", value: (price * 105n) / 100n },
        ]
      : []),
  ];

  async function submit() {
    if (next === undefined || price === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const hash = await write.mutateAsync({
        address: oracle!,
        abi: oracleAbi,
        functionName: "setPrice",
        args: [next],
        chainId: sepolia.id,
      });
      const receipt = await waitForTransactionReceipt(config, { hash });
      if (receipt.status !== "success") throw new Error("트랜잭션이 실패했어요 (reverted)");
      setLastTx({ hash, from: price, to: next });
      setInput("");
      await Promise.all([reads.refetch(), position.refetch()]);
    } catch (e) {
      setError(e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const blocker = !isConnected
    ? "지갑을 연결하면 바꿀 수 있어요."
    : chainId !== sepolia.id
      ? "Sepolia 테스트넷으로 바꿔 주세요."
      : !isOwner
        ? "오라클 소유자 지갑만 가격을 바꿀 수 있어요. 지금 연결된 지갑은 소유자가 아니에요."
        : undefined;

  return (
    <div className="grid">
      <section className="card">
        <div className="card-head">
          <h2>현재 가격</h2>
          <span className="badge good">공개 정보</span>
        </div>
        <div className="price-big">
          <TokenDot symbol="mETH" />
          <span>1 mETH =</span>
          <span>{price !== undefined ? price.toLocaleString("ko-KR") : <span className="skeleton" />}</span>
          <span className="unit">mUSDC</span>
        </div>
        <dl className="kv">
          <dt>오라클</dt>
          <dd>
            <a href={addressUrl(oracle)} target="_blank" rel="noreferrer" className="mono">
              {shortHex(oracle)} <Icon name="external" size={12} />
            </a>
          </dd>
          <dt>소유자</dt>
          <dd>
            {owner ? (
              <a href={addressUrl(owner)} target="_blank" rel="noreferrer" className="mono">
                {shortHex(owner)} <Icon name="external" size={12} />
              </a>
            ) : (
              "—"
            )}{" "}
            {isOwner && <span className="badge good">내 지갑</span>}
          </dd>
          <dt>허용 범위</dt>
          <dd>1 ~ {maxPrice.toLocaleString("ko-KR")} (정수)</dd>
        </dl>
        <p className="help">
          데모용 모의 오라클이에요. 가격을 내려서 청산을 시연할 수 있어요. 실서비스에서는 Chainlink 같은 탈중앙 오라클로
          바꾸고, 대출 풀은 가격만 읽어요.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>가격 바꾸기</h2>
          <span className="muted small">소유자 전용</span>
        </div>

        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label className="swap-box">
              <span className="swap-top">
                <span>새 가격 (1 mETH당)</span>
              </span>
              <span className="swap-main">
                <input
                  inputMode="numeric"
                  placeholder={price !== undefined ? price.toString() : "3000"}
                  value={input}
                  disabled={busy}
                  onChange={(e) => setInput(e.target.value)}
                />
                <span className="token-pill">
                  <TokenDot symbol="mUSDC" />
                  mUSDC
                </span>
              </span>
              {changeBps !== undefined && (
                <span className="swap-bottom">
                  <span>
                    지금보다 {changeBps >= 0n ? "+" : "−"}
                    {(Number(changeBps < 0n ? -changeBps : changeBps) / 100).toFixed(2)}%
                  </span>
                </span>
              )}
            </label>
            {input && parsed && "error" in parsed && <span className="error small">{parsed.error}</span>}
          </div>

          <div className="chips">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => setInput(p.value.toString())}
              >
                {p.label}
              </button>
            ))}
          </div>

          {next !== undefined && <Impact position={position} next={next} changeBps={changeBps} />}

          <button type="submit" className="btn primary wide" disabled={busy || next === undefined || Boolean(blocker)}>
            {busy ? "지갑 승인 → 블록 대기 중…" : "가격 바꾸기"}
          </button>
          {blocker && <p className="warn small">{blocker}</p>}
        </form>

        {lastTx && (
          <div className="explorer-box">
            <p className="badge good">
              가격 변경 완료 · {lastTx.from.toLocaleString("ko-KR")} → {lastTx.to.toLocaleString("ko-KR")}
            </p>
            <a className="btn ghost small" href={txUrl(lastTx.hash)} target="_blank" rel="noreferrer">
              Etherscan에서 이 거래 확인 <Icon name="external" size={12} />
            </a>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}

/** 새 가격에서 내 포지션과 청산 점검 봇이 어떻게 반응할지 미리 보여준다 */
function Impact({ position, next, changeBps }: { position: Position; next: bigint; changeBps: bigint | undefined }) {
  const { collateral, debt } = position.values;
  const botFires = changeBps !== undefined && changeBps <= -BOT_TRIGGER_BPS;

  let mine: React.ReactNode;
  if (!position.hasPermit || collateral === undefined || debt === undefined) {
    mine = <span className="muted">대출 화면에서 "내 값 열어 보기"를 하면 내 포지션에 미치는 영향도 보여 드려요.</span>;
  } else if (debt === 0n || collateral === 0n) {
    mine = <span className="muted">빚이 없어서 청산과 상관없어요.</span>;
  } else {
    const permille = Number((debt * 1000n) / (collateral * next));
    const pct = (permille / 10).toFixed(1);
    mine =
      permille > Number(LIQUIDATION_THRESHOLD_PCT) * 10 ? (
        <span>
          내 포지션 빚 비율 <strong>{pct}%</strong> → <span className="badge health-danger">청산 대상</span>
        </span>
      ) : permille > Number(LTV_PCT) * 10 ? (
        <span>
          내 포지션 빚 비율 <strong>{pct}%</strong> →{" "}
          <span className="badge health-caution">주의 (더 빌릴 수 없음)</span>
        </span>
      ) : (
        <span>
          내 포지션 빚 비율 <strong>{pct}%</strong> → <span className="badge health-safe">안전</span>
        </span>
      );
  }

  return (
    <div className="impact">
      <span>{mine}</span>
      <span className="muted small">
        {botFires
          ? "2% 이상 떨어지는 변경이라, 청산 점검 봇이 켜져 있으면 1분 안에 모든 포지션을 점검해요."
          : "2% 미만 변화거나 오르는 변경이라, 봇은 바로 점검하지 않아요 (하루 한 번 정기 점검)."}
      </span>
    </div>
  );
}

function parsePrice(input: string, max: bigint): { value: bigint } | { error: string } | undefined {
  const text = input.trim().replaceAll(",", "");
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) return { error: "정수만 입력할 수 있어요" };
  const value = BigInt(text);
  if (value < 1n) return { error: "1 이상이어야 해요" };
  if (value > max) return { error: `${max.toLocaleString("ko-KR")} 이하여야 해요 (대출 풀이 더 큰 가격을 거부해요)` };
  return { value };
}
