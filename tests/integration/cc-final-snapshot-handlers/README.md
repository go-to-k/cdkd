# Cloud Control final-snapshot handlers (`cc-final-snapshot-handlers`)

Issue #4029. Three snapshot-capable resources, each routed through Cloud Control
and each with `DeletionPolicy: Delete`:

- an Aurora PostgreSQL cluster that is a member of an `AWS::RDS::GlobalCluster`;
- a Neptune cluster (`CopyTagsToSnapshot` routes it through Cloud Control);
- a Redis `AWS::ElastiCache::CacheCluster`, moved onto Cloud Control in phase 2
  with `--recreate-via-cc-api`.

`verify.sh` deploys, asserts the routing and the recorded policies, destroys, and
fails if any of the three has a snapshot created after the run began. Cleanup
deletes any such snapshot. Before the fix, the Aurora and Neptune handlers each
left one; the cache handler left none.

The Aurora master password is a generated Secrets Manager secret resolved
through a dynamic reference, so the run sweeps the state bucket's object
versions.

Runtime: roughly 25 minutes, mostly the Aurora and ElastiCache creates.
