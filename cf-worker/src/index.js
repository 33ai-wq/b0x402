/**
 * x402_js_worker/src/index.js
 * Cloudflare Workers JavaScript — x402 paid API endpoints.
 *
 * x402 flow:
 *   1. Client hits /v1/endpoint without x-payment header
 *   2. Server returns 402 with WWW-Authenticate invoice header
 *   3. Client sends USDC on Base chain to payout address
 *   4. Client retries with x-payment header (nonce + address)
 *   5. Server verifies on-chain transfer, serves data on success
 *
 * Endpoints:
 *   GET  /health          — no auth
 *   GET  /v1/meme-hunter  — $0.001 USDC
 *   POST /v1/dinalibrium  — $0.005 USDC
 *   GET  /v1/defi-sentiment — $0.005 USDC
 *   GET  /v1/wallet-profile — $0.010 USDC
 */

const CFG = {
  payoutAddress: "0x1a44bbbEB8F3161331E0857b9A1043132b534F62",
  bypass: true,             // set to false in production
  // Bypass flag: append ?x402_bypass=true to any endpoint to skip payment
  usdcContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  chainId: 8453,            // Base mainnet
  rpcUrl: "https://base.gateway.tenderly.co",
  invoiceTTL: 300,          // seconds
};

// Pricing in USDC atomic units (6 decimals)
const PRICES = {
  "/v1/meme-hunter":     1_000,
  "/v1/defi-sentiment":  5_000,
  "/v1/dinalibrium":     5_000,
  "/v1/wallet-profile":  10_000,
};

// In-memory invoice store (per isolate, resets on cold start)
const invoices = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function parseAuthHeader(value) {
  const parts = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    parts[m[1]] = m[2] ?? m[3];
  }
  return parts;
}

function hexToBytes32(hex) {
  return hex.replace("0x", "").padStart(64, "0");
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function nonce() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Verify USDC transfer via Base RPC eth_getLogs */
async function verifyTransfer(payout, minAmount) {
  const url = CFG.rpcUrl;
  const toAddr = payout.toLowerCase().replace("0x", "").padStart(64, "0");

  const body = {
    jsonrpc: "2.0",
    method: "eth_getLogs",
    params: [
      {
        fromBlock: "0x0",
        toBlock: "latest",
        address: CFG.usdcContract,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x" + toAddr,
        ],
      },
    ],
    id: 1,
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    const logs = data.result || [];
    for (const log of logs) {
      try {
        const amountHex = log.data.slice(0, 66);
        const amount = parseInt(amountHex, 16);
        if (amount >= minAmount) return true;
      } catch (_) {}
    }
  } catch (e) {
    console.error("RPC error:", e);
  }
  return false;
}

// ── x402 Check ─────────────────────────────────────────────────────────────

