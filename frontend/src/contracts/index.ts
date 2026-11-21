import type { Address } from "viem";

import deployments from "./deployments.json";

export { poolAbi, tokenAbi } from "./abis";

export type ContractAddresses = {
  MockETH: Address;
  MockUSDC: Address;
  PrivateLendingPool: Address;
  /** 청산 기능 이후 배포에만 있다 */
  MockPriceOracle?: Address;
};

/** 이 네트워크에 배포된 컨트랙트 주소. 아직 배포 전이면 undefined. */
export function getAddresses(chainId: number | undefined): ContractAddresses | undefined {
  if (chainId === undefined) return undefined;
  return (deployments as Record<string, ContractAddresses | undefined>)[String(chainId)];
}
