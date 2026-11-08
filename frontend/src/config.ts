import { createConfig as createZamaConfig } from "@zama-fhe/react-sdk/wagmi";
import { sepolia as sepoliaFhe } from "@zama-fhe/sdk/chains";
import { web } from "@zama-fhe/sdk/web";
import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

/** 무료 공개 Sepolia RPC (API 키 불필요). hardhat/ 배포 설정과 같은 주소. */
export const SEPOLIA_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
export const EXPLORER_URL = "https://sepolia.etherscan.io";

/** 지갑 연결 (MetaMask 등 브라우저 지갑) */
export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: { [sepolia.id]: http(SEPOLIA_RPC_URL) },
});

/**
 * Zama SDK: 브라우저에서 금액을 암호화하고, 내 암호문을 복호화한다.
 * Sepolia 릴레이어는 API 키 없이 열려 있어서 프리셋 그대로 쓴다.
 */
export const zamaConfig = createZamaConfig({
  chains: [sepoliaFhe],
  wagmiConfig,
  relayers: { [sepoliaFhe.id]: web() },
  telemetry: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
