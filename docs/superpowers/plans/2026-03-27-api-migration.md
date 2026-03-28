# API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate 8 browser-based bank scrapers to API mode using `fetch()` and cookie jars, eliminating Chromium dependency.

**Architecture:** Each bank scraper is rewritten as a self-contained API scraper following the bchile.ts pattern: inline CookieJar, `runApiScraper()`, `mode: "api"`. Banks where API migration proves impossible stay `mode: "browser"` with documented rationale.

**Tech Stack:** Node.js `fetch()`, cookie jar pattern, Keycloak OAuth2 (BICE), form-urlencoded POST auth, `runApiScraper` from `src/infrastructure/api-runner.ts`

**Design spec:** `docs/superpowers/specs/2026-03-27-api-migration-design.md`

---

## File Structure

| # | Bank | File | Action |
|---|------|------|--------|
| 1 | BICE | `src/banks/bice.ts` | Rewrite (browser to API) |
| 2 | Citi | `src/banks/citi.ts` | Rewrite (browser to API, or hybrid) |
| 3 | Falabella | `src/banks/falabella.ts` | Rewrite (browser to API) |
| 4 | Scotiabank | `src/banks/scotiabank.ts` | Rewrite (browser to API) |
| 5 | Santander | `src/banks/santander.ts` | Rewrite (browser to API) |
| 6 | Itau | `src/banks/itau.ts` | Rewrite (browser to API) |
| 7 | BCI | `src/banks/bci.ts` | Rewrite (browser to API) |
| 8 | BancoEstado | `src/banks/bestado.ts` | Rewrite (browser to API) |
| 9 | AGENTS.md | `AGENTS.md` | Update bank modes and API patterns |

No new files created. No shared abstractions. Each scraper is self-contained.

**Reference implementation:** `src/banks/bchile.ts` (the canonical API scraper pattern).

**Build check command:** `npm run build && cd web && npx tsc --noEmit`

**Utility functions available** (from `src/utils.ts`): `formatRut`, `normalizeDate`, `parseChileanAmount`, `deduplicateMovements`, `normalizeInstallments`, `normalizeOwner`, `delay`

**API runner** (from `src/infrastructure/api-runner.ts`): `runApiScraper(bankId, options, scrapeFn)` handles credential validation and error wrapping.

---

## Common patterns

Every migrated scraper follows these patterns. Do NOT deviate.

**Imports:**
```typescript
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements, parseChileanAmount } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";
```

Add `formatRut`, `normalizeInstallments`, `normalizeOwner` from utils as needed per bank.

**CookieJar (inline, per scraper):**
```typescript
interface CookieJar {
  cookies: Map<string, string>;
  set(raw: string): void;
  setAll(headers: Headers): void;
  header(): string;
}

function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    cookies,
    set(raw: string) {
      const [nameValue] = raw.split(";");
      const eqIdx = nameValue.indexOf("=");
      if (eqIdx > 0) cookies.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim());
    },
    setAll(headers: Headers) {
      const setCookies = headers.getSetCookie?.() ?? [];
      for (const raw of setCookies) this.set(raw);
    },
    header() {
      return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}
```

**User-Agent:**
```typescript
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
```

**Export pattern:**
```typescript
const bankId: BankScraper = {
  id: "bankId",
  name: "Bank Name",
  url: "https://...",
  mode: "api",
  scrape: (options) => runApiScraper("bankId", options, scrapeFn),
};
export default bankId;
```

**Main scrape function signature:**
```typescript
async function scrapeBank(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult>
```

**Redirect-following helper (used for cookie collection):**
```typescript
async function followRedirects(jar: CookieJar, startUrl: string, maxRedirects = 10): Promise<string> {
  let location: string | null = startUrl;
  let lastBody = "";
  while (location && maxRedirects-- > 0) {
    const res = await fetch(location, {
      headers: { "User-Agent": UA, "Cookie": jar.header() },
      redirect: "manual",
    });
    jar.setAll(res.headers);
    const next = res.headers.get("location");
    if (res.status === 200) lastBody = await res.text();
    location = next;
  }
  return lastBody;
}
```

---

## Task 1: BICE (Keycloak OAuth2, testable)

**Files:**
- Rewrite: `src/banks/bice.ts`

Auth: GET portal triggers Keycloak redirect. Parse form action URL from Keycloak HTML. POST credentials. Follow redirect chain to establish session. Data endpoints are best-guess (need Chrome DevTools discovery).

