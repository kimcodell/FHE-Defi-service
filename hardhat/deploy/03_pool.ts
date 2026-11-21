import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/** 대출 풀에 미리 넣어 둘 mUSDC: 1,000만 개 (6 decimals) */
const POOL_LIQUIDITY = 10_000_000n * 10n ** 6n;

/**
 * PrivateLendingPool을 배포하고, 새로 배포된 경우에만 풀에 mUSDC 유동성을 발행한다.
 * 유동성 금액은 공개돼도 되므로 평문 mint를 쓴다.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, get, execute } = hre.deployments;

  const meth = await get("MockETH");
  const musdc = await get("MockUSDC");

  const pool = await deploy("PrivateLendingPool", {
    from: deployer,
    args: [meth.address, musdc.address],
    log: true,
  });
  console.log(`PrivateLendingPool : ${pool.address}`);

  if (pool.newlyDeployed) {
    await execute("MockUSDC", { from: deployer, log: true }, "mint", pool.address, POOL_LIQUIDITY);
    console.log(`Funded pool with 10,000,000 mUSDC`);
  }
};

export default func;
func.id = "deploy_pool";
func.tags = ["pool"];
func.dependencies = ["tokens"];
