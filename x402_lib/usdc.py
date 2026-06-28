"""x402_lib/usdc.py — USDC settlement verifier on Base.

Implements the atomic verification loop:
  1. eth_getTransactionReceipt — tx confirmed (status=1)
  2. receipt.to == USDC contract
  3. input = transfer(address,uint256) — selector 0xa9059cbb
  4. recipient == seller address
  5. amount >= invoice amount
  6. (optional) buyer == claim
"""

from __future__ import annotations

import os
from typing import Optional
from web3 import Web3

# Base mainnet USDC
USDC_CONTRACT = "0x833589fCD6eDb700d8e099499C050dE848489198"
TRANSFER_SELECTOR = "0xa9059cbb"

# Free public RPCs (rotate on 429)
BASE_RPCS = [
    "https://base.publicnode.com",
    "https://base.drpc.org",
    "https://1rpc.io/base",
]

# Cache the Web3 instance
_w3_cache: Optional[Web3] = None


def _get_w3() -> Web3:
    global _w3_cache
    if _w3_cache is not None:
        return _w3_cache

    for url in BASE_RPCS:
        try:
            w3 = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 10}))
            if w3.is_connected():
                _w3_cache = w3
                return w3
        except Exception:
            continue

    raise ConnectionError(
        f"All Base RPCs failed: {[r for r in BASE_RPCS]}"
    )


def _decode_erc20_transfer(input_data: str) -> Optional[tuple[str, int]]:
    """Decode ERC20 transfer(address,uint256) — selector 0xa9059cbb.

    Returns (recipient, amount) or None if decode fails.
    """
    if not input_data or len(input_data) < 10:
        return None

    selector = input_data[:10]
    if selector != TRANSFER_SELECTOR:
        return None

    # Pad to 64-byte params
    data = input_data[10:].rjust(64 * 2, "0")

    # First 32 bytes = offset (ignored for first param after selector)
    # Next 32 bytes = address (last 20 bytes of 32-byte word)
    # Last 32 bytes = amount
    try:
        addr_hex = data[64:64 + 64]  # second word
        addr = "0x" + addr_hex[-40:]
        amount_hex = data[64 + 64:]   # third word
        amount = int(amount_hex, 16)
        return addr.lower(), amount
    except Exception:
        return None


def verify_usdc_settlement(
    tx_hash: str,
    expected_recipient: str,
    expected_amount_atomic: int,
    expected_token: str = USDC_CONTRACT,
    expected_chain_id: int = 8453,
    expected_buyer: Optional[str] = None,
    rpc_url: Optional[str] = None,
) -> tuple[bool, str]:
    """Verify a USDC transfer on Base satisfies all invoice conditions.

    Returns (success, reason).
    """
    w3 = _get_w3() if not rpc_url else Web3(Web3.HTTPProvider(rpc_url))

    # Normalize tx_hash
    if tx_hash.startswith("0x"):
        tx_hash = tx_hash[2:]
    tx_hash = "0x" + tx_hash.lower()

    # ── Step 1: receipt confirmed ─────────────────────────────────────────
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except Exception as e:
        return False, f"rpc error fetching receipt: {e}"

    if receipt is None:
        return False, "tx not found on chain"

    # status: 1 = success, 0 = revert
    if receipt.status != 1:
        return False, f"tx reverted (status={receipt.status})"

    # ── Step 2: to == USDC contract ─────────────────────────────────────
    receipt_to = receipt["to"].lower() if receipt["to"] else ""
    if receipt_to != expected_token.lower():
        return False, (
            f"tx.to={receipt['to']} != USDC contract "
            f"{expected_token}"
        )

    # ── Step 3: input = transfer(address,uint256) ─────────────────────────
    input_hex = receipt["input"].hex() if hasattr(receipt["input"], "hex") else receipt["input"]
    decoded = _decode_erc20_transfer(input_hex)
    if decoded is None:
        return False, f"input does not match ERC20 transfer selector"

    recipient, amount = decoded

    # ── Step 4: recipient == seller address ───────────────────────────────
    expected_recipient_norm = Web3.to_checksum_address(expected_recipient)
    actual_recipient_norm = Web3.to_checksum_address("0x" + recipient[-40:])
    if actual_recipient_norm != expected_recipient_norm:
        return False, (
            f"recipient {actual_recipient_norm} != "
            f"expected {expected_recipient_norm}"
        )

    # ── Step 5: amount >= invoice amount (overpay = ok) ─────────────────
    if amount < expected_amount_atomic:
        return False, (
            f"amount {amount} < invoice amount "
            f"{expected_amount_atomic} USDC"
        )

    # ── Step 6 (optional): buyer address ─────────────────────────────────
    if expected_buyer:
        actual_buyer = receipt["from"].lower()
        expected_buyer_norm = Web3.to_checksum_address(expected_buyer).lower()
        if actual_buyer != expected_buyer_norm:
            return False, (
                f"buyer {actual_buyer} != expected {expected_buyer_norm}"
            )

    return True, "verified"


def get_usdc_balance(address: str, rpc_url: Optional[str] = None) -> int:
    """Get USDC balance of an address on Base (raw atomic units)."""
    w3 = _get_w3() if not rpc_url else Web3(Web3.HTTPProvider(rpc_url))
    addr_cs = Web3.to_checksum_address(address)

    # ERC20 balanceOf(address) — selector 0x70a08231
    data = "0x70a08231" + "0" * 24 + addr_cs[2:].lower()
    result = w3.eth.call({"to": USDC_CONTRACT, "data": data})
    return int(result.hex() if hasattr(result, "hex") else result, 16)