- [ ] **Step 1: Read reference scraper for patterns**

Read `src/banks/bchile.ts` fully to understand the canonical API scraper structure: CookieJar, apiGet/apiPost helpers, login flow, data fetching, export.

Read `src/banks/bice.ts` fully to understand the current browser-based logic: Keycloak form at `auth.bice.cl` with `#username`, `#password`, `#kc-login`. Data from `div.transaction-table__container table` (4 cols: date, category, description, amount). Historical periods via `ds-dropdown`.

- [ ] **Step 2: Write the API scraper**

Rewrite `src/banks/bice.ts` with the full API implementation. The scraper must:

1. GET `https://portalpersonas.bice.cl` with `redirect: "follow"` to land on Keycloak
2. Parse `<form action="...">` from the Keycloak HTML to get the session-coded action URL
3. POST `username` (clean RUT, no dots/dash) + `password` as form-urlencoded to that action URL with `redirect: "manual"`
4. Follow the redirect chain back to portal, collecting cookies at each hop
5. Handle 2FA: if still on Keycloak after POST (status 200), check for 2FA page. If found, call `onTwoFactorCode()`, POST the code to the 2FA form action
6. Handle login errors: check for "Invalid username or password" or "kc-feedback-text" in response
7. Fetch balance from Angular SPA REST API (candidate URLs: `/api/cuentas/saldo`, `/api/productos/cuentas/saldos`, `/api/cuentas`)
8. Fetch movements from REST API (candidate URLs: `/api/movimientos`, `/api/cuentas/movimientos`, `/api/cartola/movimientos`)
9. Parse movements: date, description, amount (negative if category includes "cargo"), balance, source = account
10. Deduplicate and return

Use `API_BASE = "https://portalpersonas.bice.cl/api"` for data endpoints.

Include `apiGet<T>` and `apiPost<T>` helper functions that set User-Agent, Cookie, Accept headers and call `jar.setAll()` on response.

For data endpoints, try multiple candidate URLs in order (try/catch with continue) since exact paths need live discovery. Log which endpoint was found.

- [ ] **Step 3: Build and type check**

Run: `npm run build && cd web && npx tsc --noEmit`
Expected: Both succeed with 0 errors.

- [ ] **Step 4: Live test with credentials**

Run: `node dist/cli.js --bank bice --pretty`

Outcomes:
- Login succeeds, movements returned: done, update endpoints to confirmed URLs
- Login succeeds, data endpoints 404: use Chrome DevTools Network tab to discover real endpoints, update URLs, rebuild and retest
- Keycloak form parsing fails: add more debugLog around the redirect chain, check if the form action regex needs adjustment

- [ ] **Step 5: Commit**

```bash
git add src/banks/bice.ts
git commit -m "feat(bice): migrate scraper from browser to API mode

Keycloak OAuth2 login via fetch + cookie jar. Data endpoints
are best-guess, need confirmation with live credentials."
```

---

## Task 2: Citi (REST API + ioBlackBox, testable)

**Files:**
- Rewrite: `src/banks/citi.ts`

Auth: GET homepage for cookies, GET signon page for CSRF tokens, POST login without ioBlackBox (test if it works). Data: REST account list + CSV download (both endpoints already known from browser scraper).

- [ ] **Step 1: Read current browser scraper**

Read `src/banks/citi.ts` fully. Note:
- Login form is in an iframe, fields: `#username`, `[name="password"]`
- ioBlackBox waiting logic in `waitForIoBlackBox()`
- 2-step login: username first, then "Next" button, then password
- REST endpoint: `POST /US/REST/accountsPanel/getCustomerAccounts.jws`
- CSV download: `GET /US/NCSC/dcd/StatementDownload.do?fromDate=...&toDate=...&downloadType=CSV`
- `parseCitiCsv()` function can be reused directly

- [ ] **Step 2: Write the API scraper**

Rewrite `src/banks/citi.ts`. The scraper must:

1. GET `https://www.citi.com` for initial cookies
2. GET `https://online.citi.com/US/login.do` for signon page HTML
3. Parse form action URL and hidden fields (CSRF tokens) from signon HTML
4. POST login with username + password + hidden fields (NO ioBlackBox) as form-urlencoded
5. Follow redirects, collecting cookies
6. Check for errors ("incorrect", "invalid", "failed", "try again") in response body
7. Check for 2FA ("verification code", "one-time", "verify your identity"). If found, call `onTwoFactorCode()`, POST code
8. Fetch account list: `POST /US/REST/accountsPanel/getCustomerAccounts.jws` with `Content-Type: application/json`, body `{}`
9. Download CSV: `GET /US/NCSC/dcd/StatementDownload.do?fromDate=MM/DD/YYYY&toDate=MM/DD/YYYY&downloadType=CSV` (last 3 months)
10. Parse CSV with `parseCitiCsv()` (copy from original: split by newlines, skip header, split by comma, strip quotes, normalizeDate, parseChileanAmount)

