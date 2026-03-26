# Open Banking Chile

## For all Agents (Claude, Codex, Gemini, etc.)

### What this project does
Open source scraping framework for Chilean banks. Extracts account movements and balances as JSON using Puppeteer (headless Chrome). Includes a multi-user web dashboard deployed on Vercel with Google OAuth.

### Live deployment
- **Production URL**: https://open-banking-chile.vercel.app
- **Vercel project**: `open-banking-chile` (org: `rhonorato-ship-its-projects`)
- **Vercel project ID**: `prj_ovBTOzwEpedmlf6JILFlKtbf6hBN`
- **Deploy command**: run `vercel --prod` from repo root (not from `web/` — root dir is configured as `web` in Vercel settings)
- **npm package**: `open-banking-chile` (latest: v2.1.1, publisher: `rhonorato`)

### Supported banks (10)
- Banco de Chile (`bchile`)
- BCI (`bci`)
- BancoEstado (`bestado`)
- BICE (`bice`)
- Citibank (`citi`)
- Banco Edwards (`edwards`)
- Banco Falabella (`falabella`)
- Itaú (`itau`)
- Santander (`santander`)
- Scotiabank (`scotiabank`)

---

## Project structure

```
src/
  index.ts                 — Registry of all banks, getBank(), listBanks()
  types.ts                 — BankScraper interface, BankMovement, ScrapeResult, ScraperOptions
  utils.ts                 — Shared utilities (formatRut, findChrome, parseChileanAmount, normalizeDate, etc.)
  cli.ts                   — CLI entry point (--bank, --list, --pretty, --movements)
  infrastructure/
    browser.ts             — Centralized browser launch, session management, anti-detection
    scraper-runner.ts      — Execution pipeline: validate → launch → scrape → logout → cleanup
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
    edwards.ts, itau.ts, santander.ts, scotiabank.ts, citi.ts

web/                       — Next.js 15 multi-user dashboard (App Router)
  app/
    dashboard/             — Balance hero, bank cards with skeleton loaders, sync buttons, toast notifications
    banks/                 — Add / edit / remove bank credentials (self-contained BankRow, inline delete confirm)
    movements/             — Transaction history: text search, sortable columns, pagination (50/page), monthly chart
    login/                 — Google OAuth sign-in
    api/
      banks/               — CRUD for encrypted bank credentials
      movements/           — Query movements with filters (bankId, from, to); limit 500
      scrape/[bankId]/     — SSE endpoint: runs scraper, streams progress phases
  components/
    ScrapeProgress.tsx     — Full-screen phase animation; retry re-initialises SSE (no page reload)
  lib/
    auth.ts                — Auth.js v5 (Google OAuth, JWT, email whitelist)
    db.ts                  — Drizzle ORM + postgres driver
    schema.ts              — users, bank_credentials, movements tables
    credentials.ts         — AES-256-GCM encrypt/decrypt for stored credentials
    hash.ts                — SHA-256 deduplication hash for movements
  middleware.ts            — Route protection (redirect to /login if unauthenticated)
  drizzle.config.ts        — Drizzle Kit config (reads DATABASE_URL)
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
source .env && node dist/cli.js --bank falabella --pretty
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

Required env vars (managed via Doppler project `open-banking-chile`, config `dev` for local / `prd` for production):
- `DATABASE_URL` — Postgres connection string (Supabase session pooler, port 5432)
- `AUTH_URL` — Canonical app URL (`http://localhost:3434` for dev, `https://open-banking-chile.vercel.app` for prd)
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — Google OAuth credentials
- `AUTH_SECRET` — Auth.js session secret (base64, 32 bytes)
- `CREDENTIALS_SECRET` — AES-256 key for bank credentials (hex, 64 chars = 32 bytes)

**Access policy**: any Google account can sign in — there is no email whitelist. Access control is purely "authenticated with Google OAuth". Do not add `AUTH_WHITELIST_EMAILS` back.

> Doppler syncs env vars to Vercel. Do not edit Vercel env vars manually — always update Doppler prd config instead.

---

## Adding a new bank

1. Create `src/banks/<bank-id>.ts` implementing `BankScraper`
2. Use `runScraper()` from infrastructure and compose actions from `src/actions/`
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
