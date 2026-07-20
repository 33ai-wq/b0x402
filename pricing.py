"""pricing.py — x402 endpoint price tiers in USDC atomic units.

Free tier:  GET with no X-Payment header → 402 challenge (invoice issued)
Paid tier:  GET with valid X-Payment header (tx_hash) → resource returned

Price tiers (matches live cf-worker PRICES table as of 2026-07-21):
  FREE  — any endpoint, limited to 1 req/s per IP (rate limit)
  TIER1 (0.01 USDC = 10000 wei) — /meme-hunter
  TIER2 (0.01 USDC = 10000)     — /dinalibrium, /defi-sentiment
  TIER3 (0.10 USDC = 100000)    — /wallet-profile (higher forensic value)
"""

from __future__ import annotations

USDC_DECIMALS = 6

# Atomic USDC units (USDC has 6 decimals)
PRICE_FREE   = 0
PRICE_TIER1  = 10_000     # 0.01 USDC
PRICE_TIER2  = 10_000     # 0.01 USDC
PRICE_TIER3  = 100_000    # 0.10 USDC

# Live settlement config — matches cf-worker/src/index.js CFG
USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
CHAIN_ID = 8453  # Base mainnet

# Endpoint → price tier
ENDPOINT_PRICES = {
    "/dinalibrium":     PRICE_TIER2,
    "/meme-hunter":     PRICE_TIER1,
    "/defi-sentiment":  PRICE_TIER2,
    "/wallet-profile":  PRICE_TIER3,
}

ENDPOINT_NAMES = {
    "/dinalibrium":     "Dinalibrium Token Analyzer",
    "/meme-hunter":     "Meme Hunter Signal",
    "/defi-sentiment":  "DeFi Sentiment",
    "/wallet-profile":  "On-Chain Wallet Profiler",
}


def price_label(atomic: int) -> str:
    """Human-readable USDC price."""
    return f"${atomic / 10**USDC_DECIMALS:.2f} USDC"