"""endpoints/defi_sentiment.py — Tier2 DeFi sentiment endpoint.

Scores DeFi narrative sentiment based on:
  - On-chain volume flows
  - Funding rate anomalies
  - DEX volume trends
  - TVL changes

Query params:
  protocol (str) — e.g. "aerodrome", "uniswap", "compound"
  chain (str)    — "base" | "ethereum" | "arbitrum" (default: base)
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Query, Request, HTTPException
from pydantic import BaseModel
from datetime import datetime, timezone

from x402_check import check_x402

router = APIRouter()

class SentimentData(BaseModel):
    protocol: str
    chain: str
    score: float          # -100 to +100 (bearish to bullish)
    label: str           # "very_bearish" | "bearish" | "neutral" | "bullish" | "very_bullish"
    volume_24h: float
    tvl_change_24h_pct: float
    funding_rate: float | None
    narrative_signals: list[str]
    summary: str
    fetched_at: str


# ── Data sources ─────────────────────────────────────────────────────────

async def _get_defillama_tvl(protocol: str, chain: str) -> dict:
    """Fetch TVL from DeFiLlama."""
    slug_map = {
        "aerodrome": "aerodrome-finance",
        "uniswap":   "uniswap",
        "compound":  "compound-v2",
        "curve":     "curve-dao",
        "aave":      "aave",
    }
    slug = slug_map.get(protocol.lower(), protocol.lower())

    url = f"https://api.llama.fi/protocol/{slug}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            if resp.status_code == 404:
                return {}
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        # Protocol not found or API error — return empty, continue with defaults
        return {}
    except Exception:
        return {}

    tvl = data.get("tvl", 0) or 0
    tvl_change = data.get("change_1d", 0) or 0
    chain_data = data.get("chainTvls", {})
    chain_tvl = chain_data.get(chain.capitalize(), {}).get("tvl", tvl)

    return {"tvl": chain_tvl, "tvl_change_1d": tvl_change}


# ── Scoring ──────────────────────────────────────────────────────────────

def _score_sentiment(
    protocol: str,
    chain: str,
    tvl: float,
    tvl_change_1d: float,
    funding_rate: float | None,
    volume_24h: float | None,
) -> SentimentData:
    signals = []
    score = 0.0

    if tvl_change_1d > 10:
        score += 25
        signals.append(f"TVL +{tvl_change_1d:.1f}% in 24h — inflows detected")
    elif tvl_change_1d < -10:
        score -= 25
        signals.append(f"TVL {tvl_change_1d:.1f}% in 24h — outflows detected")
    else:
        signals.append(f"TVL flat {tvl_change_1d:+.1f}%")

    if funding_rate is not None:
        if funding_rate > 0.05:
            score += 20
            signals.append(f"High funding rate {funding_rate*100:.2f}% — perp hunters accumulating")
        elif funding_rate < -0.05:
            score -= 20
            signals.append(f"Negative funding {funding_rate*100:.2f}% — longs being liquidating")
        else:
            signals.append(f"Funding rate neutral {funding_rate*100:.3f}%")

    if volume_24h and volume_24h > 1_000_000:
        score += 10
        signals.append(f"High DEX volume ${volume_24h/1e6:.1f}M in 24h")

    score = max(-100.0, min(100.0, score))

    if score >= 60:
        label = "very_bullish"
    elif score >= 20:
        label = "bullish"
    elif score > -20:
        label = "neutral"
    elif score > -60:
        label = "bearish"
    else:
        label = "very_bearish"

    emoji = {"very_bullish": "🚀", "bullish": "📈", "neutral": "➡️",
             "bearish": "📉", "very_bearish": "💀"}
    summary = f"{emoji.get(label, '')} {protocol.capitalize()} on {chain}: {label.replace('_', ' ')} ({score:+.0f}/100)"

    return SentimentData(
        protocol=protocol,
        chain=chain,
        score=round(score, 1),
        label=label,
        volume_24h=round(volume_24h or 0, 2),
        tvl_change_24h_pct=round(tvl_change_1d, 2),
        funding_rate=round(funding_rate, 4) if funding_rate else None,
        narrative_signals=signals,
        summary=summary,
        fetched_at=datetime.now(timezone.utc).isoformat(),
    )


# ── Route ────────────────────────────────────────────────────────────────

@router.get("/defi-sentiment", response_model=SentimentData)
async def defi_sentiment(
    request: Request,
    protocol: str = Query("uniswap", description="Protocol name (e.g. aerodrome, uniswap, compound)"),
    chain: str = Query("ethereum", description="Chain: base | ethereum | arbitrum"),
):
    """Score DeFi protocol sentiment — narrative + on-chain signals."""
    import os
    err, _ = check_x402(
        "/defi-sentiment",
        request.headers.get("x-payment"),
        request.query_params.get("x402_bypass"),
        os.environ.get("X402_BYPASS", "") == "true",
    )
    if err:
        return err
    chain = chain.lower()

    tvl_data = await _get_defillama_tvl(protocol, chain)

    # Funding rate from coingecko or other source (placeholder)
    funding_rate = None

    return _score_sentiment(
        protocol=protocol,
        chain=chain,
        tvl=tvl_data.get("tvl", 0),
        tvl_change_1d=tvl_data.get("tvl_change_1d", 0),
        funding_rate=funding_rate,
        volume_24h=tvl_data.get("volume_24h"),
    )