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
6. **Delete the Managed AD.** This phase asserts that the deletion was
   **accepted and is progressing** — *not* that the directory record has
   vanished. See "Why Phase 6 does not wait for the record to disappear"
   below. It then waits for the directory's **ENIs** to be released, which
   is the real precondition for Phase 7.
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

### Why Phase 6 does not wait for the record to disappear

Managed AD teardown **outlives this fixture**. Two ~96-minute live runs
(2026-07-19/20) each spent a full 2400s waiting for the deleted directory
to stop being returned, and it vanished only some time after the script
had already exited. Blocking on that adds ~40 minutes to every run for no
safety gain: a directory in `Deleting` completes on its own, nothing the
fixture does can speed it, and the delete cannot be cancelled.

So Phase 6's verdict is deliberately scoped to **"the deletion was
accepted and is progressing"**:

| Observed state | Verdict |
| --- | --- |
| `Stage=Deleted`, or `EntityDoesNotExist` | pass |
| `Stage=Deleting` at the deadline | pass, with a loud `WARNING` |
| `Stage=Failed` | **fail** |
| any other stage, or an undetermined API error | **fail** |

The invariant that actually matters — *nothing chargeable remains* — is
still enforced, by the file-system, backup and directory sweeps. A
genuinely stuck or failed deletion still fails the run.

**`Stage=Deleted` is documented but was never observed on this path.** The
Directory Service admin guide defines it ("The directory has been deleted.
All resources for the directory have been released"), so the branch is
legitimate — but across two runs the record went from `Deleting` straight
to absent. Treat that branch as belt-and-braces, not as the expected path.

### The ENI gate is the one wait that is load-bearing

Phase 7 runs `cdkd destroy`, which deletes the VPC — and its subnets
cannot be deleted while the Managed AD still holds ENIs in them. AWS
releases those only at `Stage=Deleted` ("All resources for the directory
have been released"). So tolerating a still-`Deleting` record in the
*verdict* is safe, but proceeding to Phase 7 with its ENIs still attached
is not: the destroy would fail with `DependencyViolation`.

Phase 6 therefore waits on the **ENIs** rather than on the record — the
precise precondition, and potentially satisfied earlier. That wait gets
the real budget (`DIR_ENI_WAIT_SECONDS`, 2400s) and **fails** on timeout,
because it is a genuine blocker rather than a bookkeeping detail.

The ENI query matches the directory id inside the interface `Description`.
If AWS ever changes that wording the query returns empty and the gate
passes immediately — it fails **open**, leaving Phase 7 to surface any
real problem rather than blocking the run on a string match.

### "Deleted" is not spelled the same way by both services

The two services signal deletion differently, and the probes in
`verify.sh` are deliberately **not** symmetric:

| | Terminal signal | Why |
| --- | --- | --- |
| FSx | `FileSystemNotFound` error | `FileSystemLifecycle` has no `DELETED` value (`AVAILABLE`/`CREATING`/`DELETING`/`FAILED`/`MISCONFIGURED`/`MISCONFIGURED_UNAVAILABLE`/`UPDATING`) — a deleted file system simply stops being returned. |
| Directory Service | `Stage == Deleted`, **or** `EntityDoesNotExist` | AWS keeps returning a deleted directory **successfully** for a while with `Stage=Deleted`. Waiting only for an API error spins until the deadline and then wrongly reports a leak. |

Both probes keep a distinct "indeterminate" result for any other API
error (a throttle or expired credential must never read as "gone"), and
both treat the service's `FAILED` / `Failed` state as a loud failure
rather than as deletion. The `Stage!='Deleted'` filter on the
directory-listing query exists for the same reason.

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
