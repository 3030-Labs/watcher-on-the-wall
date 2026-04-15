# Tenant Guardrails Implementation
**Started:** 2026-04-14
**Status:** IN PROGRESS

## Prompt 2: Queue + Concurrency + Kill Switch
- [x] TenantScheduler with per-tenant subqueues
- [x] Round-robin fairness
- [x] Per-tenant concurrency caps
- [x] Kill switch (paused tenants)
- [x] Hosted mode config
- [x] Tests (9 new — round-robin, concurrency cap, global limit, pause/unpause, stop)

## Prompt 3: Quota Enforcement
- [x] TenantLimits config + Zod validation
- [x] StorageAccountant
- [x] DailyImportCounter (timezone-aware)
- [x] Onboarding burst
- [x] IngestBytesCounter
- [x] HealCooldown
- [x] Tests (14 new — storage, daily import, ingest bytes, heal cooldown)

## Prompt 4: Filesystem Hardening & Acceptance Tests
- [x] Symlink rejection
- [x] Tenant root enforcement on all file ops
- [x] Hosted-mode file operation wrapper (TenantFs)
- [x] Acceptance tests (14 new — fs isolation, queue fairness, kill switch, quotas)

## Prompt 7: Observability & Metrics
- [x] Per-tenant wiki_id on every log line (setLoggerContext)
- [x] MetricsCollector class (HTTP-based, no Supabase SDK)
- [x] Queue/job visibility methods (getStatus on TenantScheduler)
- [x] Guardrail hit tracking (recordGuardrailHit → guardrail_hits table)
- [x] Admin audit log integration (logAdminAction helper in wotw-cloud)