Constants: `LOGIN_URL = "https://www.citi.com"`, `SIGNON_URL = "https://online.citi.com/US/login.do"`, `API_BASE = "https://online.citi.com"`

- [ ] **Step 3: Build and type check**

Run: `npm run build && cd web && npx tsc --noEmit`
Expected: Both succeed.

- [ ] **Step 4: Live test with credentials**

Run: `node dist/cli.js --bank citi --pretty`

Outcomes:
- Login works without ioBlackBox: keep `mode: "api"`
- Login fails (ioBlackBox required): revert `src/banks/citi.ts` to the original browser version from git (`git checkout src/banks/citi.ts`), but update the data extraction to use REST/CSV instead of DOM scraping where possible

- [ ] **Step 5: Commit**

```bash
git add src/banks/citi.ts
git commit -m "feat(citi): migrate scraper to API mode

Direct login + CSV download via fetch. If ioBlackBox blocks
login, will need to revert to browser mode for auth."
```

---

## Task 3: Falabella (Angular SPA, no credentials)

**Files:**
- Rewrite: `src/banks/falabella.ts`

Auth: Cookie jar with form login. Data: Account movements + CMR credit card (unbilled + billed).

- [ ] **Step 1: Read current browser scraper**

Read `src/banks/falabella.ts` fully. Note:
- Login: `fillRut` + `fillPassword` + `clickSubmit` (generic actions)
- Account movements: `extractAccountMovements` + `paginateAndExtract` (generic)
- CMR card: Shadow DOM `<credit-card-movements>` component with tabs ("ultimos movimientos", "movimientos facturados")
- Owner filter: select `[name='searchownership']` with value "T"/"A"/"B"
- Credit card cupos: regex from page text (Cupo de compras, Cupo utilizado, Cupo disponible)
- 2FA: SMS with simple detection

- [ ] **Step 2: Write the API scraper**

Rewrite `src/banks/falabella.ts`. The scraper must:

1. GET `https://www.bancofalabella.cl` for initial cookies
2. Try login POST to candidate endpoints (`/api/auth/login`, `/api/login`, `/personas/api/auth`, `/api/v1/auth/login`) with JSON body `{ rut: cleanRut, password }`
3. Fallback: try form-urlencoded POST to `/personas/login` with redirect following
4. Handle 401 (invalid credentials), 2FA detection, error responses
5. Fetch account movements from candidate endpoints (`/api/cuentas/movimientos`, `/api/v1/accounts/movements`, `/personas/api/cuentas/cartola`)
6. Parse movements: date, description, amount, balance, source = account
7. Fetch CMR credit card data from candidate endpoints (`/api/tarjetas/movimientos`, `/api/v1/cards/movements`, `/personas/api/tarjeta-credito/movimientos`)
8. Parse TC movements: date, description, amount (negate for purchases), source = credit_card_unbilled or credit_card_billed, owner, installments
9. Parse credit card cupos from response: total, used, available
10. Deduplicate all movements and return

Import `normalizeInstallments`, `normalizeOwner` from utils for credit card data.

Support `owner` option from `ScraperOptions` (default "B" = both).

- [ ] **Step 3: Build and type check**

Run: `npm run build && cd web && npx tsc --noEmit`
Expected: Both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/banks/falabella.ts
git commit -m "feat(falabella): migrate scraper from browser to API mode

