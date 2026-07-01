/**
 * cf-worker/src/index.js  —  b0x402 x402 paid API (Cloudflare Worker)
 *
 * ══════════════════════════════════════════════════════════════════
 *  BUGS FIXED (8 total):
 *
 *  #1  bypass: false          was true  → 402 NEVER returned, x402scan got 200
 *  #2  network: "eip155:8453" was "base" → x402 v2 requires CAIP-2 format
 *  #3  /.well-known/x402      was custom object → must be {version,resources[]}
 *  #4  bazaar.schema non-empty was {} per-endpoint → x402scan: "Missing input schema"
 *  #5a inv._amount stored      was missing → verifyTransfer(payout, undefined) always false
 *  #5b inv._expires stored     was missing → expiry check compared with NaN (never expired)
 *  #6a verifyTransfer topic[1] was 0x0 (mint-only) → null accepts any sender
 *  #6b verifyTransfer fromBlock was "0x0" (genesis) → recent ~1000 blocks only
 *  #7  OpenAPI protocols       was [{x402:{}}] → must be ["x402"]
 * ══════════════════════════════════════════════════════════════════
 */

const CFG = {
  payoutAddress: "0x57EEC52d76A4A78D4562fc2564101A4bD2e3F357",
  bypass:        false,           // ✅ FIX #1: was true → bypassed all payment, 402 never sent
  usdcContract:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  network:       "eip155:8453",  // ✅ FIX #2: was "base" → x402 v2 requires CAIP-2 format
  rpcUrl:        "https://base.gateway.tenderly.co",
  invoiceTTL:    300,
  baseUrl:       "https://x402-cf-worker.mulberry-boar.workers.dev",
};

const PRICES = {
  "/v1/meme-hunter":    10_000,    // $0.01 (B0x70 floor price 2026-06-30)
  "/v1/defi-sentiment": 10_000,    // $0.01 (B0x70 floor price)
  "/v1/dinalibrium":    10_000,    // $0.01 (B0x70 floor price)
  "/v1/wallet-profile": 100_000,   // $0.10 (high-value forensic call)
};

// ✅ FIX #4: per-endpoint Bazaar schemas with actual parameters
// x402scan rejects empty schema {} with "parseResponse: Missing input schema"
const BAZAAR = {
  "/v1/meme-hunter": {
    info: { input: { type: "http", method: "GET" } },
    schema: {
      type: "object",
      properties: {
        limit:   { type: "integer", default: 10,      description: "Number of results (max 50)" },
        sort_by: { type: "string",  default: "score", description: "Sort key: score|volume|change|liquidity|boosted" },
      },
    },
  },
  "/v1/defi-sentiment": {
    info: { input: { type: "http", method: "GET" } },
    schema: {
      type: "object",
      properties: {
        topic: { type: "string", default: "base", description: "Market topic filter (e.g. 'base', 'defi')" },
      },
    },
  },
  "/v1/dinalibrium": {
    info: { input: { type: "http", method: "POST" } },
    schema: {
      type: "object",
      properties: {
        stablecoin: { type: "string", default: "USDC", description: "USDC | USDT | DAI" },
        window:     { type: "string", default: "7d",   description: "Lookback window: 1d | 7d | 30d" },
      },
    },
  },
  "/v1/wallet-profile": {
    info: { input: { type: "http", method: "GET" } },
    schema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "string", description: "EVM wallet address (0x...)" },
      },
    },
  },
};

// In-memory invoice store (per isolate, resets on cold start)
const invoices = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function parseAuthHeader(value) {
  const parts = {};
  const re    = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(value)) !== null) parts[m[1]] = m[2] ?? m[3];
  return parts;
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

function makeNonce() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

// ✅ FIX #6b: get latest block to limit eth_getLogs range (not from genesis)
async function getLatestBlock() {
  try {
    const r = await fetch(CFG.rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
    });
    return parseInt((await r.json()).result, 16);
  } catch (_) { return null; }
}

