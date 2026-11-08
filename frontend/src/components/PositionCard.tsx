import { useState } from "react";

import type { Position } from "../hooks/usePosition";
import { formatAmount, shortHex } from "../lib/units";

/** 내 포지션: 서명(permit) 전에는 잠금 상태, 서명 후에는 복호화된 값 */
export function PositionCard({ position }: { position: Position }) {
  const [showOnChain, setShowOnChain] = useState(false);
  const { values, handles, hasPermit, grantPermit, permitAddresses } = position;

  return (
    <section className="card">
      <div className="card-head">
        <h2>내 포지션</h2>
        {hasPermit && position.isDecrypting && <span className="muted small">복호화 중…</span>}
      </div>

      {!hasPermit ? (
        <div className="locked">
          <p className="lock-icon" aria-hidden="true">
            🔐
          </p>
          <p>
            담보, 빚, 잔고는 블록체인에 <strong>암호문</strong>으로만 저장돼 있어요. 볼 수 있는 사람은 지갑 주인뿐입니다.
          </p>
          <p className="muted small">
            처음 한 번 지갑 서명을 하면 이 앱이 내 값을 복호화할 수 있어요. 돈이 나가지 않는 서명이고, 30일간 유지돼요.
          </p>
          <button
            className="btn primary"
            disabled={grantPermit.isPending || permitAddresses.length === 0}
            onClick={() => grantPermit.mutate(permitAddresses)}
          >
            {grantPermit.isPending ? "지갑에서 서명해 주세요…" : "내 포지션 보기 (서명 1회)"}
          </button>
          {grantPermit.error && <p className="error">{grantPermit.error.message}</p>}
        </div>
      ) : (
        <>
          <dl className="stats">
            <Stat label="맡긴 담보" value={values.collateral} unit="mETH" />
            <Stat label="갚을 빚 (이자 포함)" value={values.debt} unit="mUSDC" emphasis />
            <Stat label="대출 한도" value={values.limit} unit="mUSDC" hint="담보 × 3,000 × 70%" />
            <Stat label="더 빌릴 수 있는 금액" value={values.available} unit="mUSDC" />
          </dl>

          <div className="divider" />

          <dl className="stats compact">
            <Stat label="지갑 mETH" value={values.methBalance} unit="mETH" />
            <Stat label="지갑 mUSDC" value={values.musdcBalance} unit="mUSDC" />
            <div className="stat">
              <dt>마지막 대출 결과</dt>
              <dd>
                {values.lastBorrowed === undefined ? (
                  <span className="muted">—</span>
                ) : values.lastBorrowed === 0n ? (
                  <span className="badge bad">거절 또는 없음</span>
                ) : (
                  <span className="badge good">승인 {formatAmount(values.lastBorrowed)} mUSDC</span>
                )}
              </dd>
            </div>
          </dl>
          {position.decryptError && <p className="error">복호화 실패: {position.decryptError.message}</p>}
        </>
      )}

      <button className="link small" onClick={() => setShowOnChain((v) => !v)}>
        {showOnChain ? "▾" : "▸"} 다른 사람에게는 이렇게 보여요 (온체인 값)
      </button>
      {showOnChain && handles && (
        <div className="onchain">
          <p className="muted small">블록체인에 저장된 값은 아래 같은 암호문 핸들뿐이에요. 금액은 알 수 없습니다.</p>
          <ul className="mono small">
            <li>담보: {shortHex(handles.collateral, 10, 8)}</li>
            <li>빚: {shortHex(handles.scaledDebt, 10, 8)}</li>
            <li>대출 결과: {shortHex(handles.lastBorrowed, 10, 8)}</li>
          </ul>
          <p className="muted small">
            공개 이자 지수: {position.borrowIndex !== undefined ? (Number(position.borrowIndex) / 2 ** 40).toFixed(8) : "—"}{" "}
            (연 10% 고정, 시간만으로 정해져서 공개돼도 괜찮아요)
          </p>
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  unit,
  hint,
  emphasis,
}: {
  label: string;
  value: bigint | undefined;
  unit: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`stat${emphasis ? " emphasis" : ""}`}>
      <dt>
        {label}
        {hint && <span className="muted small"> · {hint}</span>}
      </dt>
      <dd>
        {value === undefined ? (
          <span className="skeleton" aria-label="불러오는 중" />
        ) : (
          <>
            <span className="num">{formatAmount(value)}</span> <span className="unit">{unit}</span>
          </>
        )}
      </dd>
    </div>
  );
}
