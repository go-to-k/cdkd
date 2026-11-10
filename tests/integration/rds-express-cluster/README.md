# RDS DBCluster express configuration

Deploys one L1 `rds.CfnDBCluster` (`aurora-postgresql`) with
`WithExpressConfiguration: true` (go-to-k/cdkd#5984). RDS itself creates the
writer `<clusterId>-instance-1`; cdkd waits for it, records its `DbiResourceId`
under the `cdkd:ExpressWriterResourceId` attribute, and deletes it before the
cluster on destroy.

## Resources

- **ExpressCluster** (`AWS::RDS::DBCluster`) - no VPC, no other resources. Express
  configuration forces port 5432 and IAM auth, so neither is declared.

## verify.sh phases

1. Deploy: record is `provisionedBy=sdk`, the writer exists and is `available`,
   the recorded writer resource id equals the live `DbiResourceId`, and the
   stack output endpoint equals the live cluster endpoint.
2. `CDKD_TEST_UPDATE=true` deploy: `BackupRetentionPeriod` 1 -> 7 live, and the
   record still carries the same `cdkd:ExpressWriterResourceId`.
3. Refusal: an out-of-band instance is added; `cdkd destroy` exits 2 with
   "besides the writer express configuration created", deletes nothing, and the
   state record stays. The instance is then removed.
4. Destroy: exit 0, the writer, the cluster and the state file are gone, and no
   manual cluster snapshot was left (RemovalPolicy.DESTROY means Delete).

## Run

```bash
export STATE_BUCKET=cdkd-state-<account-id>
./verify.sh
```
