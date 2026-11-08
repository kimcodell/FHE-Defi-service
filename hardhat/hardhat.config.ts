import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-deploy";
import "hardhat-gas-reporter";
import type { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";
import "solidity-coverage";

import "./tasks/accounts";
import "./tasks/frontend";
import "./tasks/pool";
import "./tasks/tokens";

// Run 'npx hardhat vars setup' to see the list of variables that need to be set

const MNEMONIC: string = vars.get("MNEMONIC", "test test test test test test test test test test test junk");

// Sepolia 배포 계정: SEPOLIA_PRIVATE_KEY(지갑 1개)가 있으면 그걸, 없으면 MNEMONIC을 쓴다.
//   npx hardhat vars set SEPOLIA_PRIVATE_KEY   (입력값은 이 저장소 밖 Hardhat 설정 파일에 저장됨)
// MetaMask는 0x 없이 내보내기도 해서, 앞뒤 공백을 지우고 0x를 붙인다
const rawSepoliaKey: string = vars.get("SEPOLIA_PRIVATE_KEY", "").trim();
const SEPOLIA_PRIVATE_KEY: string =
  rawSepoliaKey && !rawSepoliaKey.startsWith("0x") ? `0x${rawSepoliaKey}` : rawSepoliaKey;
// Sepolia RPC: INFURA_API_KEY가 있으면 Infura, 없으면 SEPOLIA_RPC_URL(기본: 무료 공개 RPC)
const SEPOLIA_RPC_URL: string = vars.has("INFURA_API_KEY")
  ? `https://sepolia.infura.io/v3/${vars.get("INFURA_API_KEY")}`
  : vars.get("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com");

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: 0,
  },
  etherscan: {
    apiKey: {
      sepolia: vars.get("ETHERSCAN_API_KEY", ""),
    },
  },
  gasReporter: {
    currency: "USD",
    enabled: process.env.REPORT_GAS ? true : false,
    excludeContracts: [],
  },
  networks: {
    hardhat: {
      accounts: {
        mnemonic: MNEMONIC,
      },
      chainId: 31337,
    },
    anvil: {
      accounts: {
        mnemonic: MNEMONIC,
        path: "m/44'/60'/0'/0/",
        count: 10,
      },
      chainId: 31337,
      url: "http://localhost:8545",
    },
    sepolia: {
      accounts: SEPOLIA_PRIVATE_KEY
        ? [SEPOLIA_PRIVATE_KEY]
        : {
            mnemonic: MNEMONIC,
            path: "m/44'/60'/0'/0/",
            count: 10,
          },
      chainId: 11155111,
      url: SEPOLIA_RPC_URL,
    },
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    sources: "./contracts",
    tests: "./test",
  },
  solidity: {
    version: "0.8.27",
    settings: {
      metadata: {
        // Not including the metadata hash
        // https://github.com/paulrberg/hardhat-template/issues/31
        bytecodeHash: "none",
      },
      // Disable the optimizer when debugging
      // https://hardhat.org/hardhat-network/#solidity-optimizer-support
      optimizer: {
        enabled: true,
        runs: 800,
      },
      evmVersion: "cancun",
    },
  },
  typechain: {
    outDir: "types",
    target: "ethers-v6",
  },
};

export default config;
