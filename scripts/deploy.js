const { ethers, run, network } = require("hardhat");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function main() {
  console.log("\nStarting BondingCurveFactory deployment...");
  console.log("--------------------------------------------------");

  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);

  const CONFIG = {
    devWallet: process.env.DEV_WALLET || ZERO_ADDRESS,
    multisig: process.env.MULTISIG_OWNER || ZERO_ADDRESS,
    rewardDistributor: process.env.REWARD_DISTRIBUTOR || ZERO_ADDRESS,
    uniswapV2Factory: process.env.UNISWAP_V2_FACTORY || ZERO_ADDRESS,
    weth: process.env.WETH_ADDRESS || ZERO_ADDRESS,
    priceFeed: process.env.PRICE_FEED_ADDRESS || ZERO_ADDRESS,
    targetUSD: BigInt(process.env.TARGET_USD_8DEC || "630000000000"), // $6,300 (8 decimals)
  };

  // On local Hardhat / localhost networks, deploy local mocks if zero-address placeholders are used
  const isLocal = network.name === "hardhat" || network.name === "localhost";
  if (isLocal) {
    if (CONFIG.devWallet === ZERO_ADDRESS) {
      CONFIG.devWallet = deployer.address;
    }
    if (CONFIG.rewardDistributor === ZERO_ADDRESS) {
      CONFIG.rewardDistributor = deployer.address;
    }
    if (CONFIG.weth === ZERO_ADDRESS) {
      const MockWETH = await ethers.getContractFactory("MockWETH");
      const mockWeth = await MockWETH.deploy();
      await mockWeth.waitForDeployment();
      CONFIG.weth = await mockWeth.getAddress();
    }
    if (CONFIG.uniswapV2Factory === ZERO_ADDRESS) {
      const MockUni = await ethers.getContractFactory("MockUniswapV2Factory");
      const mockUni = await MockUni.deploy();
      await mockUni.waitForDeployment();
      CONFIG.uniswapV2Factory = await mockUni.getAddress();
    }
    if (CONFIG.priceFeed === ZERO_ADDRESS) {
      const MockOracle = await ethers.getContractFactory("MockV3Aggregator");
      const mockOracle = await MockOracle.deploy(8, 2100n * 10n ** 8n); // $2,100 ETH -> 3 ETH target
      await mockOracle.waitForDeployment();
      CONFIG.priceFeed = await mockOracle.getAddress();
    }
  } else {
    if (
      CONFIG.devWallet === ZERO_ADDRESS ||
      CONFIG.uniswapV2Factory === ZERO_ADDRESS ||
      CONFIG.weth === ZERO_ADDRESS ||
      CONFIG.priceFeed === ZERO_ADDRESS
    ) {
      throw new Error(
        "Live network deployment requires DEV_WALLET, UNISWAP_V2_FACTORY, WETH_ADDRESS, and PRICE_FEED_ADDRESS in .env"
      );
    }
  }

  console.log("\nDeployment Parameters:");
  console.table({
    devWallet: CONFIG.devWallet,
    uniswapV2Factory: CONFIG.uniswapV2Factory,
    weth: CONFIG.weth,
    priceFeed: CONFIG.priceFeed,
    targetUSD: CONFIG.targetUSD.toString(),
    rewardDistributor: CONFIG.rewardDistributor,
  });

  const Factory = await ethers.getContractFactory("BondingCurveFactory");
  const constructorArgs = [
    CONFIG.devWallet,
    CONFIG.uniswapV2Factory,
    CONFIG.weth,
    CONFIG.priceFeed,
    CONFIG.targetUSD,
    CONFIG.rewardDistributor,
  ];

  const factory = await Factory.deploy(...constructorArgs);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`\nBondingCurveFactory deployed at: ${factoryAddr}`);

  if (CONFIG.multisig !== ZERO_ADDRESS && CONFIG.multisig !== deployer.address) {
    console.log(`Transferring ownership to multisig: ${CONFIG.multisig}...`);
    const tx = await factory.transferOwnership(CONFIG.multisig);
    await tx.wait();
    console.log("Ownership transferred.");
  }

  if (!isLocal && (process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY)) {
    console.log("\nVerifying contract on block explorer...");
    try {
      await run("verify:verify", {
        address: factoryAddr,
        constructorArguments: constructorArgs,
      });
      console.log("Contract verified.");
    } catch (e) {
      console.log(`Explorer verification skipped: ${e.message}`);
    }
  }

  console.log("\n--------------------------------------------------");
  console.log(`Factory: ${factoryAddr}`);
  console.log(`Owner:   ${await factory.owner()}`);
  console.log("--------------------------------------------------\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
