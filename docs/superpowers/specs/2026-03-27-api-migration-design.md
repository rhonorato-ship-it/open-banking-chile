# API Migration Design — Browser-to-API for 8 Bank Scrapers

**Date**: 2026-03-27
**Status**: Approved
**Scope**: Migrate all 8 browser-based scrapers to API mode where feasible

---

## Goal

Convert all browser-based (Puppeteer) bank scrapers to pure `fetch()` API scrapers, eliminating the Chromium dependency. Banks where pure API is impossible due to anti-bot protections stay `mode: "browser"` with documented rationale.

## Banks to Migrate (priority order)

| # | Bank | Difficulty | Testable | Auth Pattern | Anti-Bot |
|---|------|-----------|----------|-------------|----------|
| 1 | BICE | Easy | Yes | Keycloak OAuth2 | Homepage 403 only |
| 2 | Citi | Hard | Yes | ioBlackBox + form | ThreatMetrix |
| 3 | Falabella | Medium | No | Standard form | None |
| 4 | Scotiabank | Medium | No | Standard form | None |
| 5 | Santander | Medium-High | No | Login iframe + form | None |
| 6 | Itau | Hard | No | WPS portal form | Imperva |
| 7 | BCI | Hard | No | JSF form (body+dv) | None |
| 8 | BancoEstado | Very Hard | No | Angular + headful | Akamai TLS fingerprint |

## Design Decisions

### Cookie jar: inline per scraper (not shared)

Each scraper keeps its own `CookieJar` implementation (~20 lines). Rationale:
- Banks differ in cookie semantics (Spring Security XSRF, Keycloak bearer, plain session)
- Self-contained files are easier to understand and debug
- Bug in one bank's cookie handling can't break another
- Duplication is trivial (20 lines) vs abstraction risk

### 2FA: no infrastructure change

The existing `onTwoFactorCode` callback in `ScraperOptions` works identically for API scrapers. When the login response indicates 2FA, the scraper calls the callback and waits — same as browser scrapers do today.

### Fallback: browser mode stays for impossible cases

Banks with anti-bot measures that specifically target non-browser TLS fingerprints or device fingerprinting may stay `mode: "browser"`. This is documented per-bank, not treated as a failure.

---

## Per-Bank Design

### 1. BICE (Easy — testable)

**Auth**: Keycloak OAuth2 token exchange.

Flow:
1. `GET https://portalpersonas.bice.cl` — follow redirects to `auth.bice.cl/auth/realms/personas/protocol/openid-connect/auth?...`
2. Parse the Keycloak login page HTML to extract the form `action` URL (contains session code)
3. `POST` to that action URL with `username={rut}&password={password}` as `application/x-www-form-urlencoded`
4. Follow redirect chain back to `portalpersonas.bice.cl` — collect session cookies in jar
5. Authenticated session established

**Data**: The Angular SPA at `portalpersonas.bice.cl` fetches from REST APIs. Endpoints to discover:
- Account list / balance
- Current month movements (paginated)
- Historical movements by period

Current DOM selectors hint at data shape:
- `div.transaction-table__container table` — date, category, description, amount (4 columns)
- `ds-table table` / `lib-credits-and-charges table` — historical (5 columns: date, category, N/A, description, amount)
- Balance from `h2.cabeceraCard2`

**2FA**: Push/SMS. If POST response returns a 2FA challenge page instead of redirect, call `onTwoFactorCode`, then POST the code to the challenge form's action URL.

**Expected endpoint patterns** (to discover via Network tab):
- `GET /api/cuentas` or `/api/productos` — account list
- `GET /api/movimientos?periodo=actual` — current movements
- `GET /api/movimientos?periodo={id}` — historical movements

### 2. Citi (Hard — testable)

**Blocker**: ThreatMetrix `ioBlackBox` device fingerprint field.

**Strategy — try two options in order**:

**Option 1 — Direct POST without ioBlackBox**:
1. `GET https://www.citi.com` — collect initial cookies
2. Find the login form POST endpoint (from page source)
3. `POST` with `username` + `password` (no ioBlackBox)
4. If login succeeds → full API migration

