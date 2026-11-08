import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import type { Activity } from "../components/ActivityCard";

const MAX_ITEMS = 50;

/** 저장 키: 네트워크 + 지갑 주소별로 따로 보관 */
const storageKey = (chainId: number, account: Address) => `private-lending:activity:${chainId}:${account.toLowerCase()}`;

type Stored = Omit<Activity, "at"> & { at: string };

function load(key: string): Activity[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    return (JSON.parse(raw) as Stored[]).map((a) => ({ ...a, at: new Date(a.at) }));
  } catch {
    return []; // 저장소를 쓸 수 없거나(시크릿 창 등) 내용이 깨진 경우: 빈 기록으로 시작
  }
}

function save(key: string, items: Activity[]) {
  try {
    const stored: Stored[] = items.map((a) => ({ ...a, at: a.at.toISOString() }));
    window.localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // 저장 실패해도 화면 동작에는 영향 없음
  }
}

/**
 * 거래 기록을 이 브라우저의 localStorage에 보관한다 (새로고침·탭 재오픈 후에도 유지).
 * "내가 입력한 금액"은 블록체인에 없는 정보라 이 브라우저에만 남는다.
 */
export function useActivityLog(chainId: number | undefined, account: Address | undefined) {
  const key = chainId !== undefined && account ? storageKey(chainId, account) : undefined;
  const [items, setItems] = useState<Activity[]>(() => (key ? load(key) : []));
  const [loadedKey, setLoadedKey] = useState(key);

  // 지갑이나 네트워크가 바뀌면 그 계정의 기록을 불러온다
  if (key !== loadedKey) {
    setLoadedKey(key);
    setItems(key ? load(key) : []);
  }

  useEffect(() => {
    if (key) save(key, items);
  }, [key, items]);

  const add = useCallback((activity: Activity) => {
    setItems((list) => [activity, ...list.filter((a) => a.id !== activity.id)].slice(0, MAX_ITEMS));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { activities: items, add, clear };
}
