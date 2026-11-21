import { useState } from "react";
import type { Address, Hex } from "viem";
import { BaseError, decodeEventLog } from "viem";
import { useConfig, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { poolAbi } from "../contracts";
import type { Position } from "../hooks/usePosition";
import { txUrl } from "../lib/explorer";
import { shortHex } from "../lib/units";
import type { Activity } from "./ActivityCard";
import { Icon } from "./Icon";

const POKE_COUNT = 3n;

/**
 * 청산 점검(poke): 누구나 다음 순번 포지션들을 블라인드 점검할 수 있다. 보상은 없다.
 * 평소에는 청산 점검 봇(keeper/)이 가격 하락(2%)과 하루 주기로 점검하므로 필요 없고, 데모(가격 변경 직후)처럼 바로 점검하고 싶을 때 쓴다.
 */
export function LiquidationCheckCard({
  position,
  onActivity,
}: {
  position: Position;
  onActivity: (a: Activity) => void;
}) {
  const config = useConfig();
  const write = useWriteContract();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ hash: Hex; checked: Address[] }>();
  const [error, setError] = useState<string>();

  async function poke() {
    setBusy(true);
    setError(undefined);
    try {
      const hash = await write.mutateAsync({
        address: position.pool,
        abi: poolAbi,
        functionName: "poke",
        args: [POKE_COUNT],
      });
      const receipt = await waitForTransactionReceipt(config, { hash });
      if (receipt.status !== "success") throw new Error("트랜잭션이 실패했어요 (reverted)");
      const checked = receipt.logs.flatMap((log) => {
        try {
          const ev = decodeEventLog({
            abi: poolAbi,
            data: log.data,
            topics: log.topics,
          });
          return ev.eventName === "PositionChecked" ? [ev.args.user as Address] : [];
        } catch {
          return [];
        }
      });
      setResult({ hash, checked });
      await position.refetch();
      onActivity({
        id: hash,
        at: new Date(),
        hash,
        label: `청산 점검 (${checked.length}개 포지션)`,
      });
    } catch (e) {
      setError(e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="check-card">
        <span className="check-icon">
          <Icon name="pulse" size={22} />
        </span>
        <div>
          <div className="card-head">
            <h2>청산 점검</h2>
            <span className="muted small">누구나 실행 · 보상 없음</span>
          </div>
          <p className="help">
            평소에는 청산 점검 봇이 가격이 2% 떨어지거나 하루가 지나면 모든 포지션을 점검해요. 바로 점검하고 싶을 때는
            이 버튼으로 직접 진행할 수 있어요. 누가 눌러도 <strong>결과는 각 포지션 주인만</strong> 볼 수 있어요.
          </p>
        </div>
        <button className="btn soft" disabled={busy} onClick={() => void poke()}>
          {busy ? "점검 중…" : `다음 ${POKE_COUNT}개 점검`}
        </button>
      </div>
      {result && (
        <div className="explorer-box">
          <p className="small">
            점검한 포지션:{" "}
            {result.checked.length ? (
              <span className="mono">{result.checked.map((a) => shortHex(a)).join(", ")}</span>
            ) : (
              "없음 (점검할 다른 포지션이 없어요)"
            )}
          </p>
          <p className="muted small">
            청산됐는지는 블록체인에 남지 않아요. 각 주인이 자기 화면에서만 확인할 수 있어요.
          </p>
          <a className="btn ghost small" href={txUrl(result.hash)} target="_blank" rel="noreferrer">
            Etherscan에서 이 거래 확인 <Icon name="external" size={12} />
          </a>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
