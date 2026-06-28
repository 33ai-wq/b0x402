"""test_buyer.py — Smoke test for x402 seller.

Tests both paths:
  1. Unpaid → 402 challenge with invoice
  2. Bypass mode (local dev)

Usage:
  # Local test (bypass):
  python test_buyer.py --bypass

  # Remote test (against deployed server):
  python test_buyer.py --server http://localhost:8080 --endpoint /dinalibrium
"""

from __future__ import annotations

import sys
import argparse
import httpx
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


BASE_ENDPOINTS = [
    "/dinalibrium",
    "/meme-hunter",
    "/defi-sentiment",
    "/wallet-profile",
]

# Required query params per endpoint
ENDPOINT_PARAMS = {
    "/dinalibrium":    "token=0x833589fCD6eDb700d8e099499C050dE848489198",
    "/meme-hunter":    "",
    "/defi-sentiment": "protocol=uniswap&chain=ethereum",
    "/wallet-profile": "address=0x000000000000000000000000000000000000dEaD",
}

DEFAULT_SERVER = "http://localhost:8080"


def test_bypass(server: str):
    """Test bypass mode — no payment needed."""
    print(f"\n🧪 Testing bypass mode at {server}")
    print("-" * 50)

    results = []
    for ep in BASE_ENDPOINTS:
        params = ENDPOINT_PARAMS.get(ep, "")
        if params:
            url = f"{server}/v1{ep}?{params}&x402_bypass=true"
        else:
            url = f"{server}/v1{ep}?x402_bypass=true"
        try:
            r = httpx.get(url, timeout=20)
            ok = r.status_code == 200
            results.append((ep, ok, r.status_code, r.elapsed.total_seconds()))
            status = "✅" if ok else "❌"
            print(f"  {status} {ep}: HTTP {r.status_code} ({r.elapsed.total_seconds():.2f}s)")
            if not ok:
                print(f"      Error: {r.text[:120]}")
        except Exception as e:
            results.append((ep, False, 0, 0))
            print(f"  ❌ {ep}: ERROR {e}")

    ok_count = sum(1 for _, ok, _, _ in results if ok)
    print(f"\nResults: {ok_count}/{len(results)} passed")
    return all(ok for _, ok, _, _ in results)


def test_unpaid(server: str, endpoint: str):
    """Test 402 challenge — unpaid request (no X-Payment, no bypass)."""
    print(f"\n🧪 Testing 402 challenge at {server}/v1{endpoint}")
    print("-" * 50)

    params = ENDPOINT_PARAMS.get(endpoint, "")
    if params:
        url = f"{server}/v1{endpoint}?{params}"  # No x402_bypass
    else:
        url = f"{server}/v1{endpoint}"
    r = httpx.get(url, timeout=15)

    print(f"  Status: {r.status_code}")
    if r.status_code == 402:
        body = r.json()
        print(f"  ✅ 402 received as expected")
        print(f"  Price: {body.get('price_usdc', 'unknown')}")
        print(f"  Nonce: {body.get('nonce', '')[:20]}...")
        print(f"  Payout: {body.get('payout_address', '')}")
        return True
    else:
        print(f"  ⚠️  Expected 402, got {r.status_code}")
        print(f"  Body: {r.text[:200]}")
        return False


def main():
    parser = argparse.ArgumentParser(description="x402 seller smoke test")
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--endpoint", default="/dinalibrium")
    parser.add_argument("--bypass", action="store_true")
    parser.add_argument("--test-402", action="store_true")
    args = parser.parse_args()

    if args.bypass:
        return 0 if test_bypass(args.server) else 1
    elif args.test_402:
        return 0 if test_unpaid(args.server, args.endpoint) else 1
    else:
        print("x402 Seller Test Suite")
        print("=" * 50)
        print("Run with --bypass   for local dev tests")
        print("Run with --test-402 for 402 challenge test")
        return 0


if __name__ == "__main__":
    sys.exit(main())