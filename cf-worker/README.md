# b0x402 — Cloudflare Workers Edition (Live Production)

The **production deployment** of b0x402 runs on Cloudflare Workers as a JavaScript edge function. This folder contains the canonical source-of-truth for what's actually serving live API calls.

**Live URL:** https://x402-cf-worker.mulberry-boar.workers.dev

## What's here

- `src/index.js` — 752-line Worker source. Implements:
  - `GET /v1/meme-hunter` ($0.001 USDC) — DexScreener-based meme coin signals
  - `GET /v1/defi-sentiment` ($0.005 USDC) — market mood signal (bullish/bearish/neutral)
  - `POST /v1/dinalibrium` ($0.005 USDC) — ETH/stablecoin equilibrium metrics
  - `GET /v1/wallet-profile` ($0.010 USDC) — on-chain address profiling
  - `GET /openapi.json` — x402scan canonical discovery spec
  - `GET /.well-known/x402.json` — x402 discovery doc (alternative)
  - `GET /health` — free probe

- `wrangler.toml` — Cloudflare Workers config. `BYPASS=false` in production means every paid call MUST include `x-payment` header. There is no client-side bypass.

## Why JavaScript on Workers, not Python

Cloudflare's Python Workers runtime needs `workers-py >= 1.90` for the `workers` module. Their runtime currently lags. JavaScript bundles natively through wrangler and is the stable, supported path for V8 isolate execution. Same x402 protocol logic, different language.

The Python reference implementation lives in the repo root (`main.py`, `endpoints/`, `x402_check.py`, `x402_lib/`) and is the same product idea — it can run locally but is **not** what serves live traffic. Use it as a reference SDK to understand the protocol flow if you're debugging.

## How payment works (x402 V2 spec)

1. Client sends `GET /v1/meme-hunter` without `x-payment` header.
2. Worker returns `HTTP 402` with headers:
   - `Payment-Required: <base64(JSON)>` — invoice
   - `X-Payment-Version: 2`
   - Body: `{}`
3. Invoice decodes to:
   ```json
   {
     "scheme": "exact",
     "network": "base",
     "maxAmountRequired": "1000",
     "resource": "https://x402-cf-worker.mulberry-boar.workers.dev/v1/meme-hunter",
     "payTo": "0x1a44bbbEB8F3161331E0857b9A1043132b534F62",
     "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
     "maxTimeoutSeconds": 300,
     "extensions": { "bazaar": { "info": { "input": { "type": "http", "method": "GET" } }, "schema": {} } }
   }
   ```
4. Client pays USDC to `payTo` on Base mainnet (chain id 8453).
5. Client retries with `x-payment` header carrying payment proof.
6. Worker verifies on-chain via `eth_getTransactionReceipt` against Base RPC.
7. If valid: serves data. If invalid/expired: re-issues 402.

## Configuration

The wrangler.toml declares:

```toml
name = "x402-cf-worker"
main = "src/index.js"
compatibility_date = "2026-06-28"

[vars]
X402_PAYOUT_ADDRESS = "0x1a44bbbEB8F3161331E0857b9A1043132b534F62"
X402_BYPASS = "false"
```

The payout address is the receive-only wallet USDC flows into. The Worker **never signs outbound USDC transactions** — buyers pay, server just verifies settlement.

## Local dev & redeploy

```bash
# Install wrangler
npm install -g wrangler

# Authenticate
export CLOUDFLARE_API_TOKEN='***'

# Edit src/index.js, then redeploy
wrangler deploy

# Verify after deploy
curl -si https://x402-cf-worker.mulberry-boar.workers.dev/health
curl -si https://x402-cf-worker.mulberry-boar.workers.dev/v1/meme-hunter | head -5
# Expected: 402 status, Payment-Required header, bazaar extension in payload

# Cleanup
unset CLOUDFLARE_API_TOKEN
```

The Cloudflare API token is **session-only** — set as env var while deploying, unset right after. Never commit to host filesystem or `.env`.

## Settlement address

```
0x1a44bbbEB8F3161331E0857b9A1043132b534F62
```

Base mainnet, USDC (atomic units, 6 decimals). All paid calls route settlement to this address.

## License

MIT.
