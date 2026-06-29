# CI/CD — Auto-deploy CF Worker

GitHub Actions workflow that redeploys the Cloudflare Worker on every push to `main`, plus runs sanity checks against the live endpoint. Requires the **CF_API_TOKEN** to be set as a repository secret.

## Setup

1. Cloudflare API token (Workers Scripts: Edit scope):
   - dash.cloudflare.com → Profile → API Tokens → Create Token
   - Template: "Edit Cloudflare Workers"
   - Account Resources: account that owns `x402-cf-worker`
   - Copy token

2. In this GitHub repo:
   - Settings → Secrets and variables → Actions → New repository secret
   - Name: `CF_API_TOKEN`
   - Value: `<paste token>`

3. Account ID (also as secret or hardcode in workflow):
   - `CF_ACCOUNT_ID` = `b9f2219c5fc157dbab0250ea33e19e52`

What it does on each push to `main`:

- Checks out the repo
- Validates `cf-worker/src/index.js` syntax via Node parser
- Runs `wrangler deploy` to push to Cloudflare Workers
- Hits the live `/health` endpoint to confirm deploy succeeded
- Reports status back to GitHub commit

## Useful commands (off-CI)

```bash
# Manual deploy from local
cd cf-worker
export CLOUDFLARE_API_TOKEN='***'
npx wrangler deploy
unset CLOUDFLARE_API_TOKEN

# Tail logs
npx wrangler tail
```
