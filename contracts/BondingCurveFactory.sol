// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./CurveToken.sol";

interface IWETH9 {
    function deposit() external payable;
    function transfer(address to, uint value) external returns (bool);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Pair {
    function mint(address to) external returns (uint liquidity);
}

interface AggregatorV3Interface {
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );
}

struct GlobalState {
    uint256 totalRealEth;
    uint256 totalRewardPool;
    uint256 totalClaimable;
}

contract BondingCurveFactory is ReentrancyGuard, Ownable {

    // Bonding Curve Constants
    uint256 public constant TOTAL_SUPPLY    = 1_000_000_000 ether;
    uint256 public constant VIRTUAL_ETH     = 3 ether;
    // Virtual reserve = 1.32B so curve sells 660M (66%) at target
    uint256 public constant VIRTUAL_TOKEN   = 1_320_000_000 ether;
    uint256 public constant TARGET_ETH      = 3 ether;

    // Token Distribution (sums to 100%)
    uint256 public constant SALE_SUPPLY     = (TOTAL_SUPPLY * 66) / 100;  // 660M sold via curve
    uint256 public constant LP_SUPPLY       = (TOTAL_SUPPLY * 30) / 100;  // 300M Uniswap V2 LP
    uint256 public constant PROMO_SUPPLY    = (TOTAL_SUPPLY * 4)  / 100;  // 40M promo or burn
    address public constant DEAD_ADDRESS    = 0x000000000000000000000000000000000000dEaD;

    // Fee Config
    uint256 public constant FEE_DENOMINATOR     = 10_000;
    uint256 public constant FEE_PERCENT         = 100;   // 1% protocol trade fee
    uint256 public constant MIGRATION_FEE       = 0.25 ether;
    uint256 public constant MAX_BUY             = (TOTAL_SUPPLY * 2) / 100; // 2%
    uint256 public constant MAX_WALLET          = (TOTAL_SUPPLY * 2) / 100; // 2%

    uint256 public constant RECEIVER_CUT_BPS    = 1_000;   // 10% of protocol fee
    uint256 public constant RECEIVER_MIG_BPS    = 2_000;   // 20% of migration fee

    // Bounty Config
    uint256 public constant BOUNTY_BASE              = 0.005 ether;
    uint256 public constant BOUNTY_MAX               = 0.05  ether;
    uint256 public constant BOUNTY_GROWTH_PER_HOUR   = 0.002 ether;

    uint256 public constant MIN_TARGET               = 1 ether;
    uint256 public constant MAX_TARGET               = 10 ether;
    uint256 public constant FALLBACK_TARGET          = 3.5 ether;

    // Ranking Tiers
    uint256[6] public RANK_STREAK = [0, 3, 7, 14, 30, 90];
    uint256[6] public RANK_MULT   = [10, 15, 20, 30, 50, 100];

    uint256 public constant MIN_CLAIM_VOLUME    = 0.05 ether;
    uint256 public constant REWARD_CLAIM_DELAY  = 24 hours;

    // Immutables
    address public immutable uniswapV2Factory;
    address public immutable weth;
    address public immutable tokenImplementation;

    // Mutable State
    AggregatorV3Interface public priceFeed;
    address public devWallet;
    uint256 public totalRewardScore;
    uint256 public accumulatedFees;
    bool    public paused;
    uint256 public targetUSD;
    address public rewardDistributor;

    GlobalState public globalState;

    struct TokenState {
        address tokenAddress;
        uint256 virtualTokenReserves;
        uint256 virtualEthReserves;
        uint256 realEthReserves;
        bool readyForMigration;
        bool migrated;
        uint256 migrationReadyTime;
        bool rageQuitActive;
        address feeReceiver;
        uint256 tokensSold;
        uint16 creatorTaxBps;
    }

    mapping(address => TokenState) public tokens;
    mapping(address => address) public tokenPromoRecipient;
    address[] public allTokens;
    mapping(address => bool) private _migrating;

    struct UserStats {
        uint256 lastTradeDay;
        uint256 currentStreak;
        uint256 longestStreak;
        uint256 totalVolume;
        uint256 totalTrades;
        uint256 rewardScore;
        uint256 pendingRewards;
        uint256 lastTradeTimestamp;
    }

    mapping(address => UserStats) public userStats;
    mapping(address => uint256)   public receiverClaimable;

    // Events
    event TokenCreated(address indexed token, string name, string symbol, uint16 taxBps);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 price, uint256 marketCap);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 price, uint256 marketCap);
    event ReadyForMigration(address indexed token, uint256 ts);
    event Migrated(address indexed token, address indexed pair, uint256 lpEth, uint256 lpTokens, uint256 bounty);
    event RagequitActivated(address indexed token);
    event RagequitRefund(address indexed token, address indexed user, uint256 tokens, uint256 eth);
    event TraderRewardClaimed(address indexed user, uint256 amount);
    event ReceiverFeeClaimed(address indexed receiver, uint256 amount);
    event StreakUpdated(address indexed user, uint256 streak, uint8 rank);
    event RewardPoolFunded(uint256 amount);
    event Paused(bool isPaused);
    event OracleUpdated(address indexed newOracle);
    event RewardDistributorUpdated(address indexed newDistributor);
    event DevWalletUpdated(address indexed newDevWallet);
    event TargetUSDUpdated(uint256 newTarget);

    modifier whenNotPaused() {
        require(!paused, "Protocol paused");
        _;
    }

    constructor(
        address _devWallet,
        address _uniswapV2Factory,
        address _weth,
        address _priceFeed,
        uint256 _initialTargetUSD,
        address _rewardDistributor
    ) Ownable(msg.sender) {
        require(_initialTargetUSD >= 3000e8 && _initialTargetUSD <= 20000e8, "Invalid targetUSD");
        devWallet         = _devWallet;
        uniswapV2Factory  = _uniswapV2Factory;
        weth              = _weth;
        priceFeed         = AggregatorV3Interface(_priceFeed);
        targetUSD         = _initialTargetUSD;
        rewardDistributor = _rewardDistributor;
        tokenImplementation = address(new CurveToken());
    }

    function _assertSolvency() internal view {
        uint256 obligations = globalState.totalRealEth + globalState.totalRewardPool + globalState.totalClaimable + accumulatedFees;
        require(address(this).balance >= obligations, "Solvency breach");
    }

    function getTargetEth() public view returns (uint256) {
        try priceFeed.latestRoundData() returns (
            uint80 roundId, int256 price, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (price > 0 && block.timestamp - updatedAt < 2 hours && answeredInRound >= roundId) {
                uint256 target = (uint256(targetUSD) * 10**18) / uint256(price);
                if (target < MIN_TARGET) return MIN_TARGET;
                if (target > MAX_TARGET) return MAX_TARGET;
                return target;
            }
        } catch {}
        return FALLBACK_TARGET;
    }

    function getUserRank(address user) public view returns (uint8 rank) {
        uint256 streak = userStats[user].currentStreak;
        for (uint8 i = 5; i > 0; i--) {
            if (streak >= RANK_STREAK[i]) return i;
        }
        return 0;
    }

    function getRankName(uint8 rank) public pure returns (string memory) {
        if (rank == 1) return "Trader";
        if (rank == 2) return "Degen";
        if (rank == 3) return "Pro";
        if (rank == 4) return "Based";
        if (rank == 5) return "Legend";
        return "Newbie";
    }

    function _updateStreak(address user) internal {
        UserStats storage s = userStats[user];
        uint256 today = block.timestamp / 86400;

        if (s.lastTradeDay == 0) {
            s.currentStreak = 1;
        } else if (today == s.lastTradeDay) {
            // same day
        } else if (today == s.lastTradeDay + 1) {
            s.currentStreak += 1;
            if (s.currentStreak > s.longestStreak) s.longestStreak = s.currentStreak;
        } else {
            s.currentStreak = 1;
        }
        s.lastTradeDay = today;
        s.lastTradeTimestamp = block.timestamp;
        emit StreakUpdated(user, s.currentStreak, getUserRank(user));
    }

    function _addRewardScore(address user, uint256 volumeWei) internal {
        UserStats storage s = userStats[user];
        uint8 rank = getUserRank(user);
        uint256 delta = (volumeWei * RANK_MULT[rank]) / 10;
        s.rewardScore  += delta;
        totalRewardScore += delta;
        s.totalVolume  += volumeWei;
        s.totalTrades  += 1;
    }

    function _distributeTradeFee(uint256 protocolFee, uint256 creatorFee, address receiver) internal {
        address to = receiver != address(0) ? receiver : devWallet;

        uint256 rCut = (protocolFee * RECEIVER_CUT_BPS) / FEE_DENOMINATOR;
        uint256 pool = protocolFee - rCut;
        uint256 totalReceiverCut = rCut + creatorFee;

        receiverClaimable[to] += totalReceiverCut;
        globalState.totalClaimable += totalReceiverCut;
        globalState.totalRewardPool += pool;

        emit RewardPoolFunded(pool);
    }

    function _distributeMigrationFee(address receiver) internal {
        address to = receiver != address(0) ? receiver : devWallet;
        uint256 rCut = (MIGRATION_FEE * RECEIVER_MIG_BPS) / FEE_DENOMINATOR;
        uint256 pool = MIGRATION_FEE - rCut;
        receiverClaimable[to] += rCut;

        globalState.totalClaimable += rCut;
        globalState.totalRewardPool += pool;

        emit RewardPoolFunded(pool);
    }

    function claimTraderReward() external nonReentrant {
        UserStats storage s = userStats[msg.sender];
        require(s.currentStreak >= 1, "No active streak");
        require(s.totalVolume >= MIN_CLAIM_VOLUME, "Volume threshold not met");
        require(block.timestamp >= s.lastTradeTimestamp + REWARD_CLAIM_DELAY, "Wait 24h after last trade");
        require(s.rewardScore > 0, "No score");
        require(globalState.totalRewardPool > 0, "Pool empty");

        uint256 share = (globalState.totalRewardPool * s.rewardScore) / totalRewardScore;
        uint256 total = share + s.pendingRewards;
        require(total > 0, "Nothing to claim");

        totalRewardScore           -= s.rewardScore;
        s.rewardScore               = 0;
        s.pendingRewards            = 0;
        globalState.totalRewardPool -= share;

        (bool ok,) = msg.sender.call{value: total}("");
        require(ok, "Transfer failed");
        emit TraderRewardClaimed(msg.sender, total);
    }

    function claimReceiverFees() external nonReentrant {
        uint256 amount = receiverClaimable[msg.sender];
        require(amount > 0, "Nothing to claim");

        receiverClaimable[msg.sender] = 0;
        globalState.totalClaimable -= amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
        emit ReceiverFeeClaimed(msg.sender, amount);
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    function createToken(
        string memory name,
        string memory symbol,
        bytes32 salt,
        address feeReceiver,
        address promoRecipient,
        uint16 creatorTaxBps
    ) external payable whenNotPaused returns (address) {
        require(creatorTaxBps <= 400, "Max creator tax 4%");
        address token = Clones.cloneDeterministic(tokenImplementation, salt);
        CurveToken(token).initialize(name, symbol, TOTAL_SUPPLY, address(this), MAX_WALLET);

        tokens[token] = TokenState({
            tokenAddress:         token,
            virtualTokenReserves: VIRTUAL_TOKEN,
            virtualEthReserves:   VIRTUAL_ETH,
            realEthReserves:      0,
            readyForMigration:    false,
            migrated:             false,
            migrationReadyTime:   0,
            rageQuitActive:       false,
            feeReceiver:          feeReceiver,
            tokensSold:           0,
            creatorTaxBps:        creatorTaxBps
        });
        tokenPromoRecipient[token] = promoRecipient;

        allTokens.push(token);
        emit TokenCreated(token, name, symbol, creatorTaxBps);

        if (msg.value > 0) {
            TokenState storage state = tokens[token];
            uint256 ethIn = msg.value;
            uint256 totalTaxBps = 100 + state.creatorTaxBps;
            uint256 fee = (ethIn * totalTaxBps) / FEE_DENOMINATOR;
            uint256 netEth = ethIn - fee;

            uint256 newEthRes = state.virtualEthReserves + netEth;
            uint256 newTokRes = _ceilDiv(_k(), newEthRes);
            uint256 tokensOut = state.virtualTokenReserves - newTokRes;

            require(tokensOut > 0, "No tokens out");
            require(tokensOut <= MAX_BUY, "Max buy exceeded");

            state.virtualEthReserves = newEthRes;
            state.virtualTokenReserves = newTokRes;
            state.realEthReserves += netEth;
            state.tokensSold += tokensOut;
            globalState.totalRealEth += netEth;

            _updateStreak(msg.sender);
            _addRewardScore(msg.sender, ethIn);
            uint256 protocolFee = (ethIn * 100) / FEE_DENOMINATOR;
            uint256 creatorFee  = fee - protocolFee;
            _distributeTradeFee(protocolFee, creatorFee, state.feeReceiver);

            IERC20(token).transfer(msg.sender, tokensOut);

            uint256 price = (state.virtualEthReserves * 1e18) / state.virtualTokenReserves;
            emit Bought(token, msg.sender, ethIn, tokensOut, price, (price * TOTAL_SUPPLY) / 1e18);
        }

        return token;
    }

    function _k() internal pure returns (uint256) {
        return VIRTUAL_ETH * VIRTUAL_TOKEN;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    function getAmountOutTokens(address token, uint256 ethIn) public view returns (uint256) {
        TokenState memory s = tokens[token];
        require(!s.readyForMigration, "Halted for migration");
        uint256 totalTaxBps = 100 + s.creatorTaxBps;
        uint256 net = ethIn - (ethIn * totalTaxBps / FEE_DENOMINATOR);
        return s.virtualTokenReserves - (_ceilDiv(_k(), s.virtualEthReserves + net));
    }

    function getAmountOutEth(address token, uint256 tokensIn) public view returns (uint256) {
        TokenState memory s = tokens[token];
        require(!s.readyForMigration, "Halted for migration");
        uint256 ethOut = s.virtualEthReserves - (_ceilDiv(_k(), s.virtualTokenReserves + tokensIn));
        uint256 totalTaxBps = 100 + s.creatorTaxBps;
        return ethOut - (ethOut * totalTaxBps / FEE_DENOMINATOR);
    }

    function buy(address token, uint256 minTokens) external payable nonReentrant whenNotPaused {
        TokenState storage state = tokens[token];
        require(state.tokenAddress != address(0), "Unknown token");
        require(!state.readyForMigration, "Target met: wait for migration");
        require(msg.value > 0, "Send ETH");

        uint256 target = getTargetEth();
        uint256 ethIn  = msg.value;
        uint256 refund = 0;

        uint256 totalTaxBps = 100 + state.creatorTaxBps;
        uint256 fee    = (ethIn * totalTaxBps) / FEE_DENOMINATOR;
        if (fee == 0 && ethIn > 0) fee = 1;
        uint256 netEth = ethIn - fee;

        if (state.realEthReserves >= target) {
            refund = msg.value;
            ethIn = 0;
            netEth = 0;
            fee = 0;
        } else if (state.realEthReserves + netEth >= target) {
            uint256 neededNet = target - state.realEthReserves;
            uint256 required  = (neededNet * FEE_DENOMINATOR) / (FEE_DENOMINATOR - totalTaxBps) + 1;

            if (msg.value > required) {
                refund  = msg.value - required;
                ethIn   = required;
                fee     = ethIn - neededNet;
                netEth  = neededNet;
            }
        }

        uint256 newEthRes   = state.virtualEthReserves + netEth;
        uint256 newTokRes   = _ceilDiv(_k(), newEthRes);
        uint256 tokensOut   = state.virtualTokenReserves - newTokRes;

        uint256 maxTokens = SALE_SUPPLY > state.tokensSold ? SALE_SUPPLY - state.tokensSold : 0;
        if (tokensOut > maxTokens) {
            tokensOut = maxTokens;
            newTokRes = state.virtualTokenReserves - tokensOut;
            newEthRes = _ceilDiv(_k(), newTokRes);
            netEth = newEthRes - state.virtualEthReserves;

            fee = (netEth * totalTaxBps) / (FEE_DENOMINATOR - totalTaxBps);
            if (fee == 0) fee = 1;
            ethIn = netEth + fee;
            refund = msg.value > ethIn ? msg.value - ethIn : 0;
        }

        require(tokensOut >= minTokens,  "High slippage");
        require(tokensOut > 0,          "Nothing to buy");
        require(tokensOut <= MAX_BUY,    "Max buy exceeded");

        state.virtualEthReserves   = newEthRes;
        state.virtualTokenReserves = newTokRes;
        state.realEthReserves     += netEth;
        state.tokensSold          += tokensOut;
        globalState.totalRealEth  += netEth;

        _updateStreak(msg.sender);
        _addRewardScore(msg.sender, ethIn);

        uint256 protocolFee = (ethIn * 100) / FEE_DENOMINATOR;
        uint256 creatorFee  = fee > protocolFee ? fee - protocolFee : 0;
        _distributeTradeFee(protocolFee, creatorFee, state.feeReceiver);

        IERC20(token).transfer(msg.sender, tokensOut);

        uint256 price = (state.virtualEthReserves * 1e18) / state.virtualTokenReserves;
        emit Bought(token, msg.sender, ethIn, tokensOut, price, (price * TOTAL_SUPPLY) / 1e18);

        if ((state.realEthReserves >= target || state.tokensSold >= SALE_SUPPLY) && !state.readyForMigration) {
            state.readyForMigration  = true;
            state.migrationReadyTime = block.timestamp;
            emit ReadyForMigration(token, block.timestamp);
        }

        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "Refund failed");
        }

        _assertSolvency();
    }

    function sell(address token, uint256 tokensIn, uint256 minEth) external nonReentrant {
        TokenState storage state = tokens[token];
        require(state.tokenAddress != address(0), "Unknown token");
        require(!state.readyForMigration, "Halted for migration");
        require(tokensIn > 0, "Zero tokens");

        uint256 newTokRes = state.virtualTokenReserves + tokensIn;
        uint256 newEthRes = _ceilDiv(_k(), newTokRes);
        uint256 ethOut    = state.virtualEthReserves - newEthRes;

        require(ethOut <= state.realEthReserves, "Insufficient real reserves");

        uint256 totalTaxBps = 100 + state.creatorTaxBps;
        uint256 fee       = (ethOut * totalTaxBps) / FEE_DENOMINATOR;
        if (fee == 0 && ethOut > 0) fee = 1;
        uint256 netEth    = ethOut - fee;

        require(netEth >= minEth, "High slippage");

        IERC20(token).transferFrom(msg.sender, address(this), tokensIn);

        state.virtualTokenReserves = newTokRes;
        state.virtualEthReserves   = newEthRes;
        state.realEthReserves     -= ethOut;
        state.tokensSold          -= tokensIn;
        globalState.totalRealEth  -= ethOut;

        _updateStreak(msg.sender);
        _addRewardScore(msg.sender, netEth);

        uint256 protocolFee = (ethOut * 100) / FEE_DENOMINATOR;
        uint256 creatorFee  = fee > protocolFee ? fee - protocolFee : 0;
        _distributeTradeFee(protocolFee, creatorFee, state.feeReceiver);

        (bool ok,) = msg.sender.call{value: netEth}("");
        require(ok, "ETH transfer failed");

        uint256 price = (state.virtualEthReserves * 1e18) / state.virtualTokenReserves;
        emit Sold(token, msg.sender, tokensIn, netEth, price, (price * TOTAL_SUPPLY) / 1e18);

        _assertSolvency();
    }

    function migratePool(address token) external nonReentrant {
        TokenState storage state = tokens[token];
        require(state.readyForMigration, "Not ready");
        require(!state.migrated,         "Already migrated");
        require(!state.rageQuitActive,   "Ragequit active");
        require(!_migrating[token],      "In progress");
        _migrating[token] = true;

        state.migrated = true;
        CurveToken(token).removeLimits();

        uint256 realEth = state.realEthReserves;
        require(realEth >= MIGRATION_FEE + 0.05 ether, "Insufficient ETH");

        uint256 pCurve = (state.virtualEthReserves * 1e18) / state.virtualTokenReserves;

        _distributeMigrationFee(state.feeReceiver);

        uint256 lpTokens = LP_SUPPLY;
        uint256 lpEth = (lpTokens * pCurve) / 1e18;

        uint256 availableEth = realEth - MIGRATION_FEE;
        if (lpEth > availableEth) {
            lpEth = availableEth;
        } else if (availableEth > lpEth) {
            uint256 excess = availableEth - lpEth;
            globalState.totalRewardPool += excess;
            emit RewardPoolFunded(excess);
        }

        globalState.totalRealEth -= realEth;

        uint256 promoCut = PROMO_SUPPLY;
        uint256 factoryBal = IERC20(token).balanceOf(address(this));
        if (promoCut > factoryBal) promoCut = factoryBal;

        address promoTo = tokenPromoRecipient[token];
        if (promoTo == address(0)) {
            promoTo = state.feeReceiver != address(0) ? state.feeReceiver : DEAD_ADDRESS;
        }
        if (promoCut > 0) IERC20(token).transfer(promoTo, promoCut);

        factoryBal = IERC20(token).balanceOf(address(this));
        if (lpTokens > factoryBal) lpTokens = factoryBal;
        require(lpTokens > 0, "No tokens for LP");

        uint256 hoursElapsed = (block.timestamp - state.migrationReadyTime) / 1 hours;
        uint256 bounty = BOUNTY_BASE + (hoursElapsed * BOUNTY_GROWTH_PER_HOUR);
        if (bounty > BOUNTY_MAX)      bounty = BOUNTY_MAX;
        if (bounty > accumulatedFees) bounty = accumulatedFees;

        if (bounty > 0) {
            accumulatedFees -= bounty;
            (bool ok,) = msg.sender.call{value: bounty}("");
            require(ok, "Bounty failed");
        }

        IWETH9(weth).deposit{value: lpEth}();
        address pair = IUniswapV2Factory(uniswapV2Factory).getPair(token, weth);
        if (pair == address(0)) pair = IUniswapV2Factory(uniswapV2Factory).createPair(token, weth);

        require(IWETH9(weth).transfer(pair, lpEth),     "WETH seed failed");
        require(IERC20(token).transfer(pair, lpTokens), "Token seed failed");

        // Burn LP tokens permanently to 0x...dEaD
        IUniswapV2Pair(pair).mint(DEAD_ADDRESS);

        uint256 rem = IERC20(token).balanceOf(address(this));
        if (rem > 0) IERC20(token).transfer(DEAD_ADDRESS, rem);

        _migrating[token] = false;
        emit Migrated(token, pair, lpEth, lpTokens, bounty);
    }

    function rescueEmergency(address token) external nonReentrant {
        TokenState storage state = tokens[token];
        require(state.readyForMigration,  "Not at target");
        require(!state.migrated,          "Already migrated");
        require(!state.rageQuitActive,    "Already active");
        require(block.timestamp > state.migrationReadyTime + 7 days, "7-day delay not met");
        state.rageQuitActive = true;
        emit RagequitActivated(token);
    }

    function burnForRefund(address token, uint256 amount) external nonReentrant {
        TokenState storage state = tokens[token];
        require(state.rageQuitActive, "Ragequit offline");
        require(amount > 0, "Zero tokens");

        uint256 supply    = TOTAL_SUPPLY - IERC20(token).balanceOf(address(this));
        uint256 refundEth = (amount * state.realEthReserves) / supply;
        state.realEthReserves -= refundEth;
        globalState.totalRealEth -= refundEth;

        IERC20(token).transferFrom(msg.sender, address(this), amount);
        (bool ok,) = msg.sender.call{value: refundEth}("");
        require(ok, "ETH refund failed");
        emit RagequitRefund(token, msg.sender, amount, refundEth);
    }

    function getUserInfo(address user) external view returns (
        uint256 streak, uint256 longestStreak, uint8 rank, string memory rankName,
        uint256 rewardScore_, uint256 totalVolume_, uint256 totalTrades_,
        uint256 pendingRewards_, uint256 receiverBalance_
    ) {
        UserStats memory s = userStats[user];
        rank             = getUserRank(user);
        streak           = s.currentStreak;
        longestStreak    = s.longestStreak;
        rankName         = getRankName(rank);
        rewardScore_     = s.rewardScore;
        totalVolume_     = s.totalVolume;
        totalTrades_     = s.totalTrades;
        pendingRewards_  = s.pendingRewards;
        receiverBalance_ = receiverClaimable[user];
    }

    function estimateTraderReward(address user) external view returns (uint256) {
        if (totalRewardScore == 0) return 0;
        UserStats memory s = userStats[user];
        return (globalState.totalRewardPool * s.rewardScore) / totalRewardScore + s.pendingRewards;
    }

    function setTargetUSD(uint256 newTargetUSD) external onlyOwner {
        require(newTargetUSD >= 3000e8 && newTargetUSD <= 20000e8, "Target out of bounds");
        targetUSD = newTargetUSD;
        emit TargetUSDUpdated(newTargetUSD);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setDevWallet(address _devWallet) external onlyOwner {
        require(_devWallet != address(0), "Zero address");
        devWallet = _devWallet;
        emit DevWalletUpdated(_devWallet);
    }

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Zero address");
        priceFeed = AggregatorV3Interface(_oracle);
        emit OracleUpdated(_oracle);
    }

    function setRewardDistributor(address _distributor) external onlyOwner {
        require(_distributor != address(0), "Zero address");
        rewardDistributor = _distributor;
        emit RewardDistributorUpdated(_distributor);
    }

    receive() external payable {}
}
