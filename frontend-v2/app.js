/* =====================================================
   evm-token-launchpad | Bonding Curve Client & Simulator
   Matches BondingCurveFactory.sol constant-product math
   ===================================================== */

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const VIRTUAL_ETH = 3.0;
const VIRTUAL_TOKENS = 1_320_000_000;
const SALE_SUPPLY = 660_000_000;
const TARGET_ETH = 3.0;
const K = VIRTUAL_ETH * VIRTUAL_TOKENS;

const FACTORY_ABI = [
  "function allTokensLength() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function tokens(address) view returns (address tokenAddress, uint256 virtualTokenReserves, uint256 virtualEthReserves, uint256 realEthReserves, bool readyForMigration, bool migrated, uint256 migrationReadyTime, bool rageQuitActive, address feeReceiver, uint256 tokensSold, uint16 creatorTaxBps)",
  "function createToken(string name, string symbol, bytes32 salt, address feeReceiver, address promoRecipient, uint16 creatorTaxBps) external payable returns (address)",
  "function buy(address token, uint256 minTokens) external payable",
  "function sell(address token, uint256 tokensIn, uint256 minEth) external",
  "function migratePool(address token) external"
];

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

let pools = [
  {
    address: "0x0000000000000000000000000000000000000101",
    name: "Adrak Chai Coin",
    symbol: "CHAI",
    virtualEth: 4.82,
    virtualTokens: K / 4.82,
    realEth: 1.82,
    tokensSold: VIRTUAL_TOKENS - K / 4.82,
    creatorTaxBps: 100,
    readyForMigration: false,
    migrated: false
  },
  {
    address: "0x0000000000000000000000000000000000000102",
    name: "Zero Gas Meme",
    symbol: "ZGAS",
    virtualEth: 3.45,
    virtualTokens: K / 3.45,
    realEth: 0.45,
    tokensSold: VIRTUAL_TOKENS - K / 3.45,
    creatorTaxBps: 0,
    readyForMigration: false,
    migrated: false
  },
  {
    address: "0x0000000000000000000000000000000000000103",
    name: "Graduated Pool Demo",
    symbol: "GRAD",
    virtualEth: 6.0,
    virtualTokens: 660_000_000,
    realEth: 3.0,
    tokensSold: 660_000_000,
    creatorTaxBps: 50,
    readyForMigration: true,
    migrated: true
  }
];

let selectedAddress = pools[0].address;
let currentFilter = "all";
let tradeSide = "buy";
let provider = null;
let signer = null;
let userWallet = null;

function appendLog(msg) {
  const container = document.getElementById("log-entries");
  const line = document.createElement("div");
  const now = new Date().toLocaleTimeString();
  line.textContent = `[${now}] ${msg}`;
  container.prepend(line);
}

function getFactoryAddress() {
  const val = document.getElementById("factory-address-input").value.trim();
  return val && val.startsWith("0x") && val.length === 42 ? val : ZERO_ADDR;
}

function isOnChainReady() {
  const f = getFactoryAddress();
  return Boolean(signer && f !== ZERO_ADDR);
}

function getSelectedPool() {
  return pools.find((p) => p.address === selectedAddress) || pools[0];
}

function renderPools() {
  const listEl = document.getElementById("token-list");
  const visible = pools.filter((p) => {
    if (currentFilter === "active") return !p.migrated;
    if (currentFilter === "graduated") return p.migrated;
    return true;
  });

  listEl.innerHTML = visible
    .map((p) => {
      const pct = Math.min(100, (p.realEth / TARGET_ETH) * 100);
      const statusText = p.migrated
        ? "UNISWAP V2 LP"
        : p.readyForMigration
        ? "READY TO GRADUATE"
        : `${pct.toFixed(1)}% TO LP`;
      const isSelected = p.address === selectedAddress ? "selected" : "";
      return `
        <div class="token-card ${isSelected}" onclick="selectPool('${p.address}')">
          <div class="token-row">
            <div>
              <span class="token-symbol">${p.symbol}</span>
              <span class="token-name">${p.name}</span>
            </div>
            <span class="mono-badge">${statusText}</span>
          </div>
          <div class="token-row" style="font-size:12px; color:#A1A1AA;">
            <span class="mono">Reserve: ${p.realEth.toFixed(3)} / ${TARGET_ETH.toFixed(2)} ETH</span>
            <span class="mono">Sold: ${(p.tokensSold / 1e6).toFixed(1)}M</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${pct.toFixed(1)}%"></div>
          </div>
        </div>
      `;
    })
    .join("");
}

