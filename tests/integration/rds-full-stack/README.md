# RDS Full-Stack Example (`rds-full-stack`)

A realistic single-instance RDS deployment that stresses cdkd's **event-driven
DAG ordering**, **slow-create propagation**, and **intrinsic resolution of a
computed attribute** (the DB endpoint address consumed via `Fn::GetAtt`).

## Resources

- **VPC** - 2 AZs (RDS requires >= 2 subnets), `natGateways: 0`, isolated
  subnets only (the DB is private; no egress).
- **SecurityGroup** - explicit, self-referencing Postgres (5432) ingress.
- **DBSubnetGroup** - explicit, spanning the two isolated subnets.
- **DBParameterGroup** - explicit, Postgres 16.9 (family `postgres16`), with a
  non-default `application_name = cdkd-rds-full-stack` parameter.
- **`rds.DatabaseInstance`** (L2) - Postgres 16.9, `db.t3.micro`, single-AZ,
  20 GiB gp2, CDK-managed Secrets Manager credentials, `deletionProtection:
  false`, `RemovalPolicy.DESTROY`, no final snapshot.
- **SSM StringParameter** (`/cdkd/rds-full-stack/db-endpoint`) - its value is
  `Fn::GetAtt(<Database>, Endpoint.Address)`, a COMPUTED attribute only known
  after the instance is available.

## What it stresses (vs the other RDS fixtures)

- `rds-aurora` covers an Aurora **cluster** (+ writer + DBProxy) and a
  standalone L1 `CfnDBCluster` for #609 security-prop silent-drop closure.
- `rds-dbinstance-backfill` covers a standalone L1 `CfnDBInstance` for #609
  DBInstance security-prop silent-drop closure + the `provisionedBy=sdk`
  routing guard.

Neither uses an explicit **DBSubnetGroup + DBParameterGroup** pair on an L2
`rds.DatabaseInstance`, and neither consumes the DBInstance's **computed
endpoint** via a downstream `Fn::GetAtt` reference. This fixture targets
exactly that gap:

1. **Ordering** - the SubnetGroup / ParameterGroup / SG must be created before
   the instance; the SSM Parameter must be created AFTER the instance is
   available (it Refs the instance's computed endpoint).
2. **Slow-create propagation** - the instance takes ~5-10 min to become
   available; cdkd must wait and read the endpoint attribute back.
3. **Computed `Fn::GetAtt`** - the SSM parameter value must equal the LIVE
   endpoint address. If cdkd resolved the GetAtt before the instance was
   available, the value would be empty.

## Verify

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```

`verify.sh` deploys, asserts the instance uses the custom subnet group +
parameter group (and the group carries the non-default `application_name`),
asserts the SSM parameter value equals the live DB endpoint (the computed
`Fn::GetAtt` resolved post-create), then destroys and asserts the instance,
subnet group, parameter group, SSM parameter, and state file are all gone with
0 orphans. The cleanup trap deletes in the RDS-safe order (instance first +
wait, then groups, then SG / VPC).

## Cost / runtime notes

- **SLOW**: RDS instance create is ~5-10 min and delete is a few minutes more,
  so this integ takes roughly 10-20 min end-to-end. That is acceptable and
  expected for an RDS fixture.
- Cheapest reliable shape: `db.t3.micro` / 20 GiB gp2 / single-AZ / no NAT
  gateways / no final snapshot.

## Deploy / Destroy (manual)

```bash
cdkd deploy CdkdRdsFullStackExample
cdkd destroy CdkdRdsFullStackExample
```
