import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { MockETH, MockUSDC } from "../types";

/** 6 decimals 기본 단위로 변환 (예: 10 mETH -> 10_000_000) */
const units = (n: string | number) => ethers.parseUnits(String(n), 6);

type Signers = {
  owner: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
};

describe("Confidential tokens (mETH / mUSDC)", function () {
  let s: Signers;
  let meth: MockETH;
  let methAddr: string;
  let musdc: MockUSDC;

  /** signer 본인이 자기 잔고를 복호화한다. 한 번도 잔고가 없었으면 0. */
  async function balanceOf(user: HardhatEthersSigner, token: MockETH | MockUSDC = meth): Promise<bigint> {
    const handle = await token.confidentialBalanceOf(user.address);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, await token.getAddress(), user);
  }

  /** 금액을 (토큰, 호출자)에 묶인 암호문으로 만든다 */
  async function encrypt(contract: string, sender: HardhatEthersSigner, amount: bigint) {
    return fhevm.createEncryptedInput(contract, sender.address).add64(amount).encrypt();
  }

  before(async function () {
    const signers = await ethers.getSigners();
    s = { owner: signers[0], alice: signers[1], bob: signers[2], carol: signers[3] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This test suite runs only on the local FHEVM mock");
      this.skip();
    }
    meth = (await (await ethers.getContractFactory("MockETH")).deploy(s.owner.address)) as MockETH;
    musdc = (await (await ethers.getContractFactory("MockUSDC")).deploy(s.owner.address)) as MockUSDC;
    methAddr = await meth.getAddress();
  });

  describe("metadata", function () {
    it("has the planned names, symbols and 6 decimals", async function () {
      expect(await meth.name()).to.eq("Mock Ether");
      expect(await meth.symbol()).to.eq("mETH");
      expect(await meth.decimals()).to.eq(6);
      expect(await musdc.name()).to.eq("Mock USD Coin");
      expect(await musdc.symbol()).to.eq("mUSDC");
      expect(await musdc.decimals()).to.eq(6);
    });
  });

  describe("minting", function () {
    it("owner can mint a plaintext amount (used for pool liquidity)", async function () {
      await (await musdc.connect(s.owner).mint(s.alice.address, units(10_000_000))).wait();
      expect(await balanceOf(s.alice, musdc)).to.eq(units(10_000_000));
    });

    it("owner can mint an encrypted amount (team distribution: 10 mETH)", async function () {
      const enc = await encrypt(methAddr, s.owner, units(10));
      await (await meth.connect(s.owner).confidentialMint(s.alice.address, enc.handles[0], enc.inputProof)).wait();
      expect(await balanceOf(s.alice)).to.eq(units(10));
    });

    it("non-owner cannot mint", async function () {
      await expect(meth.connect(s.alice).mint(s.alice.address, units(1)))
        .to.be.revertedWithCustomError(meth, "OwnableUnauthorizedAccount")
        .withArgs(s.alice.address);

      const enc = await encrypt(methAddr, s.alice, units(1));
      await expect(
        meth.connect(s.alice).confidentialMint(s.alice.address, enc.handles[0], enc.inputProof),
      ).to.be.revertedWithCustomError(meth, "OwnableUnauthorizedAccount");
    });
  });

  describe("encrypted transfers", function () {
    beforeEach(async function () {
      await (await meth.connect(s.owner).mint(s.alice.address, units(10))).wait();
    });

    it("moves an encrypted amount between holders", async function () {
      const enc = await encrypt(methAddr, s.alice, units(3));
      await (
        await meth
          .connect(s.alice)
          ["confidentialTransfer(address,bytes32,bytes)"](s.bob.address, enc.handles[0], enc.inputProof)
      ).wait();

      expect(await balanceOf(s.alice)).to.eq(units(7));
      expect(await balanceOf(s.bob)).to.eq(units(3));
    });

    it("transfers 0 instead of reverting when the balance is too low", async function () {
      const enc = await encrypt(methAddr, s.alice, units(11));
      // revert하지 않는다: 실패 여부가 밖으로 새지 않게 하는 FHE 패턴
      await (
        await meth
          .connect(s.alice)
          ["confidentialTransfer(address,bytes32,bytes)"](s.bob.address, enc.handles[0], enc.inputProof)
      ).wait();

      expect(await balanceOf(s.alice)).to.eq(units(10));
      expect(await balanceOf(s.bob)).to.eq(0n);
    });

    it("stores only a ciphertext handle on-chain, not the amount", async function () {
      const handle = await meth.confidentialBalanceOf(s.alice.address);
      expect(handle).to.not.eq(ethers.ZeroHash);
      expect(BigInt(handle)).to.not.eq(units(10));
    });

    it("lets only the holder decrypt their balance", async function () {
      const handle = await meth.confidentialBalanceOf(s.alice.address);
      let error = "";
      try {
        await fhevm.userDecryptEuint(FhevmType.euint64, handle, methAddr, s.carol);
      } catch (e) {
        error = String(e);
      }
      expect(error).to.match(/not authorized to user decrypt/);
    });
  });

  describe("operators (ERC-7984's replacement for approve)", function () {
    beforeEach(async function () {
      await (await meth.connect(s.owner).mint(s.alice.address, units(10))).wait();
    });

    it("an operator can move funds once the holder sets it (how the lending pool will pull collateral)", async function () {
      const until = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      await (await meth.connect(s.alice).setOperator(s.bob.address, until)).wait();
      expect(await meth.isOperator(s.alice.address, s.bob.address)).to.eq(true);

      // 입력 암호문은 실제 호출자(bob)에 묶어야 한다
      const enc = await encrypt(methAddr, s.bob, units(5));
      await (
        await meth
          .connect(s.bob)
          [
            "confidentialTransferFrom(address,address,bytes32,bytes)"
          ](s.alice.address, s.bob.address, enc.handles[0], enc.inputProof)
      ).wait();

      expect(await balanceOf(s.alice)).to.eq(units(5));
      expect(await balanceOf(s.bob)).to.eq(units(5));
    });

    it("a non-operator cannot move someone else's funds", async function () {
      const enc = await encrypt(methAddr, s.bob, units(5));
      await expect(
        meth
          .connect(s.bob)
          [
            "confidentialTransferFrom(address,address,bytes32,bytes)"
          ](s.alice.address, s.bob.address, enc.handles[0], enc.inputProof),
      )
        .to.be.revertedWithCustomError(meth, "ERC7984UnauthorizedSpender")
        .withArgs(s.alice.address, s.bob.address);
    });
  });
});
