# Web Dashboard — Design Spec
**Date:** 2026-03-25
**Status:** Approved

---

## Overview

A multi-user web application deployed to Vercel that allows users to connect their Chilean bank accounts, trigger live scrapes, and view accumulated movement history. Authentication is via Google OAuth. Bank credentials are stored encrypted per user.

---

## Architecture

### Repo structure

A `web/` subdirectory inside the existing `open-banking-chile` repo. The Next.js app imports the scraper library directly via a local workspace path — no npm install required.

```
open-banking-chile/
├── src/                        ← existing library (unchanged)
├── dist/                       ← existing build output
├── web/                        ← new Next.js 16 app
│   ├── app/
│   │   ├── (auth)/
│   │   │   └── login/          ← Google sign-in page
│   │   ├── dashboard/          ← bank cards with sync buttons
│   │   ├── banks/              ← add / edit / remove bank credentials
│   │   ├── movements/          ← full movement history with filters
│   │   └── api/
│   │       ├── auth/[...nextauth]/ ← Auth.js routes
│   │       └── scrape/[bankId]/    ← SSE streaming scrape endpoint
│   ├── components/
│   │   ├── ScrapeProgress/     ← Fintoc-style phase animation
│   │   └── MovementsTable/     ← sortable/filterable movements
│   ├── lib/
│   │   ├── db.ts               ← Neon Postgres client (drizzle-orm)
│   │   ├── credentials.ts      ← AES-256-GCM encrypt / decrypt
│   │   └── auth.ts             ← Auth.js v5 config
│   ├── package.json
│   └── .env.example
├── package.json                ← existing library package
└── ...
```

### Tech stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 App Router |
| Auth | Auth.js v5 — Google OAuth provider |
| Database | Neon Postgres (Vercel Marketplace) |
| ORM | Drizzle ORM |
| Browser automation | `puppeteer-core` + `@sparticuz/chromium` |
| Styling | Tailwind CSS + shadcn/ui |
| Vercel plan | Pro required (Fluid Compute for scraping, up to 800s) |

### Data flow

1. User signs in with Google → Auth.js creates signed JWT session
2. User adds a bank → RUT + password encrypted (AES-256-GCM) → stored in Neon
3. User clicks "Sync" → browser opens SSE connection to `/api/scrape/[bankId]`
4. Server decrypts credentials, instantiates scraper, runs it
5. Scraper emits `onProgress` callbacks → server pushes SSE phase events to browser
6. On completion, movements are upserted into DB (deduplicated by hash)
7. SSE stream closes → client dismisses animation, renders updated movements

---

## Data Model

```sql
-- Managed manually (JWT-only Auth.js mode — no DB adapter)
users (
  id           TEXT PRIMARY KEY,              -- Google sub claim
  email        TEXT UNIQUE NOT NULL,
  name         TEXT,
  image        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
)

-- One row per bank per user
bank_credentials (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_id              TEXT NOT NULL,         -- e.g. "falabella", "bci"
  encrypted_rut        TEXT NOT NULL,         -- AES-256-GCM ciphertext (base64)
  encrypted_password   TEXT NOT NULL,         -- AES-256-GCM ciphertext (base64)
  rut_iv               TEXT NOT NULL,         -- separate random 12-byte IV for RUT
  password_iv          TEXT NOT NULL,         -- separate random 12-byte IV for password
  is_syncing           BOOLEAN DEFAULT false, -- concurrency guard
  last_synced_at       TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, bank_id)
)

-- Accumulated movement history — never deleted, deduplicated on upsert
movements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_id     TEXT NOT NULL,
  date        DATE NOT NULL,
  description TEXT NOT NULL,
  amount      NUMERIC NOT NULL,
  balance     NUMERIC,
  source      TEXT,                           -- "account" | "credit_card"
  hash        TEXT UNIQUE NOT NULL,           -- sha256(userId + bankId + date + description + amount)
  synced_at   TIMESTAMPTZ DEFAULT now()
)
```

**Credential encryption:** AES-256-GCM. Key is a 32-byte `CREDENTIALS_SECRET` env var. RUT and password each get their own independent random 12-byte IV (`rut_iv`, `password_iv`), stored alongside their respective ciphertexts. Sharing one IV across two encrypted values would break GCM security. Decryption only happens inside the SSE API route — credentials are never returned to the client.

**Movement deduplication:** the `hash` column prevents duplicate rows across scrape runs. Hash is computed as `sha256(userId + bankId + date + description + amount)` — `userId` is included to prevent cross-user hash collisions. Uses `INSERT ... ON CONFLICT (hash) DO NOTHING`.

**Auth.js mode:** JWT-only (no DB adapter). `callbacks.signIn` upserts the user row into the `users` table on first login. Session is a signed JWT; no `sessions` table required.

