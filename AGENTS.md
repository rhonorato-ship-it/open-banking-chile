# Open Banking Chile

## For all Agents (Claude, Codex, Gemini, etc.)

### What this project does
Open source framework for extracting movements and balances from Chilean banks. Direct API calls (preferred) or Playwright browser automation (last resort). Multi-user web dashboard on Vercel + local sync agent on user's computer.

### Architecture

1. **npm package** (`open-banking-chile`) -- Scraper library on npm
2. **Web dashboard** (`web/`) -- Next.js 15 on Vercel. Auth, credentials, movements, analytics. Does NOT run browser-mode scrapers.
3. **Local sync agent** (`src/agent.ts`) -- `npx open-banking-chile serve`. Runs all scrapers, uploads to Supabase via Realtime.

**Sync flow:** User clicks sync → dashboard inserts `sync_tasks` (pending) → agent claims via Realtime (running) → scrapes + uploads → marks done. API-mode banks also run directly on Vercel via `/api/scrape/[bankId]` SSE endpoint.

### Deployment
- **URL**: https://open-banking-chile.vercel.app
- **Deploy**: `vercel --prod` from repo root. **Always deploy after every commit.**
- **npm**: `open-banking-chile` v2.1.3

### Supported institutions (15)

| ID | Name | Mode | Pattern | Notes |
|---|---|---|---|---|
| bchile | Banco de Chile | api | cookie-jar-xsrf | 11 REST endpoints |
| edwards | Banco Edwards | api | cookie-jar-xsrf | Delegates to bchile |
| bci | BCI | api | cookie-jar-xsrf | JSF ViewState variant |
| bestado | BancoEstado | api | cookie-jar-xsrf | Akamai TLS may block |
| bice | BICE | api | keycloak-oidc | Browser fallback for Cloudflare |
| falabella | Banco Falabella | api | cookie-jar-xsrf | Account + CMR credit card |
| santander | Santander | api | cookie-jar-xsrf | Multi-account, push 2FA |
| scotiabank | Scotiabank | api | cookie-jar-xsrf | Historical via SCOTIABANK_MONTHS |
| mach | MACH | api | token-auth | Device-bound, BCI subsidiary |
| tenpo | Tenpo | api | token-auth | Skeleton, not discovered |
| fintual | Fintual | api | token-auth | Public REST API |
| racional | Racional | api | firebase-auth | Firebase Auth + Firestore |
| citi | Citibank | browser | browser-scraping | ThreatMetrix, E2E encrypted pw |
| itau | Itaú | browser | browser-scraping | Imperva, no JSON APIs |
| mercadopago | MercadoPago | browser | browser-scraping | JS device fingerprint (dps) |

Bank-specific API details: `.claude/agents/bank-{id}.md`. Scraping patterns: `.claude/skills/scraping/`.

---

## Scraper strategy (API-first -- MANDATORY)

**Chromium is a last resort.** Priority: (1) Direct `fetch()` API, (2) API-first + browser fallback for auth, (3) Browser with `--profile`, (4) Headless on local agent.

### Data requirements
- **First sync**: ≥24 months history
- **Balance**: MUST return in ScrapeResult
- **Dedup**: SHA256 hash prevents duplicates
- **Credential errors**: Return clear error → dashboard shows "Actualizar credenciales"

### Before writing ANY scraper
1. Chrome DevTools → Network tab, log in manually, observe XHR/Fetch
2. Look for JSON APIs, Swagger docs (`/api-docs`, `/swagger.json`)
3. Check mobile app traffic
4. Only consider browser after confirming NO usable API

### 2FA & Anti-bot
Per-institution 2FA table and flow details: `.claude/skills/security/two-factor-handling.md`
Anti-bot: Itaú (Imperva), Citi (ThreatMetrix), BancoEstado (Akamai TLS), BICE (Cloudflare, auto-fallback), BCI (JSF ViewState).

### Key files
`src/infrastructure/api-runner.ts` (API runner), `scraper-runner.ts` (browser runner), `browser.ts` (Playwright), `src/agent.ts` (local agent), `src/agent-auth.ts` (config persistence).

