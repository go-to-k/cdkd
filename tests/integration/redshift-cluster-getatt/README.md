# redshift-cluster-getatt

Failure-seeking integration test for cdkd's **Cloud Control API attribute
enrichment** on `AWS::Redshift::Cluster`.

Redshift Cluster has no SDK provider → always CC-routed. Pre-fix,
`Fn::GetAtt(<Cluster>, 'Endpoint.Address')` / `Endpoint.Port` fell through the
intrinsic resolver's `constructAttribute` to the physicalId (the cluster id)
instead of the real `*.redshift.amazonaws.com` endpoint — so a JDBC/ODBC
connection string built from it pointed at garbage.

The fix adds an `AWS::Redshift::Cluster` case to `enrichResourceAttributes`
(in `src/provisioning/cloud-control-provider.ts`) that calls `DescribeClusters`
and populates the flat-key `Endpoint.Address` / `Endpoint.Port` attributes.

## Topology

A `natGateways: 0` VPC + Redshift `CfnClusterSubnetGroup` + SecurityGroup + a
single-node `ra3.large` `CfnCluster` (AWS-managed master password — no literal
secret committed), plus two SSM Parameters whose `Value` is `Fn::GetAtt`
against the cluster's `Endpoint.Address` / `Endpoint.Port`.

## What it asserts

1. Deploy succeeds.
2. **(load-bearing)** the SSM Parameter for `Endpoint.Address` holds a real
   `*.redshift.amazonaws.com` hostname (NOT the cluster id), and the port is
   numeric — proving the CC-API enrichment ran.
3. Destroy is clean: state + SSM params + cluster all gone, 0 orphans.

Run via `/run-integ redshift-cluster-getatt`.
