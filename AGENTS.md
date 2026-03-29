# Open Banking Chile

## For all Agents (Claude, Codex, Gemini, etc.)

### What this project does
Open source framework for extracting movements and balances from Chilean banks and investment platforms. Uses direct API calls (preferred) or Playwright browser automation (last resort). Includes a multi-user web dashboard deployed on Vercel with Google OAuth, plus a local sync agent that runs scrapers on the user's computer.

### Architecture

The platform has three components:

1. **npm package** (`open-banking-chile`) -- Open-source scraper library, published on npm
2. **Web dashboard** (`web/`) -- Control plane + data viewer deployed on Vercel (Next.js 15). Handles auth, credential storage, movement display, analytics. Does NOT run browser-mode scrapers.
3. **Local sync agent** (`src/agent.ts`) -- Runs on the user's computer via `npx open-banking-chile serve`. Executes all scrapers (API and browser mode), uploads movements to Supabase. Communicates with dashboard via Supabase Realtime.

**Why local agent?** Browser-mode banks require a real browser (Chromium, Chrome). Vercel serverless cannot run browsers reliably (bot protection, cold starts, memory limits). The local agent has access to the user's Chrome with cookies and sessions, bypassing bot detection entirely.

**Sync flow:**
1. User clicks "Sincronizar" on dashboard
2. Dashboard inserts a row into `sync_tasks` table (status: `pending`)
3. Local agent receives the task via Supabase Realtime subscription
4. Agent claims the task (status: `running`), fetches credentials from dashboard API
5. Agent runs the scraper, uploads movements to Supabase
6. Agent marks task done (status: `done`)
7. Dashboard shows progress in real-time via `ScrapeProgressRealtime.tsx`

**Fallback for API-mode banks:** The Vercel scrape route (`/api/scrape/[bankId]`) still runs API-mode scrapers directly on the server (no browser needed). Browser-mode banks return an error message directing the user to start the local agent.

### Live deployment
- **Production URL**: https://open-banking-chile.vercel.app
- **Vercel project**: `open-banking-chile` (org: `rhonorato-ship-its-projects`)
- **Vercel project ID**: `prj_ovBTOzwEpedmlf6JILFlKtbf6hBN`
- **Deploy command**: run `vercel --prod` from repo root (not from `web/` -- root dir is configured as `web` in Vercel settings). **Always deploy after every commit.**
- **npm package**: `open-banking-chile` (latest: v2.1.2, publisher: `rhonorato`)

### Supported institutions (15)

**API mode** (12 -- no browser needed, runs on Vercel or local agent):

Banks:
- Banco de Chile (`bchile`) -- Spring Security login + REST API with XSRF cookie jar
- Banco Edwards (`edwards`) -- delegates to bchile (same portal: `portalpersonas.bancochile.cl`)
- BCI (`bci`) -- JSF form login with ViewState CSRF + HTML table parsing. Data endpoints need live testing.
- BancoEstado (`bestado`) -- cookie jar auth. Akamai TLS fingerprint may block Node.js fetch; returns helpful error if blocked.
- BICE (`bice`) -- API-first with browser fallback. HTTP login to Keycloak at `auth.bice.cl`, data via `gw.bice.cl` BFF endpoints. Falls back to Playwright browser login when Cloudflare blocks HTTP.
- Banco Falabella (`falabella`) -- cookie jar auth + REST API for account and CMR credit card data. Endpoints need live testing.
- Santander (`santander`) -- cookie jar auth via login iframe endpoint + REST API. Multi-account + CC support.
- Scotiabank (`scotiabank`) -- cookie jar auth + REST API. Historical periods via `SCOTIABANK_MONTHS` env var.

FinTech (mobile-only):
- MACH (`mach`) -- BCI subsidiary, mobile-only. Device-bound auth (AES-GCM encrypted PIN). API at `api.soymach.com/mobile/`. Best-effort scraper; requires device registration for full auth.
- Tenpo (`tenpo`) -- Mobile-only neobank (com.krealo.tenpo). Skeleton scraper probing `api.prod.tenpo.cl`. Endpoints not yet fully discovered.

WealthTech:
- Fintual (`fintual`) -- public REST API at `https://fintual.cl/api-docs`. User-Agent header required (Cloudflare blocks empty UA).
- Racional (`racional`) -- Firebase Auth (`racional-prod`) + Firestore REST API. Expanded field name detection for deposit/withdrawal mapping. Debug logging for Firestore responses.

**Browser mode** (3 -- requires Playwright, runs on local agent only):

Banks:
- Citibank (`citi`) -- Full browser mode. Password is E2E encrypted client-side in Angular SPA, ThreatMetrix/ioBlackBox requires real browser JS. Login at `www.citi.com`. Old `online.citi.com/US/login.do` endpoint returns 301. REST API + CSV download attempted post-login as data extraction method, DOM scraping as fallback.
- Itau (`itau`) -- IBM WebSphere Portal (server-rendered HTML, no JSON APIs). Imperva blocks Node.js fetch(); requires real browser. 2FA via Itau Key push notification.

