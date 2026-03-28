# Open Banking Chile

## For all Agents (Claude, Codex, Gemini, etc.)

### What this project does
Open source framework for extracting movements and balances from Chilean banks and investment platforms. Uses direct API calls (preferred) or Puppeteer browser automation (last resort). Includes a multi-user web dashboard deployed on Vercel with Google OAuth.

### Live deployment
- **Production URL**: https://open-banking-chile.vercel.app
- **Vercel project**: `open-banking-chile` (org: `rhonorato-ship-its-projects`)
- **Vercel project ID**: `prj_ovBTOzwEpedmlf6JILFlKtbf6hBN`
- **Deploy command**: run `vercel --prod` from repo root (not from `web/` — root dir is configured as `web` in Vercel settings)
- **npm package**: `open-banking-chile` (latest: v2.1.2, publisher: `rhonorato`)

### Supported institutions (13)

**API mode** (no browser needed — works on Vercel without Chromium):

Banks:
- Banco de Chile (`bchile`) — Spring Security login + REST API with XSRF cookie jar
- Banco Edwards (`edwards`) — delegates to bchile (same portal: `portalpersonas.bancochile.cl`)
- BCI (`bci`) — JSF form login with ViewState CSRF + HTML table parsing. Data endpoints need live testing.
- BancoEstado (`bestado`) — cookie jar auth. Akamai TLS fingerprint may block Node.js fetch; returns helpful error if blocked.
- BICE (`bice`) — Keycloak OIDC token exchange at `auth.bice.cl` + cookie jar. Data endpoints need live testing.
- Citibank (`citi`) — cookie jar login (ioBlackBox sent empty). REST at `/US/REST/accountsPanel/getCustomerAccounts.jws` + CSV download.
- Banco Falabella (`falabella`) — cookie jar auth + REST API for account and CMR credit card data. Endpoints need live testing.
- Itaú (`itau`) — WPS portal cookie jar + HTML parsing. Imperva may block; returns helpful error if blocked.
- Santander (`santander`) — cookie jar auth via login iframe endpoint + REST API. Multi-account + CC support.
- Scotiabank (`scotiabank`) — cookie jar auth + REST API. Historical periods via `SCOTIABANK_MONTHS` env var.

WealthTech:
- Fintual (`fintual`) — public REST API at `https://fintual.cl/api-docs`
- Racional (`racional`) — Firebase Auth (`racional-prod`) + Firestore REST API

PayTech:
- MercadoPago (`mercadopago`) — OAuth2 access token + public API at `api.mercadopago.com` (PayTech arm of MercadoLibre)

**Browser mode** (requires Puppeteer):

None — all institutions migrated to API mode. Some may fall back to requiring browser if anti-bot protections block Node.js fetch (BancoEstado/Akamai, Itaú/Imperva, BCI/JSF, Citi/ioBlackBox).

---

## Scraper strategy (API-first — MANDATORY)

**Chromium is a last resort.** Every bank, investment platform, and financial service should be scraped via API or CLI whenever possible. Do NOT default to opening a browser.

### Priority order (strict)

1. **Direct API (`fetch()`)** — The default. Check DevTools Network tab, Swagger docs, or mobile app traffic for REST/GraphQL endpoints. Use `runApiScraper()` from `src/infrastructure/api-runner.ts`. Set `mode: "api"` on the `BankScraper`. Zero browser dependencies.
   - Example: Fintual → `POST /api/access_tokens` + `GET /api/goals`
   - Example: Banco de Chile already uses in-browser `fetch()` for its API — should be migrated to direct API calls

2. **In-browser API calls** — If auth requires a browser but data comes from JSON APIs, log in with Puppeteer then call the APIs via `page.evaluate(fetch(...))`. This is an intermediate step toward full API migration.
   - Example: Banco de Chile currently does this (should be step 1 eventually)

3. **Browser with user's Chrome profile** — When a browser is truly needed (no API, complex JS rendering, 2FA/OAuth), use the user's real Chrome via `--profile` flag. This leverages existing cookies, sessions, and saved passwords — avoids bot detection entirely.

4. **Headless Chromium on Vercel** — Absolute last resort. Many banks block headless Chrome (Imperva, Incapsula, reCAPTCHA). Only use `@sparticuz/chromium` for banks proven to work headless.

