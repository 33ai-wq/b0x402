# b0x402 — Marketing & Buyer Persona Guide

## Who buys this

### Primary persona: **Agent developer**

Builds autonomous AI agents that interact with crypto markets. Needs deterministic data feeds without API key management, billing overhead, or rate-limit drama. Pays USDC per call from the agent's wallet.

Pain points we solve:
- ❌ Most free crypto APIs require signup, API key rotation, OAuth
- ❌ Paid SaaS chains them to monthly subscriptions
- ❌ Rate limits throttle production agent behavior
- ✅ x402 = pay per atomic call, no account, no key

### Secondary persona: **Quant / trader**

Runs bots or task-specific scripts that need:
- Meme coin momentum discovery (meme-hunter)
- Macro market mood gating for entry signals (defi-sentiment)
- Equilibria math on stablecoin flows (dinalibrium)
- Wallet forensics on suspicious actors (wallet-profile)

Pays in small amounts, uses tiny subsets of endpoints, retries without contract.

### Tertiary persona: **Analyst / curator**

Wants raw data for research notes, dashboards, newsletters. Calls a few endpoints a week, doesn't need bulk rates.

## Sales copy blocks (drop in any context)

### Stripe-dead-simple one-liner
> Pay-per-call crypto intelligence for AI agents. 4 endpoints, USDC on Base. No signup, no API key. From $0.001 per call.

### Long-form
> b0x402 is a hosted x402 protocol seller running on Cloudflare Workers. You call one of four endpoints (meme-hunter, defi-sentiment, dinalibrium, wallet-profile). Without an x-payment header, you get HTTP 402 with a base64 invoice asking for USDC. You pay $0.001–$0.010 USDC to the configured payout address on Base mainnet, retry with the receipt, get the data. No subscription. No API key. No rate limit. Settlement on Base L2 (chain 8453), finality under 2 seconds. The four endpoints cover meme coin momentum discovery (DexScreener-aggregated), overall DeFi market mood, ETH/stablecoin equilibrium metrics, and per-address wallet forensics.

### Crypto-native flavor
> Cheap, deterministic AI-crypto signals. No trade credit BS. Just kick USDC at it through the door and the data comes right back. Built for agent consumption — every endpoint returns typed JSON, no flaky HTML scraping.

## FAQ (for marketplace listings)

**Q: Is this real USDC?**
A: Yes. Settled on Base mainnet (chain id 8453) in USDC (contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). Atomic units, 6 decimals.

**Q: How does payment actually flow?**
A: Client sends the request → if no `x-payment` header, server returns 402 + invoice. Client pays USDC to `0x1a44bbb…f62` via any Base wallet including programmatic agent ones. Client retries with the on-chain transaction receipt as the x-payment header. Server verifies via Base RPC, then serves data.

**Q: What if I don't pay?**
A: You get 402 back. Data isn't returned.

**Q: Can I get rate-limited?**
A: No. Each call is atomic. You can flood 1000 calls in a second and pay per call. There's no API key, so nothing to throttle.

**Q: Can I pay with other tokens?**
A: Currently USDC only on Base. Future versions may add USDT and additional L2s.

**Q: What does `wallet-profile` cost?**
A: $0.010 USDC per call. Returns tx count, first/last seen, portfolio summary for any EVM address.

**Q: How accurate are the signals?**
A: We surface upstreams (DexScreener, Base RPC, etc.) with low latency. They're indicators, not advice. Use at your own risk.

## Marketplace listings matrix

| Channel | URL | Status | Format |
|---|---|---|---|
| x402scan | https://www.x402scan.com/resources/register | Pending | URL only — auto-discovers via OpenAPI |
| x402bazaar | https://www.x402bazaar.org/submit | Pending | Listing JSON, 95% rev share |
| MCP Market | https://app.mcpmarket.com/b0x402/skills | In progress | Import from GitHub |
| Coinbase Bazaar | https://docs.cdp.coinbase.com/x402/bazaar | Auto | Active after first CDP-facilitator settlement |
| awesome-x402 PR | https://github.com/xpaysh/awesome-x402 | Pending | PR with single-line addition |

## Distribution funnel

When traffic hits, the conversion chain is:
1. Agent developer sees listing at x402scan.com or awesome-x402
2. Visits URL → gets 402 + invoice
3. Has agent with USDC-bearing wallet (any x402 client) → pays 0.001-0.010 USDC
4. Receives data → integrates into their tool
5. Repeats per call

Expected buyer dev audience size (informed guess):
- Direct: ~50-200 active x402-aware agents as of mid-2026
- Adjacent: ~5,000-20,000 builders/agents consuming crypto APIs that could discover x402 pattern

Realistically, 1-5% of relevant agents will hit the URL in the first 30 days with a price floor of $0.001. Total expected volume for v1: 100-500 calls/week if listings execute well.

## Feedback loop

After listing goes live:
- Day 1: Confirm 0 errors at x402scan.com
- Day 3: Check call counts at Cloudflare dashboard (PII-free aggregate)
- Day 7: First revenue verification — confirm USDC landed at `0x1a44bb…f62`
- Day 14: Optimize pricing or endpoints based on call pattern