PayTech:
- MercadoPago (`mercadopago`) -- MercadoLibre login with email + password. Device fingerprint (`dps`) requires browser JS. Extracts balance + activity from dashboard.

---

## Scraper strategy (API-first -- MANDATORY)

**Chromium is a last resort.** Every bank, investment platform, and financial service should be scraped via API or CLI whenever possible. Do NOT default to opening a browser.

### Data requirements (ALL scrapers)
- **First sync**: Fetch at least **24 months** of movement history. No date limits on initial scrape.
- **Subsequent syncs**: Fetch new/changed movements since last sync. Dedup via SHA256 hash prevents duplicates.
- **Balance**: Every scraper MUST return `balance` in `ScrapeResult` -- the current account/portfolio balance. The dashboard derives balances from the latest movement with a non-null `balance` field.
- **Credential errors**: When login fails due to bad credentials, the scraper should return a clear error. The dashboard shows "Actualizar credenciales" instead of a generic retry button.

### Priority order (strict)

1. **Direct API (`fetch()`)** -- The default. Check DevTools Network tab, Swagger docs, or mobile app traffic for REST/GraphQL endpoints. Use `runApiScraper()` from `src/infrastructure/api-runner.ts`. Set `mode: "api"` on the `BankScraper`. Zero browser dependencies.
   - Example: Fintual -> `POST /api/access_tokens` + `GET /api/goals`
   - Example: BICE -> HTTP login to Keycloak + `gw.bice.cl` BFF endpoints

2. **API-first with browser fallback** -- Try HTTP login first; if blocked by Cloudflare/WAF, fall back to Playwright for auth only, then use pure HTTP for data. Still set `mode: "api"`.
   - Example: BICE -> Keycloak HTTP login, Cloudflare fallback to browser, data via fetch

3. **Browser with user's Chrome profile** -- When a browser is truly needed (no API, complex JS rendering, 2FA/OAuth), use the user's real Chrome via `--profile` flag or the local agent. This leverages existing cookies, sessions, and saved passwords -- avoids bot detection entirely.

4. **Headless browser on local agent** -- For browser-mode banks that cannot be API-migrated. The local agent runs Playwright with a real browser. No `@sparticuz/chromium` on Vercel -- browser-mode banks are local agent only.

### Before writing ANY scraper code

1. Open the bank/platform's website in Chrome DevTools -> Network tab
2. Log in manually and observe the XHR/Fetch requests
3. Look for JSON API responses -- these are your targets
4. Check for Swagger/OpenAPI docs (try `/api-docs`, `/swagger.json`, `/api/v1`)
5. Check if the platform has a mobile app -- mobile APIs are often simpler and better documented
6. Only after confirming there is NO usable API should you consider browser automation

### 2FA requirements per institution

| Institution | 2FA Type | Code Format | Delivery | Automatable? |
|------------|----------|-------------|----------|-------------|
| Banco de Chile | Push / SMS | 6 digits | Mobile app or SMS | Push: wait only. SMS: enter code |
| BCI | Push (BCI Pass) | -- | Mobile app | Wait only -- no code entry |
| BancoEstado | SMS | 6 digits | SMS | Enter code |
| BICE | Push / SMS | 6 digits | Mobile app or SMS | Depends on user config |
| Citi | SMS / Email | 6 digits | SMS or email | Enter code. Agentic mode: auto-extract from Gmail |
| Falabella | SMS | 4-6 digits | SMS | Enter code |
| Fintual | None | -- | -- | Fully automated (API token) |
| Itau | Push (Itau Key) | -- | Mobile app | Wait only -- no code entry |
| MACH | SMS / Push | 6 digits | Mobile app or SMS | Device-bound auth -- not automatable without registered device |
| MercadoPago | Email / QR / Facial | 6 digits (email) | Email, QR, or face scan | Email: enter code. QR/facial: manual only |
| Racional | Email OTP | 6 digits | Email | Enter code. Agentic mode: auto-extract from Gmail |
| Santander | Push | -- | Mobile app | Wait only |
| Scotiabank | Dynamic key | 6 digits | Token device or SMS | Enter code |
| Tenpo | Unknown | Unknown | Unknown | Not yet discovered |

**Web app 2FA flow (manual mode)**: When a scraper requests a code, the SSE endpoint sends `requires_2fa: true`. The frontend shows a code input field. The user types the code and submits it to `POST /api/2fa`, which writes to the `pending_2fa` Supabase table. The SSE route polls this table every 2 seconds for up to 90 seconds.

**Agentic 2FA flow (opt-out, default ON)**: When agentic mode is enabled, the scrape route first searches the user's Gmail (via OAuth2) for a recent 2FA email matching bank-specific patterns (`lib/gmail.ts`). If found within 15 seconds, the code is extracted and submitted automatically. Falls back to manual mode if Gmail search fails.

**Local agent 2FA flow**: If running in a TTY, the agent prompts the user directly on the terminal. If non-TTY (e.g., background daemon), it sets `requires_2fa: true` on the sync_task and polls `pending_2fa` just like the web app.

