// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVenueAdapter} from "./SPHINX.sol";

/// @notice Minimal interface for a Uniswap V2-style pair/router. Most EVM
///         DEXes on L2s (including many Arbitrum-native ones) expose this
///         same shape, so this adapter is a reasonable first target and a
///         template for wrapping Arcus or any other venue once its real
///         interface is confirmed.
interface IUniswapV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @title UniswapV2Adapter
/// @notice Wraps a single Uniswap V2-style router + direct token pair into
///         the IVenueAdapter shape SPHINX expects. Deploy one
///         instance per underlying DEX you want the router to compare.
contract UniswapV2Adapter is IVenueAdapter {
    using SafeERC20 for IERC20;

    IUniswapV2Router public immutable dex;
    uint256 public constant SWAP_DEADLINE_WINDOW = 5 minutes;

    error PathTooShort();

    constructor(address dexRouter) {
        dex = IUniswapV2Router(dexRouter);
    }

    /// @notice View-only quote. Direct pair path only (tokenIn -> tokenOut);
    ///         extend to multi-hop paths later if a pair needs routing
    ///         through an intermediate token.
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut)
    {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = dex.getAmountsOut(amountIn, path);
        amountOut = amounts[amounts.length - 1];
    }

    /// @notice Called by SPHINX, which has already pulled
    ///         tokenIn from the user and approved this adapter for
    ///         `amountIn`. This function pulls from the router, swaps, and
    ///         sends tokenOut straight to `recipient` (the original user) —
    ///         it never custodies funds beyond the single transaction.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut) {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(dex), amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = dex.swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            path,
            recipient,
            block.timestamp + SWAP_DEADLINE_WINDOW
        );
        amountOut = amounts[amounts.length - 1];
    }
}
