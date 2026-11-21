import { FhevmType, type FhevmTypeEuint } from "@fhevm/hardhat-plugin";
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
 *   npx hardhat pool:position  --network localhost --signer 1        # 내 포지션 복호화 (가격·청산 상태 포함)
 *
 *   청산 시연
 *   npx hardhat oracle:set-price --network localhost --price 2400     # 가격 하락 (owner만)
 *   npx hardhat pool:poke        --network localhost --signer 2       # 다음 순번 포지션 블라인드 점검 (누구나)
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
  type: FhevmTypeEuint,
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

task("pool:position", "Decrypts your own position: collateral, debt, limits, liquidation status, wallet")
  .addOptionalParam("signer", "Signer index", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { signer, pool, poolAddr, meth, methAddr, musdc, musdcAddr } = await setup(hre, args.signer);
    const me = signer.address;
    const d64 = (handle: string, contract: string) => decrypt(hre, FhevmType.euint64, handle, contract, signer);

    const collateral = await d64(await pool.collateralOf(me), poolAddr);
    const scaled = await decrypt(hre, FhevmType.euint128, await pool.scaledDebtOf(me), poolAddr, signer);
    const index = await pool.previewBorrowIndex();
    const debt = (scaled * index) >> INDEX_BITS; // 컨트랙트와 같은 계산: scaled × 지수 / 2^40
    const price = await pool.currentPrice();
    const value = collateral * price; // 담보 가치 (mUSDC 기본 단위)
    const limit = (value * 70n) / 100n;
    const threshold = (value * 80n) / 100n;
    const available = limit > debt ? limit - debt : 0n;
    // 청산 가격: 빚 = 담보 × 가격 × 80% 가 되는 가격
    const liquidationPrice = collateral > 0n ? Number((debt * 100n) / (collateral * 80n)) : 0;
    const lastBorrowed = await d64(await pool.lastBorrowedOf(me), poolAddr);
    const liquidated = await d64(await pool.liquidatedDebtOf(me), poolAddr);
    const seized = await d64(await pool.seizedCollateralOf(me), poolAddr);
    const methBal = await d64(await meth.confidentialBalanceOf(me), methAddr);
    const musdcBal = await d64(await musdc.confidentialBalanceOf(me), musdcAddr);

    console.log(`account            : ${me}`);
    console.log(`mETH price         : ${price} mUSDC (oracle, public)`);
    console.log(`collateral         : ${fmt(hre, collateral)} mETH (worth ${fmt(hre, value)} mUSDC)`);
    console.log(`debt (w/ interest) : ${fmt(hre, debt)} mUSDC`);
    console.log(`borrow limit (70%) : ${fmt(hre, limit)} mUSDC (available ${fmt(hre, available)})`);
    console.log(
      `liquidation (80%)  : at ${fmt(hre, threshold)} mUSDC of debt` +
        (debt > 0n
          ? ` -> liquidation price ${liquidationPrice} mUSDC/mETH${debt > threshold ? " (UNHEALTHY now)" : ""}`
          : ""),
    );
    console.log(
      `liquidated so far  : ${liquidated > 0n ? `debt -${fmt(hre, liquidated)} mUSDC, collateral -${fmt(hre, seized)} mETH` : "none"}`,
    );
    console.log(
      `last borrow result : ${lastBorrowed > 0n ? `approved ${fmt(hre, lastBorrowed)}` : "0 (rejected or none)"}`,
    );
    console.log(`interest index     : ${(Number(index) / 2 ** 40).toFixed(8)} (public, 10% APR)`);
    console.log(`wallet             : ${fmt(hre, methBal)} mETH, ${fmt(hre, musdcBal)} mUSDC`);
  });

task("pool:poke", "Blind-checks the next positions for liquidation (anyone can call, no reward)")
  .addOptionalParam("count", "How many positions to check (max 3)", 3, types.int)
  .addOptionalParam("signer", "Signer index", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { signer, pool } = await setup(hre, args.signer);
    const before = await pool.nextCheckIndex();
    const n = await pool.positionCount();
    const tx = await pool.connect(signer).poke(args.count);
    const receipt = await tx.wait();
    const topic = pool.interface.getEvent("PositionChecked").topicHash;
    const checked = receipt!.logs
      .filter((l) => l.topics[0] === topic)
      .map((l) => hre.ethers.getAddress("0x" + l.topics[1].slice(26)));
    console.log(`poke(${args.count}) by ${signer.address}  tx ${tx.hash}`);
    console.log(`positions: ${n}, check index ${before} -> ${await pool.nextCheckIndex()} `);
    console.log(`checked  : ${checked.length ? checked.join(", ") : "none"}`);
    console.log("results  : hidden — each owner can see it with pool:position");
  });

task("oracle:price", "Shows the current mETH price").setAction(async function (_args: TaskArguments, hre) {
  const oracle = await hre.ethers.getContractAt(
    "MockPriceOracle",
    (await hre.deployments.get("MockPriceOracle")).address,
  );
  console.log(`1 mETH = ${await oracle.price()} mUSDC`);
});

task("oracle:set-price", "Sets the mock oracle price (demo: simulate a price drop). Owner only")
  .addParam("price", "New price: 1 mETH = ? mUSDC", undefined, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    // 대출 풀(PrivateLendingPool.MAX_PRICE)은 0이거나 2^24 - 1을 넘는 가격을 거부한다.
    // 오라클은 0만 막으므로, 범위 밖 가격을 넣으면 풀의 모든 함수가 실패한다. 보내기 전에 막는다.
    const MAX_PRICE = 2 ** 24 - 1;
    if (!Number.isInteger(args.price) || args.price < 1 || args.price > MAX_PRICE) {
      throw new Error(
        `price must be an integer from 1 to ${MAX_PRICE.toLocaleString("en-US")} (got ${args.price}). ` +
          "The lending pool rejects prices outside this range, which would make every pool call revert.",
      );
    }
    const [owner] = await hre.ethers.getSigners();
    const oracle = await hre.ethers.getContractAt(
      "MockPriceOracle",
      (await hre.deployments.get("MockPriceOracle")).address,
    );
    const old = await oracle.price();
    const tx = await oracle.connect(owner).setPrice(args.price);
    await tx.wait();
    console.log(`price ${old} -> ${args.price} mUSDC per mETH  tx ${tx.hash}`);
  });
