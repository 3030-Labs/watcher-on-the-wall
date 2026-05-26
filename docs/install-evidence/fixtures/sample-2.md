# Sample 2 — meeting notes 2026-04-12 backend sync

Attendees: backend team (full), platform team (rep).

## Discussed

- **Queue backpressure under burst load.** Production p99 enqueue latency
  has been creeping up since the new ingest webhook went live. Root
  cause appears to be the synchronous DB insert blocking the queue
  worker. Proposed fix: move the insert to an async batch with a 50ms
  flush window.
- **Postgres connection-pool sizing.** Current pool of 20 is undersized
  for the new workload. Platform team will bump to 40 in next deploy
  window and watch latency for a week.
- **Deprecation of v1 ingest API.** v1 traffic has dropped below 0.5%
  of total. Plan: announce 90-day deprecation in next changelog,
  remove from docs immediately, keep endpoint live but log warnings.

## Action items

- @alex: write the async batch insert behind a feature flag, target
  next sprint.
- @bex: bump pool to 40 in this week's deploy.
- @carol: draft the v1 deprecation announcement.
