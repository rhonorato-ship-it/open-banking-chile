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
- Roadmap changes, off-roadmap work requests -> `roadmap-keeper`

---

## Roadmap governance (MANDATORY)

All development must trace to an R-number in `ROADMAP.md`. Before starting any work:
1. Check `ROADMAP.md` for the matching R-number
2. If not found: delegate to `roadmap-keeper` to add it (requires user approval with risk assessment)
3. If user says "overlook the roadmap": accept, but log exception in `ROADMAP_HISTORY.md`

**ROADMAP.md is a controlled document.** Only `roadmap-keeper` may modify it (enforced via PreToolUse hook). The roadmap-keeper will challenge changes that conflict with existing work and require express confirmation.

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

### Phase 4: QA (ALWAYS required — `qa-engineer` agent is the gate)
**Goal**: Prove the change works and doesn't break anything. Default: FAIL until proven PASS.

#### 4a. Build + types (always, even trivial changes)
```bash
npm run build                        # Must succeed, bundle < 200KB
cd web && npx tsc --noEmit           # Must succeed, 0 type errors
```

#### 4b. Functional checks (small+ changes)
- Run the scraper with real credentials: `node dist/cli.js --bank {id} --pretty`
- For web changes: test on localhost before deploying

#### 4c. Full QA audit (medium+ changes — MANDATORY, no exceptions)
- Delegate to `qa-engineer` agent. The QA agent runs ALL mandatory checks (see `qa-engineer.md`).
- QA agent's default verdict is FAIL. Every check must be proven PASS with command output or file evidence.
- **Blocking issues cannot be waived.** 3+ warnings on the same file escalate to a block.
- QA agent enforces: `skills/conventions/coding-style.md`, `skills/conventions/performance.md`, `skills/infra/error-handling.md`, `skills/financial/movement-contract.md`, `skills/security/credential-encryption.md`

- **Gate**: QA agent verdict is APPROVED. Any BLOCKED issue = stop. Fix before proceeding.

### Phase 4d: Plan-keeper gate (for planned/sprint work)
- If work was part of a plan, delegate to `plan-keeper` agent.
- Plan-keeper verifies: (1) scope matches plan, (2) deliverables match specs, (3) no regressions on previous sprints.
- Plan-keeper's default verdict is BLOCKED. Must prove scope compliance AND regression-free.
- Unplanned changes require explicit user approval before plan-keeper will pass.
- **Gate**: Plan-keeper verdict is APPROVED. Both QA and plan-keeper must pass.

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
- Committing without deploying -> stale production
- Deploying without QA -> broken production
- Code changes without AGENTS.md update -> stale docs
- New bank without agent file -> agent gives wrong advice
- Skipping design phase -> wrong scraping pattern
- Top-level heavy imports -> 45s cold starts on Vercel
- Missing balance in scraper -> dashboard shows stale data
- Not fetching 24 months on first sync -> incomplete history
- QA agent accepting "SKIP" on mandatory checks -> quality erosion
- Plan-keeper not checking previous sprint regression -> silent breakage
- Unplanned scope changes without user approval -> scope creep
