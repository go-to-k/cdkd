# fsx-windows

Integration test for the `AWS::FSx::FileSystem` **Windows** (FSx for
Windows File Server) variant of the SDK provider (issue #1088, follow-up
to PR #1085). PR #1085 shipped the Windows / ONTAP / OpenZFS variants but
live-integ-verified only OpenZFS `SINGLE_AZ_1`; this fixture closes the
Windows half of that gap (the ONTAP half is `fsx-ontap`).

The type is `ProvisioningType: NON_PROVISIONABLE`, so no Cloud Control
fallback exists — this fixture is the end-to-end proof of the Windows
variant mapping. `aws-cdk-lib` ships no Windows-variant L2, so it uses
the L1 `fsx.CfnFileSystem`.

## Why the directory is created outside cdkd

A Windows file system must join an Active Directory at creation, and the
only practical option here is an AWS Managed Microsoft AD (a self-managed
AD would need real domain controllers). **cdkd cannot provision one**:
AWS reports the directory resource type as
`ProvisioningType: NON_PROVISIONABLE` and cdkd ships no SDK provider for
it, so it sits in `src/provisioning/unsupported-types.generated.ts` and
is pre-flight rejected.

`verify.sh` therefore creates the directory out of band with
`aws ds create-microsoft-ad`, inside the VPC that the cdkd stack deploys,
and feeds its id back to the stack through the `FSX_AD_ID` env var:

- `FSX_AD_ID` unset → VPC only.
- `FSX_AD_ID` set → VPC + the AD-joined Windows file system.

The same switch is what lets phase 5 make cdkd **delete** the file system
while the VPC still stands, so the file system leaves the domain before
the domain is deleted. `verify.sh` asserts both the file system and the
Managed AD are GONE.

## Resources

- `AWS::FSx::FileSystem` — smallest legal Windows config (see "Cost
  bounding" below), joined to the out-of-band Managed AD.
- `AWS::EC2::VPC` — 2 AZs, public subnets only, no NAT. Two AZs are
  required because `DirectoryVpcSettings.SubnetIds` needs exactly two
  subnets in **different** Availability Zones. The file system itself is
  `SINGLE_AZ_1` and uses only the first subnet, and takes the VPC's
  default security group.

## Cost bounding

Every constrained value is the smallest legal one, verified against the
FSx / Directory Service APIs (not just the CloudFormation schema — the
service constraints are stricter):

| Value | Choice | Why this is the floor |
| --- | --- | --- |
| `DeploymentType` | `SINGLE_AZ_1` | Cheapest Windows deployment type (`MULTI_AZ_1` runs a standby file server) and the only one that allows the 8 MBps throughput tier — `SINGLE_AZ_2` / `MULTI_AZ_1` start at 32 MBps. |
| `StorageType` / `StorageCapacity` | `SSD` / `32` GiB | SSD's minimum is 32 GiB; HDD's is 2000 GiB, so SSD is both the floor and cheaper at this size (FSx for Windows quotas: "Minimum storage capacity, SSD file systems: 32 GiB"). |
| `ThroughputCapacity` | `8` MBps | The documented minimum throughput capacity, and the lowest member of the valid set 8, 16, 32, 64, 128, 256, 512, 1024, 2048 (`UpdateFileSystemWindowsConfiguration.ThroughputCapacity` docs, `@aws-sdk/client-fsx`). |
| `AutomaticBackupRetentionDays` | `0` | Disables automatic backups (default is 30), so the run cannot leave chargeable backups behind. |
| Managed AD `Edition` | `Standard` | The cheaper of `Standard` / `Enterprise`. The `CreateMicrosoftAD` default is `Enterprise`, so it must be passed explicitly. |
| Managed AD `Name` | `corp.cdkd-integ.com` | Matches the `CreateMicrosoftAD` `Name` pattern, resolves inside the VPC only, and is not a Single Label Domain (FSx rejects SLDs). The NetBIOS short name defaults to `corp`. |
| Managed AD `Password` | random per run | Generated with `openssl rand`, satisfies the documented 8-64 char / mixed-class complexity pattern, and is never committed. |
| UPDATE property | `WeeklyMaintenanceStartTime` | A metadata-only mutable `WindowsConfiguration` sub-property. A `ThroughputCapacity` change exercises the same `applyWindowsUpdateField` mapping but swaps the underlying file servers and adds ~30 minutes of billed wall clock. |

## Phases (verify.sh)

1. **Deploy** with `FSX_AD_ID` unset → the VPC only. Outputs `VpcId`,
   `SubnetIdA`, `SubnetIdB`.
2. **Create the Managed Microsoft AD** out of band and wait for stage
   `Active`.
3. **Deploy** with `FSX_AD_ID` set → cdkd creates the AD-joined file
   system. Asserts `AVAILABLE`, `SINGLE_AZ_1` / `SSD` / 32 GiB / 8 MBps /
   automatic backups disabled / maintenance `1:05:00`, that no backup
   exists for the file system, that
   `WindowsConfiguration.ActiveDirectoryId` is the directory from phase
   2, that the `DNSName` / `ResourceARN` `Fn::GetAtt` outputs match AWS
   (and that `DNSName` sits under the fixture domain, which witnesses the
   domain join), and that state routes the resource via the SDK provider
   (`provisionedBy=sdk`).
4. **Update** (`CDKD_TEST_UPDATE=true`): `WeeklyMaintenanceStartTime`
   `1:05:00 -> 2:06:00` (`UpdateFileSystem` — a mutable
   `WindowsConfiguration` sub-property), tag value change AND tag removal
   (`TagResource` / `UntagResource`). Asserts the FileSystemId is
   unchanged (in-place, no replacement) and the AD binding is untouched.
5. **Delete the file system through cdkd** by re-deploying with
   `FSX_AD_ID` unset — the file system is no longer in the template, so
   cdkd plans a DELETE for it. Asserts it is gone by id AND by the
   fixture's constant tag (`cdkd-integ=fsx-windows`).
6. **Delete the Managed AD** and assert it is gone by id AND by domain
   name. A leftover Managed AD bills per hour.
7. **Destroy** the stack and assert the VPC and the cdkd state file are
   gone.

The cleanup trap runs the same teardown in the same order (file system →
final backups → directory → VPC → state), and is armed on `INT` / `TERM`
as well as `EXIT`, so a Ctrl-C or harness timeout mid-run cannot leak the
two per-hour-billed resources.

### Asserting "backups are disabled"

AWS **omits** `AutomaticBackupRetentionDays` from `DescribeFileSystems`
when automatic backups are disabled rather than echoing `0`, and the AWS
CLI renders the absent field as `None`. This was observed live on the
**ONTAP** variant (2026-07-20); the Windows variant has not been observed
live, so `verify.sh` does not assume symmetry — it accepts absent-or-`0`,
which is correct whichever way the Windows API serializes it. What *was*
verified for Windows specifically: the field is optional in
`WindowsFileSystemConfiguration` (so omission is representable) and the
create-time default is **30**, so a template that failed to carry the
property would report `30`, which is still rejected. The retention field
is only a proxy anyway — the assertion that actually protects the bill is
the `describe-backups` check keyed on `FileSystem.FileSystemId`.

### Final backups

`AutomaticBackupRetentionDays: 0` only disables **scheduled** backups.
cdkd's delete sends a bare `DeleteFileSystem` with no `SkipFinalBackup`
(deliberate CloudFormation parity — CFn exposes no such property), and
the Windows API default is to take a **final backup** that outlives the
file system and bills per GB-month. `verify.sh` therefore sweeps and
asserts on backups explicitly after the delete; the file-system
assertions alone would not catch this.

### Not concurrency-safe

The pre-run cleanup deletes any file system tagged
`cdkd-integ=fsx-windows` and any directory named `corp.cdkd-integ.com` in
the region. Do not run two copies of this fixture against the same
account+region simultaneously — the second run's pre-cleanup would
destroy the first run's live directory.

## Timing

The Managed AD takes ~20-40 minutes to provision and ~10 to delete; the
Windows file system ~20-30 to create and ~10 to delete. Expect a total
wall clock of **80-110 minutes** — the longest FSx fixture by a wide
margin, which is why the Windows variant was cost-gated out of PR #1085.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