**Option 2 — Hybrid (browser login → API data)**:
If Option 1 fails, keep browser for login only. After login, use the REST endpoints:
- `POST /US/REST/accountsPanel/getCustomerAccounts.jws` — account list
- `GET /US/NCSC/dcd/StatementDownload.do?fromDate=...&toDate=...&downloadType=CSV` — movement CSV

The existing `parseCitiCsv()` function moves unchanged to the API scraper.

**2FA**: SMS/Email. If login response indicates 2FA, call `onTwoFactorCode`.

**Outcome**: If Option 1 works → `mode: "api"`, full rewrite to `runApiScraper`. If only Option 2 works → stays `mode: "browser"` with `runScraper`, but the data extraction phase switches from DOM scraping to in-browser `fetch()` calls to the REST/CSV endpoints (reducing fragility). The scraper file is still rewritten but keeps Puppeteer for login.

### 3. Falabella (Medium — no credentials)

**Auth**: Cookie jar with form login.

Flow:
1. `GET https://www.bancofalabella.cl` — collect initial cookies
2. Discover login POST endpoint from the Angular SPA (likely `/api/auth/login` or similar)
3. `POST` with RUT + password as JSON or form-urlencoded
4. Follow redirects, collect session cookies

**Data** — two phases:
- **Account movements**: REST API behind Angular SPA. Current scraper uses `extractAccountMovements` + `paginateAndExtract` from generic actions — the data feeds from an API endpoint.
- **CMR credit card**: The `<credit-card-movements>` Shadow DOM component fetches from APIs. Endpoints serve:
  - Card cupos (total/used/available)
  - Unbilled movements ("por facturar")
  - Billed movements ("facturados")
  - Owner filter support

**2FA**: SMS. `onTwoFactorCode` callback.

**Deliverable**: Complete scraper with auth flow coded, data endpoints as best-guess URLs with comments marking what needs live testing.

### 4. Scotiabank (Medium — no credentials)

**Auth**: Cookie jar with form login.

Flow:
1. `GET https://www.scotiabank.cl` — collect cookies
2. Click login equivalent: discover the auth POST endpoint
3. `POST` with RUT (dash format: `12345678-9`) + password
4. Collect session cookies

**Data**: Shadow DOM in the browser scraper is purely UI. The REST APIs behind it serve:
- Account movements (with pagination)
- Historical movements by date range (the `fillAndSubmitDateRange` function hints at parameterized API)
- Balance

Current DOM extraction uses `allDeepJs()` to pierce Shadow DOM — this is irrelevant for API mode.

**2FA**: Dynamic key (code entry). `onTwoFactorCode` callback.

### 5. Santander (Medium-High — no credentials)

**Auth**: Cookie jar. The login iframe (`iframe#login-frame`) posts to an auth endpoint.