Cookie jar auth + REST API. Account movements + CMR credit card
(unbilled + billed). Endpoint URLs need live discovery."
```

---

## Task 4: Scotiabank (Shadow DOM to REST, no credentials)

**Files:**
- Rewrite: `src/banks/scotiabank.ts`

- [ ] **Step 1: Read current browser scraper**

Read `src/banks/scotiabank.ts` fully. Note:
- Login: `fillRut` (dash format) + `fillPassword` + `clickSubmit`
- Shadow DOM: `allDeepJs()` helper pierces Shadow DOM for all element queries
- Tutorial dismissal: "continuar", "terminar", "cerrar", "omitir", "saltar" buttons
- Navigation: "Ver cartola" or sidebar "Cuentas" then "Cartola/Movimientos"
- Movement extraction: tables with headers (fecha, descripcion, cargo, abono, saldo)
- Historical periods: `SCOTIABANK_MONTHS` env var, `fillAndSubmitDateRange` with date fields
- 2FA: dynamic key detection ("clave dinamica", "segundo factor", "codigo de verificacion")

- [ ] **Step 2: Write the API scraper**

Rewrite `src/banks/scotiabank.ts`. The scraper must:

1. GET `https://www.scotiabank.cl` for initial cookies
2. Discover login endpoint. Try JSON POST to candidates (`/api/auth/login`, `/personas/api/auth`, `/api/login`) with `{ rut: formatRut(rut), password }`
3. Fallback: form-urlencoded POST to `/personas/login`
4. Handle 2FA: check response for "clave dinamica", "segundo factor", "codigo de verificacion". Call `onTwoFactorCode()` if detected.
5. Fetch current period movements from API candidates
6. Support historical periods: loop `SCOTIABANK_MONTHS` times, fetch movements for each month with date range params
7. Parse movements: date, description, cargo (negative), abono (positive), saldo
8. Extract balance from first movement's saldo or from a balance endpoint
9. Deduplicate and return

Import `formatRut` from utils.

- [ ] **Step 3: Build and type check**

Run: `npm run build && cd web && npx tsc --noEmit`
Expected: Both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/banks/scotiabank.ts
git commit -m "feat(scotiabank): migrate scraper from browser to API mode

Cookie jar auth + REST API. Shadow DOM eliminated. Historical
periods via SCOTIABANK_MONTHS env var."
```

---

## Task 5: Santander (Angular SPA + login iframe, no credentials)

**Files:**
- Rewrite: `src/banks/santander.ts`

- [ ] **Step 1: Read current browser scraper**

Read `src/banks/santander.ts` fully. Note:
- Login iframe: `iframe#login-frame` with `#rut` + `#pass`
- Sidebar IDs: `#menu-uid-0410` (cuentas), `#menu-uid-0413` (movimientos), `#menu-uid-0420` (tarjetas)
- Multi-account: Swiper carousel `#tabs-carousel-movs` with pagination dots
- Account movements: `extractAccountMovements` + `paginateAndExtract` (generic actions)
- Credit cards: `clickTcTab` ("movimientos por facturar", "movimientos facturados") + `extractCreditCardMovements`
- 2FA: push (wait only), detected via `detect2FA` with `frameFn` for iframe context
- Balance: from movements or `extractBalance` action

- [ ] **Step 2: Write the API scraper**

Rewrite `src/banks/santander.ts`. The scraper must:

1. GET `https://banco.santander.cl/personas` for initial cookies
2. Try to discover login iframe URL from homepage HTML (match `iframe` with `id="login-frame"` and extract `src`)
3. GET iframe URL for login form HTML, extract form action and hidden fields
4. POST credentials (clean RUT, password) to the form action
5. Follow redirects to establish session
6. Handle 2FA push detection
7. Fetch account list (multi-account support): try API candidates
8. For each account, fetch movements
9. Fetch credit card data: unbilled and billed movements from separate endpoints
10. Extract balance from movements or dedicated endpoint
11. Deduplicate and return

- [ ] **Step 3: Build and type check**

Run: `npm run build && cd web && npx tsc --noEmit`
Expected: Both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/banks/santander.ts
git commit -m "feat(santander): migrate scraper from browser to API mode

Cookie jar auth via login iframe endpoint. Multi-account +
credit card support. 2FA push detection."
```

---

## Task 6: Itau (WPS Portal + Imperva, no credentials)

**Files:**
- Rewrite: `src/banks/itau.ts`

- [ ] **Step 1: Read current browser scraper**

Read `src/banks/itau.ts` fully. Note:
- Login URL: `https://banco.itau.cl/wps/portal/newolb/web/login`
- Portal base: `https://banco.itau.cl/wps/myportal/newolb/web`
- Imperva block: "No pudimos validar tu acceso" or "Please stand by"
- Login fields: `#loginNameID` (formatted RUT) + `#pswdId` (password)
- Submit: `#btnLoginRecaptchaV3` click
- Balance URL: `{PORTAL_BASE}/cuentas/cuenta-corriente/saldos`
- Movements URL: `{PORTAL_BASE}/cuentas/cuenta-corriente/saldos-ultimo-movimiento`
- Movement table: 6 cells (date, description, cargo, abono, saldo, extra)
- CC deuda URL: `{PORTAL_BASE}/tarjeta-credito/resumen/deuda`
- CC facturados URL: `{PORTAL_BASE}/tarjeta-credito/resumen/cuenta-nacional`
- 2FA: Itau Key push, detected via `detect2FA`

