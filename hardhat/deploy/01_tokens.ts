import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * mETH, mUSDC 기밀 토큰을 배포한다. owner = deployer.
 * 팀원 분배는 배포 후 `npx hardhat team:fund` 태스크로 한다 (금액 암호화).
 * 대출 풀 유동성(mUSDC) 공급은 2주차 대출 풀 배포 스크립트에서 한다.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const meth = await deploy("MockETH", { from: deployer, args: [deployer], log: true });
  const musdc = await deploy("MockUSDC", { from: deployer, args: [deployer], log: true });

  console.log(`mETH  : ${meth.address}`);
  console.log(`mUSDC : ${musdc.address}`);
};

export default func;
func.id = "deploy_tokens";
func.tags = ["tokens"];
