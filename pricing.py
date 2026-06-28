"""pricing.py — x402 endpoint price tiers in USDC atomic units.

Free tier:  GET with no X-Payment header → 402 challenge (invoice issued)
Paid tier:  GET with valid X-Payment header (tx_hash) → resource returned

Price tiers:
  FREE  — any endpoint, limited to 1 req/s per IP (rate limit)
  TIER1 (0.001 USDC = 1000 wei) — /meme-hunter
  TIER2 (0.005 USDC = 5000)     — /dinalibrium, /defi-sentiment
  TIER3 (0.01  USDC = 10000)    — /wallet-profile (deeper analysis)
"""

from __future__ import annotations

USDC_DECIMALS = 6

# Atomic USDC units (USDC has 6 decimals)
PRICE_FREE   = 0
PRICE_TIER1  = 1_000      # 0.001 USDC
PRICE_TIER2  = 5_000      # 0.005 USDC
PRICE_TIER3  = 10_000     # 0.01 USDC

USDC_CONTRACT = "0x833589fCD6eDb700d8e099499C050dE848489198"
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
    return f"${atomic / 10**USDC_DECIMALS:.3f} USDC"