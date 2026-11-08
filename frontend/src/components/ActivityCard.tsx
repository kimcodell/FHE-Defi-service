import type { Hex } from "viem";

import { EXPLORER_URL } from "../config";
import { shortHex } from "../lib/units";

export type Activity = {
  id: string;
  at: Date;
  label: string;
  /** 내가 입력한 금액. 이 브라우저에만 있고 블록체인에는 없다. */
  amountText?: string;
  /** 실제로 블록체인에 보낸 암호문 핸들 */
  handle?: Hex;
  hash: Hex;
};

/** 이번 세션의 거래 기록: "내가 보낸 금액" vs "블록체인에 기록된 값" */
export function ActivityCard({ activities }: { activities: Activity[] }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>거래 기록</h2>
        <span className="muted small">이 브라우저에서 보낸 것만 표시</span>
      </div>
      {activities.length === 0 ? (
        <p className="muted">아직 거래가 없어요. 담보를 맡기는 것부터 시작해 보세요.</p>
      ) : (
        <div className="table-wrap">
          <table className="activity">
            <thead>
              <tr>
                <th>시각</th>
                <th>거래</th>
                <th>내가 입력한 금액 (나만 앎)</th>
                <th>블록체인에 기록된 값</th>
                <th>트랜잭션</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((a) => (
                <tr key={a.id}>
                  <td className="muted">{a.at.toLocaleTimeString("ko-KR")}</td>
                  <td>{a.label}</td>
                  <td>{a.amountText ?? "—"}</td>
                  <td className="mono">{a.handle ? `🔒 ${shortHex(a.handle, 8, 6)}` : "—"}</td>
                  <td>
                    <a href={`${EXPLORER_URL}/tx/${a.hash}`} target="_blank" rel="noreferrer" className="mono">
                      {shortHex(a.hash)} ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {activities.length > 0 && (
        <p className="muted small">
          Etherscan 링크를 열어 보면 금액 자리에 위 암호문 핸들만 있어요. 일반 DeFi와 비교해 보는 데모 포인트입니다.
        </p>
      )}
    </section>
  );
}