- [ ] **Step 2: Write the API scraper**

Rewrite `src/banks/itau.ts`. The scraper must:

1. GET login URL for initial cookies and Imperva check
2. If response contains "No pudimos validar tu acceso" or "Please stand by", return error: "Itau bloqueo el acceso (Imperva). Usa --profile para Chrome con perfil real."
3. Parse login page HTML for form action and hidden fields
4. POST login with `loginNameID` = `formatRut(rut)`, `pswdId` = password, hidden fields
5. Handle 2FA push detection, login errors
6. Fetch balance: GET `{PORTAL_BASE}/cuentas/cuenta-corriente/saldos`, parse "Saldo disponible para uso $ ..." regex
7. Fetch account movements: GET `{PORTAL_BASE}/cuentas/cuenta-corriente/saldos-ultimo-movimiento`, parse HTML tables (date dd/mm/yyyy, description, cargo, abono, saldo)
8. Handle pagination: check for "Pagina X de Y", follow next link
9. Fetch credit card summary: GET `{PORTAL_BASE}/tarjeta-credito/resumen/deuda`, parse card label, nacional/internacional cupos, no-facturados table
10. Fetch CC facturados: GET `{PORTAL_BASE}/tarjeta-credito/resumen/cuenta-nacional`, parse table (7+ cells)
11. Deduplicate and return

Import `formatRut`, `normalizeInstallments` from utils.

Note: Itau WPS may serve server-rendered HTML (not JSON APIs). The scraper may need to parse HTML responses rather than JSON. Use regex to extract data from HTML if no JSON endpoints are found.

- [ ] **Step 3: Build and type check**

Run: `npm run build && cd web && npx tsc --noEmit`
Expected: Both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/banks/itau.ts
git commit -m "feat(itau): migrate scraper to API mode

WPS portal auth via cookie jar. Imperva detection with helpful
error. CC unbilled + billed. May parse HTML if no JSON API."
```

---

## Task 7: BCI (JSF Portal, no credentials)

**Files:**
- Rewrite: `src/banks/bci.ts`

- [ ] **Step 1: Read current browser scraper**

Read `src/banks/bci.ts` fully. Note:
- Login URL: `https://www.bci.cl/corporativo/banco-en-linea/personas`
- RUT split: `rut_aux` (formatted), `rut` (body), `dig` (check digit)
- Password: `#clave`
- Form: `#frm` submitted via `form.submit()`
- JSF ViewState: `javax.faces.ViewState` hidden field
- 2FA: BCI Pass push, detected via `detect2FA` with keywords
- Iframes: `miBanco.jsf` (content), `fe-saldosultimosmov` (movements), `fe-mismovimientos` (TC), `vistaSaldosTDC.jsf` (TC cupo)
- Multi-account: `select` element with account options
- Account movements: table with date, description, cargo, abono (4 cols)
- TC combinations: Nacional$/Internacional USD x Facturados/No facturados
- TC cupo: regex from body text (nacional used/available/total, internacional USD)

- [ ] **Step 2: Write the API scraper**

Rewrite `src/banks/bci.ts`. The scraper must:

1. GET login URL for initial cookies and page HTML
2. Parse `javax.faces.ViewState` from hidden field in login HTML
3. POST login form: `rut` = cleanRut body, `dig` = check digit, `clave` = password, `javax.faces.ViewState` = parsed value. Content-Type: `application/x-www-form-urlencoded`
4. Follow redirects, collect session cookies
5. Handle 2FA BCI Pass push: check response for "bci pass", "segundo factor", "aprobacion en tu app"
6. Handle login errors
7. Fetch movements via iframe URLs: GET the JSF URLs that render movement tables
8. Parse HTML tables from responses (regex or string matching): date, description, cargo, abono
9. Multi-account: try fetching account selector, iterate accounts
10. Fetch TC data via iframe URLs: iterate 4 combinations (nacional/intl x facturado/no-facturado)
11. Fetch TC cupo data: parse cupo text from response
12. Deduplicate and return

