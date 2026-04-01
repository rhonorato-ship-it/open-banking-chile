# Roadmap History

> Audit log of roadmap changes, completed initiatives, and overhauls. Append-only.

## 2026-03-31 — Initial roadmap created

**Action:** Created ROADMAP.md with two initiatives.
**Approved by:** User (initial creation, no prior roadmap existed)

### R1: Open Banking Scraper Platform (v2.x)
- Originated from project inception
- v2.1.3 is current release
- 7 completed milestones, 5 in-progress items, 4 backlog items
- Major overhaul on 2026-03-28: migrated 8 banks from browser to API mode
- Agent system reorganized on 2026-03-30: 25 agents, 21 skills, 6 commands

### R2: Contract Intelligence Pipeline
- Originated from user request on 2026-03-31
- Full spec at `docs/superpowers/specs/2026-03-31-contract-intelligence-pipeline.md`
- Status: PLANNED (not yet started, separate repo needed)
- 8 sub-items (R2.1 through R2.8)

---

## Previous development log (pre-roadmap)

| Date | Change | Ref |
|------|--------|-----|
| 2026-03-25 | Web dashboard initial design spec | docs/superpowers/specs/2026-03-25-web-dashboard-design.md |
| 2026-03-27 | Agentic 2FA design spec | docs/superpowers/specs/2026-03-27-agentic-2fa-design.md |
| 2026-03-27 | API migration design spec | docs/superpowers/specs/2026-03-27-api-migration-design.md |
| 2026-03-28 | 8 banks migrated to API mode | registry.md |
| 2026-03-28 | MACH + Tenpo skeleton scrapers | registry.md |
| 2026-03-28 | Playwright migration, agentic 2FA, local agent | registry.md |
| 2026-03-29 | Fintual Bearer auth fix, v2.1.3 | registry.md |
| 2026-03-30 | Full agent system reorganization | registry.md |
| 2026-03-31 | QA + plan-keeper enforcement upgrade | qa-engineer.md, plan-keeper.md |

---

## Change log format

When the roadmap changes, append an entry here:

```markdown
## YYYY-MM-DD — [Brief description]

**Action:** [What changed in ROADMAP.md]
**Approved by:** User (explicit confirmation required)
**Reason:** [Why the change was needed]
**Risk acknowledged:** [What risks were outlined by roadmap-keeper]
**Items affected:** [R-numbers added/modified/removed]
```