function selectPool(addr) {
  selectedAddress = addr;
  renderPools();
  renderSelectedPanel();
}

function renderSelectedPanel() {
  const pool = getSelectedPool();
  if (!pool) return;

  const spotPrice = pool.virtualEth / pool.virtualTokens;
  const pct = Math.min(100, (pool.realEth / TARGET_ETH) * 100);
  const totalFeePct = ((100 + pool.creatorTaxBps) / 100).toFixed(2);

  document.getElementById("selected-title").textContent = `${pool.symbol} (${pool.name})`;
  document.getElementById("selected-address").textContent = pool.address;
  document.getElementById("selected-status").textContent = pool.migrated
    ? "GRADUATED TO UNISWAP V2"
    : pool.readyForMigration
    ? "READY FOR LP MIGRATION"
    : "CURVE ACTIVE";

  document.getElementById("stat-price").textContent = `${spotPrice.toFixed(10)} ETH`;
  document.getElementById("stat-reserve").textContent = `${pool.realEth.toFixed(4)} / ${TARGET_ETH.toFixed(2)} ETH`;
  document.getElementById("stat-sold").textContent = `${(pool.tokensSold / 1e6).toFixed(2)}M / 660M`;
  document.getElementById("stat-tax").textContent = `${totalFeePct}% (1% + ${(pool.creatorTaxBps / 100).toFixed(2)}%)`;
  document.getElementById("stat-progress").textContent = `${pct.toFixed(1)}%`;
  document.getElementById("progress-fill").style.width = `${pct.toFixed(1)}%`;

  const migrateBtn = document.getElementById("migrate-btn");
  migrateBtn.style.display = pool.readyForMigration && !pool.migrated ? "block" : "none";

  updateQuote();
}