### Before writing ANY scraper code

1. Open the bank/platform's website in Chrome DevTools → Network tab
2. Log in manually and observe the XHR/Fetch requests
3. Look for JSON API responses — these are your targets
4. Check for Swagger/OpenAPI docs (try `/api-docs`, `/swagger.json`, `/api/v1`)
5. Check if the platform has a mobile app — mobile APIs are often simpler and better documented
6. Only after confirming there is NO usable API should you consider browser automation

### 2FA requirements per institution

| Institution | 2FA Type | Code Format | Delivery | Automatable? |
|------------|----------|-------------|----------|-------------|
| Banco de Chile | Push / SMS | 6 digits | Mobile app or SMS | Push: wait only. SMS: enter code |
| BCI | Push (BCI Pass) | — | Mobile app | Wait only — no code entry |
| BancoEstado | SMS | 6 digits | SMS | Enter code |
| BICE | Push / SMS | 6 digits | Mobile app or SMS | Depends on user config |
| Citi | SMS / Email | 6 digits | SMS or email | Enter code |
| Falabella | SMS | 4-6 digits | SMS | Enter code |
| Fintual | None | — | — | Fully automated (API token) |
| Itaú | Push (Itaú Key) | — | Mobile app | Wait only — no code entry |
| MercadoPago | Email / QR / Facial | 6 digits (email) | Email, QR, or face scan | Email: enter code. QR/facial: manual only |
| Racional | Email OTP | 6 digits | Email | Enter code (sent to registered email) |
| Santander | Push | — | Mobile app | Wait only |
| Scotiabank | Dynamic key | 6 digits | Token device or SMS | Enter code |

**Web app 2FA flow**: When a scraper requests a code, the SSE endpoint sends `requires_2fa: true`. The frontend shows a code input field. The user types the code and submits it to `POST /api/2fa`, which writes to the `pending_2fa` Supabase table. The SSE route polls this table every 2 seconds for up to 90 seconds.

### Institutions with anti-bot protections (may block API mode)

All banks are now API mode, but these have anti-bot measures that may block Node.js `fetch()`. Their scrapers detect the block and return helpful error messages suggesting `--profile` as fallback:

- **Itaú** — Imperva bot protection. Scraper detects "No pudimos validar tu acceso" and suggests `--profile`.
- **BancoEstado** — Akamai TLS fingerprinting. Scraper detects 403/captcha and suggests `--headful --profile`.
- **Citi** — ThreatMetrix ioBlackBox. Scraper sends empty ioBlackBox; if login fails, suggests browser mode.
- **BCI** — JSF ViewState. Server-rendered portal may reject non-browser requests.

### Key files

- `src/infrastructure/api-runner.ts` — Browser-free runner for API scrapers
- `src/infrastructure/scraper-runner.ts` — Browser-based runner (use only when necessary)
- `src/infrastructure/browser.ts` — Puppeteer launch with `userDataDir` support

### Discovered API patterns (verbatim reference)

Use this section when debugging or extending any API-mode scraper. These details were confirmed via DevTools inspection and live testing.

#### Fintual (`mode: "api"`)
- **Auth**: `POST https://fintual.cl/api/access_tokens` with `{ user: { email, password } }` → `{ data: { attributes: { token, email } } }`
- **Data**: `GET https://fintual.cl/api/goals` with headers `X-User-Email` + `X-User-Token`
- **Response**: `{ data: [{ id, type: "goal", attributes: { name, nav } }] }` — `nav` is portfolio value in CLP
- **Docs**: Swagger at `https://fintual.cl/api-docs/v1/swagger.json`
- **Credential mapping**: `rut` field = email address, `password` field = password