### Institutions with anti-bot protections (may block API mode)

Most banks are API mode, but these have anti-bot measures that may block Node.js `fetch()`. Their scrapers detect the block and return helpful error messages suggesting `--profile` as fallback:

- **Itau** -- Imperva bot protection. **Browser mode** (Imperva confirmed to block fetch(); no JSON APIs exist). Still detects Imperva block and suggests `--headful --profile` if headless Chrome is also blocked.
- **Citi** -- ThreatMetrix ioBlackBox + E2E encrypted password. **Browser mode** required. Old `online.citi.com/US/login.do` returns 301 redirect.
- **BancoEstado** -- Akamai TLS fingerprinting. API mode, but scraper detects 403/captcha and suggests `--headful --profile`.
- **BICE** -- Cloudflare WAF on `portalpersonas.bice.cl`. API mode with automatic browser fallback (navigates directly to Keycloak URL, bypassing Cloudflare on the portal).
- **BCI** -- JSF ViewState. Server-rendered portal may reject non-browser requests.

### Key files

- `src/infrastructure/api-runner.ts` -- Browser-free runner for API scrapers
- `src/infrastructure/scraper-runner.ts` -- Browser-based runner (Playwright, use only when necessary)
- `src/infrastructure/browser.ts` -- Playwright launch with `userDataDir` support, remoteCDP, anti-detection
- `src/agent.ts` -- Local sync agent entry point
- `src/agent-auth.ts` -- Agent config persistence and Supabase client creation

### Discovered API patterns (verbatim reference)

Use this section when debugging or extending any API-mode scraper. These details were confirmed via DevTools inspection and live testing.

#### Fintual (`mode: "api"`)
- **Auth**: `POST https://fintual.cl/api/access_tokens` with `{ user: { email, password } }` -> `{ data: { attributes: { token, email } } }`
- **Data**: `GET https://fintual.cl/api/goals` with headers `X-User-Email` + `X-User-Token`
- **Response**: `{ data: [{ id, type: "goal", attributes: { name, nav } }] }` -- `nav` is portfolio value in CLP
- **Docs**: Swagger at `https://fintual.cl/api-docs/v1/swagger.json`
- **User-Agent**: Must send a non-empty User-Agent header (Cloudflare blocks empty UA from Vercel)
- **Credential mapping**: `rut` field = email address, `password` field = password

#### Banco de Chile (`mode: "api"`)
- **Auth**: Spring Security form-login. Cookie jar pattern with `JSESSIONID` + `XSRF-TOKEN` (Angular double-submit cookie)
- **Login POST**: `https://login.portal.bancochile.cl/bancochile-web/persona/login/index.html` with `userRut` + `userPassword` + `_csrf` as `application/x-www-form-urlencoded`. Use `redirect: "manual"` to capture Set-Cookie from 302.
- **XSRF**: Cookie `XSRF-TOKEN` (URL-encoded) -> decode and send as header `X-XSRF-TOKEN` on every API call
- **API base**: `https://portalpersonas.bancochile.cl/mibancochile/rest/persona`
- **Key endpoints** (all require `Cookie` + `X-XSRF-TOKEN` headers):
  - `GET selectorproductos/selectorProductos/obtenerProductos?incluirTarjetas=true` -- list all accounts + cards
  - `GET bff-ppersonas-clientes/clientes/` -- client name and RUT
  - `GET bff-pp-prod-ctas-saldos/productos/cuentas/saldos` -- account balances
  - `POST bff-pper-prd-cta-movimientos/movimientos/getCartola` -- paginated account movements
  - `POST tarjetas/widget/informacion-tarjetas` -- list credit cards
  - `POST tarjeta-credito-digital/saldo/obtener-saldo` -- card balance/limits
  - `POST tarjeta-credito-digital/movimientos-no-facturados` -- unbilled CC movements
  - `POST tarjetas/estadocuenta/fechas-facturacion` -- billing dates
  - `POST tarjetas/estadocuenta/nacional/resumen-por-fecha` -- billed national CC movements
  - `POST tarjetas/estadocuenta/internacional/resumen-por-fecha` -- billed international CC movements

#### Banco Edwards (`mode: "api"`)
- **Same portal as Banco de Chile** -- delegates to `bchile.scrape()` and rebrands the result
- Uses identical API endpoints, login flow, and XSRF pattern

#### Racional (`mode: "api"`)
- **Auth**: Firebase Authentication (project: `racional-prod`)
  - API key: `AIzaSyCHCBAaUWhTc8mGtyqfahJ4cYpeVACoCJk`
  - `POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}` with `{ email, password, returnSecureToken: true }`
  - Returns `{ idToken, refreshToken, localId }` -- `idToken` is a JWT valid for 1 hour
  - Token refresh: `POST https://securetoken.googleapis.com/v1/token?key={API_KEY}` with `grant_type=refresh_token`