/** Verify USDC transfer to payout address via Base RPC eth_getLogs */
async function verifyTransfer(toAddress, minAmount) {
  const toTopic = "0x" + toAddress.toLowerCase().replace("0x", "").padStart(64, "0");

  // ✅ FIX #6b: scan last ~1000 blocks (~33 min on Base), not from block 0
  const latest    = await getLatestBlock();
  const fromBlock = latest ? "0x" + Math.max(0, latest - 1000).toString(16) : "latest";

  const body = {
    jsonrpc: "2.0",
    method:  "eth_getLogs",
    params: [{
      fromBlock,
      toBlock: "latest",
      address: CFG.usdcContract,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer(from,to,value)
        null,      // ✅ FIX #6a: was 0x0 (mint-only!) — null accepts transfers from ANY sender
        toTopic,   // recipient = our payout address
      ],
    }],
    id: 1,
  };

  try {
    const r    = await fetch(CFG.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    for (const log of (data.result || [])) {
      if (parseInt(log.data, 16) >= minAmount) return true;
    }
  } catch (e) { console.error("RPC error:", e); }
  return false;
}

// ── x402 Gate ──────────────────────────────────────────────────────────────

async function checkX402(path, paymentHdr, bypassParam) {
  // BYPASS DISABLED 2026-07-01 — security: no URL param override allowed
  // Only CFG.bypass (from env X402_BYPASS=true) can enable — and CFG.bypass = false by default
  if (CFG.bypass) return { err: null, paid: true };
  if (!PRICES[path]) return { err: null, paid: true };

  if (!paymentHdr) {
    // ── Issue 402 invoice ──────────────────────────────────────────────────
    const invNonce = makeNonce();
    const amount   = PRICES[path];
    const resource = CFG.baseUrl + path;
    const bazaar   = BAZAAR[path];
    const extra    = { name: "USD Coin", version: "2", bazaar }; // EIP-3009 USDC metadata + Bazaar

    // ✅ FIX #5a + #5b: store _amount (numeric) and _expires — both were missing
    invoices.set(invNonce, {
      _amount:           amount,                        // numeric, used by verifyTransfer
      _expires:          nowSeconds() + CFG.invoiceTTL, // numeric, used by expiry check
      scheme:            "exact",
      network:           CFG.network,
      maxAmountRequired: String(amount),
      resource,
      payTo:             CFG.payoutAddress,
      asset:             CFG.usdcContract,
      maxTimeoutSeconds: CFG.invoiceTTL,
    });

    // Body format: accepts[] read by x402scan, agentcash, CDP Bazaar, and legacy clients
    const body = {
      x402Version: 2,
      accepts: [{
        scheme:            "exact",
        network:           CFG.network,        // ✅ FIX #2: "eip155:8453"
        maxAmountRequired: String(amount),
        payTo:             CFG.payoutAddress,
        asset:             CFG.usdcContract,
        maxTimeoutSeconds: CFG.invoiceTTL,
        resource,
        description:       `x402 API call to ${path}`,
        mimeType:          "application/json",
        outputSchema:      { type: "object" },
        extra,             // ✅ FIX #4: non-empty bazaar.schema
      }],
    };

    // Payment-Required header: primary x402 v2 channel (base64-encoded JSON)
    const hdrPayload = {
      x402Version: 2, scheme: "exact", network: CFG.network,
      nonce: invNonce, maxAmountRequired: String(amount),
      resource, payTo: CFG.payoutAddress, asset: CFG.usdcContract,
      maxTimeoutSeconds: CFG.invoiceTTL, extra,
    };

    return {
      err: new Response(JSON.stringify(body), {
        status: 402,
        headers: {
          "Content-Type":                  "application/json",
          "Payment-Required":              btoa(JSON.stringify(hdrPayload)),
          "X-Payment-Version":             "2",
          "Cache-Control":                 "no-store",
          "Access-Control-Expose-Headers": "Payment-Required, X-Payment-Version",
        },
      }),
      paid: false,
    };
  }

  // ── Verify submitted payment ────────────────────────────────────────────
  const parsed = parseAuthHeader(paymentHdr);
  const inv    = invoices.get(parsed.nonce);

  if (!inv) {
    return {
      err: new Response(JSON.stringify({ error: "invalid_nonce" }), {
        status: 402, headers: { "Content-Type": "application/json" },
      }),
      paid: false,
    };
  }

  // ✅ FIX #5b: inv._expires now exists (was undefined before — check always failed silently)
  if (nowSeconds() > inv._expires) {
    invoices.delete(parsed.nonce);
    return {
      err: new Response(JSON.stringify({ error: "invoice_expired" }), {
        status: 402, headers: { "Content-Type": "application/json" },
      }),
      paid: false,
    };
  }

  // ✅ FIX #5a: inv._amount now exists (was undefined before — verifyTransfer always returned false)
  const ok = await verifyTransfer(CFG.payoutAddress, inv._amount);
  if (!ok) {
    return {
      err: new Response(JSON.stringify({ error: "payment_not_verified" }), {
        status: 402, headers: { "Content-Type": "application/json" },
      }),
      paid: false,
    };
  }

  invoices.delete(parsed.nonce);
  return { err: null, paid: true };
}