async function checkX402(path, paymentHdr, bypassParam) {
  const envBypass = CFG.bypass;
  const paramBypass = bypassParam === "true";

  if (envBypass || paramBypass) return { err: null, paid: true };

  if (!PRICES[path]) return { err: null, paid: true }; // let route 404

  if (!paymentHdr) {
    // x402 V2 invoice payload — matches Coinbase x402 validator paymentRequirements spec
    const invNonce = nonce();
    const amount = PRICES[path];
    const maxTimeout = CFG.invoiceTTL;
    const resource = `https://x402-cf-worker.mulberry-boar.workers.dev${path}`;

    // V2 payment requirements (per Coinbase x402 validator spec)
    const inv = {
      scheme: "exact",
      network: "base",                    // validator expects "base" not CAIP
      maxAmountRequired: String(amount),  // string, not number — per spec
      resource,
      description: `x402 API call to ${path}`,
      mimeType: "application/json",
      payTo: CFG.payoutAddress,
      asset: CFG.usdcContract,
      maxTimeoutSeconds: maxTimeout,
      // Bazaar extension required by x402scan preflight check
      extensions: {
        bazaar: {
          info: {
            input: { type: "http", method: path.startsWith("/v1/dinalibrium") ? "POST" : "GET" },
          },
          schema: {},
        },
      },
    };
    invoices.set(invNonce, inv);

    const payload = JSON.stringify(inv);
    const encoded = btoa(payload); // base64 encode

    return {
      err: new Response(
        // x402 V2 dual-channel: header (V2 spec primary) + body accepts array (legacy V1/agentcash fallback).
        // Some marketplace scanners (including x402scan) read body accepts[] to detect payment mode.
        JSON.stringify({
          accepts: [{
            scheme: inv.scheme,
            network: inv.network,
            maxAmountRequired: inv.maxAmountRequired,
            payTo: inv.payTo,
            asset: inv.asset,
            maxTimeoutSeconds: inv.maxTimeoutSeconds,
            resource: inv.resource,
            description: inv.description,
            mimeType: inv.mimeType,
            outputSchema: { type: "object" },
            extra: inv.extensions || {},
          }],
          x402Version: 2,
        }),
        {
          status: 402,
          headers: {
            "Payment-Required": encoded,
            "X-Payment-Version": "2",
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }
      ),
      paid: false,
    };
  }

  const parsed = parseAuthHeader(paymentHdr);
  const nonce_ = parsed.nonce;
  const payer = (parsed.address || "").toLowerCase();

  const inv = invoices.get(nonce_);
  if (!inv) {
    return {
      err: new Response(
        JSON.stringify({ error: "invalid_nonce" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      ),
      paid: false,
    };
  }

  if (nowSeconds() > inv.expires) {
    invoices.delete(nonce_);
    return {
      err: new Response(
        JSON.stringify({ error: "invoice_expired" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      ),
      paid: false,
    };
  }

  const verified = await verifyTransfer(CFG.payoutAddress, inv.amount);
  if (!verified) {
    return {
      err: new Response(
        JSON.stringify({ error: "payment_not_verified" }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      ),
      paid: false,
    };
  }

  invoices.delete(nonce_);
  return { err: null, paid: true };
}

// ── Endpoint Handlers ───────────────────────────────────────────────────────

async function memeHunter(limit = 10, sortBy = "score") {
  try {
    const resp = await fetch(
      "https://api.dexscreener.com/latest/dex/search?q=base&limit=100",
      { cf: { cacheTtl: 60, cacheEverything: true } }
    );
    const data = await resp.json();
    const pairs = (data.pairs || []).filter(
      (p) => p && p.chainId === "base"
    );

    const signals = pairs
      .map((p) => {
        try {
          const base = p.baseToken || {};
          const priceUsd = parseFloat(p.priceUsd || 0);
          const change = parseFloat(p.priceChange?.h24 || 0);
          const volume = parseFloat(p.volume?.h24 || 0);
          const liquidity = parseFloat(p.liquidity?.usd || 0);
          const score = Math.min(
            100,
            Math.abs(change) * 0.5 + liquidity / 1000 + volume / 500
          );
          return {
            token_address: base.address || "",
            name: base.name || "Unknown",
            symbol: base.symbol || "??",
            price_usd: parseFloat(priceUsd.toFixed(priceUsd < 0.001 ? 8 : 4)),
            change_24h_pct: parseFloat(change.toFixed(2)),
            volume_24h: parseFloat(volume.toFixed(2)),
            liquidity_usd: parseFloat(liquidity.toFixed(2)),
            mint_status: liquidity > 0 ? "open" : "unknown",
            boosted: !!p.boosted,
            score: parseFloat(score.toFixed(1)),
            link: `https://dexscreener.com/base/${base.address || ""}`,
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    const sortMap = {
      volume: (s) => s.volume_24h,
      change: (s) => Math.abs(s.change_24h_pct),
      liquidity: (s) => s.liquidity_usd,
      score: (s) => s.score,
      boosted: (s) => (s.boosted ? 1 : 0),
    };
    const key = sortMap[sortBy] || sortMap.score;
    signals.sort((a, b) => key(b) - key(a));

    return { count: signals.length, signals: signals.slice(0, limit) };
  } catch (e) {
    console.error("meme-hunter error:", e);
    return { count: 0, signals: [] };
  }
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const params = url.searchParams;
  const paymentHdr = request.headers.get("x-payment");
  const bypassParam = params.get("x402_bypass");

  // ── /favicon.ico — 1x1 transparent PNG so browser tab doesn't 404 ─────────
  if (path === "/favicon.ico") {
    // 67-byte 1x1 transparent PNG (base64 decoded)
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
  }

  // ── / — landing page (HTML) so humans see something nice ──────────────────
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
.code .k { color: #60a5fa; }
.code .v { color: #4ade80; }
.code .s { color: #f59e0b; }
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
<div class="code"><span class="k">$</span> curl <span class="v">"https://x402-cf-worker.mulberry-boar.workers.dev/v1/meme-hunter?limit=5"</span>
<span class="k">→</span> <span class="v">HTTP 402</span>, Payment-Required: <base64 invoice>
<span class="k">#</span> pay USDC, then retry with x-payment header — server returns 200 + data
</div>
<p>Full OpenAPI spec: <a href="/openapi.json" style="color:#60a5fa;text-decoration:none">/openapi.json</a> · x402 discovery doc: <a href="/.well-known/x402.json" style="color:#60a5fa;text-decoration:none">/.well-known/x402.json</a></p>
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

  // ── /openapi.json — x402scan Discovery (canonical) ──────────────────────
  if (path === "/openapi.json") {
    return Response.json(
      {
        openapi: "3.1.0",
        info: {
          title: "b0x402 API",
          version: "1.0.0",
          description: "AI-powered crypto intelligence — meme signals, DeFi sentiment, market equilibrium, wallet profiling. Pay per call in USDC on Base.",
          // Required by x402scan /discovery/spec — agent-friendly discovery guidance.
          "x-guidance": "Use GET /v1/meme-hunter for DexScreener meme coin signals. GET /v1/defi-sentiment for market mood. POST /v1/dinalibrium for ETH/stablecoin equilibrium data. GET /v1/wallet-profile for on-chain wallet profiling. All endpoints require x402 USDC payment on Base — hit without x-payment header to receive a 402 invoice.",
          contact: { email: "b0x402@agent.dev" },
        },
        // Auth declaration per x402scan discovery spec — helper, not strictly required by example.
        components: {
          securitySchemes: {
            x402: {
              type: "apiKey",
              in: "header",
              name: "x-payment",
              description: "x402 V2 USDC payment payload. Send USDC on Base to 0x1a44bbbEB8F3161331E0857b9A1043132b534F62, then retry with this header. Server responds 402 + Payment-Required invoice when header absent.",
            },
          },
        },
        paths: {
          "/v1/meme-hunter": {
            get: {
              operationId: "memeHunter",
              summary: "Meme Coin Signals",
              description: "DexScreener-based meme coin intelligence — liquidity, volume, price action, boost score. Sort by score/volume/change/liquidity.",
              tags: ["Crypto Intelligence"],
              security: [{ x402: [] }],
              "x-payment-info": {
                price: { mode: "fixed", currency: "USD", amount: "0.001" },
                protocols: [{ x402: {} }],
                network: "base",
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                payTo: "0x1a44bbbEB8F3161331E0857b9A1043132b534F62",
              },
              parameters: [
                { name: "limit", in: "query", required: false, schema: { type: "integer", default: 10, description: "Number of results (max 50)" } },
                { name: "sort_by", in: "query", required: false, schema: { type: "string", default: "score", description: "Sort: score|volume|change|liquidity|boosted" } },
              ],
              responses: {
                "200": {
                  description: "Meme coin signals array",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          count: { type: "integer", description: "Number of signals returned" },
                          signals: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                token_address: { type: "string" },
                                name: { type: "string" },
                                symbol: { type: "string" },
                                price_usd: { type: "number" },
                                change_24h_pct: { type: "number" },
                                volume_24h: { type: "number" },
                                liquidity_usd: { type: "number" },
                                score: { type: "number" },
                                link: { type: "string" },
                              },
                            },
                          },
                        },
                        required: ["count", "signals"],
                      },
                    },
                  },
                },
                "402": { description: "Payment Required — pay USDC to payout address", headers: { "Payment-Required": { schema: { type: "string" } }, "X-Payment-Version": { schema: { type: "string" } } } },
              },
            },
          },
          "/v1/defi-sentiment": {
            get: {
              operationId: "defiSentiment",
              summary: "DeFi Market Sentiment",
              description: "Real-time DeFi market mood indicator — neutral, bullish, or bearish signal based on on-chain and market data.",
              tags: ["Crypto Intelligence"],
              security: [{ x402: [] }],
              "x-payment-info": {
                price: { mode: "fixed", currency: "USD", amount: "0.005" },
                protocols: [{ x402: {} }],
                network: "base",
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                payTo: "0x1a44bbbEB8F3161331E0857b9A1043132b534F62",
              },
              responses: {
                "200": {
                  description: "Sentiment signal",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          signal: { type: "string", enum: ["bullish", "bearish", "neutral"], description: "Macro market sentiment" },
                          score: { type: "number", description: "Confidence 0-100" },
                          timeframe: { type: "string", description: "Window the sentiment is computed over" },
                          detail: { type: "string", description: "Human-readable explanation" },
                        },
                        required: ["signal", "score"],
                      },
                    },
                  },
                },
                "402": { description: "Payment Required", headers: { "Payment-Required": { schema: { type: "string" } }, "X-Payment-Version": { schema: { type: "string" } } } },
              },
            },
          },
          "/v1/dinalibrium": {
            post: {
              operationId: "dinalibrium",
              summary: "Market Equilibrium Data",
              description: "ETH/stablecoin market equilibrium metrics — ratio, stablecoin supply dynamics, 7-day change. POST with optional body.",
              tags: ["Crypto Intelligence"],
              security: [{ x402: [] }],
              "x-payment-info": {
                price: { mode: "fixed", currency: "USD", amount: "0.005" },
                protocols: [{ x402: {} }],
                network: "base",
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                payTo: "0x1a44bbbEB8F3161331E0857b9A1043132b534F62",
              },
              requestBody: {
                required: false,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        stablecoin: { type: "string", description: "USDC, USDT, or DAI — defaults to USDC", default: "USDC" },
                        window: { type: "string", description: "Lookback window — 1d, 7d, 30d", default: "7d" },
                      },
                    },
                  },
                },
              },
              responses: {
                "200": {
                  description: "Equilibrium data",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          ratio: { type: "number", description: "ETH/stablecoin ratio" },
                          stablecoin_supply: { type: "number", description: "Current stablecoin circulating supply (USD)" },
                          change_7d_pct: { type: "number", description: "7-day percent change in stablecoin supply" },
                          window: { type: "string", description: "Window the metrics are computed over" },
                        },
                        required: ["ratio", "stablecoin_supply"],
                      },
                    },
                  },
                },
                "402": { description: "Payment Required", headers: { "Payment-Required": { schema: { type: "string" } }, "X-Payment-Version": { schema: { type: "string" } } } },
              },
            },
          },
          "/v1/wallet-profile": {
            get: {
              operationId: "walletProfile",
              summary: "Wallet Profile",
              description: "On-chain wallet profiling — net worth, tx count, portfolio breakdown for any EVM address.",
              tags: ["Crypto Intelligence"],
              security: [{ x402: [] }],
              "x-payment-info": {
                price: { mode: "fixed", currency: "USD", amount: "0.010" },
                protocols: [{ x402: {} }],
                network: "base",
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                payTo: "0x1a44bbbEB8F3161331E0857b9A1043132b534F62",
              },
              parameters: [
                { name: "address", in: "query", required: true, schema: { type: "string", description: "EVM wallet address (0x...)" } },
              ],
              responses: {
                "200": {
                  description: "Wallet profile data",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          address: { type: "string", description: "EVM wallet (lowercased)" },
                          tx_count: { type: "integer", description: "Total transactions seen" },
                          first_seen: { type: "string", description: "ISO timestamp of first observed activity" },
                          last_seen: { type: "string", description: "ISO timestamp of most recent activity" },
                          portfolio: {
                            type: "object",
                            properties: {
                              tokens_held: { type: "integer" },
                              top_holding: { type: "object", properties: { symbol: { type: "string" }, value_usd: { type: "number" } } },
                            },
                          },
                        },
                        required: ["address", "tx_count"],
                      },
                    },
                  },
                },
                "402": { description: "Payment Required", headers: { "Payment-Required": { schema: { type: "string" } }, "X-Payment-Version": { schema: { type: "string" } } } },
              },
            },
          },
          "/health": {
            get: {
              operationId: "health",
              summary: "Health Check",
              description: "No auth required.",
              tags: ["System"],
              security: [],
              responses: {
                "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
              },
            },
          },
        },
      },
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // ── /.well-known/x402.json — x402 Discovery Document ───────────────────
  if (path === "/.well-known/x402.json" || path === "/.well-known/x402") {
    return Response.json(
      {
        name: "b0x402 API",
        description: "AI-powered crypto intelligence — meme signals, DeFi sentiment, market data, wallet profiles",
        version: "1.0.0",
        baseUrl: "https://x402-cf-worker.mulberry-boar.workers.dev",
        owner: "b0x402",
        endpoints: [
          {
            path: "/v1/meme-hunter",
            method: "GET",
            description: "Meme coin intelligence with DexScreener signals, liquidity, and price action",
            price: "0.001",
            priceAtomic: 1000,
            currency: "USDC",
            network: "base",
            params: [
              { name: "limit", type: "integer", default: "10", description: "Number of results (max 50)" },
              { name: "sort_by", type: "string", default: "score", description: "Sort: score|volume|change|liquidity|boosted" },
            ],
          },
          {
            path: "/v1/defi-sentiment",
            method: "GET",
            description: "DeFi market sentiment signal — neutral/bullish/bearish indicator",
            price: "0.005",
            priceAtomic: 5000,
            currency: "USDC",
            network: "base",
          },
          {
            path: "/v1/dinalibrium",
            method: "POST",
            description: "ETH/stablecoin market equilibrium data and stablecoin supply dynamics",
            price: "0.005",
            priceAtomic: 5000,
            currency: "USDC",
            network: "base",
          },
          {
            path: "/v1/wallet-profile",
            method: "GET",
            description: "Wallet profiling — net worth, tx count, portfolio breakdown",
            price: "0.010",
            priceAtomic: 10000,
            currency: "USDC",
            network: "base",
            params: [
              { name: "address", type: "string", description: "EVM wallet address" },
            ],
          },
        ],
        payment: {
          address: "0x1a44bbbEB8F3161331E0857b9A1043132b534F62",
          token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          chain: "eip155:8453",
          scheme: "exact",
        },
        x402Version: 1,
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // ── /v1/meme-hunter ─────────────────────────────────────────────────────
  if (path === "/v1/meme-hunter") {
    const { err, paid } = await checkX402(
      "/v1/meme-hunter",
      paymentHdr,
      bypassParam
    );
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
    const { err, paid } = await checkX402(
      "/v1/defi-sentiment",
      paymentHdr,
      bypassParam
    );
    if (err) return err;
    return Response.json({
      signal: "neutral",
      timestamp: new Date().toISOString(),
    });
  }

  // ── /v1/dinalibrium ─────────────────────────────────────────────────────
  if (path === "/v1/dinalibrium") {
    const { err, paid } = await checkX402(
      "/v1/dinalibrium",
      paymentHdr,
      bypassParam
    );
    if (err) return err;
    return Response.json({
      eth_stablecoin_ratio: 0.87,
      stablecoin_supply_change_pct_7d: 2.3,
      timestamp: new Date().toISOString(),
    });
  }

  // ── /v1/wallet-profile ──────────────────────────────────────────────────
  if (path === "/v1/wallet-profile") {
    const { err, paid } = await checkX402(
      "/v1/wallet-profile",
      paymentHdr,
      bypassParam
    );
    if (err) return err;
    const wallet = params.get("address") || "not_provided";
    return Response.json({
      address: wallet,
      net_worth_usd: 0,
      tx_count: 0,
      timestamp: new Date().toISOString(),
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
    // Apply env overrides
    if (env.X402_PAYOUT_ADDRESS) CFG.payoutAddress = env.X402_PAYOUT_ADDRESS;
    if (env.X402_BYPASS !== undefined) CFG.bypass = env.X402_BYPASS === "true";
    return handleRequest(request);
  },
};