---

## Local sync agent

`npx open-banking-chile serve` -- first run prompts for JWT token (HS256, 365-day, signed with `AUTH_SECRET`). Saved to `~/.config/open-banking-chile/agent.json` (mode 0600).

**Lifecycle:** Start → Heartbeat (`agent_presence` every 30s) → Listen (`sync_tasks` Realtime INSERT) → Claim + Execute + Upload → Shutdown (SIGINT/SIGTERM).

**Tables:** `sync_tasks` (status: pending/running/done/error/expired, phase, requires_2fa), `agent_presence` (heartbeat, banks[]). Both RLS + Realtime enabled.

---

## Setup & Running

```bash
npm install && npm run build && cp .env.example .env
node dist/cli.js --bank falabella --pretty          # CLI
npx open-banking-chile serve                         # Local agent
doppler run --config dev -- npm run dev --prefix web  # Dashboard dev
vercel --prod                                        # Deploy (MANDATORY after every commit)
```

**Secrets:** Doppler project `open-banking-chile` (configs: `dev`, `prd`). Exception: `SUPABASE_URL` + `SUPABASE_ANON_KEY` also in Vercel dashboard for build time.

**Key env vars:** `AUTH_SECRET` (session + agent JWT), `CREDENTIALS_SECRET` (AES-256 key, 64 hex), `AUTH_GOOGLE_ID/SECRET`, `SUPABASE_URL/ANON_KEY`, `GDRIVE_*/GMAIL_*` (optional integrations).

---

## Adding a new bank

1. Check for API first (DevTools Network tab)
2. Create `src/banks/{id}.ts` → `runApiScraper()` (API) or `runScraper()` (browser)
3. Register in `src/index.ts`
4. Add env vars to `.env.example`, bank name to `BANK_NAMES` in `web/app/movements/page.tsx`

Or use the `/add-bank` command for a guided workflow.

---

## Agent team

| Agent | When invoked |
|---|---|
| `bank-{id}` (x15) | Bank name, ID, or scraper mentioned |
| `scraping-expert` | API patterns, auth flows, cookie jar, Playwright |
| `product-manager` | Feature scope, UX, database schema |
| `qa-engineer` | After code changes -- default FAIL, must prove PASS with evidence |
| `repo-architect` | After major iterations -- docs, agent files |
| `movement-classifier` | Category, transfer detection, normalization |
| `security-auditor` | Auth, encryption, token changes |
| `api-architect` | Endpoint design, SSE, error responses |
| `ux-designer` | Components, design system, a11y |
| `data-integrity` | Hash, balance, dedup, migration |
| `analytics-engineer` | Charts, aggregation, coach rules |
| `realtime-engineer` | SSE, Supabase Realtime, presence, sync |
| `financial-domain` | RUT, CLP, dates, bank quirks |
| `plan-keeper` | Sprint gate -- default BLOCKED, verifies scope + regression on prior work |
| `roadmap-keeper` | Roadmap governance -- sole authority over ROADMAP.md, challenges off-roadmap work |

**Post-iteration:** qa-engineer (default FAIL, adversarial audit), then repo-architect (docs). Both mandatory. Plan-keeper gates all sprint work (scope + regression).

**Roadmap:** All work must trace to an R-number in `ROADMAP.md`. Roadmap-keeper is the sole modifier (enforced via hook). History in `ROADMAP_HISTORY.md`.

**Skills:** `.claude/skills/` -- scraping (5), financial (5), security (3), infra (4), ux (2), conventions (2).

**Commands:** `/sync-docs`, `/add-bank`, `/review-scraper`, `/status`, `/qa`, `/review-security`.

---

## Security

- Credentials: AES-256-GCM, separate IVs per field
- Agent tokens: JWT HS256, 365 days, stored mode 0600
- No credentials sent beyond the bank's own website
- JWT-only sessions (no server-side store)
- RLS on `sync_tasks` + `agent_presence`
- Any Google account can sign in (no whitelist)
