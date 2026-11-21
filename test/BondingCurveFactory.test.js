const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BondingCurveFactory & CurveToken", function () {
  let factory, mockWeth, mockUniFactory, mockOracle;
  let owner, creator, buyer1, buyer2, dev;

  const V_ETH = ethers.parseEther("3");
  const V_TOK = ethers.parseEther("1320000000");
  const K = V_ETH * V_TOK;
  const DEAD = "0x000000000000000000000000000000000000dEaD";

  beforeEach(async function () {
    [owner, creator, buyer1, buyer2, dev] = await ethers.getSigners();

    const MockWETH = await ethers.getContractFactory("MockWETH");
    mockWeth = await MockWETH.deploy();

    const MockUni = await ethers.getContractFactory("MockUniswapV2Factory");
    mockUniFactory = await MockUni.deploy();

    const MockOracle = await ethers.getContractFactory("MockV3Aggregator");
    // $2,100 ETH -> $6,300 / $2,100 = 3.0 ETH graduation target
    mockOracle = await MockOracle.deploy(8, 2100n * 10n ** 8n);

    const BondingCurveFactory = await ethers.getContractFactory("BondingCurveFactory");
    factory = await BondingCurveFactory.deploy(
      dev.address,
      await mockUniFactory.getAddress(),
      await mockWeth.getAddress(),
      await mockOracle.getAddress(),
      6300n * 10n ** 8n,
      dev.address
    );
  });

  async function launchToken(taxBps = 0) {
    const salt = ethers.randomBytes(32);
    const tx = await factory
      .connect(creator)
      .createToken("Adrak Chai", "CHAI", salt, creator.address, ethers.ZeroAddress, taxBps);
    const receipt = await tx.wait();
    const log = receipt.logs.find((l) => {
      try {
        return factory.interface.parseLog(l)?.name === "TokenCreated";
      } catch {
        return false;
      }
    });
    return factory.interface.parseLog(log).args[0];
  }

  it("deploys ERC-1167 minimal clones and enforces 2% maxWallet while on curve", async function () {
    const tokenAddr = await launchToken(0);
    const token = await ethers.getContractAt("CurveToken", tokenAddr);

    expect(await token.name()).to.equal("Adrak Chai");
    expect(await token.symbol()).to.equal("CHAI");
    expect(await factory.allTokensLength()).to.equal(1n);

    // Buying > 2% of supply in a single order reverts
    await expect(
      factory.connect(buyer1).buy(tokenAddr, 0, { value: ethers.parseEther("0.2") })
    ).to.be.revertedWith("Max buy exceeded");
  });

  it("splits protocol (1%) and creator (0% to 4%) fees accurately and preserves x * y >= k", async function () {
    const tokenAddr = await launchToken(200); // 2% creator + 1% protocol = 3%
    const ethIn = ethers.parseEther("0.04");
    const totalFee = (ethIn * 300n) / 10000n;
    const expectedNet = ethIn - totalFee;

    await factory.connect(buyer1).buy(tokenAddr, 0, { value: ethIn });

    const st = await factory.tokens(tokenAddr);
    expect(st.realEthReserves).to.equal(expectedNet);
    expect(st.virtualEthReserves * st.virtualTokenReserves).to.be.at.least(K);

    // Creator gets 10% of 1% protocol fee + 100% of 2% creator fee = 2.1%
    const expectedCreatorClaim = (ethIn * 210n) / 10000n;
    expect(await factory.receiverClaimable(creator.address)).to.equal(expectedCreatorClaim);
  });

  it("defends against dust-trade rounding and preserves contract solvency across buys & sells", async function () {
    const tokenAddr = await launchToken(100);
    const token = await ethers.getContractAt("CurveToken", tokenAddr);

    for (let i = 0; i < 15; i++) {
      await factory.connect(buyer1).buy(tokenAddr, 0, { value: 500n });
    }

    await factory.connect(buyer2).buy(tokenAddr, 0, { value: ethers.parseEther("0.03") });
    const bal = await token.balanceOf(buyer2.address);
    await token.connect(buyer2).approve(await factory.getAddress(), bal);
    await factory.connect(buyer2).sell(tokenAddr, bal / 2n, 0);

    const st = await factory.tokens(tokenAddr);
    expect(st.virtualEthReserves * st.virtualTokenReserves).to.be.at.least(K);

    const gs = await factory.globalState();
    const contractBal = await ethers.provider.getBalance(await factory.getAddress());
    expect(contractBal).to.be.at.least(
      gs.totalRealEth + gs.totalRewardPool + gs.totalClaimable + (await factory.accumulatedFees())
    );
  });

  it("clamps extreme oracle prices and falls back when oracle data is stale", async function () {
    const block = await ethers.provider.getBlock("latest");
    await mockOracle.updateRoundData(2, 2100n * 10n ** 8n, block.timestamp - 9000, 2);
    expect(await factory.getTargetEth()).to.equal(ethers.parseEther("3.5"));

    await mockOracle.updateRoundData(3, 500000n * 10n ** 8n, block.timestamp, 3);
    expect(await factory.getTargetEth()).to.equal(ethers.parseEther("1"));
  });

  it("graduates to Uniswap V2 at target ETH, burns LP tokens to 0x...dEaD, and removes wallet limits", async function () {
    // Set $6,300 ETH price so target clamps cleanly to 1.0 ETH for fast multi-wallet fill
    const block = await ethers.provider.getBlock("latest");
    await mockOracle.updateRoundData(2, 6300n * 10n ** 8n, block.timestamp, 2);
    expect(await factory.getTargetEth()).to.equal(ethers.parseEther("1"));

    const signers = await ethers.getSigners();
    const tokenAddr = await launchToken(0);
    const token = await ethers.getContractAt("CurveToken", tokenAddr);

    // Fill curve across multiple buyers (respecting 2% maxWallet per buyer)
    let idx = 3;
    while (!(await factory.tokens(tokenAddr)).readyForMigration) {
      const w = signers[idx % signers.length];
      idx++;
      await factory.connect(w).buy(tokenAddr, 0, { value: ethers.parseEther("0.04") });
    }

    await factory.connect(buyer1).migratePool(tokenAddr);

    const st = await factory.tokens(tokenAddr);
    expect(st.migrated).to.equal(true);
    expect(await token.limitsRemoved()).to.equal(true);

    const pairAddr = await mockUniFactory.getPair(tokenAddr, await mockWeth.getAddress());
    expect(pairAddr).to.not.equal(ethers.ZeroAddress);

    const pair = await ethers.getContractAt("MockUniswapV2Pair", pairAddr);
    expect(await pair.balanceOf(DEAD)).to.be.gt(0n);
  });
});
