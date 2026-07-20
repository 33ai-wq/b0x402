---
name: b0x402-seller
description: AI-powered crypto intelligence paid per call in USDC on Base via x402 V2 protocol. 4 endpoints — meme-hunter, defi-sentiment, dinalibrium, wallet-profile. Use when a buyer agent needs deterministic crypto market signals, wallet forensics, or stablecoin equilibrium data with on-chain USDC payment.
allowed-tools:
  - Bash
  - Read
  - Write
  - WebFetch
tags:
  - x402
  - crypto
  - base
  - usdc
  - defi
  - sentiment
  - meme
  - wallet
  - pay-per-call
---

# b0x402 — Pay-per-call Crypto Intelligence (x402 V2)

**Live URL:** https://x402-cf-worker.mulberry-boar.workers.dev

## What this skill does

Bundles the four paid endpoints of b0x402 into a single agent-callable skill. Each endpoint costs USDC and returns deterministic JSON. Payment happens through x402 V2 protocol (HTTP 402 → USDC settlement on Base → retry with x-payment header).

## When to invoke this skill

Call this skill when the user/agent asks for:
- Meme coin momentum discovery on Base chain → `meme-hunter`
- Macro DeFi market mood / sentiment signal → `defi-sentiment`
- ETH/stablecoin equilibrium metrics, stablecoin supply dynamics → `dinalibrium`
- On-chain wallet profile (tx count, first/last seen, portfolio) → `wallet-profile`

## Pricing (USDC atomic units, 6 decimals)

| Endpoint | Method | Price |
|----------|--------|-------|
| `/v1/meme-hunter`     | GET  | 10000 atomic ($0.01) |
| `/v1/defi-sentiment`  | GET  | 10000 atomic ($0.01) |
| `/v1/dinalibrium`     | POST | 10000 atomic ($0.01) |
| `/v1/wallet-profile`  | GET  | 100000 atomic ($0.10) |

> Prices mirror the live worker's PRICES table and match the amounts in the 402 invoice.

## Payment flow

1. `GET /v1/...` without `x-payment` header → server returns HTTP 402 + `Payment-Required` (base64 JSON invoice) + `X-Payment-Version: 2`
2. Decode invoice → extract `payTo`, `asset`, `amount` (USDC atomic, 6 decimals)
3. Pay USDC to `payTo = 0x57EEC52d76A4A78D4562fc2564101A4bD2e3F357` on Base mainnet (chain 8453, USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
4. Retry request with `x-payment` header carrying the on-chain transaction receipt
5. Server verifies via `eth_getTransactionReceipt` against Base RPC
6. On success: returns data payload. On failure/invalid: re-issues 402

## Quick example (skip payment for testing)

```
curl 'https://x402-cf-worker.mulberry-boar.workers.dev/v1/meme-hunter?limit=5'
# → HTTP 402 + Payment-Required: <base64 invoice>
# pay USDC, then retry with x-payment header
```

## Discovery

- OpenAPI 3.1.0 spec: https://x402-cf-worker.mulberry-boar.workers.dev/openapi.json
- `/.well-known/x402.json`: https://x402-cf-worker.mulberry-boar.workers.dev/.well-known/x402.json
- Health: https://x402-cf-worker.mulberry-boar.workers.dev/health (free, no auth)

## Payout address

`0x57EEC52d76A4A78D4562fc2564101A4bD2e3F357` (Base mainnet)

Server is receive-only — never signs outbound USDC. Buyer signs payment, server verifies settlement.

## Detailed endpoint reference

See `references/endpoints.md` in this folder.