Flow:
1. `GET https://banco.santander.cl/personas` — collect cookies
2. Discover the login POST endpoint (the iframe's form action)
3. `POST` with RUT (clean format) + password
4. Collect session cookies

**Data**: Angular SPA with:
- Multi-account support (Swiper carousel → API has account list endpoint)
- Account movements per account (paginated)
- Credit card movements: unbilled ("por facturar") + billed ("facturados")

Sidebar menu IDs (`#menu-uid-0410`, etc.) are UI-only, irrelevant for API mode.

**2FA**: Push (wait only). `onTwoFactorCode` callback with push detection.

### 6. Itau (Hard — no credentials)

**Auth**: Cookie jar targeting IBM WPS portal.

Flow:
1. `GET https://banco.itau.cl/wps/portal/newolb/web/login` — collect cookies, check for Imperva block
2. If Imperva blocks Node.js `fetch()` → stays browser mode
3. If not blocked: `POST` login with `loginNameID` (formatted RUT) + `pswdId` (password)
4. Handle reCAPTCHA v3 — if it requires browser-side JS execution, this blocks API migration

**Data**: WPS portal URLs are structured and may have REST equivalents:
- `/wps/myportal/newolb/web/cuentas/cuenta-corriente/saldos` — balance
- `/wps/myportal/newolb/web/cuentas/cuenta-corriente/saldos-ultimo-movimiento` — movements
- `/wps/myportal/newolb/web/tarjeta-credito/resumen/deuda` — CC summary
- `/wps/myportal/newolb/web/tarjeta-credito/resumen/cuenta-nacional` — CC billed

Movement table has 6 columns: date, description, cargo, abono, saldo, (extra).

**2FA**: Itau Key push (wait only).

**Risk**: Imperva + reCAPTCHA v3 may block API migration entirely. If so, stays `mode: "browser"`.

### 7. BCI (Hard — no credentials)

**Auth**: Cookie jar with JSF form.

Flow:
1. `GET https://www.bci.cl/corporativo/banco-en-linea/personas` — collect cookies
2. Parse JSF form: extract `javax.faces.ViewState` hidden field
3. `POST` form with `rut` (body), `dig` (check digit), `clave` (password), `javax.faces.ViewState`
4. Follow redirects, collect session cookies

**Data**: JSF iframes (`miBanco.jsf`, `fe-saldosultimosmov`, `fe-mismovimientos`) are server-rendered. If no XHR/fetch calls exist behind the scenes, BCI stays browser-mode.

Fallback plan: Even if full API migration fails, we could do hybrid (browser login → navigate to iframe → extract from rendered HTML via the session cookies + fetch of the iframe URLs).

Movement table: date, description, cargo, abono (4 columns). Credit card combinations: Nacional$/Internacional USD x Facturados/No facturados.

**2FA**: BCI Pass push (wait only).

**Risk**: JSF portals are notoriously server-rendered. Highest probability of staying `mode: "browser"`.

### 8. BancoEstado (Very Hard — no credentials)

**Auth**: Cookie jar targeting Angular SPA.

Flow:
1. `GET https://www.bancoestado.cl/content/bancoestado-public/cl/es/home/home.html#/login` — collect cookies
2. Discover login POST endpoint from Angular app
3. `POST` with RUT + password

**Data**: Angular SPA serves CuentaRUT data:
- Balance (regex patterns: `cuentarut`, `saldo disponible`)
- Movements (HTML table with date/description/amount/balance columns)
- Pagination ("siguiente", "ver más", "cargar más")

**Blocker**: `forceHeadful: true` requirement — Akamai bot protection uses TLS fingerprinting. Node.js `fetch()` has a fundamentally different TLS fingerprint than Chrome. This is the hardest anti-bot measure to bypass without a browser.

**Risk**: Highest probability of staying `mode: "browser"`. The API scraper will be written but may not work without TLS fingerprint spoofing.

---

## Implementation Approach

1. **Sequential, priority-ordered** — BICE first (easiest, testable), then Citi, then the rest
2. **Each bank is a standalone commit** — one scraper file rewritten per commit
3. **Cookie jars inline** — no shared abstraction
4. **2FA via existing callback** — no infrastructure changes
5. **Test with credentials** — BICE and Citi tested live; others compile-tested only
6. **Banks that can't migrate stay browser-mode** — documented with rationale in AGENTS.md

## Per-bank deliverable

Each migrated scraper:
- Imports `runApiScraper` from `api-runner.ts` (not `runScraper`)
- Removes all `puppeteer-core` imports
- Has `mode: "api"` on the `BankScraper` export
- Has inline `CookieJar` implementation
- Has auth flow fully coded
- Has data endpoints with comments where URLs are best-guess (untested banks)
- Has 2FA handling via `onTwoFactorCode` callback
- Compiles with `npm run build` and `npx tsc --noEmit`

## QA checklist (per bank)

1. `npm run build` succeeds
2. `cd web && npx tsc --noEmit` passes
3. No `puppeteer-core` imports remain in the rewritten file
4. `mode: "api"` is set on the export
5. `runApiScraper` used (not `runScraper`)
6. For testable banks (BICE, Citi): run with real credentials
7. AGENTS.md updated with new API patterns
8. Bank agent file updated

## What stays browser-mode (expected)

- **BancoEstado**: Akamai TLS fingerprinting — very likely stays browser
- **BCI**: JSF server-rendered iframes — likely stays browser
- **Itau**: Imperva + reCAPTCHA — may stay browser
- **Citi**: If ioBlackBox is mandatory — stays browser (hybrid: browser login + API data)

These are not failures — they're documented decisions based on technical constraints.