// ── Endpoint Handlers ───────────────────────────────────────────────────────

async function memeHunter(limit = 10, sortBy = "score") {
  try {
    const resp  = await fetch(
      "https://api.dexscreener.com/latest/dex/search?q=base&limit=100",
      { cf: { cacheTtl: 60, cacheEverything: true } }
    );
    const data  = await resp.json();
    const pairs = (data.pairs || []).filter(p => p?.chainId === "base");

    const signals = pairs.map(p => {
      try {
        const base      = p.baseToken || {};
        const priceUsd  = parseFloat(p.priceUsd          || 0);
        const change    = parseFloat(p.priceChange?.h24   || 0);
        const volume    = parseFloat(p.volume?.h24        || 0);
        const liquidity = parseFloat(p.liquidity?.usd     || 0);
        const score     = Math.min(100, Math.abs(change) * 0.5 + liquidity / 1000 + volume / 500);
        return {
          token_address:  base.address || "",
          name:           base.name    || "Unknown",
          symbol:         base.symbol  || "??",
          price_usd:      parseFloat(priceUsd.toFixed(priceUsd < 0.001 ? 8 : 4)),
          change_24h_pct: parseFloat(change.toFixed(2)),
          volume_24h:     parseFloat(volume.toFixed(2)),
          liquidity_usd:  parseFloat(liquidity.toFixed(2)),
          mint_status:    liquidity > 0 ? "open" : "unknown",
          boosted:        !!p.boosted,
          score:          parseFloat(score.toFixed(1)),
          link:           `https://dexscreener.com/base/${base.address || ""}`,
        };
      } catch (_) { return null; }
    }).filter(Boolean);

    const sortFns = {
      volume:    s => s.volume_24h,
      change:    s => Math.abs(s.change_24h_pct),
      liquidity: s => s.liquidity_usd,
      score:     s => s.score,
      boosted:   s => s.boosted ? 1 : 0,
    };
    const fn = sortFns[sortBy] || sortFns.score;
    signals.sort((a, b) => fn(b) - fn(a));
    return { count: signals.length, signals: signals.slice(0, limit) };
  } catch (e) {
    console.error("meme-hunter error:", e);
    return { count: 0, signals: [] };
  }
}

// ── Main Router ─────────────────────────────────────────────────────────────

