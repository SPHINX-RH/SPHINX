// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IVenueAdapter} from "../SPHINX.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Configurable mock venue — set a fixed output rate per call so
///         tests can simulate a "good" venue vs a "bad/manipulated" venue.
contract MockVenueAdapter is IVenueAdapter {
    uint256 public rateNumerator;   // amountOut = amountIn * rateNumerator / 1e18
    ERC20 public tokenOutRef;

    constructor(uint256 _rateNumerator) {
        rateNumerator = _rateNumerator;
    }

    function setRate(uint256 _rateNumerator) external {
        rateNumerator = _rateNumerator;
    }

    function quote(address, address, uint256 amountIn) external view returns (uint256) {
        return (amountIn * rateNumerator) / 1e18;
    }

    function swap(address, address tokenOut, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        amountOut = (amountIn * rateNumerator) / 1e18;
        require(amountOut >= minAmountOut, "mock: below min");
        MockERC20(tokenOut).mint(recipient, amountOut);
    }
}

/// @notice Minimal Chainlink AggregatorV3Interface mock.
contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 _answer) {
        answer = _answer;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 _answer) external {
        answer = _answer;
        updatedAt = block.timestamp;
    }

    function setStale(uint256 secondsAgo) external {
        updatedAt = block.timestamp - secondsAgo;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (0, answer, 0, updatedAt, 0);
    }
}
