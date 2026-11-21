import type { Hex } from "viem";

import { txUrl } from "../lib/explorer";
import { shortHex } from "../lib/units";
import { Icon } from "./Icon";

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
export function ActivityCard({ activities, onClear }: { activities: Activity[]; onClear: () => void }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>거래 기록</h2>
        <div className="head-actions">
          <span className="muted small">이 브라우저에 저장 · 지갑별</span>
          {activities.length > 0 && (
            <button
              className="link small"
              onClick={() => {
                if (window.confirm("이 브라우저에 저장된 거래 기록을 지울까요? (블록체인 기록은 그대로예요)"))
                  onClear();
              }}
            >
              기록 지우기
            </button>
          )}
        </div>
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
                  <td className="muted">
                    {a.at.toLocaleString("ko-KR", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td>{a.label}</td>
                  <td>{a.amountText ?? "—"}</td>
                  <td className="mono">
                    {a.handle ? (
                      <span className="cipher">
                        <Icon name="lock" size={12} />
                        {shortHex(a.handle, 8, 6)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <div className="tx-cell">
                      <span className="mono muted" title={a.hash}>
                        {shortHex(a.hash)}
                      </span>
                      <a className="btn ghost small" href={txUrl(a.hash)} target="_blank" rel="noreferrer">
                        Etherscan <Icon name="external" size={12} />
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {activities.length > 0 && (
        <p className="muted small">
          Etherscan에서 거래를 열면 일반 토큰 거래에 있는 "Tokens Transferred"(토큰 전송 금액) 항목이 아예 없어요. Logs
          탭에는 FheMul·FheLe·FheIfThenElse 같은 <strong>연산 이름</strong>과 암호문 핸들만 보이고 금액은 없어요. 일반
          DeFi(Aave 등) 거래 화면과 나란히 비교하는 데모 포인트입니다.
        </p>
      )}
    </section>
  );
}
