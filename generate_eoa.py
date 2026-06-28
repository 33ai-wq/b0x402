"""generate_eoa.py — Generate a fresh x402 payout EOA.

Outputs:
  - Private key (getpass only, NOT to disk)
  - Address
  - .env entry ready to paste

Run once to create the payout wallet:
  cd /root/prpo_ai/x402_seller
  python generate_eoa.py

Then paste the X402_PAYOUT_ADDRESS=0x... line into .env
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eth_account import Account
from web3 import Web3


def generate_eoa() -> tuple[str, str]:
    """Generate fresh EOA. Returns (hex_key, address)."""
    acct = Account.create()
    key_hex = acct.key.hex()
    addr = Web3.to_checksum_address(acct.address)
    return key_hex, addr


if __name__ == "__main__":
    print("=" * 60)
    print("x402 PAYOUT EOA GENERATOR")
    print("=" * 60)
    print()
    print("⚠️  The private key shown below is the payout wallet.")
    print("⚠️  It will ONLY receive USDC — NEVER signs anything.")
    print()
    key_hex, addr = generate_eoa()

    print(f"ADDRESS:  {addr}")
    print()
    print(f"PRIVATE KEY (HEX):")
    print(f"  {key_hex}")
    print()
    print("=" * 60)
    print("NEXT STEPS:")
    print("  1. Save the private key securely (password manager / offline)")
    print("  2. Add to x402_seller/.env:")
    print()
    print(f"X402_PAYOUT_ADDRESS={addr}")
    print(f"X402_PAYOUT_KEY_HEX={key_hex}")
    print()
    print("  3. chmod 600 .env")
    print("  4. python main.py")
    print("=" * 60)