#### Banco de Chile (`mode: "api"`)
- **Auth**: Spring Security form-login. Cookie jar pattern with `JSESSIONID` + `XSRF-TOKEN` (Angular double-submit cookie)
- **Login POST**: `https://login.portal.bancochile.cl/bancochile-web/persona/login/index.html` with `userRut` + `userPassword` + `_csrf` as `application/x-www-form-urlencoded`. Use `redirect: "manual"` to capture Set-Cookie from 302.
- **XSRF**: Cookie `XSRF-TOKEN` (URL-encoded) → decode and send as header `X-XSRF-TOKEN` on every API call
- **API base**: `https://portalpersonas.bancochile.cl/mibancochile/rest/persona`
- **Key endpoints** (all require `Cookie` + `X-XSRF-TOKEN` headers):
  - `GET selectorproductos/selectorProductos/obtenerProductos?incluirTarjetas=true` — list all accounts + cards
  - `GET bff-ppersonas-clientes/clientes/` — client name and RUT
  - `GET bff-pp-prod-ctas-saldos/productos/cuentas/saldos` — account balances
  - `POST bff-pper-prd-cta-movimientos/movimientos/getCartola` — paginated account movements
  - `POST tarjetas/widget/informacion-tarjetas` — list credit cards
  - `POST tarjeta-credito-digital/saldo/obtener-saldo` — card balance/limits
  - `POST tarjeta-credito-digital/movimientos-no-facturados` — unbilled CC movements
  - `POST tarjetas/estadocuenta/fechas-facturacion` — billing dates
  - `POST tarjetas/estadocuenta/nacional/resumen-por-fecha` — billed national CC movements
  - `POST tarjetas/estadocuenta/internacional/resumen-por-fecha` — billed international CC movements

#### Banco Edwards (`mode: "api"`)
- **Same portal as Banco de Chile** — delegates to `bchile.scrape()` and rebrands the result
- Uses identical API endpoints, login flow, and XSRF pattern

#### MercadoPago (`mode: "api"`)
- **Auth**: OAuth2 personal access token (`APP_USR-...`) from `mercadopago.cl/developers/panel/app`
- **No username/password login API exists** — the token must be pre-generated by the user
- **API base**: `https://api.mercadopago.com` — all requests use `Authorization: Bearer {token}`
- **Key endpoints**:
  - `GET /users/me` — user profile (id, site_id, email)
  - `GET /users/{id}/mercadopago_account/balance` — wallet balance
  - `GET /v1/payments/search?collector.id={id}&sort=date_created&criteria=desc` — payments received (paginated)
  - `POST /v1/account/settlement_report` + `GET /v1/account/settlement_report/{file}` — CSV movement report
- **Limitation**: API is seller/merchant-oriented. Buyer-only accounts may return 0 movements.
- **Token refresh**: `POST /oauth/token` with `grant_type=refresh_token` + `MERCADOPAGO_CLIENT_ID` + `MERCADOPAGO_CLIENT_SECRET` env vars
- **Credential mapping**: `rut` field = unused (can be blank), `password` field = `APP_USR-...` access token

#### Racional (`mode: "api"`)
- **Auth**: Firebase Authentication (project: `racional-prod`)
  - API key: `AIzaSyCHCBAaUWhTc8mGtyqfahJ4cYpeVACoCJk`
  - `POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}` with `{ email, password, returnSecureToken: true }`
  - Returns `{ idToken, refreshToken, localId }` — `idToken` is a JWT valid for 1 hour
  - Token refresh: `POST https://securetoken.googleapis.com/v1/token?key={API_KEY}` with `grant_type=refresh_token`
- **Data**: Firestore at `projects/racional-prod/databases/(default)/documents`
  - User doc: `users/{localId}` — portfolio data may be embedded as fields
  - Business constants: `businessConstants/generalConstants`, `businessConstants/portfolioConstants`, `businessConstants/portfolioLabels`
  - Uses Firestore REST API: `GET https://firestore.googleapis.com/v1/projects/racional-prod/databases/(default)/documents/{path}` with `Authorization: Bearer {idToken}`
- **Credential mapping**: `rut` field = email address, `password` field = password
- **2FA**: Firebase may enforce MFA (returns `MISSING_MFA` error). Email OTP handled via `onTwoFactorCode` callback.

#### BICE (browser mode — migration candidate)
- **Auth**: Keycloak OIDC at `auth.bice.cl/auth/realms/personas/protocol/openid-connect/auth`
- **Direct portal**: `https://portalpersonas.bice.cl` triggers Keycloak redirect (skips homepage 403)
- **Keycloak form**: `#username` + `#password` + `#kc-login` (standard Keycloak IDs)
- **Migration path**: Keycloak token exchange via `POST /auth/realms/personas/protocol/openid-connect/token` could replace browser login

