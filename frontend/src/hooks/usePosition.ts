import { useDecryptValues, useGrantPermit, useHasPermit } from "@zama-fhe/react-sdk";
import type { Address, Hex } from "viem";
import { zeroAddress } from "viem";
import { useConnection, useReadContracts } from "wagmi";

import { type ContractAddresses, poolAbi, tokenAbi } from "../contracts";
import { ZERO_HANDLE } from "../lib/units";

/** 컨트랙트와 같은 고정값: 담보 1단위당 대출 한도(3000 × 0.7), 이자 지수 2^40 */
export const MAX_BORROW_PER_COLLATERAL = 2100n;
const INDEX_BITS = 40n;

type HandleKey = "collateral" | "scaledDebt" | "lastBorrowed" | "methBalance" | "musdcBalance";

/**
 * 내 포지션.
 * 1) 체인에서 암호문 핸들(0x…)을 읽는다 — 누구나 볼 수 있는 값
 * 2) 사용자가 서명(permit)한 뒤에만 복호화한다 — 본인만 볼 수 있는 값
 * 3) 현재 부채·한도는 브라우저에서 계산한다 (부채 = scaled × 공개 이자 지수 / 2^40)
 */
export function usePosition(addresses: ContractAddresses | undefined) {
  const { address: user } = useConnection();
  const account = user ?? zeroAddress;
  const pool = addresses?.PrivateLendingPool ?? zeroAddress;
  const meth = addresses?.MockETH ?? zeroAddress;
  const musdc = addresses?.MockUSDC ?? zeroAddress;
  const enabled = Boolean(user && addresses);

  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: pool, abi: poolAbi, functionName: "collateralOf", args: [account] },
      { address: pool, abi: poolAbi, functionName: "scaledDebtOf", args: [account] },
      { address: pool, abi: poolAbi, functionName: "lastBorrowedOf", args: [account] },
      { address: meth, abi: tokenAbi, functionName: "confidentialBalanceOf", args: [account] },
      { address: musdc, abi: tokenAbi, functionName: "confidentialBalanceOf", args: [account] },
      { address: pool, abi: poolAbi, functionName: "previewBorrowIndex" },
      { address: meth, abi: tokenAbi, functionName: "isOperator", args: [account, pool] },
      { address: musdc, abi: tokenAbi, functionName: "isOperator", args: [account, pool] },
    ],
    query: { enabled, refetchInterval: 12_000 },
  });

  const data = reads.data;
  const handles: Record<HandleKey, Hex> | undefined = data && {
    collateral: data[0],
    scaledDebt: data[1],
    lastBorrowed: data[2],
    methBalance: data[3],
    musdcBalance: data[4],
  };
  const borrowIndex = data?.[5];
  const operators = data ? { meth: data[6], musdc: data[7] } : undefined;

  // 복호화 권한(permit)은 세 컨트랙트에 한 번에 받는다. 서명은 버튼을 눌렀을 때만 요청한다.
  const permitAddresses: Address[] = addresses ? [pool, meth, musdc] : [];
  const hasPermit = useHasPermit({ contractAddresses: permitAddresses }, { enabled });
  const grantPermit = useGrantPermit();

  const contractOf: Record<HandleKey, Address> = {
    collateral: pool,
    scaledDebt: pool,
    lastBorrowed: pool,
    methBalance: meth,
    musdcBalance: musdc,
  };
  const inputs = handles
    ? (Object.keys(handles) as HandleKey[])
        .filter((k) => handles[k] !== ZERO_HANDLE)
        .map((k) => ({ encryptedValue: handles[k], contractAddress: contractOf[k] }))
    : [];
  const decrypted = useDecryptValues(inputs, { enabled: Boolean(hasPermit.data) && inputs.length > 0 });

  /** 핸들이 0이면 한 번도 기록된 적 없음 = 0. 복호화 전이면 undefined. */
  const clear = (key: HandleKey): bigint | undefined => {
    if (!handles) return undefined;
    if (handles[key] === ZERO_HANDLE) return 0n;
    const value = decrypted.data?.[handles[key]];
    return typeof value === "bigint" ? value : undefined;
  };

  const collateral = clear("collateral");
  const scaledDebt = clear("scaledDebt");
  const debt =
    scaledDebt !== undefined && borrowIndex !== undefined ? (scaledDebt * borrowIndex) >> INDEX_BITS : undefined;
  const limit = collateral !== undefined ? collateral * MAX_BORROW_PER_COLLATERAL : undefined;
  const available =
    limit !== undefined && debt !== undefined ? (limit > debt ? limit - debt : 0n) : undefined;

  return {
    user,
    pool,
    tokens: { meth, musdc },
    handles,
    borrowIndex,
    operators,
    isLoading: reads.isLoading,
    readError: reads.error,
    refetch: reads.refetch,
    hasPermit: hasPermit.data === true,
    permitAddresses,
    grantPermit,
    isDecrypting: decrypted.isFetching,
    decryptError: decrypted.error,
    values: {
      collateral,
      debt,
      lastBorrowed: clear("lastBorrowed"),
      methBalance: clear("methBalance"),
      musdcBalance: clear("musdcBalance"),
      limit,
      available,
    },
  };
}

export type Position = ReturnType<typeof usePosition>;
