# Agentic 2FA — Gmail-based automatic code extraction

**Date**: 2026-03-27
**Status**: Approved

## Goal

Let users sync banks without manually entering 2FA codes. The system reads the code from their Gmail automatically.

## Architecture

### Gmail OAuth (per-user, separate from sign-in)
- `/api/gmail/connect` — redirects to Google OAuth with `gmail.readonly` scope
- `/api/gmail/callback` — exchanges code for tokens, stores encrypted refresh token in `users` table (`gmail_refresh_token`, `gmail_token_iv`)
- Uses same `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` as sign-in

### Global toggle
- `agentic_mode: boolean` on `users` table (default false)
- Dashboard toggle: "Sincronizacion agentica"
- If on + Gmail not connected: prompt to connect
- If on + Gmail connected: green badge

### 2FA flow (agentic mode)
1. Scraper hits 2FA → scrape route checks `mode=agentic` query param
2. SSE: `{ requires_2fa: true, agentic: true, message: "Buscando codigo en Gmail..." }`
3. Poll Gmail every 3s with bank-specific query (sender + subject keywords)
4. If no match after 15s → generic search (any recent email with code-like content)
5. If no match after 30s → fallback to manual mode (show input field)
6. Code found → extract via regex → return to scraper

### Bank sender patterns (`BANK_2FA_PATTERNS`)
```typescript
{ bankId: "racional", query: "from:@racional.cl", codeRegex: /\b\d{6}\b/ }
{ bankId: "citi", query: "from:@citi.com", codeRegex: /\b\d{6}\b/ }
{ bankId: "bestado", query: "from:@bancoestado.cl", codeRegex: /\b\d{6}\b/ }
{ bankId: "falabella", query: "from:@bancofalabella.cl", codeRegex: /\b\d{4,6}\b/ }
{ bankId: "scotiabank", query: "from:@scotiabank.cl", codeRegex: /\b\d{6}\b/ }
// Generic fallback: subject:(codigo OR verificacion OR OTP OR code) newer_than:2m
```

### Frontend
- ScrapeProgress: agentic path shows "Buscando codigo..." animation, auto-fallback to manual input
- Dashboard: toggle + Gmail connect button + status badge
- `/api/scrape/{bankId}?mode=agentic` passes mode to SSE endpoint

### Files to create/modify
- Create: `web/app/api/gmail/connect/route.ts`
- Create: `web/app/api/gmail/callback/route.ts`
- Create: `web/lib/gmail.ts` (Gmail API client + code extraction)
- Modify: `web/app/api/scrape/[bankId]/route.ts` (agentic 2FA branch)
- Modify: `web/components/ScrapeProgress.tsx` (agentic UI path)
- Modify: `web/app/dashboard/page.tsx` (toggle + Gmail connect)
- DB: Add `agentic_mode`, `gmail_refresh_token`, `gmail_token_iv` to `users` table
