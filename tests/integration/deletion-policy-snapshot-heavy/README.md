# deletion-policy-snapshot-heavy

Integration test for `DeletionPolicy: Snapshot` on the two CFn-documented
Snapshot-capable types that complete cdkd's coverage (issue #1353):

- `AWS::Redshift::Cluster` (single-node `ra3.large` — cheapest ORDERABLE Redshift
  shape): `cdkd destroy` must run `CreateClusterSnapshot` + wait to
  `available` BEFORE the CC-routed delete.
- `AWS::ElastiCache::ReplicationGroup` (1-node Redis on `cache.t3.micro`):
  destroy must run the ElastiCache `CreateSnapshot` (replication-group form)
  + wait before the CC-routed delete.

Flow: deploy both → `cdkd destroy` → assert both resources gone AND a ready
cdkd-prefixed (`<physicalId>-final-<ts>`) snapshot exists for each → delete
the snapshot artifacts (a real user would keep them) → zero orphans.

Kept separate from the fast `deletion-policy-snapshot` fixture (EBS, ~3 min)
because this run takes **~30-40 minutes** (ElastiCache replication-group
create dominates) and bills real Redshift/ElastiCache hours. The Redshift
master password is generated per run (`CDKD_TEST_RS_PASSWORD`, throwaway).

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
