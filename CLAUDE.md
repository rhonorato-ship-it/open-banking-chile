# See AGENTS.md for full project documentation

## Agent delegation rules

When the user's request involves a specific topic, delegate to the appropriate specialized agent WITHOUT the user having to name it:

### Bank-specific issues
If the request mentions a bank name, ID, or its scraper file — delegate to the corresponding `bank-{id}` agent:
- `bchile`, `Banco de Chile`, `bchile.ts` → `bank-bchile`
- `bci`, `BCI`, `bci.ts` → `bank-bci`
- `bestado`, `BancoEstado`, `bestado.ts` → `bank-bestado`
- `bice`, `BICE`, `bice.ts` → `bank-bice`
- `citi`, `Citibank`, `citi.ts` → `bank-citi`
- `edwards`, `Edwards`, `edwards.ts` → `bank-edwards`
- `falabella`, `Falabella`, `falabella.ts` → `bank-falabella`
- `fintual`, `Fintual`, `fintual.ts` → `bank-fintual`
- `itau`, `Itaú`, `itau.ts` → `bank-itau`
- `mercadopago`, `MercadoPago`, `mercadopago.ts` → `bank-mercadopago`
- `racional`, `Racional`, `racional.ts` → `bank-racional`
- `santander`, `Santander`, `santander.ts` → `bank-santander`
- `scotiabank`, `Scotiabank`, `scotiabank.ts` → `bank-scotiabank`

### Cross-cutting concerns
- Scraping technique, API patterns, auth flow, cookie jar, fetch → `scraping-expert`
- Feature scope, user flows, dashboard, database schema → `product-manager`
- Quality assurance, testing, verification, regression → `qa-engineer`
- Documentation, repo structure, agent updates, AGENTS.md → `repo-architect`

### Automatic post-iteration delegation
After completing a major code change (new bank, migration, architecture change), automatically run:
1. `qa-engineer` — verify build, types, compliance
2. `repo-architect` — update docs and agent files

## SDLC — Development lifecycle

Every major iteration follows this process. Do NOT skip steps.

### Phase 1: Discovery
- For new banks: inspect Chrome DevTools Network tab for API endpoints
- For bugs: read the current scraper code and the bank agent file
- For features: consult `product-manager` for scope decisions

### Phase 2: Design
- Use `feature-dev:code-architect` agent for non-trivial changes
- Document discovered API endpoints verbatim in AGENTS.md before writing code
- Choose the right pattern: token-based, cookie jar, Firebase, OAuth2, or browser

### Phase 3: Implementation
- API-first is mandatory (see AGENTS.md)
- Follow existing patterns: `fintual.ts` (token), `bchile.ts` (cookie jar), `racional.ts` (Firebase)
- Set `mode: "api"` on the BankScraper export if no browser is needed

### Phase 4: QA
- Run `npm run build` — must succeed
- Run `cd web && npx tsc --noEmit` — must succeed
- Run the scraper with real credentials: `node dist/cli.js --bank {id} --pretty`
- Delegate to `qa-engineer` for full checklist

### Phase 5: Codification
- Delegate to `repo-architect` to update:
  - AGENTS.md (bank list, API patterns, migration status)
  - Bank agent files (`.claude/agents/bank-{id}.md`)
  - Memory files if project status changed
- Bundle size must stay under 200KB

### Phase 6: Deploy (when requested)
- `vercel --prod` from repo root
- Verify on production URL: https://open-banking-chile.vercel.app
