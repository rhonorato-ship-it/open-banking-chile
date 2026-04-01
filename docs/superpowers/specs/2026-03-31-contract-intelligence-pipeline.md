# Contract Intelligence Pipeline — Spec (R2)

> Payments SaaS contract analysis system. Ingests counterparty contracts, compares against company template, classifies clauses, flags deviations, enables LLM-powered analysis with citations.

**Core principle:** Our template = our preferred position. All analysis starts from template. First drafts align with template unless user instructs otherwise.

## Repo Structure

Separate repo: `payments-contract-pipeline/`

```
templates/           master_template.docx, template_positions.yaml, fallback_positions.yaml, red_lines.yaml
ingestion/           parsers/ (pdf, docx), segmenter, metadata_extractor, template_loader, pipeline
classification/      clause_classifier, taxonomy, prompts/, training/
comparison/          deviation_detector, position_checker, risk_scorer, prompts/
storage/             models, vector_store, migrations/, schema.sql
retrieval/           hybrid_search, query_router, reranker
generation/          rag_engine, redline_generator, system_prompt.txt, citation_formatter, draft_engine
api/                 FastAPI main, routes/ (ingest, query, compare, redline, contracts, clauses, deviations)
tests/               fixtures/ (sample contracts)
scripts/             bulk_ingest, index_template, evaluate_classifier, seed_taxonomy
```

## Template System

### template_positions.yaml
Each clause type maps to preferred position, fallback, and red line:
```yaml
liability_cap:
  preferred: "Aggregate liability capped at 12 months of fees paid"
  fallback: "Aggregate liability capped at fees paid in the 6 months preceding the claim"
  red_line: "Never accept uncapped liability or liability exceeding 24 months of fees"
```

### red_lines.yaml — absolute non-negotiables (BLOCKERS)
- Uncapped liability, unlimited indemnification
- Audit without 30-day notice, non-mutual IP indemnification
- Exclusivity provisions, unilateral termination without cure
- Governing law where we have no presence
- Chargeback liability shifting without dispute mechanism
- PCI-DSS beyond certified scope, unlimited data retention

### Comparison flow
1. Classify each clause by type (taxonomy)
2. Match to corresponding template position
3. Compare incoming vs preferred → score deviation
4. Severity: **Aligned** | **Minor** (near fallback) | **Major** (beyond fallback) | **Blocker** (red line)
5. Generate redline language for Major/Blocker deviations

## Payments SaaS Clause Taxonomy (8 categories, 30+ types)

**Commercial:** Pricing/Fees, Settlement/Payouts, Volume Commitments, Chargebacks/Disputes, Refunds
**Service Levels:** Uptime SLA, SLA Credits, Support/Response, API/Integration, Change Management
**Payment Obligations:** PCI-DSS, Payment Methods, AML/KYC, Fraud Prevention, Regulatory/Licensing
**Data/Privacy:** DPA, Data Residency, Data Retention, Breach Notification
**Liability/Risk:** Limitation of Liability, Indemnification, Insurance
**Term/Governance:** Term/Renewal, Termination, Post-Termination, Governing Law, Assignment
**IP/Confidentiality:** IP Ownership, Confidentiality, Branding/Co-Marketing
**Boilerplate:** Force Majeure, Notices, Entire Agreement, Audit Rights

## Metadata Schema (key fields)

| Field | Type | Description |
|---|---|---|
| contract_type | enum | MSA, PSA, Order Form, DPA, SLA, NDA, Addendum |
| counterparty_type | enum | merchant, acquiring_bank, card_scheme, technology_partner, reseller |
| our_role | enum | payment_processor, payment_gateway, payment_facilitator, PSP |
| pricing_model | enum | interchange_plus, flat_rate, tiered, blended, custom |
| settlement_timing | text | T+1, T+2, etc. |
| uptime_sla_pct | decimal | Committed uptime |
| liability_cap | text | Cap description |
| template_deviation_score | decimal | 0=aligned, 100=max deviation |
| blocker_count | integer | Red-line violations found |

## System Prompt (core rules)

1. **TEMPLATE FIRST** — always compare against template, first suggestion aligns with template
2. **DEVIATION AWARENESS** — note alignment/fallback/deviation for every clause
3. **CITATIONS REQUIRED** — cite contract name, section, clause. Never invent content.
4. **PAYMENTS EXPERTISE** — interchange, chargebacks, settlement, PCI-DSS, card scheme rules
5. **RISK CALIBRATION** — 99.9% uptime is standard; 99.99% is aggressive; uncapped liability is always blocker
6. **DRAFTING MODE** — start from template wording, adapt minimally, explain changes
7. **NEVER GIVE LEGAL ADVICE** — flag for human review

## Technical Requirements

- **Parsing:** pdfplumber/docling for PDF, python-docx for DOCX. Preserve structure. Fee tables as structured data.
- **Segmentation:** Along contract structure (numbered sections). Preserve parent-child.
- **Template indexing:** Same clause structure as contracts, flagged `is_template = True`.
- **Classification:** Phase 1: Claude API few-shot. Phase 2: fine-tuned lightweight classifier. Store confidence.
- **Deviation detection:** Match by clause type + semantic similarity → LLM comparison → check positions/red_lines → score severity.
- **Embeddings:** Strong model, metadata-enriched (contract type, clause type, counterparty type).
- **Hybrid retrieval:** Structured SQL + vector similarity + comparison + cross-contract queries.
- **Redline generation:** Start from template, adapt to counterparty context, show changes, never violate red lines.
- **API:** FastAPI. POST /ingest, POST /query, POST /compare, POST /redline, GET /contracts, GET /clauses, GET /deviations.

## Getting Started

1. `scripts/index_template.py` — parse and store template as baseline
2. Populate YAML position files
3. Build ingestion pipeline, test with fixtures
4. Add comparison + deviation detection
5. Add retrieval + RAG
6. Expose via API
