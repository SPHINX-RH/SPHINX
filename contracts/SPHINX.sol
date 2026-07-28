// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Minimal interface a "venue" (DEX pool, AMM, RFQ desk, etc.) must
///         implement so the router can quote and execute against it.
///         Adapters wrap real venues (Arcus, Uniswap-style pools, etc.)
///         into this shape.
interface IVenueAdapter {
    /// @return amountOut the estimated output for a given input, read-only
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        external
        view
        returns (uint256 amountOut);

    /// @notice Executes the swap. Adapter is trusted to pull tokenIn from
    ///         msg.sender (router) via prior approve, and send tokenOut back.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);
}

/// @title SPHINX
/// @notice Compares registered venues for a given Stock Token pair, lets an
///         AI agent role publish a *recommendation* (view-only, non-binding),
///         and lets the end user execute against whichever venue they accept
///         — the agent never moves user funds on its own.
contract SPHINX is Ownable {
    using SafeERC20 for IERC20;

    struct Venue {
        address adapter;       // IVenueAdapter implementation
        bool active;
    }

    struct Guardrails {
        uint256 maxOrderSize;       // in tokenIn units, 0 = no cap
        uint16 maxSlippageBps;      // e.g. 100 = 1.00%
        uint16 maxRefDeviationBps;  // max deviation from Chainlink ref price, 0 = skip check
    }

    // tokenIn => tokenOut => Chainlink feed for a sanity reference price
    mapping(address => mapping(address => address)) public referenceFeed;

    // registered venues, iterated off-chain by index for quoting
    Venue[] public venues;

    // per-pair guardrails; falls back to defaultGuardrails if unset
    mapping(address => mapping(address => Guardrails)) public pairGuardrails;
    Guardrails public defaultGuardrails = Guardrails({
        maxOrderSize: 0,
        maxSlippageBps: 150,    // 1.5% default cap
        maxRefDeviationBps: 2000 // 20% default sanity threshold
    });

    // address allowed to publish recommendations (off-chain AI agent signer)
    address public agent;

    event VenueRegistered(uint256 indexed venueId, address adapter);
    event VenueStatusChanged(uint256 indexed venueId, bool active);
    event Recommendation(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 indexed venueId,
        uint256 expectedOut,
        string reason
    );
    event SwapExecuted(
        address indexed user,
        uint256 indexed venueId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error VenueInactive();
    error OrderTooLarge();
    error SlippageExceeded();
    error NotAgent();
    error ReferencePriceStale();
    error VenueIndexOutOfBounds();

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    constructor(address initialAgent) Ownable(msg.sender) {
        agent = initialAgent;
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function registerVenue(address adapter) external onlyOwner returns (uint256 venueId) {
        venues.push(Venue({adapter: adapter, active: true}));
        venueId = venues.length - 1;
        emit VenueRegistered(venueId, adapter);
    }

    function setVenueActive(uint256 venueId, bool active) external onlyOwner {
        if (venueId >= venues.length) revert VenueIndexOutOfBounds();
        venues[venueId].active = active;
        emit VenueStatusChanged(venueId, active);
    }

    /// @notice Removes a venue by swapping with the last element and popping.
    ///         Deactivating is usually preferred; use this only to clean up
    ///         permanently broken/dead venues.
    function removeVenue(uint256 venueId) external onlyOwner {
        if (venueId >= venues.length) revert VenueIndexOutOfBounds();
        uint256 last = venues.length - 1;
        if (venueId != last) venues[venueId] = venues[last];
        venues.pop();
    }

    function setReferenceFeed(address tokenIn, address tokenOut, address feed) external onlyOwner {
        referenceFeed[tokenIn][tokenOut] = feed;
    }

    function setPairGuardrails(address tokenIn, address tokenOut, uint256 maxOrderSize, uint16 maxSlippageBps, uint16 maxRefDeviationBps)
        external
        onlyOwner
    {
        pairGuardrails[tokenIn][tokenOut] = Guardrails(maxOrderSize, maxSlippageBps, maxRefDeviationBps);
    }

    function setAgent(address newAgent) external onlyOwner {
        agent = newAgent;
    }

    /// @notice Revokes agent role entirely (sets to zero address).
    ///         After this, publishRecommendation is permanently disabled
    ///         until a new agent is set.
    function revokeAgent() external onlyOwner {
        agent = address(0);
    }

    // ---------------------------------------------------------------
    // Views — anyone can call these, no funds move
    // ---------------------------------------------------------------

    function venueCount() external view returns (uint256) {
        return venues.length;
    }

    /// @notice Quotes every active venue for a pair and returns the best one.
    ///         Pure read — the agent calls this off-chain (or on-chain) to
    ///         decide what to recommend; it does not execute anything.
    function bestVenue(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 venueId, uint256 amountOut)
    {
        uint256 best;
        uint256 bestId = type(uint256).max;
        for (uint256 i = 0; i < venues.length; i++) {
            if (!venues[i].active) continue;
            uint256 q = IVenueAdapter(venues[i].adapter).quote(tokenIn, tokenOut, amountIn);
            if (q > best) {
                best = q;
                bestId = i;
            }
        }
        return (bestId, best);
    }

    function _referenceSanityCheck(
        address tokenIn,
        address tokenOut,
        uint256 quotedOut,
        uint256 amountIn,
        uint16 maxDeviationBps
    ) internal view {
        address feed = referenceFeed[tokenIn][tokenOut];
        if (feed == address(0) || maxDeviationBps == 0) return; // no reference or check disabled

        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(feed).latestRoundData();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - updatedAt > 1 hours) revert ReferencePriceStale();
        require(answer > 0, "bad reference price");

        uint256 refRate = SafeCast.toUint256(answer);
        uint256 impliedRate = (quotedOut * 1e18) / amountIn;

        // Absolute deviation check — reject if venue quote is wildly off oracle
        uint256 diff = impliedRate > refRate ? impliedRate - refRate : refRate - impliedRate;
        require(diff * 10000 <= refRate * maxDeviationBps, "quote deviates too far from oracle");
    }

    // ---------------------------------------------------------------
    // Agent — publishes a recommendation only, cannot move funds
    // ---------------------------------------------------------------

    function publishRecommendation(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        string calldata reason
    ) external onlyAgent {
        (uint256 venueId, uint256 expectedOut) = bestVenue(tokenIn, tokenOut, amountIn);
        emit Recommendation(tokenIn, tokenOut, amountIn, venueId, expectedOut, reason);
    }

    // ---------------------------------------------------------------
    // User execution — explicit venue choice + minAmountOut required.
    // The user (or their wallet UI, pre-filled from a Recommendation
    // event) always makes the final call; the agent never triggers this.
    // ---------------------------------------------------------------

    function executeSwap(
        uint256 venueId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    ) external returns (uint256 amountOut) {
        if (venueId >= venues.length) revert VenueIndexOutOfBounds();
        Venue memory v = venues[venueId];
        if (!v.active) revert VenueInactive();

        Guardrails memory g = pairGuardrails[tokenIn][tokenOut];
        if (g.maxSlippageBps == 0 && g.maxOrderSize == 0 && g.maxRefDeviationBps == 0) g = defaultGuardrails;
        if (g.maxOrderSize != 0 && amountIn > g.maxOrderSize) revert OrderTooLarge();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(v.adapter, amountIn);

        uint256 quoted = IVenueAdapter(v.adapter).quote(tokenIn, tokenOut, amountIn);
        _referenceSanityCheck(tokenIn, tokenOut, quoted, amountIn, g.maxRefDeviationBps);

        uint256 minAllowed = quoted - (quoted * g.maxSlippageBps / 10000);
        if (minAmountOut < minAllowed) revert SlippageExceeded();

        amountOut = IVenueAdapter(v.adapter).swap(tokenIn, tokenOut, amountIn, minAmountOut, msg.sender);

        emit SwapExecuted(msg.sender, venueId, tokenIn, tokenOut, amountIn, amountOut);
    }
}
