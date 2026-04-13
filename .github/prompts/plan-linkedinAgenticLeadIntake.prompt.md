## Plan v2: Agentic LinkedIn Lead Intake

### Constraints (locked)
- Public-page collection only (no login, no paid provider fallback)
- Target market: C-suites in Retail, Real Estate, Retail Tech, Commerce
- Desired outcome: higher fresh lead flow with explicit confidence/provenance, then feed into existing email generation
- Tradeoff accepted: throughput can degrade when anonymous access is blocked

### Architecture Summary
- Add AI-callable backend tools for discovery, extraction, ranking, and persistence
- Keep `generateEmailForLead` path intact; insert validated enrichment before generation
- Move from static-file-first to hybrid ingestion: seed JSON + live fetch + dedupe + Mongo persistence
- Require provenance and confidence on every candidate before AI personalization

### Phase 1 — MVP (5–7 days)
**Goal:** Produce a reliable first agentic pipeline with observable quality.

**Deliverables**
1. Canonical lead schema in backend (identity + sector + c-suite classification + provenance + confidence).
2. New endpoints/tools:
	- `POST /api/agent/search-public-profiles`
	- `POST /api/agent/extract-profile-signals`
	- `POST /api/agent/rank-csuite-targets`
	- `POST /api/agent/save-candidates`
3. Company/sector-first query builder (Retail, Real Estate, Retail Tech, Commerce).
4. Deterministic dedupe using existing identity logic and profile URL normalization.
5. “Insufficient public data” guardrail path when confidence is below threshold.

**Implementation Notes**
- Integrate around existing load/generation flow in `src/index.ts`.
- Keep `src/linkedin.json` only as bootstrap fallback, not primary source.
- Store crawl attempts and failures to avoid repeated dead-end fetches.

**Exit Criteria**
- Tool endpoints return schema-valid objects and clear error codes.
- End-to-end run can find, rank, and persist candidates from at least 2 sectors.
- Email generation only consumes validated lead records.

### Phase 2 — Scale (4–6 days)
**Goal:** Increase throughput and stability under anonymous constraints.

**Deliverables**
1. Queue-based crawling orchestration (batch jobs, retries, cooldown windows).
2. Per-domain throttling and adaptive backoff.
3. Incremental refresh strategy (re-crawl stale leads, skip recently attempted URLs).
4. Precomputed sector/company target packs to reduce exploratory fetch cost.
5. Bulk ranking endpoint for high-volume campaign preparation.

**Implementation Notes**
- Prioritize homogeneous batches: company-first, then title filters (`CEO`, `COO`, `CRO`, `CTO`, etc.).
- Log coverage metrics: attempted URLs, parse success %, leads accepted %, c-suite precision proxy.

**Exit Criteria**
- Stable batch processing with bounded retries and no runaway loops.
- Measurable lift in fresh accepted leads versus static JSON baseline.
- Predictable latency for bulk lead preparation requests.

### Phase 3 — Hardening (3–4 days)
**Goal:** Improve trust, observability, and operational control.

**Deliverables**
1. Confidence policy: hard thresholds for auto-accept vs skip.
2. Evidence snapshots saved with each lead (source URL, extraction timestamp, parsed fields).
3. Admin/ops endpoints for job status and quality dashboards.
4. Documentation updates in `API_DOCS.md` and `INFRASTRUCTURE.md` reflecting best-effort anonymous collection limits.

**Implementation Notes**
- Add defensive validation before persistence and before passing data to Gemini.
- Prevent low-evidence records from entering outbound workflows.

**Exit Criteria**
- Every persisted lead has provenance + confidence.
- Operators can inspect job outcomes and failure reasons quickly.
- Docs reflect real operational expectations and constraints.

### Data Contract (minimum)
- `identifier`: stable key (profile URL normalized)
- `name`: string
- `title`: string
- `company`: string
- `sector`: enum (`retail` | `real_estate` | `retail_tech` | `commerce` | `unknown`)
- `isCSuite`: boolean
- `confidence`: number (0–1)
- `provenance`: `{ sourceUrl, fetchedAt, method }`
- `signals`: `{ titleMatch, sectorMatch, companyMatch }`

### Validation & Metrics
- API validation: input schema + deterministic error responses.
- Quality validation: sampled title/sector precision checks per batch.
- Throughput validation: leads/hour, accept rate, retry rate, stale refresh success.
- Safety validation: no email generation from records below confidence threshold.

### Risks You’re Explicitly Accepting
- Anonymous public access can be rate-limited or blocked unpredictably.
- Coverage and freshness will fluctuate by time/region/query pattern.
- 1,000+ daily volume is not guaranteed without broader source options.

### Next Refinement Options
- Convert this into sprint tickets with owner, estimate, and acceptance criteria.
- Add a concrete endpoint spec (request/response JSON) for each agent tool.
- Define confidence thresholds per campaign type.
