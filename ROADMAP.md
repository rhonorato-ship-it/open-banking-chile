# Roadmap

> **Controlled document.** Only the `roadmap-keeper` agent may modify this file. Changes require explicit user approval with risk acknowledgment. See `.claude/agents/roadmap-keeper.md` for the change protocol.

## Active Initiatives

### R1: Open Banking Scraper Platform (v2.x) — ACTIVE
**Status:** v2.1.3 shipped. 12/15 banks API-mode. Local sync agent operational.

#### Completed milestones
- [x] 15 bank scrapers implemented (12 API, 3 browser)
- [x] Playwright migration (replaced Puppeteer)
- [x] Local sync agent with Supabase Realtime
- [x] Agentic 2FA (Gmail auto-extraction)
- [x] Web dashboard (Next.js 15, Google OAuth, analytics, coach)
- [x] Google Drive XLSX export
- [x] Agent coordination system (25 agents, 21 skills, 6 commands)

#### In progress
- [ ] **R1.1** MACH full auth — device-bound AES-GCM PIN replication (TD-001)
- [ ] **R1.2** Tenpo endpoint discovery — APK decompilation needed (TD-002)
- [ ] **R1.3** Live testing — BCI, Falabella, BICE, Itau, Citi with real credentials (TD-007, TD-008)
- [ ] **R1.4** Bundle size optimization — 228KB → <200KB target
- [ ] **R1.5** UX redesign — align with open-finance-tool design (360 view, coach, time series)

#### Backlog (not started)
- [ ] **R1.6** ML-based category classification (replace regex, TD-003)
- [ ] **R1.7** Personalized coach recommendations (TD-004)
- [ ] **R1.8** Budget tracking and goal setting (TD-005)
- [ ] **R1.9** Multi-hop transfer detection (TD-006)

---

### R2: Contract Intelligence Pipeline — PLANNED
**Status:** Spec drafted. Not yet started. Requires new repo (`payments-contract-pipeline`).

**Objective:** Build a contract intelligence system for payments SaaS that ingests counterparty contracts, compares against our company template, classifies clauses using a payments-specific taxonomy, flags deviations, and enables LLM-powered analysis with citations.

**Core principle:** Our template represents our preferred contractual position. All analysis starts from the template. First drafts align with template terms unless user instructs otherwise.

#### Key components
- [ ] **R2.1** Template system — master template, positions YAML, fallback positions, red lines
- [ ] **R2.2** Ingestion pipeline — PDF/DOCX parsing, clause segmentation, metadata extraction
- [ ] **R2.3** Classification — payments SaaS taxonomy (8 categories, 30+ clause types)
- [ ] **R2.4** Deviation detection — compare vs template, score severity (Aligned/Minor/Major/Blocker)
- [ ] **R2.5** Storage — ORM models, vector store, embeddings with metadata
- [ ] **R2.6** Retrieval — hybrid search (structured SQL + vector similarity), reranking
- [ ] **R2.7** Generation — RAG engine, redline generator, citation formatter
- [ ] **R2.8** API — FastAPI (ingest, query, compare, redline, contracts, clauses, deviations)

#### Spec reference
Full specification: `docs/superpowers/specs/2026-03-31-contract-intelligence-pipeline.md`

#### Dependencies
- Separate repo (not in open-banking-chile)
- Claude API for classification and generation
- Vector DB (pgvector or dedicated)
- Sample contracts for testing

---

## Roadmap Rules

1. **No development outside the roadmap.** Every task must trace to an R-number. If work isn't listed, it must be added to the roadmap first (with user approval).
2. **Roadmap changes require explicit approval.** The roadmap-keeper agent will challenge changes, outline risks, and require express confirmation.
3. **Completed items stay visible.** Checked boxes are never removed — they move to "Completed milestones" for auditability.
4. **Tech debt items must map to R-numbers.** Every TD-xxx in tech-debt.md should reference its corresponding R-number.
5. **New initiatives get an R-number.** Sequential (R1, R2, R3...). Sub-items use dot notation (R1.1, R1.2...).
