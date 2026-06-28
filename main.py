"""x402 seller FastAPI server — dependency-based x402 enforcement.

Faster, cleaner architecture: x402 check runs inside each route as a
FastAPI dependency, not as a middleware. This avoids ASGI middleware quirks.

Run:
  cd /root/prpo_ai/x402_seller
  pip install -r requirements.txt   # (already done via .venv-sniper)
  python main.py

Generate payout EOA:
  python generate_eoa.py

.env setup (chmod 600):
  X402_PAYOUT_ADDRESS=<your_base_eoa>
  X402_PAYOUT_KEY_HEX=<hex_key>   # optional, getpass used otherwise
  X402_BYPASS=true                # for dev/testing
"""

from __future__ import annotations

import os
import sys
import time
import logging
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Depends, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

# ── Setup ─────────────────────────────────────────────────────────────────

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"

if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
)
log = logging.getLogger("x402_seller")

# ── Settings ───────────────────────────────────────────────────────────────

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    payout_address: str = ""
    bypass: bool = False

settings = Settings()

if not settings.payout_address:
    for line in (ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []):
        if line.startswith("X402_PAYOUT_ADDRESS="):
            settings.payout_address = line.split("=", 1)[1].strip().strip('"')
            break

# ── Import x402 lib ────────────────────────────────────────────────────────

sys.path.insert(0, str(BASE_DIR))
from x402_lib import get_manager, verify_usdc_settlement, USDC_CONTRACT, CHAIN_ID
from pricing import ENDPOINT_PRICES, ENDPOINT_NAMES, price_label
from keystore import get_payout_address

try:
    PAYOUT_ADDR = get_payout_address()
except Exception as e:
    log.warning(f"Payout address not resolved: {e}")
    PAYOUT_ADDR = settings.payout_address or "NOT_SET"

# ── x402 Dependency ─────────────────────────────────────────────────────────

def parse_payment_header(value: str) -> dict:
    parts = {}
    for chunk in value.split(","):
        chunk = chunk.strip()
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    return parts


async def check_x402(request: Request, endpoint: str) -> JSONResponse | None:
    """Dependency: checks payment. Returns None (proceed) or JSONResponse (reject).

    Usage in routes:
      x402_err = await check_x402(request, "/meme-hunter")
      if x402_err:
          return x402_err
    """
    # Bypass check
    if settings.bypass or request.query_params.get("x402_bypass") == "true":
        client_ip = getattr(request.client, "host", "unknown")
        log.warning(f"BYPASS: ip={client_ip} endpoint={endpoint}")
        return None

    payment_hdr = request.headers.get("x-payment")
    if not payment_hdr:
        # Issue invoice
        price = ENDPOINT_PRICES.get(endpoint, 0)
        inv = get_manager().issue(
            seller_address=PAYOUT_ADDR,
            amount_atomic=price,
            token=USDC_CONTRACT,
            chain_id=CHAIN_ID,
            endpoint=endpoint,
        )
        return JSONResponse(
            status_code=402,
            content={
                "error": "payment_required",
                "message": f"x402 payment required for {endpoint}",
                "name": ENDPOINT_NAMES.get(endpoint, endpoint),
                "price_usdc": price_label(price),
                "price_atomic": price,
                "nonce": inv.nonce,
                "payout_address": PAYOUT_ADDR,
                "chain_id": CHAIN_ID,
                "token": USDC_CONTRACT,
                "expires_at": int(inv.expires_at),
                "how_to_pay": (
                    f"Transfer ≥{price_label(price)} USDC to {PAYOUT_ADDR} "
                    f"on Base (chain 8453), then re-request with header "
                    f"X-Payment: tx_hash=<your_transfer_tx_hash>,nonce={inv.nonce}"
                ),
            },
            headers={"www-authenticate": inv.to_challenge_header()},
        )

    # Verify payment
    parsed = parse_payment_header(payment_hdr)
    tx_hash = parsed.get("tx_hash", "")
    nonce   = parsed.get("nonce", "")

    if not tx_hash or not nonce:
        return JSONResponse(
            status_code=400,
            content={"error": "bad_request", "message": "X-Payment requires tx_hash and nonce"},
        )

    inv = get_manager().get(nonce)
    if inv is None:
        return JSONResponse(
            status_code=400,
            content={"error": "bad_request", "message": "nonce not found or already used"},
        )

    ok, reason = verify_usdc_settlement(
        tx_hash=tx_hash,
        expected_recipient=PAYOUT_ADDR,
        expected_amount_atomic=inv.amount_atomic,
        expected_token=USDC_CONTRACT,
    )

    if not ok:
        return JSONResponse(status_code=402, content={"error": "payment_required", "message": f"payment failed: {reason}"})

    ok2, reason2, _ = get_manager().verify_and_pop(nonce, tx_hash)
    if not ok2:
        return JSONResponse(status_code=402, content={"error": "payment_required", "message": f"nonce already used: {reason2}"})

    log.info(
        f"💸 PAID: nonce={nonce[:16]}… amount={price_label(inv.amount_atomic)} "
        f"buyer={parsed.get('buyer_addr', 'unknown')[:12]}… tx={tx_hash[:12]}…"
    )
    return None


# ── App lifecycle ──────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(f"x402 seller starting — payout: {PAYOUT_ADDR[:12]}…")
    log.info(f"Endpoints: {list(ENDPOINT_PRICES.keys())}")
    log.info(f"Bypass: {settings.bypass}")
    yield
    log.info("x402 seller stopped")


app = FastAPI(title="prpo_ai x402 Seller", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import routers
from endpoints.dinalibrium import router as dina_router
from endpoints.meme_hunter import router as meme_router
from endpoints.defi_sentiment import router as defi_router
from endpoints.wallet_profile import router as wallet_router

app.include_router(dina_router,   prefix="/v1", tags=["x402"])
app.include_router(meme_router,   prefix="/v1", tags=["x402"])
app.include_router(defi_router,   prefix="/v1", tags=["x402"])
app.include_router(wallet_router, prefix="/v1", tags=["x402"])


# ── Health / info ──────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "payout_address": PAYOUT_ADDR,
        "endpoints": ENDPOINT_PRICES,
        "chain": "base",
        "token": USDC_CONTRACT,
    }


@app.get("/")
async def root():
    return {
        "service": "prpo_ai x402 Seller",
        "version": "1.0.0",
        "endpoints": {ep: {"price_usdc": price_label(p), "name": ENDPOINT_NAMES[ep]}
                      for ep, p in ENDPOINT_PRICES.items()},
        "chain": "Base (8453)",
        "token": "USDC",
        "payout_address": PAYOUT_ADDR,
        "docs": "/docs",
    }


# ── Run ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False, log_level="info")