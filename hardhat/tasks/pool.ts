import { FhevmType } from "@fhevm/hardhat-plugin";
import { task, types } from "hardhat/config";
import type { HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";

import type { MockConfidentialToken, PrivateLendingPool } from "../types";

/**
 * 대출 풀 Hardhat 태스크 (웹 화면이 하게 될 일을 터미널에서 그대로 해본다)
 *
 *   npx hardhat pool:authorize --network localhost --signer 1        # 처음 한 번: 풀에 토큰 이동 권한
 *   npx hardhat pool:deposit   --network localhost --signer 1 --amount 5
 *   npx hardhat pool:borrow    --network localhost --signer 1 --amount 10000
 *   npx hardhat pool:repay     --network localhost --signer 1 --amount 10100
 *   npx hardhat pool:withdraw  --network localhost --signer 1
 *   npx hardhat pool:position  --network localhost --signer 1        # 내 포지션 복호화
 */

const DECIMALS = 6;
const INDEX_BITS = 40n;
const OPERATOR_DAYS = 30;

async function setup(hre: HardhatRuntimeEnvironment, signerIndex: number) {
  const { ethers, deployments, fhevm } = hre;
  await fhevm.initializeCLIApi();
  const signer = (await ethers.getSigners())[signerIndex];
  const poolAddr = (await deployments.get("PrivateLendingPool")).address;
  const methAddr = (await deployments.get("MockETH")).address;
  const musdcAddr = (await deployments.get("MockUSDC")).address;
  const pool = (await ethers.getContractAt("PrivateLendingPool", poolAddr)) as unknown as PrivateLendingPool;
  const meth = (await ethers.getContractAt("MockETH", methAddr)) as unknown as MockConfidentialToken;
  const musdc = (await ethers.getContractAt("MockUSDC", musdcAddr)) as unknown as MockConfidentialToken;
  return { signer, pool, poolAddr, meth, methAddr, musdc, musdcAddr };
}

function toUnits(hre: HardhatRuntimeEnvironment, amount: string): bigint {
  const units = hre.ethers.parseUnits(amount, DECIMALS);
  if (units <= 0n || units >= 1n << 64n) throw new Error(`Amount out of range: ${amount}`);
  return units;
}

const fmt = (hre: HardhatRuntimeEnvironment, units: bigint) => hre.ethers.formatUnits(units, DECIMALS);

/** 금액을 (풀, 호출자)에 묶인 암호문으로 만들어 풀 함수에 넘긴다 */
async function callWithEncryptedAmount(
  hre: HardhatRuntimeEnvironment,
  args: TaskArguments,
  fn: "deposit" | "borrow" | "repay",
) {
  const { signer, pool, poolAddr } = await setup(hre, args.signer);
  const amount = toUnits(hre, args.amount);
  const enc = await hre.fhevm.createEncryptedInput(poolAddr, signer.address).add64(amount).encrypt();
  const tx = await pool.connect(signer)[fn](enc.handles[0], enc.inputProof);
  await tx.wait();
  console.log(`${fn}(${args.amount}) sent by ${signer.address}  tx ${tx.hash}`);
  console.log(`on-chain the amount is only a ciphertext handle: ${hre.ethers.hexlify(enc.handles[0])}`);
  return { signer, pool, poolAddr };
}

async function decrypt(
  hre: HardhatRuntimeEnvironment,
  type: FhevmType,
  handle: string,
  contract: string,
  signer: Awaited<ReturnType<typeof setup>>["signer"],
): Promise<bigint> {
  if (handle === hre.ethers.ZeroHash) return 0n;
  return hre.fhevm.userDecryptEuint(type, handle, contract, signer);
}

task("pool:authorize", "Lets the pool move your mETH (deposit) and mUSDC (repay) — ERC-7984 operator")
  .addOptionalParam("signer", "Signer index", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { signer, poolAddr, meth, musdc } = await setup(hre, args.signer);
    const block = await hre.ethers.provider.getBlock("latest");
    const until = block!.timestamp + OPERATOR_DAYS * 24 * 60 * 60;
    await (await meth.connect(signer).setOperator(poolAddr, until)).wait();
    await (await musdc.connect(signer).setOperator(poolAddr, until)).wait();
    console.log(`Pool ${poolAddr} can move mETH/mUSDC for ${signer.address} for ${OPERATOR_DAYS} days`);
  });

