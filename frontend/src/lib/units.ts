import { formatUnits, parseUnits } from "viem";

/** mETH, mUSDC 모두 6 decimals */
export const DECIMALS = 6;
const MAX_UINT64 = (1n << 64n) - 1n;

/** 입력 문자열 → 기본 단위. 잘못된 값이면 에러 메시지를 돌려준다. */
export function parseAmount(input: string): { value: bigint } | { error: string } {
  const text = input.trim().replaceAll(",", "");
  if (!text) return { error: "금액을 입력하세요" };
  if (!/^\d+(\.\d{0,6})?$/.test(text)) return { error: "숫자만, 소수점 6자리까지 입력할 수 있어요" };
  const value = parseUnits(text, DECIMALS);
  if (value <= 0n) return { error: "0보다 큰 금액을 입력하세요" };
  if (value > MAX_UINT64) return { error: "너무 큰 금액이에요" };
  return { value };
}

/** 기본 단위 → 사람이 읽는 숫자 (천 단위 쉼표, 소수점 최대 6자리) */
export function formatAmount(value: bigint, maxFraction = 6): string {
  const [whole, fraction = ""] = formatUnits(value, DECIMALS).split(".");
  const grouped = BigInt(whole).toLocaleString("ko-KR");
  const trimmed = fraction.slice(0, maxFraction).replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** 0x1234…abcd */
export function shortHex(hex: string, head = 6, tail = 4): string {
  return hex.length <= head + tail + 2 ? hex : `${hex.slice(0, head + 2)}…${hex.slice(-tail)}`;
}

export const ZERO_HANDLE = `0x${"0".repeat(64)}` as const;
