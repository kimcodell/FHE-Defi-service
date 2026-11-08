import { EXPLORER_URL } from "../config";

/** Sepolia Etherscan 링크 */
export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER_URL}/address/${address}`;
