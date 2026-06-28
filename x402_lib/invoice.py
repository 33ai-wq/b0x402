"""x402_lib/invoice.py — Single-use nonce invoice manager.

Issues invoices, tracks pending table, verifies nonces atomically.
Thread-safety via threading.Lock for single-process uvicorn.
"""

from __future__ import annotations

import os
import json
import time
import secrets
import threading
from dataclasses import dataclass, asdict
from typing import Optional
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PENDING_FILE = BASE_DIR / "pending_invoices.json"


@dataclass
class Invoice:
    nonce: str           # 32-byte hex, server-issued, single-use
    address: str         # seller's pay-to Base EVM address
    amount_atomic: int   # USDC atomic units (6 decimals)
    chain_id: int        # 8453 = Base mainnet
    token: str           # USDC contract on Base
    expires_at: float    # unix timestamp (TTL = 300s default)
    endpoint: str        # which endpoint was requested
    created_at: float    # unix timestamp

    def is_expired(self) -> bool:
        return time.time() > self.expires_at

    def to_challenge_header(self) -> str:
        """Build WWW-Authenticate X-Payment header value."""
        return (
            f"X-Payment address={self.address}, "
            f"amount={self.amount_atomic}, "
            f"token={self.token}, "
            f"chain_id={self.chain_id}, "
            f"nonce={self.nonce}, "
            f"expires={int(self.expires_at)}"
        )

    def to_dict(self) -> dict:
        return asdict(self)


class InvoiceManager:
    """Thread-safe pending invoice table."""

    INVOICE_TTL = 300  # seconds

    def __init__(self):
        self._lock = threading.Lock()
        self._pending: dict[str, Invoice] = {}
        self._audit_log: list[dict] = []
        self._load_from_disk()

    # ── Persistence ───────────────────────────────────────────────────────

    def _load_from_disk(self):
        if PENDING_FILE.exists():
            try:
                raw = json.loads(PENDING_FILE.read_text())
                for nonce, data in raw.items():
                    inv = Invoice(**data)
                    # Drop expired on startup
                    if not inv.is_expired():
                        self._pending[nonce] = inv
            except Exception:
                pass  # corrupted file — start fresh

    def _save_to_disk(self):
        try:
            data = {n: inv.to_dict() for n, inv in self._pending.items()}
            PENDING_FILE.write_text(json.dumps(data, indent=2))
        except Exception:
            pass

    # ── Invoice lifecycle ────────────────────────────────────────────────

    def issue(
        self,
        seller_address: str,
        amount_atomic: int,
        token: str = "0x833589fcd6eDcb700d8e099498C03A35C0739d",
        chain_id: int = 8453,
        endpoint: str = "/",
        ttl: int = None,
    ) -> Invoice:
        """Issue a new single-use invoice."""
        if ttl is None:
            ttl = self.INVOICE_TTL

        nonce = secrets.token_hex(32)
        now = time.time()

        inv = Invoice(
            nonce=nonce,
            address=seller_address,
            amount_atomic=amount_atomic,
            chain_id=chain_id,
            token=token,
            expires_at=now + ttl,
            endpoint=endpoint,
            created_at=now,
        )

        with self._lock:
            self._pending[nonce] = inv
            self._save_to_disk()

        return inv

    def get(self, nonce: str) -> Optional[Invoice]:
        with self._lock:
            return self._pending.get(nonce)

    def verify_and_pop(
        self,
        nonce: str,
        tx_hash: str,
        buyer_addr: Optional[str] = None,
    ) -> tuple[bool, str, Optional[Invoice]]:
        """Atomically verify nonce and remove from pending.

        Returns (success, reason, invoice).
        """
        with self._lock:
            inv = self._pending.pop(nonce, None)

        if inv is None:
            return False, f"nonce not found or already used: {nonce}", None

        if inv.is_expired():
            return False, f"invoice expired at {inv.expires_at}", inv

        # Log audit
        audit = {
            "nonce": nonce,
            "tx_hash": tx_hash,
            "buyer_addr": buyer_addr,
            "endpoint": inv.endpoint,
            "amount_atomic": inv.amount_atomic,
            "verified_at": time.time(),
        }
        self._audit_log.append(audit)
        self._save_to_disk()

        return True, "ok", inv

    def audit_trail(self) -> list[dict]:
        with self._lock:
            return list(self._audit_log)


# Singleton
_manager: Optional[InvoiceManager] = None
_manager_lock = threading.Lock()


def get_manager() -> InvoiceManager:
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = InvoiceManager()
    return _manager