**Concurrency control:** The `is_syncing` flag on `bank_credentials` acts as a mutex. The SSE route checks `is_syncing = true` and returns 409 if another scrape is already running for that bank+user. The flag is set to `false` in a `finally` block (success or error). The UI disables the "Sync" button while `is_syncing` is true.

---

## Security

- All routes under `/dashboard`, `/banks`, `/movements`, and `/api/scrape` are protected via Next.js middleware checking the Auth.js session
- Credentials encrypted at rest (AES-256-GCM), decrypted only server-side
- `CREDENTIALS_SECRET` stored as a Vercel environment variable (never in code)
- Bank credentials never logged, never included in error messages returned to client
- Session: signed JWT via Auth.js, no server-side session store needed

---

## Scrape API Route — SSE

`GET /api/scrape/[bankId]`

Uses Vercel Fluid Compute (extended timeout). Returns `text/event-stream`.

**SSE event shape:**
```json
{ "phase": 1, "label": "Iniciando conexión", "message": "Abriendo sesión segura" }
{ "phase": 2, "label": "Autenticando", "message": "Verificando credenciales en Falabella" }
{ "phase": 3, "label": "Extrayendo movimientos", "message": "Leyendo tu historial" }
{ "phase": 4, "label": "Procesando datos", "message": "Deduplicando y guardando" }
{ "phase": 5, "label": "Completado", "message": "42 movimientos sincronizados", "done": true }
```

On error:
```json
{ "phase": 2, "error": true, "message": "Credenciales incorrectas" }
```

The `onProgress` callback on `ScraperOptions` has the signature `(step: string) => void` and emits free-form strings like `"Abriendo Falabella..."` or `"Extrayendo movimientos..."`. The SSE route maps these strings to phase numbers using keyword detection:

```ts
function stringToPhase(msg: string): 1 | 2 | 3 | 4 {
  const m = msg.toLowerCase();
  if (m.includes("abriendo") || m.includes("navegando") || m.includes("conectando")) return 1;
  if (m.includes("login") || m.includes("autenti") || m.includes("credencial") || m.includes("ingresando")) return 2;
  if (m.includes("extray") || m.includes("movimiento") || m.includes("listo")) return 3;
  return 4; // default: processing
}
```

Phase 5 ("Completado") is emitted explicitly by the SSE route after the DB upsert completes, not via `onProgress`.

---

## Loading Animation

A full-screen overlay rendered client-side (`'use client'`) over the dashboard when a scrape is in progress.

### Visual design (Fintoc-inspired)

- Background: `#050505` with a centered radial blue glow (`#0ea5e9` at ~15% opacity) that pulses slowly
- Bank logo + name at the top in bold white (32px, font-weight 700)
- 5 phase nodes laid out vertically, connected by an animated vertical progress line

### Phase node states

| State | Circle | Label |
|---|---|---|
| Pending | Grey hollow ring | Muted grey text |
| Active | Pulsing blue ring + spinning inner arc + blue glow halo | Bright white, active sub-message below |
| Done | Solid blue fill + white checkmark | White text |

### Progress line

Thin (2px) vertical line between nodes. Grey base, fills blue from top as each phase completes — identical to a bank transfer step-tracker.

### Terminal states

- **Success:** glow briefly expands, final node shows checkmark, overlay auto-dismisses after 1.5s
- **Error:** active node turns red (`#ef4444`), shows error message inline with a "Reintentar" button

---

## Pages

| Route | Description |
|---|---|
| `/login` | Google sign-in, dark themed, Fintoc-style |
| `/dashboard` | Grid of bank cards. Each shows bank name, last synced time, movement count, and a "Sync" button |
| `/banks` | Add/edit/delete bank credentials (RUT + password per bank) |
| `/movements` | Full table of all movements across all banks with date/bank/amount filters |

---

## Environment Variables

```bash
# Auth.js
AUTH_SECRET=
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=

# Neon Postgres
DATABASE_URL=

# Credential encryption
CREDENTIALS_SECRET=   # 32-byte hex key

# Vercel Fluid Compute
NEXT_PUBLIC_APP_URL=
```

---

## Deployment

1. `cd web && vercel link` → connect to Vercel project
2. Install Neon integration from Vercel Marketplace → auto-provisions `DATABASE_URL`
3. Set remaining env vars via `vercel env add`
4. Run DB migrations: `npx drizzle-kit push` (one-time; re-run after schema changes)
5. `vercel deploy --prod`

Vercel Pro plan required for Fluid Compute extended timeout (scrapes run 1–3 minutes per bank).

### Next.js config requirements for @sparticuz/chromium

`next.config.ts` must exclude Chromium from the Next.js bundle and mark it as a server-external package:

```ts
const nextConfig = {
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
};
```

Without this, Next.js will attempt to bundle `@sparticuz/chromium` (a native binary) and fail at build time. The binary is loaded at runtime from `node_modules` on the Vercel function instance.