Import `formatRut` from utils for the `rut_aux` field.

Note: BCI JSF portal is server-rendered. The scraper will likely need to parse HTML responses rather than JSON. This is the highest risk of needing to stay browser-mode.

- [ ] **Step 3: Build and type check**

Run: `npm run build && cd web && npx tsc --noEmit`
Expected: Both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/banks/bci.ts
git commit -m "feat(bci): migrate scraper to API mode

JSF form login with ViewState CSRF. HTML parsing for data.
Multi-account + 4 TC combinations. Highest risk of needing browser."
```

---

## Task 8: BancoEstado (Angular SPA + Akamai, no credentials)

**Files:**
- Rewrite: `src/banks/bestado.ts`

- [ ] **Step 1: Read current browser scraper**

Read `src/banks/bestado.ts` fully. Note:
- Login URL: `https://www.bancoestado.cl/content/bancoestado-public/cl/es/home/home.html#/login`
- Login form: `#rut` (readonly removed on focus) + `#pass` + `#btnLogin`
- `forceHeadful: true` (Akamai TLS fingerprinting)
- Angular change detection: dispatch input/change/blur events
- Balance: regex patterns for "cuentarut" / "saldo disponible"
- Movement navigation: "ir a movimientos", "ver movimientos", sidebar "cuentas" then "cuentarut"
- Movement extraction: HTML tables with headers (fecha, descripcion, cargo/abono, saldo) or dashboard cards
- Pagination: "siguiente", "ver mas", "cargar mas"

- [ ] **Step 2: Write the API scraper**

Rewrite `src/banks/bestado.ts`. The scraper must:

1. GET login URL for initial cookies
2. Check for Akamai block: if status 403 or response contains captcha/challenge, return error: "BancoEstado bloqueo el acceso (Akamai). Requiere browser con --profile."
3. Discover login POST endpoint from Angular SPA
4. POST credentials with clean RUT + password
5. Follow redirects
6. Fetch CuentaRUT balance from API
7. Fetch movements from API with pagination support
8. Parse movements: date, description, amount, balance
9. Deduplicate and return

This bank is the most likely to fail at API migration. If the initial GET already returns 403, the scraper returns an informative error immediately.

- [ ] **Step 3: Build and type check**

Run: `npm run build && cd web && npx tsc --noEmit`
Expected: Both succeed.

- [ ] **Step 4: Commit**

```bash
git add src/banks/bestado.ts
git commit -m "feat(bestado): migrate scraper to API mode

Cookie jar auth attempt. Akamai TLS detection with helpful
error. CuentaRUT balance + movements. May need browser fallback."
```

---

## Task 9: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the institution list**

In the "Supported institutions" section:
- Move all migrated banks from "Browser mode" to "API mode"
- For each, note the auth pattern (Keycloak, cookie jar, JSF, etc.)
- For banks that need live endpoint discovery, add a note

- [ ] **Step 2: Update the "Discovered API patterns" section**

Add entries for any newly confirmed endpoints (especially BICE and Citi after live testing).

For untested banks, add skeleton entries noting the auth pattern and that endpoints are best-guess.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md with new API-mode banks

Move 8 banks from browser to API mode. Document auth patterns
and endpoint discovery status."
```

---

## Task 10: Final QA

- [ ] **Step 1: Full build check**

Run: `npm run build`
Expected: SUCCESS, bundle output generated.

- [ ] **Step 2: Full type check**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Verify no puppeteer imports in migrated files**

Run grep for `puppeteer-core` across all bank files. Expected: zero matches in any of the 8 migrated files. Only `edwards.ts` delegates to `bchile.ts` (already API), and the remaining API scrapers (`fintual.ts`, `racional.ts`, `mercadopago.ts`) should also have no puppeteer imports.

- [ ] **Step 4: Verify all migrated banks have mode: "api"**

Run grep for `mode:` across bank files. Expected: all 8 migrated files show `mode: "api"`.

- [ ] **Step 5: Test BICE with credentials**

Run: `node dist/cli.js --bank bice --pretty`
Expected: Login succeeds, movements returned (or clear error about endpoint discovery).

- [ ] **Step 6: Test Citi with credentials**

Run: `node dist/cli.js --bank citi --pretty`
Expected: Login succeeds (or clear ioBlackBox error).

- [ ] **Step 7: Commit QA results**

If any files were adjusted during QA:
```bash
git add -A
git commit -m "fix: QA adjustments after API migration"
```
