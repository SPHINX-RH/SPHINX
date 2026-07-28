#!/usr/bin/env node
/**
 * SPHINX — Off-chain AI Agent
 *
 * Runs on a schedule (configurable POLL_INTERVAL_SEC). Each cycle:
 *   1. Calls bestVenue() for every configured pair
 *   2. Reads Chainlink reference feed (if configured)
 *   3. Compares venue quote vs reference price
 *   4. Calls publishRecommendation() with the result
 *
 * The agent key CANNOT call executeSwap — only publishRecommendation.
 * User funds are never at risk even if the agent key is compromised.
 *
 * Usage:
 *   AGENT_PRIVATE_KEY=... RPC_URL=... node src/index.js           # continuous
 *   AGENT_PRIVATE_KEY=... RPC_URL=... node src/index.js --once    # one cycle
 */

const { ethers } = require("ethers");
const {
  ROUTER_ADDRESS, PAIRS, POLL_INTERVAL_SEC,
  ROUTER_ABI, CHAINLINK_FEED_ABI, buildReason
} = require("./config");

const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL   = process.env.RPC_URL;

if (!AGENT_KEY) { console.error("❌ AGENT_PRIVATE_KEY not set"); process.exit(1); }
if (!RPC_URL)   { console.error("❌ RPC_URL not set");         process.exit(1); }

// ── Bootstrap ────────────────────────────────────────────────────────────

const provider  = new ethers.JsonRpcProvider(RPC_URL);
const wallet    = new ethers.Wallet(AGENT_KEY, provider);
const router    = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);

// ── Core logic ───────────────────────────────────────────────────────────

async function runCycle() {
  const ts = new Date().toISOString();
  console.log(`\n━━━ Cycle ${ts} ━━━`);

  if (PAIRS.length === 0) {
    console.log("⚠️  No pairs configured. Add pairs to PAIRS in config.js");
    return;
  }

  // Verify agent address matches router
  const routerAgent = await router.agent();
  if (routerAgent.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`❌ Agent mismatch — router expects ${routerAgent}, you are ${wallet.address}`);
    return;
  }

  for (const pair of PAIRS) {
    try {
      await processPair(pair);
    } catch (err) {
      console.error(`  ❌ ${pair.label}:`, err.shortMessage || err.message);
    }
  }
}

async function processPair({ tokenIn, tokenOut, label, amountIn }) {
  console.log(`  📊 ${label} (amountIn: ${ethers.formatEther(amountIn)})`);

  // 1. Get best venue quote
  const [venueId, expectedOut] = await router.bestVenue(tokenIn, tokenOut, amountIn);
  if (venueId === ethers.MaxUint256) {
    console.log(`    ↳ No active venues`);
    return;
  }
  console.log(`    ↳ Best: venue #${venueId}, expectedOut: ${ethers.formatEther(expectedOut)}`);

  // 2. Check Chainlink reference price (if configured)
  let refRate = null;
  try {
    const feedAddr = await router.referenceFeed(tokenIn, tokenOut);
    if (feedAddr !== ethers.ZeroAddress) {
      const feed = new ethers.Contract(feedAddr, CHAINLINK_FEED_ABI, provider);
      const [, answer, , updatedAt] = await feed.latestRoundData();
      const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
      console.log(`    ↳ Oracle: ${ethers.formatEther(answer)} (${age}s ago)`);
      if (age > 3600) {
        console.log(`    ⚠️  Oracle stale (>1h), skipping recommendation`);
        return;
      }
      refRate = answer;
    } else {
      console.log(`    ↳ No reference feed configured`);
    }
  } catch (e) {
    console.log(`    ↳ Oracle read failed: ${e.shortMessage || e.message}`);
  }

  // 3. Publish recommendation
  const betterThanRef = refRate ? expectedOut > refRate : null;
  const reason = buildReason(Number(venueId), expectedOut, label, refRate || 0n, betterThanRef);
  console.log(`    📝 Publishing: "${reason}"`);

  const tx = await router.publishRecommendation(tokenIn, tokenOut, amountIn, reason);
  console.log(`    ✅ Tx: ${tx.hash}`);
}

// ── Scheduler ────────────────────────────────────────────────────────────

async function main() {
  console.log(`🚀 SPHINX Agent`);
  console.log(`   Wallet:  ${wallet.address}`);
  console.log(`   Router:  ${ROUTER_ADDRESS}`);
  console.log(`   RPC:     ${RPC_URL}`);
  console.log(`   Pairs:   ${PAIRS.length} configured`);
  console.log(`   Interval: ${POLL_INTERVAL_SEC}s`);

  if (process.argv.includes("--once")) {
    await runCycle();
    console.log("Done (--once).");
    process.exit(0);
  }

  // Continuous mode
  while (true) {
    await runCycle();
    await new Promise(r => setTimeout(r, POLL_INTERVAL_SEC * 1000));
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
