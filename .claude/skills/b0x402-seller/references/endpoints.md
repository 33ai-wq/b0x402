# Endpoints — Detailed Reference

## 1. GET /v1/meme-hunter ($0.01 USDC)

**Purpose:** Surface DexScreener-based meme coin signals with liquidity, volume, 24h price action, and boost score.

**Query parameters:**
- `limit` (int, default 10, max 50) — number of results
- `sort_by` (string, default "score") — `score | volume | change | liquidity | boosted`

**Response:**
```json
{
  "count": 5,
  "signals": [
    {
      "token_address": "0x...",
      "name": "Token Name",
      "symbol": "TKN",
      "price_usd": 0.00012,
      "change_24h_pct": 12.4,
      "volume_24h": 45000,
      "liquidity_usd": 7800,
      "score": 87,
      "link": "https://dexscreener.com/base/0x..."
    }
  ],
  "fetched_at": "2026-06-29T14:11:00.000Z"
}
```

## 2. GET /v1/defi-sentiment ($0.01 USDC)

**Purpose:** Real-time DeFi market mood indicator — bullish / bearish / neutral with confidence score.

**Response:**
```json
{
  "signal": "neutral",
  "score": 58,
  "timeframe": "7d",
  "detail": "Market in consolidation. Stablecoin supply rising mildly, ETH/BTC ratio trending flat.",
  "timestamp": "2026-06-29T14:11:00.000Z"
}
```

## 3. POST /v1/dinalibrium ($0.01 USDC)

**Purpose:** ETH/stablecoin equilibrium metrics. Stablecoin supply dynamics.

**Request body (optional):**
```json
{
  "stablecoin": "USDC",
  "window": "7d"
}
```

**Response:**
```json
{
  "ratio": 0.87,
  "stablecoin_supply": 42500000000,
  "change_7d_pct": 2.3,
  "window": "7d",
  "timestamp": "2026-06-29T14:11:00.000Z"
}
```

## 4. GET /v1/wallet-profile ($0.10 USDC)

**Purpose:** On-chain wallet profile for any EVM address on Base.

**Query parameters:**
- `address` (string, required) — EVM wallet address `0x...`

**Response:**
```json
{
  "address": "0x5118c9fb60b2d3d086491654d5a0c344298b57f2",
  "tx_count": 47,
  "first_seen": "2026-05-13T08:24:11.000Z",
  "last_seen": "2026-06-28T22:01:43.000Z",
  "portfolio": {
    "tokens_held": 4,
    "top_holding": { "symbol": "USDC", "value_usd": 215.43 }
  },
  "timestamp": "2026-06-29T14:11:00.000Z"
}
```

## Error shapes

When server returns non-402 errors:

```json
{ "error": "not_found", "endpoints": ["/v1/meme-hunter", ...] }
```

When payment missing/invalid:
```
HTTP 402
Payment-Required: <base64 invoice>
X-Payment-Version: 2
Body: {}
```
