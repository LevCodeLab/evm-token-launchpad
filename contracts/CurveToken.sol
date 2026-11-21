// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title CurveToken
 * @dev Minimal proxy (ERC-1167) cloneable ERC-20 token with temporary max-wallet guard
 *      that automatically lifts when the token graduates to Uniswap V2.
 */
contract CurveToken is Initializable, ERC20Upgradeable, OwnableUpgradeable {
    bool public limitsRemoved;
    uint256 public maxWallet;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        address factory,
        uint256 _maxWallet
    ) external initializer {
        __ERC20_init(name, symbol);
        __Ownable_init(factory);
        maxWallet = _maxWallet;
        _mint(factory, totalSupply);
    }

    function removeLimits() external onlyOwner {
        limitsRemoved = true;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        super._update(from, to, value);
        if (!limitsRemoved && to != owner() && from != owner() && to != address(0)) {
            require(balanceOf(to) <= maxWallet, "Max Wallet Exceeded");
        }
    }
}
