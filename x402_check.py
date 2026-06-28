"""x402_check.py — Standalone x402 payment verification.

Used by endpoints: called as the FIRST line in each route function.
Returns (error_response, None) if payment required/failed, or (None, buyer_addr) if ok.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure x402_lib is importable
_BASE_DIR = Path(__file__).resolve().parent
if str(_BASE_DIR) not in sys.path:
    sys.path.insert(0, str(_BASE_DIR))

from fastapi.responses import JSONResponse
from x402_lib import get_manager, verify_usdc_settlement, USDC_CONTRACT, CHAIN_ID
from pricing import ENDPOINT_PRICES, ENDPOINT_NAMES, price_label

# Payout address (lazy load)
_PAYOUT_ADDR: str | None = None

def _get_payout() -> str:
    global _PAYOUT_ADDR
    if _PAYOUT_ADDR is None:
        try:
            from keystore import get_payout_address
            _PAYOUT_ADDR = get_payout_address()
        except Exception:
            from dotenv import load_dotenv
            env = _BASE_DIR / ".env"
            if env.exists():
                load_dotenv(env)
            from os import getenv
            _PAYOUT_ADDR = getenv("X402_PAYOUT_ADDRESS", "NOT_SET")
    return _PAYOUT_ADDR


def parse_payment_header(value: str) -> dict:
    parts = {}
    for chunk in value.split(","):
        chunk = chunk.strip()
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            parts[k.strip()] = v.strip()
    return parts


def check_x402(
    endpoint_key: str,
    payment_hdr: str | None,
    bypass_query: str | None,
    settings_bypass: bool,
) -> tuple[JSONResponse | None, str | None]:
    """
    Returns (json_error_response, None) if reject, or (None, buyer_addr) if ok.
    Call this at the START of each endpoint route.
    """
    # Bypass check
    if settings_bypass or bypass_query == "true":
        return None, "bypass"

    if not payment_hdr:
        # Issue invoice
        price = ENDPOINT_PRICES.get(endpoint_key, 0)
        payout = _get_payout()
        inv = get_manager().issue(
            seller_address=payout,
            amount_atomic=price,
            token=USDC_CONTRACT,
            chain_id=CHAIN_ID,
            endpoint=endpoint_key,
        )
        body = {
            "error": "payment_required",
            "message": f"x402 payment required for {endpoint_key}",
            "name": ENDPOINT_NAMES.get(endpoint_key, endpoint_key),
            "price_usdc": price_label(price),
            "price_atomic": price,
            "nonce": inv.nonce,
            "payout_address": payout,
            "chain_id": CHAIN_ID,
            "token": USDC_CONTRACT,
            "expires_at": int(inv.expires_at),
            "how_to_pay": (
                f"Transfer ≥{price_label(price)} USDC to {payout} on Base (chain 8453), "
                f"then re-request with header X-Payment: tx_hash=<your_transfer_tx_hash>,nonce={inv.nonce}"
            ),
        }
        return JSONResponse(status_code=402, content=body, headers={"www-authenticate": inv.to_challenge_header()}), None

    # Verify payment
    parsed = parse_payment_header(payment_hdr)
    tx_hash = parsed.get("tx_hash", "")
    nonce   = parsed.get("nonce", "")

    if not tx_hash or not nonce:
        return JSONResponse(status_code=400, content={"error": "bad_request", "message": "X-Payment requires tx_hash and nonce"}), None

    inv = get_manager().get(nonce)
    if inv is None:
        return JSONResponse(status_code=400, content={"error": "bad_request", "message": "nonce not found or already used"}), None

    ok, reason = verify_usdc_settlement(
        tx_hash=tx_hash,
        expected_recipient=_get_payout(),
        expected_amount_atomic=inv.amount_atomic,
        expected_token=USDC_CONTRACT,
    )

    if not ok:
        return JSONResponse(status_code=402, content={"error": "payment_required", "message": f"payment verification failed: {reason}"}), None

    ok2, reason2, _ = get_manager().verify_and_pop(nonce, tx_hash)
    if not ok2:
        return JSONResponse(status_code=402, content={"error": "payment_required", "message": f"nonce already used: {reason2}"}), None

    return None, parsed.get("buyer_addr", "unknown")