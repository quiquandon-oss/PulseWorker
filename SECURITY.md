# V1 security: findings, remediation and runbook (sec-v1, 2026-11-01)

## Findings (verified from code and repository state)

1. **No route authentication.**
   - `worker.js` checks no credential on any route. The 2026-08-11 gate was reverted in ef54a29.
   - **Open write and cost routes:** 15 POST routes write to D1, spend Workers AI or Gemini quota, or send Telegram
     messages. They include `/history`, `/backfill-sources`, `/txs-backup`, `/portfolio-log`, `/alert-configs*`,
     `/test-telegram`, `/gemini-outlook`, `/trader-analysis*`, `/whale-*` and `/liquidation-analysis`.
   - **Open private reads:** `GET /txs-backup` (the full transaction backup) and `GET /portfolio-history` return
     private financial data to anyone who knows the Worker URL. That URL is in the public page.
2. **Secrets in the public CryptoPulse page and its public git history**, since commit 8aa8b8f (2026-08-07). The
   repository is public, and GitHub Pages serves the repository root.
   - `APP_SECRET`: never enforced by the Worker. The header is ignored.
   - `FRED_KEY` (FRED API).
   - `CG_API_KEY` (CoinGecko).
   - `SOSO_API_KEY` (SoSoValue).
   - `ALERT_WRITE_SECRET`: shared secret of the Google Apps Script web app that stores DCA alert configuration.
3. **Deploys without tests.** `deploy.yml` deployed on every push to `main` without running the tests and without an
   approval step.

**Not verifiable from the development sandbox:**
- **Active exploitation.** There is no access to Cloudflare request logs or analytics, and the Worker host is blocked
  by the sandbox network policy. **Owner check:** Cloudflare dashboard → Workers → `sentiment-ff75` → Metrics/Logs.
  Look for requests to `/txs-backup`, `/portfolio-history` and the POST routes from user agents other than your
  browsers. Also check the Gemini and Workers AI usage graphs for unexplained spikes.

## Remediation in this change

- **Fail-closed route gate.** `V1_PROTECTED_ROUTES` (23 routes) require `X-V1-Token` equal to the `V1_ACCESS_TOKEN`
  secret, compared in constant time.
  - **Missing or weak secret** (fewer than 32 characters): every protected route answers **503** and runs nothing.
  - **Missing or wrong token:** **401**.
  - **Either way,** D1 and the network are never touched (tested).
  - **Also protected:** the routes that spend the owner's third-party quotas, `/macro-proxy` and `/api-proxy/*`.
  - **Still public:** `/history` GET, the news, stock, STRC and whale proxies, the `/foufi-*` reads, `/risk-regime`,
    `/hl-oi`, the `/alert-configs` and `/alert-log` reads, `/analysis` and `/security-status`.
- **Third-party keys are Worker secrets.** `/macro-proxy` uses `FRED_API_KEY` and ignores any client-supplied key when
  that secret is set. `/api-proxy/coingecko` and `/api-proxy/sosovalue` forward allowlisted upstream paths only,
  with `CG_API_KEY` and `SOSO_API_KEY`.
- **Tested deploys.** `deploy.yml` runs `npm test` before deploying.
- **Frontend (CryptoPulse #7).** The page ships no secret. It adds the per-device token only to protected routes.

**Consequence of fail-closed.** When the code deploys, every protected route refuses until the secret exists. The
release order below is therefore mandatory.

## Owner runbook

The exact commands, expected outputs and checks are in `RELEASE_V1.md`. In short:

1. **Rotate** the FRED, CoinGecko and SoSoValue keys and the Apps Script secret at each provider.
2. **Set the Worker secrets first:** `V1_ACCESS_TOKEN` (`openssl rand -hex 32`), `FRED_API_KEY`, `CG_API_KEY` and
   `SOSO_API_KEY`. The current code ignores them, so setting them first is harmless.
3. **Merge this PR.** The deploy runs the tests, then deploys.
4. **Check `/security-status`:** `route_auth` should read `enforced` and every `server_keys` entry should be `true`.
5. **Merge CryptoPulse #7,** then enter the token on each device under Settings → Device access.

## Rollback

- **Enforcement:** there is no "open" mode any more. Deleting `V1_ACCESS_TOKEN` *closes* every protected route.
  To undo the release, roll back the deployment (Cloudflare dashboard → Deployments → previous version, or
  `wrangler rollback`) or revert the merge commit.
- **Code:** revert the merge commit; the deploy runs the tests first.
