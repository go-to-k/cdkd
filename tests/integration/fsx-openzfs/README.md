# fsx-openzfs

Integration test for the `AWS::FSx::FileSystem` **OpenZFS** variant of the
SDK provider (issue #1068, follow-up to #1042). The type is
`ProvisioningType: NON_PROVISIONABLE`, so no Cloud Control fallback exists —
this fixture is the end-to-end proof of the non-Lustre variant mapping.
`aws-cdk-lib` ships no OpenZFS L2, so it uses the L1 `fsx.CfnFileSystem`.

OpenZFS `SINGLE_AZ_1` is the **cheapest** non-Lustre variant to stand up (no
Active Directory, one subnet, 64 GiB / 64 MB/s — the smallest legal config),
so it is the variant chosen for the live integ. **Windows** and **ONTAP** are
unit-tested and share this fixture's integ-verified create-poll / delete-poll
path (the shared lifecycle machinery is variant-agnostic); a per-variant
Windows-managed-AD / multi-AZ-ONTAP integ is an optional cost-gated follow-up.

## Resources

- `AWS::FSx::FileSystem` — smallest legal OpenZFS config: `SINGLE_AZ_1` at
  64 GiB, 64 MB/s throughput, default root volume (`RecordSizeKiB: 128`,
  `DataCompressionType: LZ4`). Billed per hour — the fixture bounds wall
  clock to one create/update/destroy cycle and `verify.sh` asserts the file
  system is GONE from AWS afterwards (by id AND by tag).
- `AWS::EC2::VPC` — minimal network (1 AZ, public subnet only, no NAT). The
  file system uses the VPC's default security group.

## Phases (verify.sh)

1. **Deploy** the baseline file system and assert via
   `aws fsx describe-file-systems` that it is `AVAILABLE` with the templated
   config (SINGLE_AZ_1, 64 GiB, `ThroughputCapacity: 64`), that the `DNSName`
   / `RootVolumeId` outputs (`Fn::GetAtt`, `RootVolumeId` being OpenZFS-only)
   match the AWS-side values, and that state routes the resource via the SDK
   provider (`provisionedBy=sdk`).
2. **Update** (`CDKD_TEST_UPDATE=true`): `ThroughputCapacity` `64 -> 128`
   (`UpdateFileSystem` — a mutable `OpenZFSConfiguration` sub-property), tag
   value change AND tag removal (`TagResource` / `UntagResource`). Asserts the
   FileSystemId is unchanged (in-place, no replacement).
3. **Destroy** and assert the file system + VPC are gone from AWS and the
   cdkd state file is removed. A leftover FSx file system is never acceptable
   (per-hour billing) — the cleanup trap force-deletes any file system
   carrying the fixture's constant tag (`cdkd-integ=fsx-openzfs`).

## Timing

FSx OpenZFS creation takes ~5-15 minutes and deletion a few more; expect a
total wall clock of 15-30 minutes.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
