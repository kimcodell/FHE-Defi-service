import { useState } from "react";

import type { Health, Position } from "../hooks/usePosition";
import { formatAmount, shortHex } from "../lib/units";

/** 내 포지션: 서명(permit) 전에는 잠금 상태, 서명 후에는 복호화된 값 */
export function PositionCard({ position }: { position: Position }) {
  const [showOnChain, setShowOnChain] = useState(false);
  const { values, handles, hasPermit, grantPermit, permitAddresses } = position;

  return (
    <section className="card">
      <div className="card-head">
        <h2>내 포지션</h2>
        <div className="head-actions">
          {hasPermit && position.isDecrypting && <span className="muted small">복호화 중…</span>}
          <span className="pill small" title="오라클 가격 (공개). 데모에서는 가격 하락을 재현할 수 있어요">
            mETH {position.price !== undefined ? position.price.toLocaleString("ko-KR") : "—"} mUSDC
          </span>
        </div>
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
          {values.liquidatedDebt !== undefined && values.liquidatedDebt > 0n && (
            <div className="liquidated">
              <strong>청산됐어요.</strong> 가격 하락으로 빚 {formatAmount(values.liquidatedDebt)} mUSDC가 담보{" "}
              {formatAmount(values.seizedCollateral ?? 0n)} mETH로 상계됐어요 (벌금 5% 포함, 누적).
              <span className="muted small"> 이 사실은 나만 볼 수 있어요. 블록체인에는 "점검됨"만 남아요.</span>
            </div>
          )}

          <dl className="stats">
            <Stat label="맡긴 담보" value={values.collateral} unit="mETH" />
            <Stat label="갚을 빚 (이자 포함)" value={values.debt} unit="mUSDC" emphasis />
            <Stat label="대출 한도" value={values.limit} unit="mUSDC" hint="담보 × 가격 × 70%" />
            <Stat label="더 빌릴 수 있는 금액" value={values.available} unit="mUSDC" />
          </dl>

          <HealthBar position={position} />

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
            <li>청산 기록: {shortHex(handles.liquidatedDebt, 10, 8)}</li>
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

const HEALTH_TEXT: Record<Health, string> = {
  none: "빚 없음",
  safe: "안전",
  caution: "주의 — 더 빌릴 수 없어요",
  danger: "청산 위험 — 다음 점검 때 청산돼요",
};

/** 건전성: 빚 ÷ 담보 가치. 70%(대출 한도)와 80%(청산 기준)에 선을 표시한다 */
function HealthBar({ position }: { position: Position }) {
  const { health, ratioPermille, liquidationPrice } = position.values;
  if (health === undefined) return null;
  const pct = ratioPermille !== undefined ? ratioPermille / 10 : 0;
  return (
    <div className="health">
      <div className="health-head">
        <span className="muted small">빚 ÷ 담보 가치</span>
        <span className={`badge health-${health}`}>
          {health === "none" ? HEALTH_TEXT.none : `${pct.toFixed(1)}% · ${HEALTH_TEXT[health]}`}
        </span>
      </div>
      <div className="health-track" aria-hidden="true">
        <div className={`health-fill health-${health}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        <span className="health-mark" style={{ left: "70%" }} title="대출 한도 70%" />
        <span className="health-mark danger" style={{ left: "80%" }} title="청산 기준 80%" />
      </div>
      <div className="health-legend muted small">
        <span>0%</span>
        <span style={{ left: "70%" }}>한도 70%</span>
        <span style={{ left: "80%" }}>청산 80%</span>
      </div>
      {liquidationPrice !== undefined && (
        <p className="muted small">
          mETH 가격이 <strong>{liquidationPrice.toLocaleString("ko-KR")} mUSDC</strong> 아래로 내려가면 청산돼요 (빚의
          절반을 담보로 상계, 벌금 5%).
        </p>
      )}
    </div>
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
