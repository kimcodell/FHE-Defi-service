import { FhevmType } from "@fhevm/hardhat-plugin";
import { task, types, vars } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

import type { MockConfidentialToken } from "../types";

/**
 * 토큰 관련 Hardhat 태스크
 *
 * 로컬 예시 (터미널 2개):
 *   npx hardhat node
 *   npx hardhat deploy --network localhost
 *   npx hardhat team:fund --network localhost --to 0xA...,0xB...,0xC...
 *   npx hardhat token:balance --network localhost --token mETH --signer 1
 *
 * Sepolia에서는 --network sepolia 로 바꿔 실행한다.
 */

const TOKEN_CONTRACTS: Record<string, string> = { mETH: "MockETH", mUSDC: "MockUSDC" };
const DECIMALS = 6;
const MAX_UINT64 = (1n << 64n) - 1n;

/** 팀원 1인당 기본 지급량 (기획안 기준) */
const TEAM_ALLOWANCE = { mETH: "10", mUSDC: "1000" };

async function getToken(hre: HardhatRuntimeEnvironment, symbol: string) {
  const contractName = TOKEN_CONTRACTS[symbol];
  if (!contractName) {
    throw new Error(`--token must be one of: ${Object.keys(TOKEN_CONTRACTS).join(", ")}`);
  }
  const deployment = await hre.deployments.get(contractName);
  const token = (await hre.ethers.getContractAt(contractName, deployment.address)) as unknown as MockConfidentialToken;
  return { token, address: deployment.address };
}

function parseAmount(hre: HardhatRuntimeEnvironment, amount: string): bigint {
  const units = hre.ethers.parseUnits(amount, DECIMALS);
  if (units <= 0n || units > MAX_UINT64) {
    throw new Error(`Amount ${amount} is out of range for euint64 with ${DECIMALS} decimals`);
  }
  return units;
}

function parseRecipients(hre: HardhatRuntimeEnvironment, list: string): string[] {
  const recipients = list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const r of recipients) {
    if (!hre.ethers.isAddress(r)) throw new Error(`Not an address: ${r}`);
  }
  if (recipients.length === 0) throw new Error("No recipients given");
  return recipients;
}

task("token:address", "Prints the deployed mETH and mUSDC addresses").setAction(async function (
  _args: TaskArguments,
  hre,
) {
  for (const [symbol, name] of Object.entries(TOKEN_CONTRACTS)) {
    const d = await hre.deployments.get(name);
    console.log(`${symbol.padEnd(6)} ${d.address}`);
  }
});

task("token:distribute", "Mints an ENCRYPTED amount of a token to each address (amount hidden on-chain)")
  .addParam("token", "mETH or mUSDC")
  .addParam("to", "Comma-separated recipient addresses")
  .addParam("amount", "Amount per recipient in whole tokens, e.g. 10 or 1000.5")
  .setAction(async function (args: TaskArguments, hre) {
    const { ethers, fhevm } = hre;
    await fhevm.initializeCLIApi();

    const { token, address } = await getToken(hre, args.token);
    const [owner] = await ethers.getSigners();
    const amount = parseAmount(hre, args.amount);

    for (const to of parseRecipients(hre, args.to)) {
      // 입력 암호문은 (토큰 컨트랙트, 호출자) 쌍에 묶인다. 호출자는 owner다.
      const enc = await fhevm.createEncryptedInput(address, owner.address).add64(amount).encrypt();
      const tx = await token.connect(owner).confidentialMint(to, enc.handles[0], enc.inputProof);
      await tx.wait();
      console.log(`${args.token} -> ${to}  (amount encrypted)  tx ${tx.hash}`);
    }
  });

task("team:fund", "Gives each team member 10 mETH + 1,000 mUSDC as encrypted mints")
  .addOptionalParam("to", "Comma-separated addresses. Defaults to the TEAM_ADDRESSES hardhat var")
  .setAction(async function (args: TaskArguments, hre) {
    const to: string = args.to ?? vars.get("TEAM_ADDRESSES", "");
    if (!to) {
      throw new Error("Pass --to or run: npx hardhat vars set TEAM_ADDRESSES 0xA...,0xB...,0xC...");
    }
    for (const [symbol, amount] of Object.entries(TEAM_ALLOWANCE)) {
      await hre.run("token:distribute", { token: symbol, to, amount });
    }
  });

task("token:balance", "Decrypts a signer's own token balance (only the holder can do this)")
  .addParam("token", "mETH or mUSDC")
  .addOptionalParam("signer", "Index of the signer whose balance to decrypt", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { ethers, fhevm } = hre;
    await fhevm.initializeCLIApi();

    const { token, address } = await getToken(hre, args.token);
    const signer = (await ethers.getSigners())[args.signer];
    const handle = await token.confidentialBalanceOf(signer.address);

    console.log(`holder           : ${signer.address}`);
    console.log(`encrypted handle : ${handle}`);
    if (handle === ethers.ZeroHash) {
      console.log(`balance          : 0 ${args.token}`);
      return;
    }
    const clear = await fhevm.userDecryptEuint(FhevmType.euint64, handle, address, signer);
    console.log(`balance          : ${ethers.formatUnits(clear, DECIMALS)} ${args.token}`);
  });
