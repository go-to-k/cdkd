---
description: The noncurrent version purge and the replication gap
paths:
  - 'src/state/s3-noncurrent-version-purge.ts'
  - 'src/state/s3-replication-purge-gap.ts'
---

# Noncurrent-version purge and the replication gap

Versioning is ON for the state bucket, so a plain `DeleteObject` writes a delete
marker and prior versions stay readable by id;
`s3-noncurrent-version-purge.ts` makes "deleted" mean unreadable. **`state.json`
is deliberately NOT purged** — its noncurrent versions ARE the recovery
capability.

**S3 never replicates a delete naming a `VersionId`**, so with CRR or SRR the
purge is SOURCE-ONLY and the replica keeps every body. cdkd cannot remove those
copies, so `s3-replication-purge-gap.ts` reports it
([#2447](https://github.com/go-to-k/cdkd/issues/2447)); its JSDoc argues each:

1. **Scoped to keys a BODY was really removed for, or could not be settled.**
   Only `resp.Versions` entries count — a noncurrent DELETE MARKER never does,
   on the walk or any failure arm — but a failed LISTING does.
2. **The PROBE is cached, the WARNING deduped separately**: the cache is keyed
   on bucket AND asserted `ExpectedBucketOwner`, evicting transient answers; the
   warning dedupes per (bucket, description, DESTINATIONS) and claims its slot
   after emitting.
3. **Two arms are ANSWERS, not failures, both silent**:
   `ReplicationConfigurationNotFoundError` (delivered as an ERROR) and
   `AccessDenied` on `s3:GetReplicationConfiguration`. Pin by CACHING; asserting
   silence cannot tell an answer from an unhandled shape.
4. **A credential-shaped 403 is TRANSIENT**, checked BEFORE the blanket 403
   rule; cached permanent, one blip silences it.
5. **`normalizeReplicationRules` over-approximates toward warning**: tag filters
   become whole-bucket prefixes, a missing `Status` is enabled, `Disabled` is
   KEPT.
6. **Nothing here may reject.** A rejected cached promise re-throws to every
   later caller and the outer catch swallows it: a dead detector.
