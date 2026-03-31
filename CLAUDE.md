# See AGENTS.md for full project documentation

## Agent delegation rules

When the user's request involves a specific topic, delegate to the appropriate specialized agent WITHOUT the user having to name it:

### Bank/institution-specific issues
If the request mentions an institution name, ID, or its scraper file -- delegate to the corresponding `bank-{id}` agent:
- `bchile`, `Banco de Chile`, `bchile.ts` -> `bank-bchile`
- `bci`, `BCI`, `bci.ts` -> `bank-bci`
- `bestado`, `BancoEstado`, `bestado.ts` -> `bank-bestado`
- `bice`, `BICE`, `bice.ts` -> `bank-bice`
- `citi`, `Citibank`, `citi.ts` -> `bank-citi`
- `edwards`, `Edwards`, `edwards.ts` -> `bank-edwards`
- `falabella`, `Falabella`, `falabella.ts` -> `bank-falabella`
- `fintual`, `Fintual`, `fintual.ts` -> `bank-fintual`
- `itau`, `Itau`, `itau.ts` -> `bank-itau`
- `mach`, `MACH`, `mach.ts` -> `bank-mach`
- `mercadopago`, `MercadoPago`, `mercadopago.ts` -> `bank-mercadopago`
- `racional`, `Racional`, `racional.ts` -> `bank-racional`
- `santander`, `Santander`, `santander.ts` -> `bank-santander`
- `scotiabank`, `Scotiabank`, `scotiabank.ts` -> `bank-scotiabank`
- `tenpo`, `Tenpo`, `tenpo.ts` -> `bank-tenpo`

### Cross-cutting concerns
- Scraping technique, API patterns, auth flow, cookie jar, fetch, Playwright -> `scraping-expert`
- Feature scope, user flows, dashboard, database schema -> `product-manager`
- Quality assurance, testing, verification, regression -> `qa-engineer`
- Documentation, repo structure, agent updates, AGENTS.md -> `repo-architect`
- Local sync agent, agent auth, Supabase Realtime, sync_tasks -> `realtime-engineer`

### Domain-specific concerns
- Movement categories, transfer detection, amount normalization -> `movement-classifier`
- Credential encryption, token management, security audit -> `security-auditor`
- API endpoint design, SSE streaming, error responses -> `api-architect`
- Dashboard UI, components, design system, accessibility -> `ux-designer`
- Deduplication, hash stability, data migration -> `data-integrity`
- Charts, analytics, aggregation, coach recommendations -> `analytics-engineer`
- RUT, CLP, Chilean dates, bank quirks -> `financial-domain`
- Sprint compliance, plan gate enforcement -> `plan-keeper`

---

## SDLC -- Development Lifecycle (MANDATORY)

Every change to this project follows this lifecycle. Phases are NOT optional -- skipping a phase leads to regressions, stale docs, and broken deployments. The SDLC applies to ALL changes, not just large ones. Scale the depth of each phase to the size of the change.

### Change classification

| Type | Examples | Required phases |
|------|---------|----------------|
| **Trivial** | Typo fix, comment update, single-line change | 3 -> 4a -> 6 |
| **Small** | Bug fix in one scraper, UI tweak | 3 -> 4a -> 4b -> 6 |
| **Medium** | New feature, migrate one bank to API | 1 -> 2 -> 3 -> 4 -> 5 -> 6 |
| **Large** | Architecture change, new agent, SDLC update | 1 -> 2 -> 3 -> 4 -> 5 -> 6 |

### Phase 1: Discovery
**Goal**: Understand the problem before touching code.
- For new institutions: inspect Chrome DevTools Network tab for API endpoints
- For bugs: read the current scraper code AND the bank agent file
- For features: consult `product-manager` for scope decisions
- **Gate**: Can you describe the change in one sentence? If not, keep discovering.

