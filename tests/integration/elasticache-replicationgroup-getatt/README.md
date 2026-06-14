# elasticache-replicationgroup-getatt

Failure-seeking integration test for cdkd's **Cloud Control API attribute
enrichment** on `AWS::ElastiCache::ReplicationGroup`.

ElastiCache ReplicationGroup has no SDK provider, so it always routes through
Cloud Control. Pre-fix, `Fn::GetAtt(<RG>, 'PrimaryEndPoint.Address')` fell
through the intrinsic resolver's `constructAttribute` to the physicalId (the
replication-group id) instead of the real Redis hostname — so a security-group
rule or client connection string built from the endpoint pointed at garbage.

The fix adds an `AWS::ElastiCache::ReplicationGroup` case to
`enrichResourceAttributes` (in `src/provisioning/cloud-control-provider.ts`)
that calls `DescribeReplicationGroups` and populates the flat-key endpoint
attributes with the CFn casing (`PrimaryEndPoint.Address` / `ReaderEndPoint.*`
/ `ConfigurationEndPoint.*` / `ReadEndPoint.Addresses` list).

## Topology

A `natGateways: 0` VPC + ElastiCache subnet group + SecurityGroup + a
cluster-mode-disabled Redis `CfnReplicationGroup` (single `cache.t3.micro`
node), plus two SSM Parameters whose `Value` is `Fn::GetAtt` against the RG's
`PrimaryEndPoint.Address` / `PrimaryEndPoint.Port`.

## What it asserts

1. Deploy succeeds.
2. **(load-bearing)** the SSM Parameter for `PrimaryEndPoint.Address` holds a
   real `*.cache.amazonaws.com` hostname (NOT the RG id), and the port is
   numeric — proving the CC-API enrichment ran.
3. Destroy is clean: state + SSM params + ReplicationGroup all gone, 0 orphans.

Run via `/run-integ elasticache-replicationgroup-getatt`.