#### Citibank (browser mode — partially API)
- **Has REST endpoints**: `POST /US/REST/accountsPanel/getCustomerAccounts.jws`, CSV download at `/US/NCSC/dcd/StatementDownload.do`
- **Blocker**: ThreatMetrix `ioBlackBox` device fingerprinting required before login submission
- **Migration path**: If `ioBlackBox` can be generated without a browser, full API migration is possible

---

## Project structure

```
src/
  index.ts                 — Registry of all banks, getBank(), listBanks()
  types.ts                 — BankScraper interface, BankMovement, ScrapeResult, ScraperOptions
  utils.ts                 — Shared utilities (formatRut, findChrome, parseChileanAmount, normalizeDate, etc.)
  cli.ts                   — CLI entry point (--bank, --list, --pretty, --movements)
  infrastructure/
    browser.ts             — Centralized browser launch, session management, anti-detection, userDataDir
    scraper-runner.ts      — Browser-based execution pipeline: validate → launch → scrape → logout → cleanup
    api-runner.ts          — API-based execution pipeline: validate → fetch → return (no browser)
    cookies.ts             — Session cookie persistence (save/load to filesystem for CLI, /tmp for Lambda)
  actions/
    login.ts               — Generic login (RUT formats, password, submit, error detection)
    navigation.ts          — DOM navigation (click by text, sidebars, banner dismissal)
    extraction.ts          — Movement extraction from HTML tables with fallbacks
    pagination.ts          — Multi-page iteration (Siguiente, Ver más)
    credit-card.ts         — Credit card movement extraction (tabs, billing periods)
    balance.ts             — Balance extraction (regex + CSS selector fallbacks)
    two-factor.ts          — 2FA detection and wait (configurable keywords/timeout)
  banks/
    All 13 scrapers are API mode (fetch-only, no Puppeteer):
    bchile.ts, edwards.ts, fintual.ts, mercadopago.ts, racional.ts,
    bci.ts, bestado.ts, bice.ts, citi.ts, falabella.ts,
    itau.ts, santander.ts, scotiabank.ts

web/                       — Next.js 15 multi-user dashboard (App Router), deployed on Vercel
  app/
    dashboard/             — Balance hero, bank cards with skeleton loaders, sync buttons, toast notifications
    banks/                 — Add / edit / remove bank credentials (self-contained BankRow, inline delete confirm)
    movements/             — Transaction history: text search, sortable columns, pagination (50/page), monthly chart
    analytics/             — Filter bar, summary totals, time-series chart, bank comparison, category breakdown, spending heatmap
    login/                 — Google OAuth sign-in
    api/
      banks/               — CRUD for encrypted bank credentials
      movements/           — Query movements with filters (bankId, from, to); enriched with category + isInternalTransfer
      analytics/           — Pre-aggregated time-series, category breakdown, bank comparison, heatmap (filters: bankId, from, to)
      dashboard-summary/   — Current-month spend/income/net, transfer count, top-5 categories, last-6-month series
      coach/               — Rule-based financial recommendations (top category, savings pressure, transfer ratio)
      drive/               — POST: export all movements as XLSX to Google Drive; returns { url, name }
      scrape/[bankId]/     — SSE endpoint: runs scraper, streams progress phases
  components/
    ScrapeProgress.tsx     — Full-screen phase animation; retry re-initialises SSE (no page reload)
  lib/
    auth.ts                — Auth.js v5 (Google OAuth, JWT) + Supabase user upsert on sign-in
    auth.config.ts         — Edge-compatible auth config (used by middleware)
    db.ts                  — Supabase HTTP client (@supabase/supabase-js, PostgREST — no TCP connection)
    credentials.ts         — AES-256-GCM encrypt/decrypt for stored credentials
    hash.ts                — SHA-256 deduplication hash for movements
    utils.ts               — Shared utilities (isValidIsoDate, etc.)
    categories.ts          — Regex-based category inference from movement description (15 categories)
    transfers.ts           — Cross-bank internal transfer detection (debit/credit pair matching)
    coach.ts               — Rule-based coach recommendations (getCoachRecommendations)
    drive/
      export.ts            — buildMovementsXlsx(): multi-sheet XLSX from movements array
      google-drive.ts      — uploadToDrive(): Google Drive upload via OAuth2 (GDRIVE_* env vars)
  middleware.ts            — Route protection (redirect to /login if unauthenticated)
```

---

## Setup