- **Data**: Firestore at `projects/racional-prod/databases/(default)/documents`
  - Top-level collections: `deposits`, `withdrawals`, `contributions`, `goals` -- filtered by `userId` field
  - User doc: `users/{localId}` -- portfolio data may be embedded as fields
  - Cloud Functions: `https://us-central1-racional-prod.cloudfunctions.net` for account summaries
  - Uses Firestore REST API: `GET https://firestore.googleapis.com/v1/projects/racional-prod/databases/(default)/documents/{path}` with `Authorization: Bearer {idToken}`
- **Field mapping**: Expanded detection for deposit/withdrawal field names. Debug logging for Firestore document structure.
- **Credential mapping**: `rut` field = email address, `password` field = password
- **2FA**: Firebase may enforce MFA (returns `MISSING_MFA` error). Email OTP handled via `onTwoFactorCode` callback.

#### BICE (`mode: "api"` -- API-first with browser fallback)
- **Auth**: Keycloak OIDC at `auth.bice.cl/realms/personas/protocol/openid-connect/auth`
  - HTTP login attempted first (pure fetch to Keycloak form)
  - Cloudflare may block with 403 or `cf-mitigated: challenge` header
  - On Cloudflare block: automatic fallback to Playwright browser login
- **Portal URL**: `https://portalpersonas.bice.cl` -- Keycloak redirect
- **Keycloak direct URL**: Navigate directly to Keycloak auth URL to bypass Cloudflare on portal
- **Keycloak form**: `#username` (formatted RUT with dots) + `#password` + `#kc-login` (standard Keycloak IDs)
- **Post-login**: OAuth agent at `gw.bice.cl/oauth-agent-personas` exchanges auth code for session:
  - `POST /oauth-agent-personas/login/start` with `{ pageUrl: "https://portalpersonas.bice.cl/?code=..." }`
  - `POST /oauth-agent-personas/login/end` -- sets HTTP-only session cookies
  - `GET /oauth-agent-personas/userInfo` -- verify session
- **Data endpoints** (pure HTTP with cookie jar, no browser needed):
  - `POST https://gw.bice.cl/portalpersonas/bff-portal-hbp/v1/products` -- account list
  - `POST https://gw.bice.cl/portalpersonas/bff-checking-account-transactions-100/v1/balance` -- balance
  - `POST https://gw.bice.cl/portalpersonas/bff-checking-account-transactions-100/v1/transactions` -- movements (paginated, 40/page, up to 25 pages)
- **2FA**: Keycloak may prompt for OTP -- detected via page content keywords (`otp`, `two-factor`, `segundo factor`), code entered into `#otp` or equivalent input
- **Credential error detection**: Keycloak returns 200 with `kc-feedback-text` class or `Invalid username or password` on bad credentials

#### Citibank (`mode: browser` -- full browser required)
- **Login URL**: `https://www.citi.com` (Angular SPA, NOT `online.citi.com` which 301s)
- **Anti-bot**: ThreatMetrix/LexisNexis `ioBlackBox` device fingerprinting. E2E encrypted password.
- **Login flow**: Browser waits for `#username` field (may be in iframe), waits for ioBlackBox to populate (8s max), enters credentials, clicks `#signInBtn`
- **Data extraction**: REST API + CSV download attempted first (`POST /US/REST/accountsPanel/getCustomerAccounts.jws`, `GET /US/NCSC/dcd/StatementDownload.do`), DOM scraping as fallback
- **2FA**: SMS/email OTP. Keywords: `verification code`, `one-time`, `verify your identity`, `security code`
- **US format**: Amounts in `$1,234.56`, dates in `MM/DD/YYYY` -- converted to DD-MM-YYYY

#### MACH (`mode: "api"` -- best-effort)
- **Mobile-only** -- no web portal. APK: `cl.bci.sismo.mach` (BCI subsidiary)
- **Base URL**: `https://api.soymach.com/mobile/`
- **Auth headers**: `Content-Type: application/json`, `Accept-Version: 0.31.0`, `mach-header-id: {device_id}`, `Authorization: Bearer {token}`
- **Auth flow** (device-bound):
  1. Device must be registered with the MACH app first (one-time)
  2. PIN auth: `POST credentials/security-pin/authentication/verify` with AES-GCM encrypted PIN `{ "content": "...", "tag": "...", "iv": "..." }`
  3. Token refresh: `POST auth/token/acknowledge` + stored refresh token
- **Data endpoints** (all require Bearer token + mach-header-id):
  - `GET accounts/balance` -- account balance
  - `GET accounts/information` -- account details
  - `GET movements/history/v2` -- movement history (paginated)
  - `GET credit-lines/balance` -- credit card balance
  - `GET credit-lines/movements/authorized` -- CC unbilled movements
  - `GET credit-lines/movements/statement` -- CC billed movements
- **Limitation**: Device registration and AES-GCM PIN encryption cannot be replicated server-side without the device key. Scraper returns helpful error explaining this.
- **Credential mapping**: `rut` field = phone number, `password` field = security PIN (4-6 digits)

