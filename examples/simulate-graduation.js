/**
 * End-to-end Hardhat script that deploys BondingCurveFactory with mocks,
 * launches an ERC-1167 CurveToken clone, buys up to target ETH, and migrates LP.
 *
 * Run with: npx hardhat run examples/simulate-graduation.js
 */

const { ethers } = require("hardhat");

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, creator] = signers;

  const MockWETH = await ethers.getContractFactory("MockWETH");
  const weth = await MockWETH.deploy();

  const MockUni = await ethers.getContractFactory("MockUniswapV2Factory");
  const uni = await MockUni.deploy();

  const MockOracle = await ethers.getContractFactory("MockV3Aggregator");
  const oracle = await MockOracle.deploy(8, 6300n * 10n ** 8n);

  const Factory = await ethers.getContractFactory("BondingCurveFactory");
  const factory = await Factory.deploy(
    deployer.address,
    await uni.getAddress(),
    await weth.getAddress(),
    await oracle.getAddress(),
    6300n * 10n ** 8n,
    deployer.address
  );

  const tx = await factory
    .connect(creator)
    .createToken("Masala Chai", "CHAI", ethers.randomBytes(32), creator.address, ethers.ZeroAddress, 100);
  const rc = await tx.wait();
  const ev = rc.logs.find((l) => {
    try {
      return factory.interface.parseLog(l)?.name === "TokenCreated";
    } catch {
      return false;
    }
  });
  const tokenAddr = factory.interface.parseLog(ev).args[0];
  console.log("Clone deployed:", tokenAddr);

  let i = 2;
  while (!(await factory.tokens(tokenAddr)).readyForMigration) {
    await factory.connect(signers[i % signers.length]).buy(tokenAddr, 0, {
      value: ethers.parseEther("0.04"),
    });
    i++;
  }

  await factory.migratePool(tokenAddr);
  const pairAddr = await uni.getPair(tokenAddr, await weth.getAddress());
  console.log("Graduated Uniswap V2 Pair:", pairAddr);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
