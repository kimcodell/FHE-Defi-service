import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import type { ContractTransactionResponse } from "ethers";
import { ethers, fhevm } from "hardhat";

import { MockETH, MockUSDC, PrivateLendingPool } from "../types";

/** 6 decimals 기본 단위 (예: 10 mETH -> 10_000_000) */
const units = (n: string | number) => ethers.parseUnits(String(n), 6);
/** 이자 몇 초분 등 아주 작은 오차 허용치: 0.01 토큰 */
const TOLERANCE = units("0.01");
const ONE_YEAR = 365 * 24 * 60 * 60;

describe("PrivateLendingPool", function () {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let meth: MockETH;
  let musdc: MockUSDC;
  let pool: PrivateLendingPool;
  let methAddr: string;
  let musdcAddr: string;
  let poolAddr: string;

  // ------------------------------------------------------------------
  // 헬퍼
  // ------------------------------------------------------------------

  async function decrypt64(handle: string, contract: string, user: HardhatEthersSigner): Promise<bigint> {
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, contract, user);
  }

  const balance = async (token: MockETH | MockUSDC, user: HardhatEthersSigner) =>
    decrypt64(await token.confidentialBalanceOf(user.address), await token.getAddress(), user);
  const collateral = async (user: HardhatEthersSigner) =>
    decrypt64(await pool.collateralOf(user.address), poolAddr, user);
  const lastBorrowed = async (user: HardhatEthersSigner) =>
    decrypt64(await pool.lastBorrowedOf(user.address), poolAddr, user);

  /** 프론트에서 하는 계산과 같다: 현재 부채 = scaled × 지수 / 2^40 */
  async function currentDebt(user: HardhatEthersSigner): Promise<bigint> {
    const handle = await pool.scaledDebtOf(user.address);
    if (handle === ethers.ZeroHash) return 0n;
    const scaled = await fhevm.userDecryptEuint(FhevmType.euint128, handle, poolAddr, user);
    return (scaled * (await pool.previewBorrowIndex())) >> 40n;
  }

  async function encrypted(user: HardhatEthersSigner, amount: bigint) {
    return fhevm.createEncryptedInput(poolAddr, user.address).add64(amount).encrypt();
  }

  async function deposit(user: HardhatEthersSigner, amount: bigint) {
    const e = await encrypted(user, amount);
    return (await pool.connect(user).deposit(e.handles[0], e.inputProof)).wait();
  }
  async function borrow(user: HardhatEthersSigner, amount: bigint) {
    const e = await encrypted(user, amount);
    return (await pool.connect(user).borrow(e.handles[0], e.inputProof)).wait();
  }
  async function repay(user: HardhatEthersSigner, amount: bigint) {
    const e = await encrypted(user, amount);
    return (await pool.connect(user).repay(e.handles[0], e.inputProof)).wait();
  }
  async function withdraw(user: HardhatEthersSigner) {
    return (await pool.connect(user).withdrawCollateral()).wait();
  }

  /** 트랜잭션이 남긴 이벤트 종류 목록 (금액이 아닌 "어떤 이벤트가 났는지"만) */
  function eventSignatures(receipt: Awaited<ReturnType<ContractTransactionResponse["wait"]>>): string[] {
    return receipt!.logs.map((log) => `${log.address}:${log.topics[0]}`);
  }

  // ------------------------------------------------------------------
  // 준비: 토큰·풀 배포, 풀에 1,000만 mUSDC, 팀원에게 10 mETH + 1,000 mUSDC, operator 등록
  // ------------------------------------------------------------------

  before(async function () {
    [owner, alice, bob] = await ethers.getSigners();
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This test suite runs only on the local FHEVM mock");
      this.skip();
    }
    meth = (await (await ethers.getContractFactory("MockETH")).deploy(owner.address)) as MockETH;
    musdc = (await (await ethers.getContractFactory("MockUSDC")).deploy(owner.address)) as MockUSDC;
    methAddr = await meth.getAddress();
    musdcAddr = await musdc.getAddress();
    pool = (await (
      await ethers.getContractFactory("PrivateLendingPool")
    ).deploy(methAddr, musdcAddr)) as PrivateLendingPool;
    poolAddr = await pool.getAddress();

    await (await musdc.mint(poolAddr, units(10_000_000))).wait();
    const until = (await time.latest()) + ONE_YEAR * 10;
    for (const user of [alice, bob]) {
      await (await meth.mint(user.address, units(10))).wait();
      await (await musdc.mint(user.address, units(1000))).wait();
      await (await meth.connect(user).setOperator(poolAddr, until)).wait();
      await (await musdc.connect(user).setOperator(poolAddr, until)).wait();
    }
  });

  it("uses the planned fixed parameters", async function () {
    expect(await pool.PRICE()).to.eq(3000);
    expect(await pool.LTV_BPS()).to.eq(7000);
    expect(await pool.APR_BPS()).to.eq(1000);
    expect(await pool.MAX_BORROW_PER_COLLATERAL()).to.eq(2100);
  });

  // ------------------------------------------------------------------
  describe("② deposit", function () {
    it("locks the encrypted amount as collateral", async function () {
      await deposit(alice, units(5));
      expect(await collateral(alice)).to.eq(units(5));
      expect(await balance(meth, alice)).to.eq(units(5));
    });

    it("accumulates multiple deposits", async function () {
      await deposit(alice, units(2));
      await deposit(alice, units(3));
      expect(await collateral(alice)).to.eq(units(5));
    });

    it("adds 0 (no revert) when the wallet has less than the amount", async function () {
      await deposit(alice, units(11));
      expect(await collateral(alice)).to.eq(0n);
      expect(await balance(meth, alice)).to.eq(units(10));
    });

    it("reverts if the pool was never set as operator", async function () {
      const carol = (await ethers.getSigners())[3];
      await (await meth.mint(carol.address, units(10))).wait();
      const e = await encrypted(carol, units(1));
      await expect(pool.connect(carol).deposit(e.handles[0], e.inputProof)).to.be.revertedWithCustomError(
        meth,
        "ERC7984UnauthorizedSpender",
      );
    });
  });

  // ------------------------------------------------------------------
  describe("③ borrow", function () {
    beforeEach(async function () {
      await deposit(alice, units(5)); // 한도 = 5 × 2100 = 10,500 mUSDC
    });

    it("approves a request within the limit (10,000 of 10,500)", async function () {
      await borrow(alice, units(10_000));
      expect(await lastBorrowed(alice)).to.eq(units(10_000));
      expect(await balance(musdc, alice)).to.eq(units(11_000));
      expect(await currentDebt(alice)).to.be.closeTo(units(10_000), TOLERANCE);
    });

    it("pays 0 (no revert) for a request over the limit", async function () {
      await borrow(alice, units(10_501));
      expect(await lastBorrowed(alice)).to.eq(0n);
      expect(await balance(musdc, alice)).to.eq(units(1000));
      expect(await currentDebt(alice)).to.eq(0n);
    });

    it("counts existing debt toward the limit", async function () {
      await borrow(alice, units(10_000));
      await borrow(alice, units(1000)); // 11,000 > 10,500 → 거절
      expect(await lastBorrowed(alice)).to.eq(0n);
      await borrow(alice, units(400)); // 10,400 ≤ 10,500 → 승인
      expect(await lastBorrowed(alice)).to.eq(units(400));
      expect(await currentDebt(alice)).to.be.closeTo(units(10_400), TOLERANCE);
    });

    it("pays 0 to a user with no collateral", async function () {
      await borrow(bob, units(1));
      expect(await lastBorrowed(bob)).to.eq(0n);
      expect(await balance(musdc, bob)).to.eq(units(1000));
    });

    it("approved and rejected requests look identical on-chain (same events, same contracts)", async function () {
      // fhEVM은 암호 연산마다 이벤트(연산 종류만, 값 없음)를 남긴다.
      // 사용자의 첫 대출은 비어 있던 부채 기록을 초기화하는 연산이 추가되므로, 한 번 미리 호출해 조건을 맞춘다.
      await borrow(alice, units(1));

      const approved = await borrow(alice, units(100));
      expect(await lastBorrowed(alice)).to.eq(units(100));
      const rejected = await borrow(alice, units(1_000_000));
      expect(await lastBorrowed(alice)).to.eq(0n);

      // 승인이든 거절이든 같은 컨트랙트에서 같은 종류의 이벤트가 같은 순서로 난다 → 결과를 구분할 수 없다
      expect(eventSignatures(rejected)).to.deep.eq(eventSignatures(approved));
    });
  });

  // ------------------------------------------------------------------
  describe("④ repay", function () {
    beforeEach(async function () {
      await deposit(alice, units(5));
      await borrow(alice, units(10_000)); // 지갑: 11,000 mUSDC
    });

    it("reduces the debt by a partial repayment", async function () {
      await repay(alice, units(4000));
      expect(await currentDebt(alice)).to.be.closeTo(units(6000), TOLERANCE);
      expect(await balance(musdc, alice)).to.eq(units(7000));
    });

    it("takes only what is owed when overpaying, and clears the debt to exactly 0", async function () {
      await repay(alice, units(20_000));
      expect(
        await pool
          .scaledDebtOf(alice.address)
          .then((h) => fhevm.userDecryptEuint(FhevmType.euint128, h, poolAddr, alice)),
      ).to.eq(0n);
      // 11,000 − (10,000 + 몇 초치 이자)
      expect(await balance(musdc, alice)).to.be.closeTo(units(1000), TOLERANCE);
      expect(await balance(musdc, alice)).to.be.lessThan(units(1000));
    });

    it("changes nothing if the wallet cannot cover the repayment", async function () {
      // 가진 mUSDC를 bob에게 모두 보내 지갑을 비운다
      const e = await fhevm.createEncryptedInput(musdcAddr, alice.address).add64(units(11_000)).encrypt();
      await (
        await musdc
          .connect(alice)
          ["confidentialTransfer(address,bytes32,bytes)"](bob.address, e.handles[0], e.inputProof)
      ).wait();

      await repay(alice, units(5000));
      expect(await currentDebt(alice)).to.be.closeTo(units(10_000), TOLERANCE);
    });
  });

  // ------------------------------------------------------------------
  describe("⑥ interest (10% APR, fixed)", function () {
    it("grows the debt by ~10% after one year", async function () {
      await deposit(alice, units(5));
      await borrow(alice, units(1000));
      await time.increase(ONE_YEAR);
      expect(await currentDebt(alice)).to.be.closeTo(units(1100), TOLERANCE);
    });

    it("updates the public index on accrue()", async function () {
      const before = await pool.borrowIndex();
      await time.increase(ONE_YEAR);
      await (await pool.accrue()).wait();
      const after = await pool.borrowIndex();
      // 1.0 → 1.1 (2^40 고정소수점), 몇 초 오차 허용
      expect(Number(after) / Number(before)).to.be.closeTo(1.1, 0.0001);
    });

    it("requires repaying principal + interest to fully clear the debt", async function () {
      await deposit(alice, units(5));
      await borrow(alice, units(1000)); // 지갑 2,000
      await time.increase(ONE_YEAR);

      await repay(alice, units(1000)); // 원금만 → 이자 ~100 남음
      expect(await currentDebt(alice)).to.be.closeTo(units(100), TOLERANCE);

      await repay(alice, units(1000)); // 나머지 다 갚기
      expect(await currentDebt(alice)).to.eq(0n);
      expect(await balance(musdc, alice)).to.be.closeTo(units(900), TOLERANCE);
    });

    it("counts interest toward the borrow limit", async function () {
      await deposit(alice, units(5)); // 한도 10,500
      await borrow(alice, units(10_000));
      await time.increase(ONE_YEAR); // 부채 ~11,000 > 한도
      await borrow(alice, units(1));
      expect(await lastBorrowed(alice)).to.eq(0n);
    });
  });

  // ------------------------------------------------------------------
  describe("⑤ withdraw collateral", function () {
    beforeEach(async function () {
      await deposit(alice, units(5));
    });

    it("returns nothing while debt remains", async function () {
      await borrow(alice, units(1000));
      await withdraw(alice);
      expect(await collateral(alice)).to.eq(units(5));
      expect(await balance(meth, alice)).to.eq(units(5));
    });

    it("returns all collateral once the debt is fully repaid", async function () {
      await borrow(alice, units(1000));
      await repay(alice, units(2000));
      await withdraw(alice);
      expect(await collateral(alice)).to.eq(0n);
      expect(await balance(meth, alice)).to.eq(units(10));
    });

    it("returns collateral immediately if nothing was borrowed", async function () {
      await withdraw(alice);
      expect(await balance(meth, alice)).to.eq(units(10));
    });
  });

  // ------------------------------------------------------------------
  describe("privacy", function () {
    beforeEach(async function () {
      await deposit(alice, units(5));
      await borrow(alice, units(1000));
    });

    for (const [label, getHandle, type] of [
      ["collateral", () => pool.collateralOf(alice.address), FhevmType.euint64],
      ["debt", () => pool.scaledDebtOf(alice.address), FhevmType.euint128],
      ["borrow result", () => pool.lastBorrowedOf(alice.address), FhevmType.euint64],
    ] as const) {
      it(`another user cannot decrypt someone's ${label}`, async function () {
        const handle = await getHandle();
        let error = "";
        try {
          await fhevm.userDecryptEuint(type, handle, poolAddr, bob);
        } catch (e) {
          error = String(e);
        }
        expect(error).to.match(/not authorized to user decrypt/);
      });
    }

    it("keeps users isolated in the shared pool", async function () {
      await deposit(bob, units(1)); // 한도 2,100
      await borrow(bob, units(3000)); // 거절
      expect(await lastBorrowed(bob)).to.eq(0n);
      expect(await lastBorrowed(alice)).to.eq(units(1000));
      expect(await collateral(alice)).to.eq(units(5));
    });
  });

  // ------------------------------------------------------------------
  it("stays within fhEVM per-transaction HCU limits (20M total, 5M depth)", async function () {
    const receipts = {
      deposit: await deposit(alice, units(5)),
      borrow: await borrow(alice, units(1000)),
      repay: await repay(alice, units(500)),
      withdrawCollateral: await withdraw(alice),
    };
    const rows: Record<string, { totalHCU: number; depthHCU: number }> = {};
    for (const [name, receipt] of Object.entries(receipts)) {
      const hcu = fhevm.computeTransactionHCU(receipt!);
      rows[name] = { totalHCU: hcu.globalHCU, depthHCU: hcu.maxHCUDepth };
      expect(hcu.globalHCU).to.be.lessThan(20_000_000);
      expect(hcu.maxHCUDepth).to.be.lessThan(5_000_000);
    }
    console.table(rows);
  });

  // ------------------------------------------------------------------
  it("runs the demo scenario end to end", async function () {
    await deposit(alice, units(5)); // ② 5 mETH 예치 → 한도 10,500
    await borrow(alice, units(10_000)); // ③ 승인
    expect(await lastBorrowed(alice)).to.eq(units(10_000));
    await borrow(alice, units(1000)); // ③ 한도 초과 → 거절
    expect(await lastBorrowed(alice)).to.eq(0n);
    await repay(alice, units(10_100)); // ④ 원금 + 이자 (초과분은 안 가져감)
    expect(await currentDebt(alice)).to.eq(0n);
    await withdraw(alice); // ⑤ 담보 반환
    expect(await balance(meth, alice)).to.eq(units(10));
  });
});