function setFilter(filter, btn) {
  currentFilter = filter;
  document.querySelectorAll(".filter-group .tab-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  renderPools();
}

function setTradeSide(side) {
  tradeSide = side;
  document.getElementById("tab-buy").classList.toggle("active", side === "buy");
  document.getElementById("tab-sell").classList.toggle("active", side === "sell");
  document.getElementById("amount-label").textContent = side === "buy" ? "Pay Amount (ETH)" : "Sell Amount (Tokens)";
  document.getElementById("amount-unit").textContent = side === "buy" ? "ETH" : "TOKENS";
  document.getElementById("trade-submit-btn").textContent = side === "buy" ? "Execute Buy" : "Execute Sell";
  document.getElementById("trade-amount").value = side === "buy" ? "0.25" : "5000000";

  const presetRow = document.getElementById("preset-row");
  if (side === "buy") {
    presetRow.innerHTML = `
      <button class="btn-chip" onclick="setPreset('0.05')">0.05 ETH</button>
      <button class="btn-chip" onclick="setPreset('0.25')">0.25 ETH</button>
      <button class="btn-chip" onclick="setPreset('0.50')">0.50 ETH</button>
      <button class="btn-chip" onclick="setPreset('1.00')">1.00 ETH</button>
    `;
  } else {
    presetRow.innerHTML = `
      <button class="btn-chip" onclick="setPreset('1000000')">1M</button>
      <button class="btn-chip" onclick="setPreset('5000000')">5M</button>
      <button class="btn-chip" onclick="setPreset('10000000')">10M</button>
      <button class="btn-chip" onclick="setPreset('20000000')">20M</button>
    `;
  }
  updateQuote();
}

function setPreset(val) {
  document.getElementById("trade-amount").value = val;
  updateQuote();
}

function updateQuote() {
  const pool = getSelectedPool();
  const raw = parseFloat(document.getElementById("trade-amount").value) || 0;
  const totalTaxRate = (100 + pool.creatorTaxBps) / 10000;

  if (raw <= 0 || pool.migrated) {
    document.getElementById("quote-out").textContent = pool.migrated ? "Pool on Uniswap V2" : "0";
    document.getElementById("quote-fee").textContent = "0 ETH";
    return;
  }

  if (tradeSide === "buy") {
    const fee = raw * totalTaxRate;
    const netEth = raw - fee;
    const newEth = pool.virtualEth + netEth;
    const newTok = K / newEth;
    const tokensOut = Math.max(0, pool.virtualTokens - newTok);
    document.getElementById("quote-out").textContent = `${Math.floor(tokensOut).toLocaleString()} ${pool.symbol}`;
    document.getElementById("quote-fee").textContent = `${fee.toFixed(5)} ETH`;
  } else {
    const newTok = pool.virtualTokens + raw;
    const newEth = K / newTok;
    const grossEth = Math.max(0, pool.virtualEth - newEth);
    const fee = grossEth * totalTaxRate;
    const netEth = Math.max(0, grossEth - fee);
    document.getElementById("quote-out").textContent = `${netEth.toFixed(5)} ETH`;
    document.getElementById("quote-fee").textContent = `${fee.toFixed(5)} ETH`;
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    appendLog("No browser wallet detected; running in local curve simulator mode.");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    userWallet = await signer.getAddress();
    document.getElementById("wallet-btn").textContent = `${userWallet.slice(0, 6)}...${userWallet.slice(-4)}`;
    document.getElementById("mode-badge").textContent = isOnChainReady() ? "On-Chain Connected" : "Wallet Connected";
    appendLog(`Connected wallet ${userWallet.slice(0, 8)}...`);
    await syncOnChainPools();
  } catch (err) {
    appendLog(`Wallet connect cancelled: ${err.message}`);
  }
}

async function syncOnChainPools() {
  if (!provider || getFactoryAddress() === ZERO_ADDR) return;
  try {
    const factory = new ethers.Contract(getFactoryAddress(), FACTORY_ABI, provider);
    const len = Number(await factory.allTokensLength());
    const loaded = [];
    for (let i = 0; i < Math.min(len, 25); i++) {
      const tokenAddr = await factory.allTokens(i);
      const st = await factory.tokens(tokenAddr);
      const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
      const [name, symbol] = await Promise.all([erc20.name(), erc20.symbol()]);
      loaded.push({
        address: tokenAddr,
        name,
        symbol,
        virtualEth: Number(ethers.formatEther(st.virtualEthReserves)),
        virtualTokens: Number(ethers.formatEther(st.virtualTokenReserves)),
        realEth: Number(ethers.formatEther(st.realEthReserves)),
        tokensSold: Number(ethers.formatEther(st.tokensSold)),
        creatorTaxBps: Number(st.creatorTaxBps),
        readyForMigration: st.readyForMigration,
        migrated: st.migrated
      });
    }
    if (loaded.length > 0) {
      pools = loaded;
      selectedAddress = pools[0].address;
      document.getElementById("mode-badge").textContent = "On-Chain Live";
      renderPools();
      renderSelectedPanel();
    }
  } catch (err) {
    appendLog(`On-chain sync skipped: ${err.message}`);
  }
}

async function submitTrade() {
  const pool = getSelectedPool();
  const raw = parseFloat(document.getElementById("trade-amount").value) || 0;
  if (raw <= 0 || !pool) return;

  if (isOnChainReady()) {
    try {
      const factory = new ethers.Contract(getFactoryAddress(), FACTORY_ABI, signer);
      if (tradeSide === "buy") {
        const tx = await factory.buy(pool.address, 0, { value: ethers.parseEther(raw.toString()) });
        appendLog(`Submitted buy tx ${tx.hash.slice(0, 12)}...`);
        await tx.wait();
      } else {
        const erc20 = new ethers.Contract(pool.address, ERC20_ABI, signer);
        const amtWei = ethers.parseEther(raw.toString());
        const allow = await erc20.allowance(userWallet, getFactoryAddress());
        if (allow < amtWei) {
          const appTx = await erc20.approve(getFactoryAddress(), ethers.MaxUint256);
          await appTx.wait();
        }
        const tx = await factory.sell(pool.address, amtWei, 0);
        appendLog(`Submitted sell tx ${tx.hash.slice(0, 12)}...`);
        await tx.wait();
      }
      await syncOnChainPools();
      return;
    } catch (err) {
      appendLog(`Tx failed: ${err.reason || err.message}`);
      return;
    }
  }

  // Local deterministic constant-product simulation
  const totalTaxRate = (100 + pool.creatorTaxBps) / 10000;
  if (tradeSide === "buy") {
    if (pool.readyForMigration) {
      appendLog(`${pool.symbol} already hit 3.00 ETH target; click Graduate Pool.`);
      return;
    }
    const fee = raw * totalTaxRate;
    const netEth = Math.min(raw - fee, TARGET_ETH - pool.realEth);
    const newEth = pool.virtualEth + netEth;
    const newTok = K / newEth;
    const tokensOut = pool.virtualTokens - newTok;

    pool.virtualEth = newEth;
    pool.virtualTokens = newTok;
    pool.realEth += netEth;
    pool.tokensSold += tokensOut;
    if (pool.realEth >= TARGET_ETH - 1e-6) {
      pool.readyForMigration = true;
      appendLog(`${pool.symbol} reached ${TARGET_ETH} ETH target! Ready for Uniswap V2 graduation.`);
    } else {
      appendLog(`Bought ${Math.floor(tokensOut).toLocaleString()} ${pool.symbol} for ${raw} ETH.`);
    }
  } else {
    if (pool.readyForMigration) {
      appendLog(`${pool.symbol} halted for LP migration.`);
      return;
    }
    const newTok = pool.virtualTokens + raw;
    const newEth = K / newTok;
    const grossEth = pool.virtualEth - newEth;
    if (grossEth > pool.realEth) {
      appendLog("Sell exceeds real ETH reserves in pool.");
      return;
    }
    const netEth = grossEth * (1 - totalTaxRate);
    pool.virtualTokens = newTok;
    pool.virtualEth = newEth;
    pool.realEth -= grossEth;
    pool.tokensSold = Math.max(0, pool.tokensSold - raw);
    appendLog(`Sold ${raw.toLocaleString()} ${pool.symbol} for ${netEth.toFixed(4)} ETH.`);
  }

  renderPools();
  renderSelectedPanel();
}

async function triggerMigrate() {
  const pool = getSelectedPool();
  if (!pool || !pool.readyForMigration || pool.migrated) return;

  if (isOnChainReady()) {
    try {
      const factory = new ethers.Contract(getFactoryAddress(), FACTORY_ABI, signer);
      const tx = await factory.migratePool(pool.address);
      appendLog(`Migrating ${pool.symbol} to Uniswap V2...`);
      await tx.wait();
      await syncOnChainPools();
      return;
    } catch (err) {
      appendLog(`Migrate failed: ${err.reason || err.message}`);
      return;
    }
  }

  pool.migrated = true;
  appendLog(`Graduated ${pool.symbol} to Uniswap V2 and burned LP tokens to 0x...dEaD.`);
  renderPools();
  renderSelectedPanel();
}

function openCreateModal() {
  document.getElementById("create-modal").style.display = "flex";
}

function closeCreateModal() {
  document.getElementById("create-modal").style.display = "none";
}

async function createNewToken() {
  const name = document.getElementById("new-name").value.trim();
  const symbol = document.getElementById("new-symbol").value.trim().toUpperCase();
  const taxBps = Math.min(400, Math.max(0, parseInt(document.getElementById("new-tax").value, 10) || 0));
  const devBuy = parseFloat(document.getElementById("new-dev-buy").value) || 0;

  if (!name || !symbol) {
    appendLog("Enter both token name and symbol.");
    return;
  }

  if (isOnChainReady()) {
    try {
      const factory = new ethers.Contract(getFactoryAddress(), FACTORY_ABI, signer);
      const salt = ethers.hexlify(ethers.randomBytes(32));
      const tx = await factory.createToken(
        name,
        symbol,
        salt,
        userWallet,
        ZERO_ADDR,
        taxBps,
        { value: devBuy > 0 ? ethers.parseEther(devBuy.toString()) : 0n }
      );
      appendLog(`Deploying ${symbol} clone...`);
      await tx.wait();
      closeCreateModal();
      await syncOnChainPools();
      return;
    } catch (err) {
      appendLog(`Create failed: ${err.reason || err.message}`);
      return;
    }
  }

  const fakeAddr = `0x0000000000000000000000000000000000000${(pools.length + 101).toString(16)}`;
  const newPool = {
    address: fakeAddr,
    name,
    symbol,
    virtualEth: VIRTUAL_ETH,
    virtualTokens: VIRTUAL_TOKENS,
    realEth: 0,
    tokensSold: 0,
    creatorTaxBps: taxBps,
    readyForMigration: false,
    migrated: false
  };

  if (devBuy > 0) {
    const net = devBuy * (1 - (100 + taxBps) / 10000);
    newPool.virtualEth += net;
    newPool.virtualTokens = K / newPool.virtualEth;
    newPool.realEth = net;
    newPool.tokensSold = VIRTUAL_TOKENS - newPool.virtualTokens;
  }

  pools.unshift(newPool);
  selectedAddress = newPool.address;
  closeCreateModal();
  appendLog(`Created ERC-1167 clone ${symbol} (${taxBps} bps creator tax).`);
  renderPools();
  renderSelectedPanel();
}

document.addEventListener("DOMContentLoaded", () => {
  renderPools();
  renderSelectedPanel();
  appendLog("Ready. Set deployed BondingCurveFactory address above or explore curves locally.");
});
