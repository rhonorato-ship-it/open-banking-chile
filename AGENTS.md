# Open Banking Chile

## For all Agents (Claude, Codex, Gemini, etc.)

### What this project does
Open source scraping framework for Chilean banks. Extracts account movements and balances as JSON using Puppeteer (headless Chrome). Includes a multi-user web dashboard deployed on Vercel with Google OAuth.

### Live deployment
- **Production URL**: https://open-banking-chile.vercel.app
- **Vercel project**: `open-banking-chile` (org: `rhonorato-ship-its-projects`)
- **Vercel project ID**: `prj_ovBTOzwEpedmlf6JILFlKtbf6hBN`
- **Deploy command**: run `vercel --prod` from repo root (not from `web/` — root dir is configured as `web` in Vercel settings)
- **npm package**: `open-banking-chile` (latest: v2.1.2, publisher: `rhonorato`)

### Supported banks (13)
- Banco de Chile (`bchile`)
- BCI (`bci`)
- BancoEstado (`bestado`)
- BICE (`bice`)
- Citibank (`citi`)
- Banco Edwards (`edwards`)
- Banco Falabella (`falabella`)
- Fintual (`fintual`) — **API mode** (no browser)
- Itaú (`itau`)
- MercadoPago (`mercadopago`)
- Racional (`racional`)
- Santander (`santander`)
- Scotiabank (`scotiabank`)

---

## Scraper strategy (API-first)

When adding or fixing a scraper, follow this priority order:

1. **API first** — If the service has a REST/GraphQL API, use `fetch()` via `runApiScraper()` from `src/infrastructure/api-runner.ts`. No browser, no Puppeteer, no Chromium. Set `mode: "api"` on the `BankScraper`. Example: Fintual uses `POST /api/access_tokens` + `GET /api/goals`.

2. **Browser with user's Chrome profile** — If a browser is needed (no known API, complex JS rendering), prefer the user's system Chrome with `userDataDir` for local/CLI usage. This leverages existing cookies, sessions, and saved passwords. Use `--profile` flag in CLI.

3. **Headless Chromium** — Last resort, used on Vercel/Lambda via `@sparticuz/chromium`. Only for traditional banks with no API alternative.

**When to open a browser window:**
- The service has no usable API
- Authentication requires 2FA, CAPTCHA, or OAuth that can't be done via API
- The scraper should automate everything — minimize manual user interaction

**When NOT to open a browser:**
- The service has a REST API (even if undocumented — check DevTools Network tab)
- Auth is email+password with a token response
- Data is available as JSON from API endpoints

**Key files:**
- `src/infrastructure/api-runner.ts` — Browser-free runner for API scrapers
- `src/infrastructure/scraper-runner.ts` — Browser-based runner for traditional scrapers
- `src/infrastructure/browser.ts` — Puppeteer launch with `userDataDir` support

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
  actions/
    login.ts               — Generic login (RUT formats, password, submit, error detection)
    navigation.ts          — DOM navigation (click by text, sidebars, banner dismissal)
    extraction.ts          — Movement extraction from HTML tables with fallbacks
    pagination.ts          — Multi-page iteration (Siguiente, Ver más)
    credit-card.ts         — Credit card movement extraction (tabs, billing periods)
    balance.ts             — Balance extraction (regex + CSS selector fallbacks)
    two-factor.ts          — 2FA detection and wait (configurable keywords/timeout)
  banks/
    falabella.ts, bchile.ts, bci.ts, bestado.ts, bice.ts,
    edwards.ts, itau.ts, santander.ts, scotiabank.ts, citi.ts,
    fintual.ts (API mode), mercadopago.ts, racional.ts

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

When extending or debugging a bank scraper, follow this procedure:

1. **Get to a point** — Run the scraper and reach the target page (e.g. post-login dashboard).
2. **Scrape page** — Save HTML with `--screenshots` (writes to `debug/*.html` when enabled).
3. **Analyze scraped HTML** — Inspect the DOM to identify selectors, menu labels, and structure.
4. **Implement** — Add or adjust navigation/extraction logic based on findings.
5. **Start again** — Run scraper, verify, then repeat for the next step.

Do not skip steps 2–3. Do not implement without inspecting the scraped HTML first.

---

## Common issues

- **Chrome not found** → install Chrome or set `CHROME_PATH`
- **2FA prompt** → cannot be automated; bank security feature
- **0 movements** → use `--screenshots` to debug DOM structure
- **Bot detection** → some banks (Citi) require headed mode; `--screenshots` also helps diagnose

---

## Security

- All credentials stored with AES-256-GCM encryption (separate IVs per field)
- No credentials transmitted to external servers beyond the bank's own website
- Screenshots may contain sensitive data — handle with care
- Web dashboard uses JWT-only sessions (no server-side session store)
- Authentication: any Google account can sign in — no email whitelist is implemented or desired
