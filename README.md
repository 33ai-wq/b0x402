# b0x402 — x402 Seller on Base L2

Pay-per-call AI endpoints for crypto market intelligence, settled in **USDC on Base (chain 8453)** via the [x402 HTTP 402 protocol](https://github.com/coinbase/x402).

## Endpoints (all gated by HTTP 402 invoice → USDC payment)

| Endpoint | Path | Free tier | Paid price |
|----------|------|-----------|------------|
| `/v1/meme-hunter` | `GET /v1/meme-hunter?token=<CA>` | 402 challenge | $0.001 USDC |
| `/v1/dinalibrium` | `POST /v1/dinalibrium` body `{"token": "0x..."}` | 402 challenge | $0.005 USDC |
| `/v1/defi-sentiment` | `GET /v1/defi-sentiment?topic=base` | 402 challenge | $0.005 USDC |
| `/v1/wallet-profile` | `GET /v1/wallet-profile?wallet=0x...` | 402 challenge | $0.010 USDC |

Dev bypass (only for testing):
```
curl 'http://127.0.0.1:8080/v1/meme-hunter?x402_bypass=true'
```

## Architecture

```
client ── GET /v1/... ───▶ FastAPI server ──▶ 402 invoice (nonce, expiry, payout)
                                              │
client ── pay USDC on Base L2 ────────────────┤  (settlement out-of-band)
                                              │
client ── GET + X-Payment header ─────────────▶
                                              │
server ── verify eth_getTransactionReceipt ──▶ execute route ──▶ JSON response
                                              │
                                              ▼
                                         nonce consumed
```

* `x402_lib/invoice.py` — thread-safe invoice manager (single-use nonce).
* `x402_lib/usdc.py` — on-chain settlement verifier via `eth_getTransactionReceipt`.
* `endpoints/*.py` — 4 product modules.
* `x402_check.py` — FastAPI dependency gate, mounted per-route.
* `keystore.py` — optional encrypted payout key (Fernet).
* `pricing.py` — tier constants, USDC atomic units.

## Local run

```bash
# 1. Setup
cd b0x402
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Configure
cp .env.example .env
# edit X402_PAYOUT_ADDRESS, BASE_RPC_URL, USDC_CONTRACT_BASE

# 3. Boot
python main.py
# → server on http://127.0.0.1:8080

# 4. Test
curl http://127.0.0.1:8080/health                          # → 200 {"status":"ok"}
curl http://127.0.0.1:8080/v1/meme-hunter                  # → 402 invoice
curl 'http://127.0.0.1:8080/v1/meme-hunter?x402_bypass=true'  # → 200 paid response
```

## Deployment

Production deploy guide (Fly.io recommended):

```
# Install fly CLI
curl -L https://fly.io/install.sh | sh

# Auth (browser flow)
fly auth signup
fly auth login

# Launch (auto-detects Dockerfile)
fly launch --name b0x402 --region nrt

# Inject secrets (NEVER commit these)
fly secrets set X402_PAYOUT_ADDRESS=0x1a44...
fly secrets set BASE_RPC_URL=https://base.gateway.tenderly.co
fly secrets set USDC_CONTRACT_BASE=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# Deploy
fly deploy

# Live URL
https://b0x402.fly.dev
```

Free tier: 3 shared-cpu 256MB VMs, 3GB storage, 160GB bandwidth/month.

## Security notes

* Payout wallet is **receive-only** — server does not sign outgoing USDC transactions.
* Private keys (if any) live only in encrypted envelopes (`keystore.py`) and are never committed.
* X402 invoice nonces are single-use, atomic; replay attempts return `402 invalid_nonce`.
* Do not commit `.env` to git. `.gitignore` blocks it.

## Wallet

Payout address (Base mainnet, USDC):
```
0x1a44bbbEB8F3161331E0857b9A1043132b534F62
```

Owner: `b0x70`. x402 endpoints forward incoming USDC to this address.

## License

MIT.