#### Tenpo (`mode: "api"` -- skeleton)
- **Mobile-only** -- no web portal. APK: `com.krealo.tenpo` (Kotlin backend, likely Spring Boot)
- **Discovered base URL**: `api.prod.tenpo.cl` (reachable but paths unknown)
- **Scraper approach**: Probes common neobank API patterns (auth paths, payload shapes)
- **Next step**: Decompile APK to discover real endpoints and auth flow
- **Credential mapping**: `rut` field = phone number or email, `password` field = PIN or password

---

## Local sync agent

### Overview

The local sync agent (`src/agent.ts`) runs on the user's computer and executes bank scrapers. It replaces the previous architecture where all scrapers ran on Vercel serverless functions.

### Usage

```bash
# First run -- authenticates interactively
npx open-banking-chile serve

# Run with explicit token
npx open-banking-chile serve --token eyJhbG...

# Run against a custom dashboard URL (e.g., local dev)
npx open-banking-chile serve --url http://localhost:3434
```

### Agent auth flow

1. User visits `/agent` page on dashboard
2. Dashboard generates a JWT signed with `AUTH_SECRET` (valid 365 days)
3. User pastes the token into the agent CLI
4. Token saved to `~/.config/open-banking-chile/agent.json` (mode 0600)
5. Agent creates a Supabase client with the token as Authorization header

### Agent lifecycle

1. **Start**: Load config, authenticate, detect configured banks (API first, env vars fallback)
2. **Heartbeat**: Upsert to `agent_presence` table every 30 seconds
3. **Listen**: Subscribe to `sync_tasks` table via Supabase Realtime (INSERT events with status=pending)
4. **Execute**: Claim task (atomic update to status=running), fetch credentials, run scraper, upload movements
5. **Shutdown**: Remove presence row, unsubscribe from Realtime (SIGINT/SIGTERM)

### Supabase tables (agent)

```sql
-- sync_tasks: task queue (dashboard creates, agent executes)
-- Columns: id, user_id, bank_id, status, phase, message, requires_2fa, agent_id, error, movements_inserted, created_at, started_at, finished_at
-- Status values: pending, running, done, error, expired

-- agent_presence: heartbeat-based online detection
-- Columns: user_id, agent_id, last_heartbeat, banks (text[]), version
```

Both tables have RLS enabled and Supabase Realtime publication.

### Key files

- `src/agent.ts` -- Main agent loop, task handler, credential fetching, movement upload
- `src/agent-auth.ts` -- Config persistence (`~/.config/open-banking-chile/agent.json`), Supabase client creation
- `web/app/agent/page.tsx` -- Agent setup page (token generation, copy to clipboard)
- `web/app/api/agent/token/route.ts` -- POST: generates agent JWT (HS256, signed with AUTH_SECRET)
- `web/app/api/agent/credentials/route.ts` -- GET: returns decrypted credentials for a bank (agent JWT auth)
- `web/app/api/agent/credentials/list/route.ts` -- GET: returns list of configured bank IDs (agent JWT auth)
- `web/components/AgentStatus.tsx` -- Online/offline indicator (polls `agent_presence` table)
- `web/components/ScrapeProgressRealtime.tsx` -- Real-time sync progress via Supabase Realtime subscription on `sync_tasks`
- `supabase/migrations/20260328220000_sync_agent.sql` -- SQL migration for `sync_tasks` + `agent_presence` tables

---

## Project structure