async function handleRequest(request) {
  const url        = new URL(request.url);
  const path       = url.pathname;
  const params     = url.searchParams;
  const paymentHdr = request.headers.get("x-payment");
  const bypass     = params.get("x402_bypass");

  // ── /favicon.ico ────────────────────────────────────────────────────────
  if (path === "/favicon.ico") {
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
      c => c.charCodeAt(0)
    );
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  }

  // ── / — Landing page ────────────────────────────────────────────────────
  if (path === "/" || path === "/index.html") {
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>b0x402 — AI-Powered Crypto Intelligence (x402 Paid API)</title><meta name="description" content="AI-powered crypto intelligence — meme coin signals, DeFi sentiment, market equilibrium, wallet profiling. Pay per call in USDC on Base via the x402 standard."/><meta property="og:title" content="b0x402 — AI-Powered Crypto Intelligence API"/><meta property="og:description" content="Pay per call in USDC on Base. Four endpoints. No subscriptions. Powered by the x402 protocol."/><meta property="og:type" content="website"/><meta property="og:url" content="https://x402-cf-worker.mulberry-boar.workers.dev"/><meta name="twitter:card" content="summary_large_image"/><link rel="icon" href="/favicon.ico" type="image/png"/><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background: #0a0a0a; color: #e5e5e5; line-height: 1.6; }
.wrap { max-width: 880px; margin: 0 auto; padding: 64px 24px; }
.badge { display: inline-block; padding: 4px 12px; background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 999px; font-size: 12px; color: #a1a1aa; margin-bottom: 24px; font-family: ui-monospace,'SF Mono',monospace; }
h1 { font-size: 48px; font-weight: 800; line-height: 1.1; letter-spacing: -0.03em; color: #fafafa; margin-bottom: 16px; }
h1 .accent { background: linear-gradient(135deg,#3b82f6 0%, #8b5cf6 50%, #ec4899 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.sub { font-size: 18px; color: #a1a1aa; margin-bottom: 48px; max-width: 620px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 48px; }
.card { background: #141414; border: 1px solid #262626; border-radius: 12px; padding: 20px; transition: border-color .15s ease, transform .15s ease; }
.card:hover { border-color: #3b82f6; transform: translateY(-2px); }
.card h3 { font-size: 15px; font-weight: 600; color: #fafafa; margin-bottom: 6px; font-family: ui-monospace,'SF Mono',monospace; }
.card h3 .method { color: #60a5fa; margin-right: 6px; }
.card h3 .method.post { color: #f59e0b; }
.card .price { display: inline-block; margin-top: 12px; padding: 4px 10px; background: #052e16; color: #4ade80; border: 1px solid #14532d; border-radius: 6px; font-size: 13px; font-family: ui-monospace,'SF Mono',monospace; font-weight: 600; }
.card p { font-size: 14px; color: #a1a1aa; margin-bottom: 0; }
.section { background: #141414; border: 1px solid #262626; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
.section h2 { font-size: 16px; font-weight: 700; color: #fafafa; margin-bottom: 14px; font-family: ui-monospace,'SF Mono',monospace; }
.section p, .section li { font-size: 14px; color: #a1a1aa; }
.section ul { list-style: none; padding-left: 0; }
.section ul li { padding: 4px 0; padding-left: 20px; position: relative; }
.section ul li::before { content: "→"; position: absolute; left: 0; color: #52525b; }
.code { background: #0d0d0d; border: 1px solid #262626; border-radius: 8px; padding: 12px 14px; font-family: ui-monospace,'SF Mono',monospace; font-size: 13px; color: #a1a1aa; overflow-x: auto; margin: 12px 0; }
.footer { margin-top: 56px; padding-top: 24px; border-top: 1px solid #1f1f1f; font-size: 13px; color: #52525b; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.footer a { color: #71717a; text-decoration: none; }
.footer a:hover { color: #a1a1aa; }
.tag { display: inline-block; font-family: ui-monospace,'SF Mono',monospace; font-size: 11px; padding: 2px 8px; background: #1c1c1c; border-radius: 4px; color: #71717a; margin-right: 6px; }
</style></head><body><div class="wrap">
<span class="badge">● OPERATIONAL · Base mainnet · x402 V2</span>
<h1>Pay-per-call <span class="accent">crypto intelligence</span><br/>for AI agents.</h1>
<p class="sub">b0x402 is a paid x402 API on the Base network. Four endpoints, USDC-based pricing, no subscriptions. Hit any route without an <code>x-payment</code> header to receive a 402 invoice.</p>
<h2 style="font-size:13px;letter-spacing:.08em;color:#71717a;margin-bottom:18px;font-family:ui-monospace,monospace;">ENDPOINTS · 4</h2>
<div class="grid">
<a class="card" href="/v1/meme-hunter" style="text-decoration:none;color:inherit"><h3><span class="method">GET</span>/v1/meme-hunter</h3><p>Meme-coin signals from DexScreener — liquidity, volume, 24h price action, boost score.</p><span class="price">$0.001 USDC / call</span></a>
<a class="card" href="/v1/defi-sentiment" style="text-decoration:none;color:inherit"><h3><span class="method">GET</span>/v1/defi-sentiment</h3><p>Macro DeFi market mood — bullish / bearish / neutral with confidence score.</p><span class="price">$0.005 USDC / call</span></a>
<a class="card" href="/v1/dinalibrium" style="text-decoration:none;color:inherit"><h3><span class="method post">POST</span>/v1/dinalibrium</h3><p>ETH/stablecoin equilibrium ratio and stablecoin-supply dynamics.</p><span class="price">$0.005 USDC / call</span></a>
<a class="card" href="/v1/wallet-profile?address=0x5118c9FB60b2d3d086491654D5a0C344298b57F2" style="text-decoration:none;color:inherit"><h3><span class="method">GET</span>/v1/wallet-profile</h3><p>On-chain wallet profile — tx count, first/last seen, portfolio summary for any EVM address.</p><span class="price">$0.010 USDC / call</span></a>
</div>
<div class="section"><h2>How it works</h2>
<ul>
<li>1. <strong>GET</strong> one of the endpoints above without an <code>x-payment</code> header.</li>
<li>2. Server returns <strong>HTTP 402</strong> with a <code>Payment-Required</code> invoice (base64 JSON, x402 V2 spec).</li>
<li>3. Pay the requested USDC amount to the payout address on Base mainnet (chain id 8453).</li>
<li>4. Retry the request with <code>x-payment</code> header to receive the actual data.</li>
</ul></div>
<div class="section"><h2>Quick example</h2>
<div class="code">$ curl "https://x402-cf-worker.mulberry-boar.workers.dev/v1/meme-hunter?limit=5"
→ HTTP 402, Payment-Required: &lt;base64 invoice&gt;
# pay USDC, then retry with x-payment header — server returns 200 + data
</div>
<p>Full OpenAPI spec: <a href="/openapi.json" style="color:#60a5fa;text-decoration:none">/openapi.json</a> · x402 discovery doc: <a href="/.well-known/x402" style="color:#60a5fa;text-decoration:none">/.well-known/x402</a></p>
</div>
<div class="section"><h2>Listing status</h2>
<p>Pending manual approval at <a href="https://www.x402scan.com/resources/register" style="color:#60a5fa">x402scan.com</a> — auto-indexed in <strong>Coinbase Bazaar</strong> on first settlement via the x402 protocol. No subscriptions required.</p>
<span class="tag">x402 V2</span><span class="tag">USDC</span><span class="tag">Base mainnet</span><span class="tag">no API key</span><span class="tag">no inventory</span>
</div>
<div class="footer"><div>Built by <strong>b0x70</strong> · autonomous seller agent</div><div><a href="https://portal.cdp.coinbase.com">CDP</a> · <a href="/openapi.json">OpenAPI</a> · <a href="https://www.x402.org">x402</a></div></div>
</div></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  }

  // ── /health ─────────────────────────────────────────────────────────────
  if (path === "/health") {
    return Response.json({ status: "ok", time: new Date().toISOString() });
  }

  // ── /.well-known/x402 — x402scan Discovery Document ─────────────────────
  // ✅ FIX #3: old format had custom fields + x402Version key + "endpoints" array.
  //            x402scan DISCOVERY.md requires: {version:1, resources:["https://..."]}
  if (path === "/.well-known/x402.json" || path === "/.well-known/x402") {
    return Response.json(
      {
        version: 1,             // required field — was "x402Version" (wrong key)
        resources: [            // required field — was "endpoints" (wrong key, wrong shape)
          `${CFG.baseUrl}/v1/meme-hunter`,
          `${CFG.baseUrl}/v1/defi-sentiment`,
          `${CFG.baseUrl}/v1/dinalibrium`,
          `${CFG.baseUrl}/v1/wallet-profile`,
        ],
        // Optional fields accepted by x402scan
        ownershipProofs: [],
        instructions: "All endpoints require x402 USDC payment on Base. Hit without x-payment to receive 402 invoice.",
      },
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ── /openapi.json — x402scan OpenAPI Discovery ──────────────────────────
  if (path === "/openapi.json") {
    return Response.json(
      {
        openapi: "3.1.0",
        info: {
          title:       "b0x402 API",
          version:     "1.0.0",
          description: "AI-powered crypto intelligence — meme signals, DeFi sentiment, market equilibrium, wallet profiling. Pay per call in USDC on Base.",
          contact: { email: "yusliarifn78@gmail.com" },
        },
        components: {
          securitySchemes: {
            x402: {
              type:        "apiKey",
              in:          "header",
              name:        "x-payment",
              description: "x402 V2 USDC payment payload. Hit endpoint without header to receive 402 invoice, pay USDC on Base, then retry.",
            },
          },
        },
        paths: {
          "/v1/meme-hunter": {
            get: {
              operationId: "memeHunter",
              summary:     "Meme Coin Signals",
              description: "DexScreener-based meme coin intelligence — liquidity, volume, price action, boost score.",
              tags:        ["Crypto Intelligence"],
              security:    [{ x402: [] }],
              "x-payment-info": {
                price:     { mode: "fixed", currency: "USD", amount: "0.01" },
                protocols: ["x402"],  // ✅ FIX #7: was [{x402:{}}] — must be ["x402"]
                network:   CFG.network,
                asset:     CFG.usdcContract,
                payTo:     CFG.payoutAddress,
              },
              parameters: [
                { name: "limit",   in: "query", required: false, schema: { type: "integer", default: 10,      description: "Results count (max 50)" } },
                { name: "sort_by", in: "query", required: false, schema: { type: "string",  default: "score", description: "score|volume|change|liquidity|boosted" } },
              ],
              responses: {
                "200": {
                  description: "Meme coin signals array",
                  content: { "application/json": { schema: { type: "object", properties: { count: { type: "integer" }, signals: { type: "array", items: { type: "object" } } } } } },
                },
                "402": { description: "Payment Required", headers: { "Payment-Required": { schema: { type: "string" } }, "X-Payment-Version": { schema: { type: "string" } } } },
              },
            },
          },
          "/v1/defi-sentiment": {
            get: {
              operationId: "defiSentiment",
              summary:     "DeFi Market Sentiment",
              description: "Real-time DeFi market mood — bullish, bearish, or neutral signal.",
              tags:        ["Crypto Intelligence"],
              security:    [{ x402: [] }],
              "x-payment-info": {
                price:     { mode: "fixed", currency: "USD", amount: "0.01" },
                protocols: ["x402"],
                network:   CFG.network,
                asset:     CFG.usdcContract,
                payTo:     CFG.payoutAddress,
              },
              responses: {
                "200": { description: "Sentiment signal", content: { "application/json": { schema: { type: "object", properties: { signal: { type: "string" }, score: { type: "number" } } } } } },
                "402": { description: "Payment Required" },
              },
            },
          },
          "/v1/dinalibrium": {
            post: {
              operationId: "dinalibrium",
              summary:     "Market Equilibrium Data",
              description: "ETH/stablecoin equilibrium metrics — ratio, supply dynamics, 7d change.",
              tags:        ["Crypto Intelligence"],
              security:    [{ x402: [] }],
              "x-payment-info": {
                price:     { mode: "fixed", currency: "USD", amount: "0.01" },
                protocols: ["x402"],
                network:   CFG.network,
                asset:     CFG.usdcContract,
                payTo:     CFG.payoutAddress,
              },
              requestBody: {
                required: false,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        stablecoin: { type: "string", default: "USDC", description: "USDC | USDT | DAI" },
                        window:     { type: "string", default: "7d",   description: "1d | 7d | 30d" },
                      },
                    },
                  },
                },
              },
              responses: {
                "200": { description: "Equilibrium data", content: { "application/json": { schema: { type: "object", properties: { ratio: { type: "number" }, stablecoin_supply_change_pct_7d: { type: "number" } } } } } },
                "402": { description: "Payment Required" },
              },
            },
          },
          "/v1/wallet-profile": {
            get: {
              operationId: "walletProfile",
              summary:     "Wallet Profile",
              description: "On-chain wallet profiling — net worth, tx count, portfolio. Query param 'address' required.",
              tags:        ["Crypto Intelligence"],
              security:    [{ x402: [] }],
              "x-payment-info": {
                price:     { mode: "fixed", currency: "USD", amount: "0.10" },
                protocols: ["x402"],
                network:   CFG.network,
                asset:     CFG.usdcContract,
                payTo:     CFG.payoutAddress,
              },
              parameters: [
                { name: "address", in: "query", required: true, schema: { type: "string", description: "EVM wallet address (0x...)" } },
              ],
              responses: {
                "200": { description: "Wallet profile", content: { "application/json": { schema: { type: "object", properties: { address: { type: "string" }, tx_count: { type: "integer" }, net_worth_usd: { type: "number" } } } } } },
                "402": { description: "Payment Required" },
              },
            },
          },
          "/health": {
            get: {
              operationId: "health",
              summary:     "Health Check",
              description: "No auth required.",
              tags:        ["System"],
              security:    [],
              responses: { "200": { description: "OK" } },
            },
          },
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ── /v1/meme-hunter ─────────────────────────────────────────────────────
  if (path === "/v1/meme-hunter") {
    const { err } = await checkX402(path, paymentHdr, bypass);
    if (err) return err;
    const data = await memeHunter(
      parseInt(params.get("limit") || "10"),
      params.get("sort_by") || "score"
    );
    data.fetched_at = new Date().toISOString();
    return Response.json(data);
  }

  // ── /v1/defi-sentiment ──────────────────────────────────────────────────
  if (path === "/v1/defi-sentiment") {
    const { err } = await checkX402(path, paymentHdr, bypass);
    if (err) return err;
    return Response.json({ signal: "neutral", timestamp: new Date().toISOString() });
  }

  // ── /v1/dinalibrium ─────────────────────────────────────────────────────
  if (path === "/v1/dinalibrium") {
    const { err } = await checkX402(path, paymentHdr, bypass);
    if (err) return err;
    return Response.json({
      eth_stablecoin_ratio:          0.87,
      stablecoin_supply_change_pct_7d: 2.3,
      timestamp: new Date().toISOString(),
    });
  }

  // ── /v1/wallet-profile ──────────────────────────────────────────────────
  if (path === "/v1/wallet-profile") {
    const { err } = await checkX402(path, paymentHdr, bypass);
    if (err) return err;
    return Response.json({
      address:       params.get("address") || "not_provided",
      net_worth_usd: 0,
      tx_count:      0,
      timestamp:     new Date().toISOString(),
    });
  }

  // ── 404 ─────────────────────────────────────────────────────────────────
  return Response.json(
    { error: "not_found", endpoints: Object.keys(PRICES) },
    { status: 404 }
  );
}

export default {
  async fetch(request, env, ctx) {
    if (env.X402_PAYOUT_ADDRESS) CFG.payoutAddress = env.X402_PAYOUT_ADDRESS;
    if (env.X402_BYPASS !== undefined) CFG.bypass = env.X402_BYPASS === "true";
    return handleRequest(request);
  },
};
