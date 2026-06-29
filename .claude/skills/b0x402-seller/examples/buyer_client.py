# Example Python x402 client (reference)
# This is reference code; production buyers can use any x402-compatible client.

import os, json, base64, urllib.request, urllib.error
from web3 import Web3
from web3.middleware import geth_poa_middleware

BASE = "https://x402-cf-worker.mulberry-boar.workers.dev"
PAYOUT = "0x1a44bbbEB8F3161331E0857b9A1043132b534F62"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
BASE_RPC = "https://mainnet.base.org"

# Setup wallet
w3 = Web3(Web3.HTTPProvider(BASE_RPC))
w3.middleware_onion.inject(geth_poa_middleware, layer=0)
PRIVATE_KEY = os.environ["BUYER_PRIVATE_KEY"]  # session env var only
account = w3.eth.account.from_key(PRIVATE_KEY)


def call_x402(path):
    # Step 1: probe endpoint, expect 402 with invoice header
    req = urllib.request.Request(f"{BASE}{path}",
        headers={"User-Agent": "buyer-agent"})
    invoice = None
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        if e.code != 402:
            raise
        invoice_b64 = e.headers.get("Payment-Required")
        invoice = json.loads(base64.b64decode(invoice_b64))

    # Step 2: pay USDC atomic amount to payout address
    amount = int(invoice["maxAmountRequired"])
    erc20_transfer_selector = "0xa9059cbb"
    calldata = (
        erc20_transfer_selector
        + PAYOUT[2:].rjust(64, "0")
        + hex(amount)[2:].rjust(64, "0")
    )
    tx = {
        "to": Web3.to_checksum_address(USDC),
        "value": 0,
        "data": calldata,
        "gas": 100000,
        "gasPrice": w3.eth.gas_price,
        "nonce": w3.eth.get_transaction_count(account.address),
        "chainId": 8453,
    }
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction).hex()

    # Step 3: wait for confirmation on Base
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

    # Step 4: retry with x-payment header
    req2 = urllib.request.Request(
        f"{BASE}{path}",
        headers={
            "x-payment": json.dumps({"txHash": tx_hash, "receipt": dict(receipt)}),
            "User-Agent": "buyer-agent",
        },
    )
    return json.loads(urllib.request.urlopen(req2).read())


if __name__ == "__main__":
    data = call_x402("/v1/meme-hunter?limit=3")
    print(json.dumps(data, indent=2))
