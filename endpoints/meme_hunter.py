"""endpoints/meme_hunter.py — Tier1 meme coin signal endpoint.

Queries DexScreener boosted tokens, returns top signals by:
  - 24h volume
  - price change %
  - liquidity
  - mint status (renounced / locked / open)

Query params:
  limit (int, default 10) — max tokens to return
  min_liquidity (int, default 1000) — min liquidity in USD
  sort_by (str) — "volume" | "change" | "liquidity" | "boosted"
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Query, Request, HTTPException
from pydantic import BaseModel

from x402_check import check_x402
from typing import Optional

router = APIRouter()

class MemeSignal(BaseModel):
    token_address: str
    name: str
    symbol: str
    price_usd: float
    change_24h_pct: float
    volume_24h: float
    liquidity_usd: float
    mint_status: str          # "renounced" | "locked" | "open" | "unknown"
    boosted: bool
    score: float              # 0–100 signal score
    link: str


class MemeHunterResponse(BaseModel):
    count: int
    signals: list[MemeSignal]
    fetched_at: str


DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens"

# ── Fetch ─────────────────────────────────────────────────────────────────

async def _fetch_dexscreener(token_addresses: list[str]) -> list[dict]:
    if not token_addresses:
        return []
    url = f"{DEXSCREENER_API}/" + ",".join(token_addresses[:30])  # batch limit
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(url)
    if resp.status_code == 404:
        return []
    resp.raise_for_status()
    data = resp.json()
    pairs = data.get("pairs", [])
    if isinstance(pairs, dict):
        pairs = [pairs] if pairs else []
    return pairs


def _build_signal(pair: dict) -> Optional[MemeSignal]:
    try:
        base = pair.get("baseToken", {})
        quote = pair.get("quoteToken", {})
        price_usd = float(pair.get("priceUsd") or 0)
        price_native = float(pair.get("priceNative") or 0)
        change = float(pair.get("priceChange", {}).get("h24") or 0)
        volume = float(pair.get("volume", {}).get("h24") or 0)
        liquidity = float(pair.get("liquidity", {}).get("usd") or 0)
        boosted = pair.get("boosted", False)

        addr = base.get("address", "")

        # Mint status heuristic (DexScreener may expose this)
        mint_str = pair.get("mintEnabled", None)
        if mint_str is False:
            mint_status = "renounced"
        elif liquidity > 0 and price_native > 0:
            mint_status = "open"  # assume open if trading
        else:
            mint_status = "unknown"

        # Simple signal score
        score = min(100.0, (abs(change) * 0.5) + (liquidity / 1000) + (volume / 500))
        score = round(score, 1)

        return MemeSignal(
            token_address=addr,
            name=base.get("name", "Unknown"),
            symbol=base.get("symbol", "??"),
            price_usd=round(price_usd, price_usd > 0.001 and price_usd < 1 and 8 or 4),
            change_24h_pct=round(change, 2),
            volume_24h=round(volume, 2),
            liquidity_usd=round(liquidity, 2),
            mint_status=mint_status,
            boosted=bool(boosted),
            score=score,
            link=f"https://dexscreener.com/base/{addr}",
        )
    except Exception:
        return None


# ── Route ────────────────────────────────────────────────────────────────

@router.get("/meme-hunter", response_model=MemeHunterResponse)
async def meme_hunter(
    request: Request,
    limit: int = Query(10, ge=1, le=50),
    min_liquidity: float = Query(1000, ge=0),
    sort_by: str = Query("score", regex="^(volume|change|liquidity|score|boosted)$"),
):
    """Scan DexScreener for boosted meme tokens on Base."""
    import os
    err, _ = check_x402(
        "/meme-hunter",
        request.headers.get("x-payment"),
        request.query_params.get("x402_bypass"),
        os.environ.get("X402_BYPASS", "") == "true",
    )
    if err:
        return err
    from datetime import datetime, timezone

    # Fetch recently boosted tokens from DexScreener
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(
                "https://api.dexscreener.com/latest/dex/search?q=base&limit=100",
                timeout=25,
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        raise HTTPException(502, f"DexScreener unavailable: {e}")

    # data = {"schemaVersion": "...", "pairs": [...]}
    pairs_raw = data.get("pairs", []) if isinstance(data, dict) else []
    # Filter to Base chain only
    pairs = [p for p in pairs_raw if isinstance(p, dict) and p.get("chainId") == "base"]

    signals = []
    for pair in pairs:
        sig = _build_signal(pair)
        if sig and sig.liquidity_usd >= min_liquidity:
            signals.append(sig)

    # Sort
    sort_map = {
        "volume":    lambda s: s.volume_24h,
        "change":    lambda s: abs(s.change_24h_pct),
        "liquidity": lambda s: s.liquidity_usd,
        "score":     lambda s: s.score,
        "boosted":   lambda s: int(s.boosted),
    }
    signals.sort(key=sort_map.get(sort_by, sort_map["score"]), reverse=True)
    signals = signals[:limit]

    now = datetime.now(timezone.utc).isoformat()

    return MemeHunterResponse(
        count=len(signals),
        signals=signals,
        fetched_at=now,
    )