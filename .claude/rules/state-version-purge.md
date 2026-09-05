---
description: Why cdkd purges noncurrent state-bucket versions, and the S3 replication gap that purge cannot close
paths:
  - 'src/state/s3-noncurrent-version-purge.ts'
  - 'src/state/s3-replication-purge-gap.ts'
---

# The noncurrent-version purge, and what replication does to it

`src/state/s3-noncurrent-version-purge.ts` is what makes "cdkd deleted the
object" mean the body is unreadable: `cdkd bootstrap` turns VERSIONING on for
the state bucket, so a plain `DeleteObject` writes a delete marker and leaves
every prior version readable through `GetObject` with a `VersionId`. Six call
sites purge (`grep -rn 'purgeNoncurrentKeyVersions\|purgeNoncurrentVersions'
src/`): the custom-resource response sidecar (`custom-resource-provider.ts`,
and `gc.ts` for the abandoned ones), the transient CFn template
(`upload-cfn-template.ts`), the bootstrap marker (`bootstrap-destroy.ts`),
`lock.json` (`lock-manager.ts`), and the rollback journal (via
`S3StateBackend.purgeNoncurrentVersions`). `state.json` is deliberately NOT
purged -- its noncurrent versions ARE the recovery capability versioning is
enabled for. The module's own JSDoc is the authority on the rest.

## `src/state/s3-replication-purge-gap.ts` -- the detector for what the purge cannot reach

A `purgeNoncurrentKeyVersions` call that removed a BODY -- or could not settle
whether there was one -- ends here, asking `GetBucketReplication` whether the
state bucket replicates those keys
(issue [#2447](https://github.com/go-to-k/cdkd/issues/2447)).

**S3 never replicates a delete that names a `VersionId`.** PUTs replicate;
delete MARKERS replicate when `DeleteMarkerReplication` is enabled; a version-id
delete is excluded so that a delete on the source cannot destroy data on the
destination. So on a bucket with CRR or SRR the purge is SOURCE-ONLY and the
replica keeps every body -- the purge mechanism's own defect, reproduced one
bucket over and invisible from every signal cdkd emitted, which is worse than an
unfixed gap because the user is REASSURED. cdkd cannot remove the replica's
copies (that would mean cross-BUCKET deletes, a far larger capability), so this
module DETECTS and says so.

Six decisions are load-bearing; a later edit must not undo them. Four were
CORRECTIONS forced by review, so each is recorded with the failure it closes.
The full argument for each lives in the module's own JSDoc -- this list exists
so a later edit knows which lines are load-bearing, not to restate them.

1. **Scoped to keys a BODY was really removed for, or could not be settled.** Probing every requested
   key made a routine green deploy announce that the rollback journal's copies
   survive in the replica -- `deleteRollbackJournal` fires on EVERY successful
   deploy, so the object had often never existed. The first fix counted a
   noncurrent DELETE MARKER as a purged body and reinstated the same warning
   from deploy 2 onward, so provenance is tracked: only entries from
   `resp.Versions` count -- on the walk AND on every failure arm, so a throttle
   deleting yesterday's marker cannot reinstate it either. Keys whose LISTING
   failed are included (provenance genuinely unknown); when nothing was purged
   there is no probe at all.
2. **The PROBE is cached, the WARNING is deduped separately.** The cache is the
   `src/provisioning/create-only-properties.ts` shape (in-flight promise
   stored; definitive answers kept, transient ones evicted) keyed on bucket AND
   asserted `ExpectedBucketOwner` -- a mismatched-owner 403 cached under the
   bare bucket silenced every correctly-scoped caller. The warning dedupes per
   (bucket, object description, DESTINATIONS), and each of the three closes a
   measured hole: the bucket alone lets `lock-manager.ts`'s `debug`-demoted
   release line consume the journal's warning; without the destinations, a
   `cdkd/dev/...` purge matching one rule burns the slot and a later
   `cdkd/prod/...` purge never names the SECOND replica holding it. The slot is
   claimed only after the warning is actually emitted, so a throwing sink does
   not lose it.
3. **Two arms are ANSWERS, not failures, and both are silent.**
   `ReplicationConfigurationNotFoundError` is S3's ordinary reply for an
   unreplicated bucket, delivered as an ERROR (verified live: that string on
   both `name` and `Code`, HTTP 404); `AccessDenied` on
   `s3:GetReplicationConfiguration` is `debug`-only. Both are pinned by
   CACHING, not by silence -- silence cannot tell an answer from an unhandled
   shape, and asserting it left both green under a mutation removing the arm.
4. **A credential-shaped 403 is TRANSIENT**, checked before the blanket 403
   rule. `InvalidAccessKeyId` and the token-expiry codes clear on their own;
   cached as permanent, one blip silenced the detector for the whole process.
5. **`normalizeReplicationRules` over-approximates toward warning.** A
   tag-filtered rule reduces to a whole-bucket prefix; a missing `Status` counts
   as enabled; a `Disabled` rule is KEPT AND FLAGGED, because disabling stops
   FUTURE replication without removing what it already copied. A rule DELETED
   after copying is the one shape this cannot reach -- nothing is left to read
   -- and is recorded as a residual rather than implied away.
6. **Nothing here may reject.** A rejected promise in the cache would be
   re-thrown to every later caller and swallowed by the outer catch -- a
   silently dead detector. Hence the `catch` on the cached promise, the
   non-object-tolerant `errorCodes` / `httpStatus`, and identity-checked
   evictions.

User-facing writeup: [docs/state-management.md](../../docs/state-management.md),
"S3 replication defeats the purge". The wider sibling class -- other places
cdkd reports data removed while AWS keeps a readable copy -- is issue
[#2624](https://github.com/go-to-k/cdkd/issues/2624).