```
src/
  index.ts                 -- Registry of all 15 banks, getBank(), listBanks()
  types.ts                 -- BankScraper interface, BankMovement, ScrapeResult, ScraperOptions
  utils.ts                 -- Shared utilities (formatRut, findChrome, parseChileanAmount, normalizeDate, etc.)
  cli.ts                   -- CLI entry point (--bank, --list, --pretty, --movements, serve)
  agent.ts                 -- Local sync agent (Supabase Realtime, task execution, credential fetching)
  agent-auth.ts            -- Agent config persistence (~/.config/), Supabase client creation
  infrastructure/
    browser.ts             -- Playwright launch, session management, anti-detection, userDataDir, remoteCDP
    scraper-runner.ts      -- Browser-based execution pipeline: validate -> launch -> scrape -> logout -> cleanup
    api-runner.ts          -- API-based execution pipeline: validate -> fetch -> return (no browser)
    cookies.ts             -- Session cookie persistence (save/load to filesystem for CLI, /tmp for Lambda)
  actions/
    login.ts               -- Generic login (RUT formats, password, submit, error detection)
    navigation.ts          -- DOM navigation (click by text, sidebars, banner dismissal)
    extraction.ts          -- Movement extraction from HTML tables with fallbacks
    pagination.ts          -- Multi-page iteration (Siguiente, Ver mas)
    credit-card.ts         -- Credit card movement extraction (tabs, billing periods)
    balance.ts             -- Balance extraction (regex + CSS selector fallbacks)
    two-factor.ts          -- 2FA detection and wait (configurable keywords/timeout)
  sync/
    drive.ts               -- Google Drive sync (XLSX export)
    formatter.ts           -- Movement formatting utilities
    merger.ts              -- Movement merging logic
  banks/
    12 API-mode scrapers (fetch-only): bchile.ts, edwards.ts, fintual.ts,
    mach.ts, racional.ts, tenpo.ts, bci.ts, bestado.ts,
    bice.ts (API-first + browser fallback), falabella.ts, santander.ts, scotiabank.ts
    3 browser-mode scrapers (Playwright): citi.ts, itau.ts, mercadopago.ts

web/                       -- Next.js 15 multi-user dashboard (App Router), deployed on Vercel
  app/
    dashboard/             -- Balance hero, per-bank colored cards, sync buttons, toast notifications
    banks/                 -- Add / edit / remove bank credentials (self-contained BankRow, inline delete confirm)
    movements/             -- Transaction history: text search, sortable columns, pagination (50/page), monthly chart
    analytics/             -- Filter bar, summary totals, time-series chart, bank comparison, category breakdown, spending heatmap
    agent/                 -- Agent setup page (token generation, copy-paste flow, agent status)
    login/                 -- Google OAuth sign-in
    api/
      agent/
        token/             -- POST: generate agent JWT (HS256, 365-day expiry)
        credentials/       -- GET: decrypted bank credentials (agent JWT auth)
          list/            -- GET: connected bank IDs (agent JWT auth)
      banks/               -- CRUD for encrypted bank credentials
      movements/           -- Query movements with filters (bankId, from, to); enriched with category + isInternalTransfer
      analytics/           -- Pre-aggregated time-series, category breakdown, bank comparison, heatmap (filters: bankId, from, to)
      dashboard-summary/   -- Current-month spend/income/net, transfer count, top-5 categories, last-6-month series
      coach/               -- Rule-based financial recommendations (top category, savings pressure, transfer ratio)
      drive/               -- POST: export all movements as XLSX to Google Drive; returns { url, name }
      gmail/               -- Gmail OAuth2: connect, disconnect, status, toggle agentic mode, callback
      scrape/[bankId]/     -- SSE endpoint: API-mode banks run directly; browser-mode banks return "use local agent"
      2fa/                 -- POST: submit 2FA code to pending_2fa table
      debug-session/       -- Session debugging endpoint
  components/
    Navigation.tsx         -- Top nav bar (teal accent, Geist fonts, light theme). Links: Dashboard, Movimientos, Analitica, Cuentas, Agente
    ScrapeProgress.tsx     -- SSE-based sync progress animation (used for API-mode Vercel syncs)
    ScrapeProgressRealtime.tsx -- Supabase Realtime sync progress (used for local agent syncs)
    AgentStatus.tsx        -- Agent online/offline indicator (polls agent_presence, 90s threshold)
  lib/
    auth.ts                -- Auth.js v5 (Google OAuth, JWT) + Supabase user upsert on sign-in
    auth.config.ts         -- Edge-compatible auth config (used by middleware)
    db.ts                  -- Supabase HTTP client (@supabase/supabase-js, PostgREST -- no TCP connection)
    supabase-browser.ts    -- Browser-side Supabase client for Realtime subscriptions (NEXT_PUBLIC_ env vars)
    credentials.ts         -- AES-256-GCM encrypt/decrypt for stored credentials
    hash.ts                -- SHA-256 deduplication hash for movements
    gmail.ts               -- Gmail OAuth2 + 2FA code extraction (bank-specific patterns, generic fallback)
    rut.ts                 -- RUT validation and normalization
    utils.ts               -- Shared utilities (isValidIsoDate, etc.)
    categories.ts          -- Regex-based category inference from movement description (15 categories)
    transfers.ts           -- Cross-bank internal transfer detection (debit/credit pair matching)
    coach.ts               -- Rule-based coach recommendations (getCoachRecommendations)
    drive/
      export.ts            -- buildMovementsXlsx(): multi-sheet XLSX from movements array
      google-drive.ts      -- uploadToDrive(): Google Drive upload via OAuth2 (GDRIVE_* env vars)
  middleware.ts            -- Route protection (redirect to /login if unauthenticated)

supabase/
  migrations/
    20260328220000_sync_agent.sql -- sync_tasks + agent_presence tables (RLS + Realtime)
```

---

## Setup

### CLI
```bash
npm install && npm run build
cp .env.example .env  # fill in credentials
```

### Local sync agent
```bash
# Install globally (or use npx)
npm install -g open-banking-chile

# First run -- will prompt for token
open-banking-chile serve

# Or use npx directly
npx open-banking-chile serve
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

# Use your Chrome profile (cookies, sessions -- great for 2FA-heavy banks)
source .env && node dist/cli.js --bank mercadopago --profile
```

### Local sync agent
```bash
# First run -- authenticates interactively (opens browser to /agent for token)
npx open-banking-chile serve

# With explicit token
npx open-banking-chile serve --token eyJhbGciOi...

# Against local dev dashboard
npx open-banking-chile serve --url http://localhost:3434
```

### Web dashboard (local dev, requires Doppler)
```bash
# From repo root
doppler run --project open-banking-chile --config dev -- npm run dev --prefix web
# Open http://localhost:3434
```