### Phase 2: Design
**Goal**: Plan the approach before implementation.
- Use `feature-dev:code-architect` agent for non-trivial changes
- Document discovered API endpoints verbatim in AGENTS.md BEFORE writing code
- Choose the right pattern: token-based, cookie jar, Firebase, Keycloak OIDC, or browser
- **Gate**: Is the approach documented? Are API endpoints confirmed?

### Phase 3: Implementation
**Goal**: Write the code.
- API-first is mandatory (see AGENTS.md "Scraper strategy")
- Follow existing patterns: `fintual.ts` (token), `bchile.ts` (cookie jar), `racional.ts` (Firebase), `bice.ts` (Keycloak + browser fallback)
- Set `mode: "api"` on the BankScraper export if no browser is needed
- Browser-mode banks use `runScraper()` from `scraper-runner.ts` (Playwright)
- Balance must be captured by every scraper
- First sync must fetch at least 24 months of history
- **Gate**: Code compiles. No `require()` in ESM. No top-level heavy imports.

### Phase 4: QA (ALWAYS required)
**Goal**: Verify the change works and doesn't break anything.

#### 4a. Build checks (always, even for trivial changes)
```bash
npm run build                        # Must succeed, bundle < 200KB
cd web && npx tsc --noEmit           # Must succeed, 0 type errors
```

#### 4b. Functional checks (small+ changes)
- Run the scraper with real credentials: `node dist/cli.js --bank {id} --pretty`
- For web changes: test on localhost before deploying
- For agent changes: test with `node dist/agent.js` or `npx open-banking-chile serve`

#### 4c. Full QA audit (medium+ changes)
- Delegate to `qa-engineer` agent for the full checklist:
  1. Build verification
  2. Diff review (no require(), no dead code, no hardcoded secrets)
  3. AGENTS.md compliance (modes match code, endpoints match constants)
  4. Dedup stability (hashes are deterministic across syncs)
  5. Movement contract (amounts, dates, sources, balance)
  6. Scrape route compatibility (API-mode runs on Vercel, browser-mode returns "use local agent")
  7. 2FA flow (agentic Gmail search -> manual SSE -> UI input -> POST /api/2fa -> pending_2fa -> poll)
  8. Agent flow (sync_tasks Realtime -> claim -> scrape -> upload -> done)
  9. Bundle size (< 200KB)

- **Gate**: ALL checks pass. Do NOT proceed to Phase 5 with failing checks.

### Phase 5: Codification (medium+ changes)
**Goal**: Update all documentation to match the code.
- Delegate to `repo-architect` agent for the full audit:
  1. AGENTS.md: bank list, modes, API patterns, structure tree, agent architecture
  2. Bank agent files: `.claude/agents/bank-{id}.md` match source code
  3. Cross-agent consistency: scraping-expert, product-manager, qa-engineer
  4. CLAUDE.md: delegation rules list all institutions
  5. Memory files: current, not stale
- **Gate**: Repo architect reports 0 issues.

### Phase 6: Deploy (ALWAYS after committed changes)
**Goal**: Production must always reflect the latest committed code.
- `vercel --prod` from repo root (NOT from web/)
- Deploy after EVERY commit, not just medium+ changes
- Verify on production URL: https://open-banking-chile.vercel.app
- For API-mode scrapers on Vercel: sync should complete in < 15 seconds
- For local agent syncs: sync should complete in < 120 seconds

### SDLC violations to watch for
These are the most common shortcuts that cause regressions:
- Committing without deploying -> user sees stale production
- Deploying without running QA -> broken production
- Updating code without updating AGENTS.md -> stale API patterns
- Adding a new bank without updating bank agent file -> agent gives wrong advice
- Skipping the design phase -> wrong scraping pattern chosen
- Not testing with real credentials -> auth flow bugs only caught in production
- Top-level imports of heavy modules -> 45s cold starts on Vercel
- Not capturing balance -> dashboard shows stale/missing balance data
- Not fetching 24 months on first sync -> user sees incomplete history