task("pool:deposit", "Deposits an encrypted amount of mETH as collateral")
  .addParam("amount", "mETH amount, e.g. 5")
  .addOptionalParam("signer", "Signer index", 0, types.int)
  .setAction(async (args: TaskArguments, hre) => {
    await callWithEncryptedAmount(hre, args, "deposit");
  });

task("pool:borrow", "Borrows an encrypted amount of mUSDC, then shows (to you only) whether it was approved")
  .addParam("amount", "mUSDC amount, e.g. 10000")
  .addOptionalParam("signer", "Signer index", 0, types.int)
  .setAction(async (args: TaskArguments, hre) => {
    const { signer, pool, poolAddr } = await callWithEncryptedAmount(hre, args, "borrow");
    const sent = await decrypt(hre, FhevmType.euint64, await pool.lastBorrowedOf(signer.address), poolAddr, signer);
    console.log(sent > 0n ? `result: APPROVED, received ${fmt(hre, sent)} mUSDC` : "result: REJECTED (0 received)");
  });

task("pool:repay", "Repays an encrypted amount of mUSDC (only the outstanding debt is taken)")
  .addParam("amount", "mUSDC amount, e.g. 10100")
  .addOptionalParam("signer", "Signer index", 0, types.int)
  .setAction(async (args: TaskArguments, hre) => {
    await callWithEncryptedAmount(hre, args, "repay");
  });

task("pool:withdraw", "Returns all collateral if the debt is 0 (otherwise returns 0)")
  .addOptionalParam("signer", "Signer index", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { signer, pool } = await setup(hre, args.signer);
    const tx = await pool.connect(signer).withdrawCollateral();
    await tx.wait();
    console.log(`withdrawCollateral sent by ${signer.address}  tx ${tx.hash}`);
  });

task("pool:position", "Decrypts your own position: collateral, debt (with interest), borrow limit, wallet")
  .addOptionalParam("signer", "Signer index", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { signer, pool, poolAddr, meth, methAddr, musdc, musdcAddr } = await setup(hre, args.signer);

    const collateral = await decrypt(hre, FhevmType.euint64, await pool.collateralOf(signer.address), poolAddr, signer);
    const scaled = await decrypt(hre, FhevmType.euint128, await pool.scaledDebtOf(signer.address), poolAddr, signer);
    const index = await pool.previewBorrowIndex();
    const debt = (scaled * index) >> INDEX_BITS; // 컨트랙트와 같은 계산: scaled × 지수 / 2^40
    const limit = collateral * (await pool.MAX_BORROW_PER_COLLATERAL());
    const available = limit > debt ? limit - debt : 0n;
    const lastBorrowed = await decrypt(
      hre,
      FhevmType.euint64,
      await pool.lastBorrowedOf(signer.address),
      poolAddr,
      signer,
    );
    const methBal = await decrypt(
      hre,
      FhevmType.euint64,
      await meth.confidentialBalanceOf(signer.address),
      methAddr,
      signer,
    );
    const musdcBal = await decrypt(
      hre,
      FhevmType.euint64,
      await musdc.confidentialBalanceOf(signer.address),
      musdcAddr,
      signer,
    );

    console.log(`account            : ${signer.address}`);
    console.log(`collateral         : ${fmt(hre, collateral)} mETH`);
    console.log(`debt (w/ interest) : ${fmt(hre, debt)} mUSDC`);
    console.log(`borrow limit       : ${fmt(hre, limit)} mUSDC (available ${fmt(hre, available)})`);
    console.log(
      `last borrow result : ${lastBorrowed > 0n ? `approved ${fmt(hre, lastBorrowed)}` : "0 (rejected or none)"}`,
    );
    console.log(`interest index     : ${(Number(index) / 2 ** 40).toFixed(8)} (public, 10% APR)`);
    console.log(`wallet             : ${fmt(hre, methBal)} mETH, ${fmt(hre, musdcBal)} mUSDC`);
  });
