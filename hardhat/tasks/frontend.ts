import fs from "node:fs";
import path from "node:path";

import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * 웹 화면(frontend/)이 컨트랙트를 호출하는 데 필요한 두 가지를 복사한다.
 *   - ABI       → frontend/src/contracts/abis.ts
 *   - 배포 주소 → frontend/src/contracts/deployments.json (chainId별로 누적)
 *
 *   npx hardhat deploy --network sepolia
 *   npx hardhat frontend:export --network sepolia
 */

const FRONTEND_CONTRACTS_DIR = path.resolve(__dirname, "../../frontend/src/contracts");
const CONTRACTS = ["MockETH", "MockUSDC", "MockPriceOracle", "PrivateLendingPool"] as const;

task("frontend:export", "Writes ABIs and this network's deployed addresses into frontend/src/contracts").setAction(
  async function (_args: TaskArguments, hre) {
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    fs.mkdirSync(FRONTEND_CONTRACTS_DIR, { recursive: true });

    // ABI: 두 토큰은 같은 ABI라 하나만 내보낸다
    const tokenAbi = (await hre.artifacts.readArtifact("MockETH")).abi;
    const poolAbi = (await hre.artifacts.readArtifact("PrivateLendingPool")).abi;
    const oracleAbi = (await hre.artifacts.readArtifact("MockPriceOracle")).abi;
    const abisTs =
      "// 자동 생성 파일 — 직접 고치지 말 것. hardhat/ 에서 `npx hardhat frontend:export` 로 갱신한다.\n" +
      `export const tokenAbi = ${JSON.stringify(tokenAbi, null, 2)} as const;\n\n` +
      `export const poolAbi = ${JSON.stringify(poolAbi, null, 2)} as const;\n\n` +
      `export const oracleAbi = ${JSON.stringify(oracleAbi, null, 2)} as const;\n`;
    fs.writeFileSync(path.join(FRONTEND_CONTRACTS_DIR, "abis.ts"), abisTs);

    // 배포 주소: 기존 파일에 이 네트워크만 덮어쓴다
    const deploymentsFile = path.join(FRONTEND_CONTRACTS_DIR, "deployments.json");
    const all: Record<string, Record<string, string>> = fs.existsSync(deploymentsFile)
      ? JSON.parse(fs.readFileSync(deploymentsFile, "utf8"))
      : {};
    const current: Record<string, string> = {};
    for (const name of CONTRACTS) {
      current[name] = (await hre.deployments.get(name)).address;
    }
    all[String(chainId)] = current;
    fs.writeFileSync(deploymentsFile, JSON.stringify(all, null, 2) + "\n");

    console.log(`Exported ABIs and chain ${chainId} addresses to ${FRONTEND_CONTRACTS_DIR}`);
    console.table(current);
  },
);
