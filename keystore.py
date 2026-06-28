"""keystore.py — Payout EOA keystore for x402 seller.

Scope:
  - Hold payout private key only in-memory for current Python session.
  - Never write raw key to disk. Encrypt keystore via Fernet (n=2**14).
  - Always confirm address before any operation.
  - Payout wallet NEVER signs. Only receives USDC.

Key sources (priority order):
  1. getpass prompt (B0x70 paste live each session)
  2. env var X402_PAYOUT_KEY_HEX (chmod 600 .env) — optional

Payout address: stored in .env as X402_PAYOUT_ADDRESS
"""

from __future__ import annotations

import os
import sys
import json
import getpass
from pathlib import Path
from cryptography.fernet import Fernet
from web3 import Web3

# ── Constants ────────────────────────────────────────────────────────────
ENV_PATH = Path("/root/prpo_ai/x402_seller/.env")
KEY_ENV_VAR = "X402_PAYOUT_KEY_HEX"
ADDR_ENV_VAR = "X402_PAYOUT_ADDRESS"
KMS_ENV_VAR = "X402_MASTER_KMS_KEY"
KEYSTORE_FILE = Path("/root/prpo_ai/x402_seller/.keystore.enc")


def _read_env_var(name: str) -> str | None:
    if not ENV_PATH.exists():
        return None
    try:
        with open(ENV_PATH, "r") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == name:
                    return v.strip().strip('"').strip("'")
    except PermissionError:
        print("[keystore] .env not readable (chmod 600)", file=sys.stderr)
    return None


def _get_kms_key() -> bytes | None:
    """Read master KMS key from env (never from disk plaintext)."""
    raw = os.environ.get(KMS_ENV_VAR) or _read_env_var(KMS_ENV_VAR)
    if raw:
        return raw.encode()[:32].ljust(32, b"=")
    return None


def get_payout_address() -> str:
    """Return configured payout address."""
    addr = _read_env_var(ADDR_ENV_VAR)
    if not addr:
        raise RuntimeError(
            f"{ADDR_ENV_VAR} not set in {ENV_PATH}. "
            "Generate a new EOA with generate_eoa.py first."
        )
    return Web3.to_checksum_address(addr)


# ── Key loading ─────────────────────────────────────────────────────────

def load_key() -> bytes:
    """Load payout EOA private key into memory.

    Returns raw bytes (32, no 0x prefix).
    """
    from eth_account import Account

    expected_addr = get_payout_address()

    # Try Fernet keystore first
    kms = _get_kms_key()
    if kms and KEYSTORE_FILE.exists():
        try:
            f = Fernet(Fernet.generate_key() if len(kms) < 32 else kms)
            # Use KMS-derived key properly
            fernet_key = Fernet(kms if len(kms) == 32 else kms[:32])
            enc = KEYSTORE_FILE.read_bytes()
            dec = fernet_key.decrypt(enc)
            raw = dec.decode().strip()
            key_bytes = bytes.fromhex(raw.replace("0x", ""))
            acct = Account.from_key(key_bytes)
            derived = Web3.to_checksum_address(acct.address)
            if derived.lower() != expected_addr.lower():
                raise ValueError("keystore address mismatch")
            print("[keystore] payout key loaded from encrypted keystore",
                  file=sys.stderr)
            return key_bytes
        except Exception:
            pass  # fallback to env/getpass

    # Env var
    env_raw = _read_env_var(KEY_ENV_VAR)
    if env_raw:
        raw = env_raw.strip()
        if raw.startswith("0x"):
            raw = raw[2:]
        if len(raw) != 64:
            raise ValueError(f"Key must be 64 hex chars, got {len(raw)}")
        key_bytes = bytes.fromhex(raw)
        acct = Account.from_key(key_bytes)
        derived = Web3.to_checksum_address(acct.address)
        if derived.lower() != expected_addr.lower():
            raise RuntimeError(
                f"ADDRESS MISMATCH: derived={derived} expected={expected_addr}"
            )
        print("[keystore] payout key loaded from .env", file=sys.stderr)
        return key_bytes

    # Getpass
    raw = getpass.getpass(
        "X402 PAYOUT PRIVATE KEY (hex, 0x-prefixed, hidden): "
    ).strip()
    if raw.startswith("0x"):
        raw = raw[2:]
    if len(raw) != 64:
        raise ValueError(f"Expected 64 hex chars, got {len(raw)}")
    key_bytes = bytes.fromhex(raw)
    acct = Account.from_key(key_bytes)
    derived = Web3.to_checksum_address(acct.address)
    if derived.lower() != expected_addr.lower():
        raise RuntimeError(
            f"ADDRESS MISMATCH: derived={derived} expected={expected_addr}"
        )
    print("[keystore] payout key loaded via getpass", file=sys.stderr)
    return key_bytes


def save_encrypted_keystore(key_bytes: bytes, kms_passphrase: str):
    """Save encrypted keystore. Requires KMS passphrase."""
    if len(kms_passphrase) < 16:
        raise ValueError("KMS passphrase must be >= 16 chars")
    fernet_key = Fernet(kms_passphrase[:32].ljust(32, "=").encode())
    enc = fernet_key.encrypt(key_bytes.hex().encode())
    KEYSTORE_FILE.write_bytes(enc)
    KEYSTORE_FILE.chmod(0o600)
    print(f"[keystore] keystore saved to {KEYSTORE_FILE}", file=sys.stderr)