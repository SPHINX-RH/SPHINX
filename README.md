# SPHINX

<p align="center">
  <img src="web/assets/logo.jpg" alt="SPHINX" width="96" style="border-radius:12px;">
</p>

<p align="center">
  <a href="https://sphinxai.fun"><img src="https://img.shields.io/badge/website-sphinxai.fun-1F4B8F" alt="Website"></a>
  <a href="https://x.com/sphinx_rh"><img src="https://img.shields.io/badge/X-@sphinx__rh-1F4B8F" alt="X"></a>
  <a href="https://github.com/SPHINX-RH/SPHINX/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <img src="https://img.shields.io/badge/chain-Robinhood%20Chain%20·%204663-8B6914" alt="Chain">
  <img src="https://img.shields.io/badge/tests-13%2F13-brightgreen" alt="Tests">
</p>

**AI-recommended, self-executed liquidity routing for Robinhood Chain Stock Tokens.**

An off-chain agent watches every DEX venue trading Robinhood Chain Stock Tokens, compares quotes against a live Chainlink reference price, and publishes the best route. The user's wallet reads the recommendation and executes the swap on-chain — with their own slippage floor, their own signature.

> **"Every venue, compared. Best route, your signature."**

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  OFF-CHAIN    │     │    ON-CHAIN       │     │   USER       │
│  AGENT        │────▶│    SPHINX.sol     │◀────│   WALLET     │
│              │     │                  │     │              │
│  Polls venues │     │  bestVenue()      │     │  executeSwap │
│  Compares vs  │     │  publishRec()     │     │  (only user  │
│  Chainlink    │     │  Guardrails       │     │   can call)  │
│              │     │                  │     │              │
│  KEY: agent   │     │  KEY: owner       │     │  KEY: user   │
└──────────────┘     └──────────────────┘     └──────────────┘
```

**Three signers, three roles.** The agent recommends. The router enforces guardrails. The user executes. The agent's key is isolated — it can only call `publishRecommendation`, a pure event-emitting function with zero fund movement.

## Contracts

### SPHINX.sol
The core router. Registers venue adapters, compares live quotes, publishes agent-gated recommendations, executes user-authorized swaps under on-chain guardrails.

| Function | Caller | Description |
|----------|--------|-------------|
| `registerVenue(address)` | Owner | Add a venue adapter |
| `bestVenue(tokenIn, tokenOut, amountIn)` | Anyone (view) | Compare live quotes across all active venues |
| `publishRecommendation(...)` | Agent only | Emit `Recommendation` event — no custody, no execution |
| `executeSwap(venueId, tokenIn, tokenOut, amountIn, minAmountOut)` | Anyone | Execute swap with guardrail checks |

### UniswapV2Adapter.sol
Wraps any Uniswap V2-style DEX into the `IVenueAdapter` shape the router expects. Template for adding more venues (Arcus, RFQ desks, etc).

### Guardrails (on-chain, per-pair)
- **Slippage floor** — `minAmountOut` set too loose is rejected before the venue sees it
- **Oracle deviation** — quotes exceeding a configurable threshold from Chainlink are blocked
- **Order size caps** — per-pair max prevents a single trade from crushing thin liquidity
- **Agent key isolation** — agent signer can only call `publishRecommendation`, never `executeSwap`

## Tests

```bash
forge test -vv
```

**13/13 passing.** Foundry suite covers: venue comparison, swap execution, slippage enforcement, order size limits, stale oracle rejection, venue removal, agent isolation, and index-out-of-bounds protection.

## Project Structure

```
sphinx/
├── contracts/
│   ├── SPHINX.sol              # Core router
│   ├── UniswapV2Adapter.sol    # Uniswap V2 venue adapter
│   └── mocks/Mocks.sol         # Test mocks (ERC20, venue, aggregator)
├── test/
│   └── SPHINX.t.sol            # 13 Foundry tests
├── agent/
│   └── src/
│       ├── index.js            # Off-chain recommendation agent
│       ├── config.js           # Pair config, ABI, RPC
│       └── abis/SPHINX.json    # Contract ABI
├── web/
│   ├── index.html              # Landing page
│   ├── demo.html               # Live pipeline demo
│   ├── app/index.html          # Wallet-enabled web app
│   └── engine/                 # WebGL background (Shredder + Aratanagara)
├── scripts/
│   └── deploy.sh               # Deploy to Robinhood Chain
├── server.mjs                  # Express static server (port 4200)
└── foundry.toml                # Foundry config
```

## Quick Start

1. Visit **[sphinxai.fun/app](https://sphinxai.fun/app)**
2. Connect your wallet (MetaMask or Rabby)
3. Switch to **Robinhood Chain (4663)**
4. Browse live venue recommendations from the agent
5. Pick a route, set your slippage, and execute

> The agent recommends. The router enforces guardrails. You sign.

## Deploying to Robinhood Chain (Mainnet)

```bash
forge create contracts/SPHINX.sol:SPHINX \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --constructor-args $AGENT_ADDRESS \
  --broadcast
```

Chain ID: **4663**. Explorer: [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com)

## Links

- 🌐 **Website**: [sphinxai.fun](https://sphinxai.fun)
- 📂 **GitHub**: [SPHINX-RH/SPHINX](https://github.com/SPHINX-RH/SPHINX)
- 🎮 **Demo**: Live pipeline simulation at [sphinxai.fun/demo](https://sphinxai.fun/demo.html)
- 📱 **App**: Wallet-enabled swap at [sphinxai.fun/app](https://sphinxai.fun/app)

## License

MIT — see [LICENSE](LICENSE) for details.