### Web dashboard (production deploy)
```bash
# Always run from repo root -- Vercel root dir is configured as "web"
# MANDATORY: deploy after EVERY commit -- production must always match latest code
vercel --prod
```

### Secret management

All secrets live in [Doppler](https://doppler.com) project **`open-banking-chile`**:
- Config **`dev`** -- injected locally via `doppler run --project open-banking-chile --config dev --`
- Config **`prd`** -- synced to Vercel automatically via the Doppler -> Vercel integration

**Exception**: `SUPABASE_URL` and `SUPABASE_ANON_KEY` are also set directly in the Vercel dashboard (project settings -> environment variables) so they are available at build time without Doppler.

### Environment variables

| Variable | Config | Value / notes |
|---|---|---|
| `SUPABASE_URL` | dev + prd | `https://wcyxlyitcbmeczihaohq.supabase.co` |
| `SUPABASE_ANON_KEY` | dev + prd | Supabase anon JWT -- find in Supabase dashboard -> project **`open-banking`** -> Settings -> API |
| `NEXT_PUBLIC_SUPABASE_URL` | dev + prd | Same as `SUPABASE_URL` -- exposed to browser for Realtime subscriptions |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | dev + prd | Same as `SUPABASE_ANON_KEY` -- exposed to browser for Realtime subscriptions |
| `AUTH_URL` | dev | `http://localhost:3434` |
| `AUTH_URL` | prd | `https://open-banking-chile.vercel.app` |
| `AUTH_GOOGLE_ID` | dev + prd | Google OAuth client ID -- Google Cloud project **`open-banking-chile`** |
| `AUTH_GOOGLE_SECRET` | dev + prd | Google OAuth client secret -- same project |
| `AUTH_SECRET` | dev + prd | Auth.js session secret -- generate: `openssl rand -base64 32`. Also used to sign agent JWTs. |
| `CREDENTIALS_SECRET` | dev + prd | AES-256 key for bank credentials -- generate: `openssl rand -hex 32` (64 hex chars) |
| `GDRIVE_CLIENT_ID` | dev + prd | Google OAuth2 client ID for Drive (Google Cloud project **`open-banking-chile`**) |
| `GDRIVE_CLIENT_SECRET` | dev + prd | Google OAuth2 client secret for Drive |
| `GDRIVE_REFRESH_TOKEN` | dev + prd | OAuth2 refresh token -- generated via `node scripts/google-drive-auth.mjs` in open-finance-tool |
| `GOOGLE_DRIVE_FOLDER_ID` | dev + prd | Target Drive folder ID (from the folder's URL) |
| `GMAIL_CLIENT_ID` | dev + prd | Google OAuth2 client ID for Gmail 2FA extraction |
| `GMAIL_CLIENT_SECRET` | dev + prd | Google OAuth2 client secret for Gmail |
| `CHROME_PATH` | agent only | Custom Chrome/Chromium path for local agent (optional) |

### Google OAuth (Google Cloud project: `open-banking-chile`)

Authorized redirect URIs -- both must be present in Google Cloud Console -> APIs & Services -> Credentials -> OAuth 2.0 Client:

```
http://localhost:3434/api/auth/callback/google     <- local dev
https://open-banking-chile.vercel.app/api/auth/callback/google  <- production
```

### Supabase (project: `open-banking`)

- **URL**: `https://wcyxlyitcbmeczihaohq.supabase.co`
- **Client**: `@supabase/supabase-js` (PostgREST HTTP API -- required because Supabase's TCP pooler doesn't work from Vercel serverless). `DATABASE_URL` is not used.
- **Realtime**: Enabled for `sync_tasks` and `agent_presence` tables. Browser client uses `NEXT_PUBLIC_SUPABASE_*` env vars via `lib/supabase-browser.ts`.
- **RLS**: Enabled on `sync_tasks` and `agent_presence`. Tables `users`, `bank_credentials`, `movements` use server-side anon key (no RLS).

**Access policy**: any Google account can sign in -- no email whitelist. Do not add `AUTH_WHITELIST_EMAILS`.

### Google Drive export

The `/api/drive` POST endpoint exports all user movements as a multi-sheet XLSX file to a shared Google Drive folder. Uses OAuth2 (not a service account). Each export overwrites the previous file with the same date-based name.

- `GDRIVE_*` env vars must be set in both Doppler `dev` and `prd` configs
- The Drive OAuth2 credentials use a separate Google Cloud client (Desktop app type) from the sign-in OAuth client
- `isDriveConfigured()` returns `false` if any of the four required env vars are missing -- the endpoint returns 503 gracefully

---

## Adding a new bank

1. **Check for an API first** -- inspect the service's Network tab in DevTools for REST/GraphQL endpoints
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

1. **Discover the API** -- Open Chrome DevTools -> Network tab (filter: Fetch/XHR). Log in manually and navigate to movements/portfolio pages.
2. **Identify auth pattern** -- Common patterns found in this project:
   - **Token-based**: POST credentials -> receive token -> use as Bearer header (Fintual)
   - **Cookie jar**: POST credentials -> receive session cookies + CSRF token -> send cookies on every request (Banco de Chile, BancoEstado, Falabella, Santander, Scotiabank)
   - **Firebase Auth**: POST to `identitytoolkit.googleapis.com/v1/accounts:signInWithPassword` -> receive `idToken` (Racional)
   - **Keycloak OIDC**: HTTP login to Keycloak form, exchange auth code for session (BICE)
3. **Map all endpoints** -- Record every XHR request: URL, method, headers, request body, response shape. Add these verbatim to the "Discovered API patterns" section above.
4. **Implement** -- Use `runApiScraper()`, follow `fintual.ts` (simple token), `bchile.ts` (cookie jar), or `bice.ts` (Keycloak + browser fallback) as templates.
5. **Test** -- `node dist/cli.js --bank <id> --pretty` with real credentials.

### Browser-mode scrapers (last resort)

1. **Get to a point** -- Run the scraper and reach the target page (e.g. post-login dashboard).
2. **Scrape page** -- Save HTML with `--screenshots` (writes to `debug/*.html` when enabled).
3. **Analyze scraped HTML** -- Inspect the DOM to identify selectors, menu labels, and structure.
4. **Implement** -- Add or adjust navigation/extraction logic based on findings.
5. **Start again** -- Run scraper, verify, then repeat for the next step.

Do not skip steps 2-3. Do not implement without inspecting the scraped HTML first.

---

## Common issues

- **Chrome not found** -> only needed for browser-mode banks (citi, itau, mercadopago). API-mode banks work without Chrome.
- **Agent not online** -> run `npx open-banking-chile serve` on your computer. Dashboard shows agent status indicator.
- **"Este banco requiere navegador"** -> browser-mode banks cannot run on Vercel. Start the local agent.
- **2FA prompt** -> handled via `onTwoFactorCode` callback. Agentic mode (default ON) auto-extracts from Gmail. Falls back to manual input.
- **0 movements** -> for API-mode: check debug log for HTTP status codes. For browser-mode: use `--screenshots`.
- **Bot detection** -> Itau (Imperva), BICE (Cloudflare), BancoEstado (TLS fingerprint). Use `--profile` for local runs with system Chrome.
- **MercadoPago 0 movements** -> normal for buyer-only accounts. The API only shows seller/wallet activity.
- **Token expired** -> Fintual tokens don't expire within a session. Racional Firebase tokens expire in 1 hour but auto-refresh. Agent tokens last 365 days.
- **Login failed / bad credentials** -> dashboard shows "Actualizar credenciales" button instead of generic retry. Check if credentials are correct in `/banks` page.
- **Cloudflare blocks BICE HTTP login** -> automatic browser fallback handles this. Ensure Chrome is available on the machine running the agent.

---

## Dashboard UX

The web dashboard uses a light theme with teal accent color and Geist fonts. Key design elements:

- **Navigation** (`components/Navigation.tsx`): Sticky top bar with logo, nav links (Dashboard, Movimientos, Analitica, Cuentas, Agente), and sign-out button
- **Per-bank colored cards**: Each bank has a distinct color for visual identification in the dashboard
- **Vista 360**: Bank overview showing all connected accounts with balances and sync status
- **Agent status indicator**: Shows whether the local agent is online (green) or offline (gray)
- **Sync progress**: Real-time progress animation during syncs (Supabase Realtime for agent syncs, SSE for direct API syncs)

---

## Agent team

This project uses specialized agents (`.claude/agents/`) that are automatically delegated to based on the user's request:

| Agent | Role | When invoked |
|-------|------|-------------|
| `bank-{id}` (x15) | Bank-specific expert | Any mention of a bank name, ID, or its scraper |
| `scraping-expert` | Technique expert | API patterns, auth flows, cookie jars, fetch, Playwright |
| `product-manager` | Product decisions | Feature scope, UX, database schema, platform consistency |
| `qa-engineer` | Quality assurance | After every code change -- build, types, compliance, regressions |
| `repo-architect` | Documentation | After major iterations -- AGENTS.md, agent files, memory, structure |

**Delegation is automatic** -- see CLAUDE.md for routing rules.

**Post-iteration protocol**: After every major change, `qa-engineer` runs first (catches bugs), then `repo-architect` runs (updates docs). This is mandatory and should not be skipped.

---

## Security

- All credentials stored with AES-256-GCM encryption (separate IVs per field)
- Agent tokens are JWTs signed with AUTH_SECRET (HS256), valid 365 days, stored in `~/.config/open-banking-chile/agent.json` with mode 0600
- Agent credential API requires valid JWT -- returns decrypted credentials only for the authenticated user
- No credentials transmitted to external servers beyond the bank's own website
- Screenshots may contain sensitive data -- handle with care
- Web dashboard uses JWT-only sessions (no server-side session store)
- Authentication: any Google account can sign in -- no email whitelist is implemented or desired
- Supabase RLS enabled on `sync_tasks` and `agent_presence` tables
