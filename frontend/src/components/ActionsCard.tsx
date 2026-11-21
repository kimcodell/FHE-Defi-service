import { useZamaSDK } from "@zama-fhe/react-sdk";
import { useState } from "react";
import type { Address, Hex } from "viem";
import { BaseError } from "viem";
import { useConfig, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { poolAbi, tokenAbi } from "../contracts";
import type { Position } from "../hooks/usePosition";
import { txUrl } from "../lib/explorer";
import { formatAmount, parseAmount, shortHex } from "../lib/units";
import type { Activity } from "./ActivityCard";

type Kind = "deposit" | "borrow" | "repay" | "withdraw";
type Step = "idle" | "encrypting" | "signing" | "confirming" | "done" | "error";

const TABS: { kind: Kind; label: string; unit?: "mETH" | "mUSDC" }[] = [
  { kind: "deposit", label: "담보 맡기기", unit: "mETH" },
  { kind: "borrow", label: "빌리기", unit: "mUSDC" },
  { kind: "repay", label: "갚기", unit: "mUSDC" },
  { kind: "withdraw", label: "담보 돌려받기" },
];

const STEP_TEXT: Record<Step, string> = {
  idle: "",
  encrypting: "브라우저에서 금액을 암호화하는 중… (몇 초 걸려요)",
  signing: "지갑에서 트랜잭션을 승인해 주세요",
  confirming: "블록에 기록되기를 기다리는 중… (10~30초)",
  done: "완료",
  error: "실패",
};

const OPERATOR_DAYS = 30;

export function ActionsCard({ position, onActivity }: { position: Position; onActivity: (a: Activity) => void }) {
  const [kind, setKind] = useState<Kind>("deposit");
  const [input, setInput] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string>();
  const [borrowBefore, setBorrowBefore] = useState<Hex>();
  const [lastTx, setLastTx] = useState<{ hash: Hex; handle?: Hex }>();

  const sdk = useZamaSDK();
  const config = useConfig();
  const write = useWriteContract();

  const { user, pool, values, operators } = position;
  const tab = TABS.find((t) => t.kind === kind)!;
  const busy = step === "encrypting" || step === "signing" || step === "confirming";
  const parsed = tab.unit ? parseAmount(input) : undefined;

  // 예치는 mETH, 상환은 mUSDC를 풀이 가져가야 하므로 operator 권한이 필요하다
  const needsOperator =
    operators !== undefined && ((kind === "deposit" && !operators.meth) || (kind === "repay" && !operators.musdc));

  function selectTab(next: Kind) {
    if (busy) return;
    setKind(next);
    setInput("");
    setStep("idle");
    setError(undefined);
  }

  async function run(action: () => Promise<{ hash: Hex; handle?: Hex }>, record: Omit<Activity, "id" | "at" | "hash" | "handle">) {
    setError(undefined);
    try {
      const { hash, handle } = await action();
      setStep("confirming");
      const receipt = await waitForTransactionReceipt(config, { hash });
      if (receipt.status !== "success") throw new Error("트랜잭션이 실패했어요 (reverted)");
      await position.refetch();
      setLastTx({ hash, handle });
      setStep("done");
      onActivity({ ...record, id: hash, at: new Date(), hash, handle });
    } catch (e) {
      setStep("error");
      setError(e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e));
    }
  }

  async function grantOperator() {
    const token: Address = kind === "deposit" ? position.tokens.meth : position.tokens.musdc;
    const until = Math.floor(Date.now() / 1000) + OPERATOR_DAYS * 24 * 60 * 60;
    await run(
      async () => {
        setStep("signing");
        const hash = await write.mutateAsync({
          address: token,
          abi: tokenAbi,
          functionName: "setOperator",
          args: [pool, until],
        });
        return { hash };
      },
      { label: `${kind === "deposit" ? "mETH" : "mUSDC"} 사용 권한 부여` },
    );
  }

  async function submit() {
    if (!user) return;
    if (kind === "withdraw") {
      await run(
        async () => {
          setStep("signing");
          const hash = await write.mutateAsync({ address: pool, abi: poolAbi, functionName: "withdrawCollateral" });
          return { hash };
        },
        { label: "담보 돌려받기 요청" },
      );
      return;
    }
    if (!parsed || "error" in parsed) return;
    if (kind === "borrow") setBorrowBefore(position.handles?.lastBorrowed);

    await run(
      async () => {
        // 1. 금액을 (대출 풀, 내 주소)에 묶인 암호문으로 만든다 — 평문은 브라우저 밖으로 나가지 않는다
        setStep("encrypting");
        const { encryptedValues, inputProof } = await sdk.encrypt({
          values: [{ type: "euint64", value: parsed.value }],
          contractAddress: pool,
          userAddress: user,
        });
        const handle = encryptedValues[0]!;
        // 2. 암호문 + 증명만 컨트랙트로 보낸다
        setStep("signing");
        const hash = await write.mutateAsync({
          address: pool,
          abi: poolAbi,
          functionName: kind,
          args: [handle, inputProof],
        });
        return { hash, handle };
      },
      { label: tab.label, amountText: `${formatAmount(parsed.value)} ${tab.unit}` },
    );
    setInput("");
  }

  // 빠른 입력: 빌리기는 남은 한도의 99.9%(전송까지 붙는 이자 여유), 갚기는 빚 + 0.01 (지갑 잔고 한도)
  const quickFill = (() => {
    if (kind === "borrow" && values.available !== undefined && values.available > 0n)
      return { label: "최대", value: (values.available * 999n) / 1000n };
    if (kind === "repay" && values.debt !== undefined && values.debt > 0n && values.musdcBalance !== undefined) {
      const target = values.debt + 10_000n;
      return { label: "전액", value: target < values.musdcBalance ? target : values.musdcBalance };
    }
    if (kind === "deposit" && values.methBalance !== undefined && values.methBalance > 0n)
      return { label: "전부", value: values.methBalance };
    return undefined;
  })();

  const warning = (() => {
    if (!parsed || "error" in parsed) return undefined;
    if (kind === "borrow" && values.available !== undefined && parsed.value > values.available)
      return "남은 한도보다 많아요. 이대로 보내면 거절되어 0원이 지급돼요 (실패 여부도 숨기기 위해 에러를 내지 않아요).";
    if (kind === "deposit" && values.methBalance !== undefined && parsed.value > values.methBalance)
      return "지갑 mETH보다 많아요. 이대로 보내면 0이 예치돼요.";
    if (kind === "repay" && values.musdcBalance !== undefined && parsed.value > values.musdcBalance)
      return "지갑 mUSDC보다 많아요. 이대로 보내면 아무것도 갚아지지 않아요.";
    return undefined;
  })();

  // 빚은 0인데 담보가 잠겨 있으면 → 담보 돌려받기 안내
  const canWithdraw = values.debt === 0n && values.collateral !== undefined && values.collateral > 0n;

  const borrowResult =
    kind === "borrow" && step === "done" && position.handles?.lastBorrowed !== borrowBefore
      ? values.lastBorrowed
      : undefined;

  return (
    <section className="card">
      <div className="card-head">
        <h2>거래하기</h2>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.kind}
            role="tab"
            aria-selected={t.kind === kind}
            className={`tab${t.kind === kind ? " active" : ""}`}
            onClick={() => selectTab(t.kind)}
            disabled={busy}
          >
            {t.label}
          </button>
        ))}
      </div>

      <TabHelp kind={kind} position={position} />

      {kind === "repay" && canWithdraw && (
        <div className="nudge">
          <p>
            <strong>빚을 모두 갚았어요.</strong> 담보 {formatAmount(values.collateral!)} mETH는 아직 대출 풀에 잠겨 있어요.
            돌려받기는 별도 거래예요.
          </p>
          <button className="btn primary" disabled={busy} onClick={() => selectTab("withdraw")}>
            담보 돌려받으러 가기 →
          </button>
        </div>
      )}

      {needsOperator ? (
        <div className="setup">
          <p>
            처음 한 번, 대출 풀이 내 {kind === "deposit" ? "mETH" : "mUSDC"}를 옮길 수 있게 권한을 줘야 해요. (일반 토큰의
            "approve"에 해당, {OPERATOR_DAYS}일간 유효)
          </p>
          <button className="btn primary" disabled={busy} onClick={grantOperator}>
            {busy ? STEP_TEXT[step] : "권한 주기"}
          </button>
        </div>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {tab.unit && (
            <label className="field">
              <span className="muted small">금액 ({tab.unit})</span>
              <div className="input-row">
                <input
                  inputMode="decimal"
                  placeholder="0.0"
                  value={input}
                  disabled={busy}
                  onChange={(e) => setInput(e.target.value)}
                />
                <span className="unit">{tab.unit}</span>
                {quickFill && (
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy}
                    onClick={() => setInput(formatAmount(quickFill.value).replaceAll(",", ""))}
                  >
                    {quickFill.label}
                  </button>
                )}
              </div>
              {input && parsed && "error" in parsed && <span className="error small">{parsed.error}</span>}
              {warning && <span className="warn small">{warning}</span>}
            </label>
          )}

          <button
            type="submit"
            className="btn primary wide"
            disabled={busy || (tab.unit !== undefined && (!parsed || "error" in parsed))}
          >
            {busy ? STEP_TEXT[step] : tab.unit ? `🔒 암호화해서 ${tab.label}` : tab.label}
          </button>
        </form>
      )}

      {step === "done" && (
        <div className="result">
          {kind === "borrow" ? (
            borrowResult === undefined ? (
              <p className="muted">
                {position.hasPermit ? "결과를 복호화하는 중…" : "'내 포지션 보기'를 켜면 승인 여부를 확인할 수 있어요."}
              </p>
            ) : borrowResult > 0n ? (
              <p className="badge good">승인 — {formatAmount(borrowResult)} mUSDC를 받았어요</p>
            ) : (
              <p className="badge bad">거절 — 한도를 넘어서 0원이 지급됐어요</p>
            )
          ) : kind === "repay" && canWithdraw ? (
            <p className="badge good">상환 완료 — 빚이 0이 됐어요</p>
          ) : (
            <p className="badge good">완료됐어요. 포지션이 갱신됐습니다.</p>
          )}
          {lastTx && (
            <div className="explorer-box">
              <a className="btn ghost small" href={txUrl(lastTx.hash)} target="_blank" rel="noreferrer">
                Etherscan에서 이 거래 확인 ↗
              </a>
              {lastTx.handle && (
                <p className="muted small">
                  블록체인에는 금액 대신 이 암호문만 기록됐어요:{" "}
                  <span className="mono">{shortHex(lastTx.handle, 10, 8)}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {step === "error" && error && <p className="error">{error}</p>}
    </section>
  );
}

function TabHelp({ kind, position }: { kind: Kind; position: Position }) {
  const v = position.values;
  const show = (x: bigint | undefined, unit: string) => (x === undefined ? "🔒" : `${formatAmount(x)} ${unit}`);
  switch (kind) {
    case "deposit":
      return (
        <p className="help">
          맡긴 mETH 1개당{" "}
          {position.price !== undefined ? ((Number(position.price) * 7) / 10).toLocaleString("ko-KR") : "—"} mUSDC까지
          빌릴 수 있어요 (현재 가격의 70%). 지갑: <strong>{show(v.methBalance, "mETH")}</strong>
        </p>
      );
    case "borrow":
      return (
        <p className="help">
          더 빌릴 수 있는 금액: <strong>{show(v.available, "mUSDC")}</strong>. 한도를 넘으면 0원이 지급돼요.
        </p>
      );
    case "repay":
      return (
        <p className="help">
          갚을 빚: <strong>{show(v.debt, "mUSDC")}</strong>. 더 많이 보내도 빚만큼만 가져가요.
        </p>
      );
    case "withdraw":
      return (
        <p className="help">
          빚이 0이면 맡긴 담보(<strong>{show(v.collateral, "mETH")}</strong>)를 전부 돌려받아요. 빚이 남아 있으면 0이
          돌아와요.
        </p>
      );
  }
}
