import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/** 시작 가격: 1 mETH = 3,000 mUSDC */
const INITIAL_PRICE = 3000;

/**
 * 데모용 모의 가격 오라클을 배포한다. owner(deployer)가 가격을 바꿔 가격 하락·청산을 시연한다.
 * 실서비스에서는 IPriceOracle을 구현한 Chainlink 어댑터로 바꿔 대출 풀에 넘기면 된다.
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const oracle = await hre.deployments.deploy("MockPriceOracle", {
    from: deployer,
    args: [deployer, INITIAL_PRICE],
    log: true,
  });
  console.log(`MockPriceOracle : ${oracle.address}`);
};

export default func;
func.id = "deploy_oracle";
func.tags = ["oracle"];
