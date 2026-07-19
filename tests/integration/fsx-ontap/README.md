# fsx-ontap

Integration test for the `AWS::FSx::FileSystem` **ONTAP** (FSx for NetApp
ONTAP) variant of the SDK provider (issue #1088, follow-up to PR #1085).
PR #1085 shipped the Windows / ONTAP / OpenZFS variants but
live-integ-verified only OpenZFS `SINGLE_AZ_1`; this fixture closes the
ONTAP half of that gap (the Windows half is `fsx-windows`).

The type is `ProvisioningType: NON_PROVISIONABLE`, so no Cloud Control
fallback exists — this fixture is the end-to-end proof of the ONTAP
variant mapping. `aws-cdk-lib` ships no ONTAP L2, so it uses the L1
`fsx.CfnFileSystem`.

## Resources

- `AWS::FSx::FileSystem` — smallest legal ONTAP config (see "Cost
  bounding" below).
- `AWS::EC2::VPC` — minimal network (1 AZ, public subnet only, no NAT).
  The file system uses the VPC's default security group.

## Cost bounding

ONTAP is materially pricier per hour than OpenZFS, so every constrained
value is the smallest legal one, verified against the FSx API (not just
the CloudFormation schema — the service constraints are stricter):

| Value | Choice | Why this is the floor |
| --- | --- | --- |
| `DeploymentType` | `SINGLE_AZ_1` | One subnet, one HA pair. `MULTI_AZ_*` doubles the file-server footprint. |
| `StorageCapacity` | `1024` GiB | ONTAP's minimum is `1024 * HAPairs` and `HAPairs` defaults to 1 (`CreateFileSystemRequest.StorageCapacity` docs, `@aws-sdk/client-fsx`). |
| `ThroughputCapacity` | `128` MBps | For `SINGLE_AZ_1` the valid values are 128, 256, 512, 1024, 2048, 4096 MBps (`CreateFileSystemOntapConfiguration.ThroughputCapacityPerHAPair` docs, `@aws-sdk/client-fsx`). |
| `AutomaticBackupRetentionDays` | `0` | Disables automatic backups (default is 30), so the run cannot leave chargeable backups behind after the file system is deleted. |
| `PreferredSubnetId` | omitted | Required only for `MULTI_AZ_1` / `MULTI_AZ_2`. |
| `FsxAdminPassword` | omitted | Optional; the fixture never uses the ONTAP CLI, so no secret is committed. |
| UPDATE property | `WeeklyMaintenanceStartTime` | A metadata-only mutable `OntapConfiguration` sub-property. A `ThroughputCapacity` change exercises the same `applyOntapUpdateField` mapping but is a live storage-optimization operation that adds tens of minutes of billed wall clock. |

## Phases (verify.sh)

1. **Deploy** the baseline file system and assert via
   `aws fsx describe-file-systems` that it is `AVAILABLE` with the
   templated config (SINGLE_AZ_1, 1024 GiB, `ThroughputCapacity: 128`,
   `AutomaticBackupRetentionDays: 0`, `WeeklyMaintenanceStartTime:
   1:05:00`), that the `ResourceARN` output (`Fn::GetAtt`) matches the
   AWS-side value, and that state routes the resource via the SDK
   provider (`provisionedBy=sdk`). ONTAP file systems expose no top-level
   `DNSName` (their endpoints live under `OntapConfiguration.Endpoints`),
   so `ResourceARN` is the attribute this variant asserts against.
2. **Update** (`CDKD_TEST_UPDATE=true`): `WeeklyMaintenanceStartTime`
   `1:05:00 -> 2:06:00` (`UpdateFileSystem` — a mutable
   `OntapConfiguration` sub-property), tag value change AND tag removal
   (`TagResource` / `UntagResource`). Asserts the FileSystemId is
   unchanged (in-place, no replacement).
3. **Destroy** and assert the file system + VPC are gone from AWS and the
   cdkd state file is removed. A leftover FSx file system is never
   acceptable (per-hour billing on 1 TiB of SSD) — the cleanup trap
   force-deletes any file system carrying the fixture's constant tag
   (`cdkd-integ=fsx-ontap`), and is armed on `INT` / `TERM` as well as
   `EXIT` so a Ctrl-C mid-run cannot leak it.

### Final backups

`AutomaticBackupRetentionDays: 0` only disables **scheduled** backups.
cdkd's delete sends a bare `DeleteFileSystem` with no `SkipFinalBackup`
(deliberate CloudFormation parity — CFn exposes no such property), and
the ONTAP API default is to take a **final backup** that outlives the
file system and bills per GB-month on 1 TiB. `verify.sh` therefore sweeps
and asserts on backups explicitly after the destroy; the file-system
assertions alone would not catch this.

### Not concurrency-safe

The pre-run cleanup deletes any file system tagged `cdkd-integ=fsx-ontap`
in the region. Do not run two copies of this fixture against the same
account+region simultaneously.

## Timing

FSx ONTAP creation takes ~20-25 minutes and deletion ~10 more; expect a
total wall clock of 35-50 minutes.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
