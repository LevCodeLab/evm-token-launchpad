// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }
}

contract MockUniswapV2Pair is ERC20 {
    address public token0;
    address public token1;

    constructor() ERC20("Uniswap V2 LP", "UNI-V2") {}

    function initialize(address _token0, address _token1) external {
        token0 = _token0;
        token1 = _token1;
    }

    function mint(address to) external returns (uint256 liquidity) {
        liquidity = 1000 ether;
        _mint(to, liquidity);
    }
}

contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        MockUniswapV2Pair p = new MockUniswapV2Pair();
        p.initialize(tokenA, tokenB);
        getPair[tokenA][tokenB] = address(p);
        getPair[tokenB][tokenA] = address(p);
        return address(p);
    }
}

contract MockV3Aggregator {
    uint8 public decimals;
    int256 public latestAnswer;
    uint256 public latestTimestamp;
    uint80 public latestRound;

    constructor(uint8 _decimals, int256 _initialAnswer) {
        decimals = _decimals;
        latestAnswer = _initialAnswer;
        latestTimestamp = block.timestamp;
        latestRound = 1;
    }

    function updateRoundData(
        uint80 roundId,
        int256 answer,
        uint256 timestamp,
        uint80 answeredInRound
    ) external {
        latestRound = roundId;
        latestAnswer = answer;
        latestTimestamp = timestamp;
        answeredInRound;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (latestRound, latestAnswer, latestTimestamp, latestTimestamp, latestRound);
    }
}
