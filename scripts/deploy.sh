#!/bin/bash
# deploy.sh — Deploy SPHINX + UniswapV2Adapter to Robinhood Chain
#
# Required env vars:
#   DEPLOYER_PRIVATE_KEY   — deployer wallet (fund with mainnet ETH for gas)
#   AGENT_ADDRESS           — agent wallet address (set as router's agent)
#   RPC_URL                 — RHC mainnet RPC
#
# Usage:
#   DEPLOYER_PRIVATE_KEY=0x... AGENT_ADDRESS=0x... RPC_URL=https://... bash deploy.sh

set -euo pipefail

DEPLOYER_KEY="${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY}"
AGENT="${AGENT_ADDRESS:?Set AGENT_ADDRESS}"
RPC="${RPC_URL:?Set RPC_URL}"

export PATH="$HOME/.foundry/bin:$PATH"

echo "============================================"
echo " SPHINX — Deploy to RHC"
echo "============================================"
echo " Deployer:  $(cast wallet address --private-key "$DEPLOYER_KEY")"
echo " Agent:     $AGENT"
echo " RPC:       $RPC"
echo "============================================"

# ── Step 1: Deploy SPHINX ──

echo ""
echo "[1/3] Deploying SPHINX..."

ROUTER=$(forge create contracts/SPHINX.sol:SPHINX \
  --rpc-url "$RPC" \
  --private-key "$DEPLOYER_KEY" \
  --constructor-args "$AGENT" \
  --broadcast \
  --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['deployedTo'])")

echo "  ✅ Router: $ROUTER"

# ── Step 2: Deploy UniswapV2Adapter ──

echo ""
echo "[2/3] Deploying UniswapV2Adapter..."
echo "  ⚠️  Constructor needs a real DEX router address on RHC."
echo "  Using placeholder — update UNISWAP_V2_ROUTER before using."

UNISWAP_V2_ROUTER="${UNISWAP_V2_ROUTER:-0x0000000000000000000000000000000000000000}"

ADAPTER=$(forge create contracts/UniswapV2Adapter.sol:UniswapV2Adapter \
  --rpc-url "$RPC" \
  --private-key "$DEPLOYER_KEY" \
  --constructor-args "$UNISWAP_V2_ROUTER" \
  --broadcast \
  --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['deployedTo'])")

echo "  ✅ Adapter: $ADAPTER"

# ── Step 3: Register venue ──

echo ""
echo "[3/3] Registering UniswapV2Adapter as venue..."

cast send "$ROUTER" \
  "registerVenue(address)" "$ADAPTER" \
  --rpc-url "$RPC" \
  --private-key "$DEPLOYER_KEY" \
  --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  ✅ Tx: {d[\"transactionHash\"]}')"

# ── Summary ──

echo ""
echo "============================================"
echo " Deploy Complete"
echo "============================================"
echo " Router:   $ROUTER"
echo " Adapter:  $ADAPTER"
echo ""
echo " Add to agent/.env:"
echo "   ROUTER_ADDRESS=$ROUTER"
echo ""
echo " Verify on explorer:"
echo "   https://robinhoodchain.blockscout.com/address/$ROUTER"
echo "============================================"
