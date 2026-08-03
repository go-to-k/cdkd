# deletion-policy-snapshot

Integration test for `DeletionPolicy: Snapshot` (issue #1352) and
`UpdateReplacePolicy: Snapshot` at the replacement delete site (issue #1357,
unblocked by the `AWS::EC2::Volume` immutable-property classification in
issue #1356).

CloudFormation creates a final snapshot BEFORE deleting a resource whose
`DeletionPolicy` is `Snapshot`. cdkd historically treated the policy as
`Delete` (no snapshot — silent data loss, live-A/B confirmed on
`AWS::EC2::Volume`). This fixture proves both cdkd delete paths honor the
policy on the cheapest Snapshot-capable type:

1. **Deploy** two 1 GiB gp3 volumes, both `DeletionPolicy: Snapshot`.
2. **Redeploy with `CDKD_TEST_UPDATE=true`** — `VolumeRemove` is dropped from
   the template, so the **deploy engine's DELETE branch** must create a
   completed, `cdkd:final-snapshot-of`-tagged EBS snapshot before deleting
   the volume.
3. **Redeploy with `CDKD_TEST_REPLACE=true`** — `VolumeKeep` moves to a
   different Availability Zone. `AvailabilityZone` is immutable on an EBS
   volume, so cdkd REPLACES the volume (create-first, then delete the old
   one) and the replacement delete must honor `UpdateReplacePolicy: Snapshot`.
   `AWS::EC2::Volume` is a stateful type, so the deploy passes
   `--force-stateful-recreation`.
4. **`cdkd destroy`** — the **destroy runner** must do the same for the
   replacement `VolumeKeep`; the state file must be gone afterwards.
5. The three final snapshots (the test's artifacts — a real user would keep
   them) are deleted and verified gone, so the run ends orphan-zero.

`AWS::EC2::Volume` is CC-API-routed, so both paths exercise the engine-side
pre-delete `CreateSnapshot`+wait from `src/provisioning/final-snapshot.ts`.
The atomic-parameter path (RDS / Neptune / DocDB / ElastiCache CacheCluster)
is pinned by unit tests instead — an RDS instance would add ~15 minutes and
real cost to this fixture for the same context-field plumbing.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
