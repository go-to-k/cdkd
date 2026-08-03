# rollback-deletion-policy-snapshot

Integration test for `DeletionPolicy: Snapshot` on a **rolled-back CREATE**
(issue #1358).

A deploy that creates two resources and fails on the second rolls the first
one back. cdkd used to ORPHAN a rolled-back CREATE carrying
`DeletionPolicy: Snapshot` — left in AWS, dropped from state — handing the
user an untracked, billing resource after a deploy that reported a completed
rollback. CloudFormation deletes it and honors the policy: final snapshot
first, then delete.

1. **Deploy** a 1 GiB gp3 volume (`VolumeSnap`, `DeletionPolicy: Snapshot`)
   plus a deliberately-invalid SQS queue (`BadQueue`, out-of-range
   `MessageRetentionPeriod`) that `DependsOn` it. The deploy MUST fail.
2. The automatic **rollback** must create a completed
   `cdkd:final-snapshot-of`-tagged EBS snapshot of `VolumeSnap` and then
   DELETE the volume. The old orphan log line (`Leaving VolumeSnap ... in
   AWS`) is asserted absent, so a regression names itself.
3. `VolumeSnap` must be gone from the cdkd state resource map. The state FILE
   itself legitimately survives — since issue #1208 a clean automatic rollback
   keeps the failed resource's pre-failure record so
   `cdkd rollback --revert-failed` can still reach it.
4. The final snapshot (the test's artifact — a real user would keep it) is
   deleted and verified gone, so the run ends orphan-zero.

`AWS::EC2::Volume` is the cheapest CFn-documented Snapshot-capable type and is
CC-API-routed, so the rollback exercises the engine-side pre-delete
`CreateSnapshot`+wait from `src/provisioning/final-snapshot.ts` reached through
`src/deployment/rollback-executor.ts`'s `delete-with-final-snapshot` action.
The atomic-parameter path (RDS / Neptune / DocDB / ElastiCache CacheCluster)
and the refusal paths are pinned by unit tests instead.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
