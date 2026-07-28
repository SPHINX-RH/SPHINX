/**
 * Agent configuration — edit pairs, RPC, and agent key here.
 *
 * Required env vars (use :? semantics — fail loud if missing):
 *   AGENT_PRIVATE_KEY   — agent signer (can only publishRecommendation, never executeSwap)
 *   RPC_URL             — Robinhood Chain mainnet RPC
 *
 * Optional:
 *   ROUTER_ADDRESS      — deployed SPHINX address (defaults to placeholder)
 *   POLL_INTERVAL_SEC   — seconds between recommendation cycles (default 60)
 */

const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "0x0000000000000000000000000000000000000000";

/** Pairs the agent monitors. Add real RHC stock-token pairs here. */
const PAIRS = [
  // { tokenIn: "0x...", tokenOut: "0x...", label: "USDG → NVDAon", amountIn: "1000000000000000000000" } // 1000 USDG
];

const POLL_INTERVAL_SEC = parseInt(process.env.POLL_INTERVAL_SEC || "60", 10);

// ── ABI fragments (minimal, just what the agent calls) ──────────────────

const ROUTER_ABI = [
  "function bestVenue(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 venueId, uint256 amountOut)",
  "function publishRecommendation(address tokenIn, address tokenOut, uint256 amountIn, string reason)",
  "function venueCount() view returns (uint256)",
  "function referenceFeed(address tokenIn, address tokenOut) view returns (address)",
  "function agent() view returns (address)"
];

const CHAINLINK_FEED_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function description() view returns (string)"
];

// ── Recommendation reason templates ─────────────────────────────────────

function buildReason(venueId, expectedOut, tokenLabel, refRate, isBetter) {
  const pct = refRate > 0n
    ? Number((expectedOut * 10000n) / refRate) / 100
    : null;
  const diff = isBetter ? "better" : "worse";
  const pctStr = pct !== null ? ` (~${pct.toFixed(2)}% vs ref)` : "";
  return `Venue #${venueId} ${diff} at ${expectedOut}${pctStr}`;
}

module.exports = {
  ROUTER_ADDRESS, PAIRS, POLL_INTERVAL_SEC,
  ROUTER_ABI, CHAINLINK_FEED_ABI, buildReason
};
