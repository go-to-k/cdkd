# deletion-policy-snapshot

Integration test for `DeletionPolicy: Snapshot` (issue #1352).

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
3. **`cdkd destroy`** — the **destroy runner** must do the same for
   `VolumeKeep`; the state file must be gone afterwards.
4. The two final snapshots (the test's artifacts — a real user would keep
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
