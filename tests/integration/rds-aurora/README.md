# RDS Aurora Serverless v2 Example

This example deploys an Aurora Serverless v2 (MySQL) cluster with minimal cost configuration.

## Resources

- **VPC** - 1 AZ, no NAT gateways, isolated subnets only
- **Security Group** - Allows MySQL (3306) access from within the VPC
- **Aurora Serverless v2 Cluster** - MySQL 3.08.0, 0.5-1 ACU capacity. Created
  on the SDK route (every key the L2 emits is handled since issue #2762), then
  verify.sh rewrites its record to `provisionedBy: cc-api`, the Cloud Control
  route the record keeps on later deploys, and asserts that route and that
  destroying it left no manual snapshot (issue #3993). Its writer instance
  declares `PromotionTier: 0`; verify.sh asserts the writer is created on the
  SDK route with that tier live (issue #2762)
- **Secrets Manager Secret** - Auto-generated database credentials (created by CDK)
- **RDS Proxy** (`AuroraProxy`) - sets `DebugLogging` in phase 1 and DROPS it in
  the `CDKD_TEST_UPDATE=true` phase; verify.sh asserts the live value stays
  true (ModifyDBProxy keeps an omitted setting, and a CFn A/B showed
  CloudFormation keeps it too) and that the deploy warned about it, saying
  CloudFormation leaves it (issue #1160). It also declares
  `DefaultAuthScheme: NONE`, `EndpointNetworkType: IPV4` and
  `TargetConnectionNetworkType: IPV4`; verify.sh asserts the proxy stayed on
  the SDK route, records the values and holds them live (issue #2762)
- **RDS Proxy endpoint** (`ReaderEndpoint`, READ_ONLY) - declares
  `EndpointNetworkType: IPV4`; verify.sh asserts the endpoint stayed on the SDK
  route, records the value and holds it live (issue #2762)

- **SecurityCluster** (L1 `CfnDBCluster`, aurora-postgresql, no instance) - the
  issue #609 DBCluster security-property silent-drop assertions
  (`ManageMasterUserPassword` / `MasterUserSecret` / `MonitoringRoleArn` /
  `MonitoringInterval` / `EnableIAMDatabaseAuthentication`) plus the issue
  #5004 removal-keeps-the-value assertions: `DeletionProtection` +
  `EnableIAMDatabaseAuthentication` are set in phase 1 and DROPPED in the
  `CDKD_TEST_UPDATE=true` phase; verify.sh asserts both are KEPT, as
  CloudFormation does; the same phase drops `BackupRetentionPeriod` (7 in
  phase 1) and asserts the reset to 1, proving `ModifyDBCluster` fired. The
  same phase drops `VpcSecurityGroupIds` and asserts the cluster moved to the
  VPC's `default` security group, as CloudFormation does (issue #1160). Phase 2b
  proves a failed `--remove-protection` destroy restores it (issue #2204); it
  runs with `--verbose` to read AWS's member refusal, which the thrown error
  names only by its class (issue #2319). It
  declares no `DeletionPolicy`, so its destroy takes CloudFormation's default
  final snapshot, which verify.sh asserts and then deletes (issue #4030). Its
  `SecondsUntilAutoPause` is 600 in phase 1 and 1800 in phase 2, each asserted
  live (issue #5466). Phase 1 also declares a custom
  `DBClusterParameterGroupName` (`SecurityClusterParams`), both windows,
  `CopyTagsToSnapshot: true` and `StorageType: aurora-iopt1`, each asserted
  live; phase 2 changes the maintenance window and drops the other four, which
  verify.sh asserts KEPT, as CloudFormation keeps them (measured, issue #2762).
- **EngineCluster** (L1 `CfnDBCluster`, no instance, `DeletionPolicy: Delete`) -
  phase 2c swaps its `Engine` from aurora-mysql to aurora-postgresql, which
  CloudFormation replaces: verify.sh asserts the deploy is refused without
  `--force-stateful-recreation` and replaces the cluster with it (issue #5467).

## Outputs

- `ClusterEndpoint` - Aurora cluster endpoint hostname
- `SecretArn` - Secrets Manager secret ARN for database credentials
- `VpcId` - VPC ID

## Deploy

```bash
cdkd deploy RdsAuroraStack
```

## Destroy

```bash
cdkd destroy RdsAuroraStack
```

## Cost Notes

- Serverless v2 with minCapacity 0.5 ACU keeps costs minimal
- No NAT gateways (isolated subnets only) avoids NAT gateway charges
- Single AZ deployment reduces costs further