### CLI
```bash
npm install && npm run build
cp .env.example .env  # fill in credentials
```

### Web dashboard
```bash
cd web && npm install
# Env vars come from Doppler (see below)
```

---

## Running

### CLI
```bash
# Standard headless mode
source .env && node dist/cli.js --bank falabella --pretty

# Use your Chrome profile (cookies, sessions — great for 2FA-heavy banks)
source .env && node dist/cli.js --bank mercadopago --profile
```

### Web dashboard (local dev, requires Doppler)
```bash
# From repo root
doppler run --project open-banking-chile --config dev -- npm run dev --prefix web
# Open http://localhost:3434
```

### Web dashboard (production deploy)
```bash
# Always run from repo root — Vercel root dir is configured as "web"
vercel --prod
```

### Secret management

All secrets live in [Doppler](https://doppler.com) project **`open-banking-chile`**:
- Config **`dev`** — injected locally via `doppler run --project open-banking-chile --config dev --`
- Config **`prd`** — synced to Vercel automatically via the Doppler → Vercel integration

**Exception**: `SUPABASE_URL` and `SUPABASE_ANON_KEY` are also set directly in the Vercel dashboard (project settings → environment variables) so they are available at build time without Doppler.

### Environment variables

| Variable | Config | Value / notes |
|---|---|---|
| `SUPABASE_URL` | dev + prd | `https://wcyxlyitcbmeczihaohq.supabase.co` |
| `SUPABASE_ANON_KEY` | dev + prd | Supabase anon JWT — find in Supabase dashboard → project **`open-banking`** → Settings → API |
| `AUTH_URL` | dev | `http://localhost:3434` |
| `AUTH_URL` | prd | `https://open-banking-chile.vercel.app` |
| `AUTH_GOOGLE_ID` | dev + prd | Google OAuth client ID — Google Cloud project **`open-banking-chile`** |
| `AUTH_GOOGLE_SECRET` | dev + prd | Google OAuth client secret — same project |
| `AUTH_SECRET` | dev + prd | Auth.js session secret — generate: `openssl rand -base64 32` |
| `CREDENTIALS_SECRET` | dev + prd | AES-256 key for bank credentials — generate: `openssl rand -hex 32` (64 hex chars) |
| `GDRIVE_CLIENT_ID` | dev + prd | Google OAuth2 client ID for Drive (Google Cloud project **`open-banking-chile`**) |
| `GDRIVE_CLIENT_SECRET` | dev + prd | Google OAuth2 client secret for Drive |
| `GDRIVE_REFRESH_TOKEN` | dev + prd | OAuth2 refresh token — generated via `node scripts/google-drive-auth.mjs` in open-finance-tool |
| `GOOGLE_DRIVE_FOLDER_ID` | dev + prd | Target Drive folder ID (from the folder's URL) |

### Google OAuth (Google Cloud project: `open-banking-chile`)

Authorized redirect URIs — both must be present in Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client:

```
http://localhost:3434/api/auth/callback/google     ← local dev
https://open-banking-chile.vercel.app/api/auth/callback/google  ← production
```

### Supabase (project: `open-banking`)

- **URL**: `https://wcyxlyitcbmeczihaohq.supabase.co`
- **Client**: `@supabase/supabase-js` (PostgREST HTTP API — required because Supabase's TCP pooler doesn't work from Vercel serverless). `DATABASE_URL` is not used.
- **RLS**: disabled — the anon key has full table access server-side. Tables: `users`, `bank_credentials`, `movements`.

**Access policy**: any Google account can sign in — no email whitelist. Do not add `AUTH_WHITELIST_EMAILS`.

### Google Drive export

The `/api/drive` POST endpoint exports all user movements as a multi-sheet XLSX file to a shared Google Drive folder. Uses OAuth2 (not a service account). Each export overwrites the previous file with the same date-based name.

- `GDRIVE_*` env vars must be set in both Doppler `dev` and `prd` configs
- The Drive OAuth2 credentials use a separate Google Cloud client (Desktop app type) from the sign-in OAuth client
- `isDriveConfigured()` returns `false` if any of the four required env vars are missing — the endpoint returns 503 gracefully

---

## Adding a new bank

1. **Check for an API first** — inspect the service's Network tab in DevTools for REST/GraphQL endpoints
2. Create `src/banks/<bank-id>.ts` implementing `BankScraper`
   - If API available: use `runApiScraper()` from `api-runner.ts`, set `mode: "api"`
   - If browser needed: use `runScraper()` from `scraper-runner.ts`, compose actions from `src/actions/`
3. Register in `src/index.ts`
4. Add env vars to `.env.example`
5. Add bank name to `BANK_NAMES` map in `web/app/movements/page.tsx`

See CONTRIBUTING.md for the full guide.

---

## Scraper development workflow

### API-mode scrapers (preferred)

1. **Discover the API** — Open Chrome DevTools → Network tab (filter: Fetch/XHR). Log in manually and navigate to movements/portfolio pages.
2. **Identify auth pattern** — Common patterns found in this project:
   - **Token-based**: POST credentials → receive token → use as Bearer header (Fintual, MercadoPago)
   - **Cookie jar**: POST credentials → receive session cookies + CSRF token → send cookies on every request (Banco de Chile)
   - **Firebase Auth**: POST to `identitytoolkit.googleapis.com/v1/accounts:signInWithPassword` → receive `idToken` (Racional)
   - **OAuth2**: User pre-authorizes app → use access token (MercadoPago)
3. **Map all endpoints** — Record every XHR request: URL, method, headers, request body, response shape. Add these verbatim to the "Discovered API patterns" section above.
4. **Implement** — Use `runApiScraper()`, follow `fintual.ts` (simple token) or `bchile.ts` (cookie jar) as templates.
5. **Test** — `node dist/cli.js --bank <id> --pretty` with real credentials.

### Browser-mode scrapers (last resort)

1. **Get to a point** — Run the scraper and reach the target page (e.g. post-login dashboard).
2. **Scrape page** — Save HTML with `--screenshots` (writes to `debug/*.html` when enabled).
3. **Analyze scraped HTML** — Inspect the DOM to identify selectors, menu labels, and structure.
4. **Implement** — Add or adjust navigation/extraction logic based on findings.
5. **Start again** — Run scraper, verify, then repeat for the next step.

Do not skip steps 2–3. Do not implement without inspecting the scraped HTML first.

---

## Common issues

- **Chrome not found** → only needed for browser-mode banks. API-mode banks work without Chrome.
- **2FA prompt** → handled via `onTwoFactorCode` callback (web app polls Supabase `pending_2fa` table). CLI falls back to stdin.
- **0 movements** → for API-mode: check debug log for HTTP status codes. For browser-mode: use `--screenshots`.
- **Bot detection** → Itaú (Imperva), BICE (403), BancoEstado (TLS fingerprint). Use `--profile` for local runs with system Chrome.
- **MercadoPago 0 movements** → normal for buyer-only accounts. The API only shows seller/wallet activity.
- **Token expired** → Fintual tokens don't expire within a session. MercadoPago tokens last 180 days. Racional Firebase tokens expire in 1 hour but auto-refresh.
- **Login failed on Vercel** → check if the bank is in the "browser mode" list. Browser-mode banks may fail on Vercel due to bot protection.

---

## Agent team

This project uses specialized agents (`.claude/agents/`) that are automatically delegated to based on the user's request:

| Agent | Role | When invoked |
|-------|------|-------------|
| `bank-{id}` (x13) | Bank-specific expert | Any mention of a bank name, ID, or its scraper |
| `scraping-expert` | Technique expert | API patterns, auth flows, cookie jars, fetch, Puppeteer |
| `product-manager` | Product decisions | Feature scope, UX, database schema, platform consistency |
| `qa-engineer` | Quality assurance | After every code change — build, types, compliance, regressions |
| `repo-architect` | Documentation | After major iterations — AGENTS.md, agent files, memory, structure |

**Delegation is automatic** — see CLAUDE.md for routing rules.

**Post-iteration protocol**: After every major change, `qa-engineer` runs first (catches bugs), then `repo-architect` runs (updates docs). This is mandatory and should not be skipped.

---

## Security

- All credentials stored with AES-256-GCM encryption (separate IVs per field)
- No credentials transmitted to external servers beyond the bank's own website
- Screenshots may contain sensitive data — handle with care
- Web dashboard uses JWT-only sessions (no server-side session store)
- Authentication: any Google account can sign in — no email whitelist is implemented or desired
