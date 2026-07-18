# fsx-lustre

Integration test for the `AWS::FSx::FileSystem` SDK provider
(issue #1042). The type is `ProvisioningType: NON_PROVISIONABLE`, so no
Cloud Control fallback exists — this fixture is the end-to-end proof of
the SDK provider, built on the CDK L2 (`aws-fsx.LustreFileSystem`).

## Resources

- `AWS::FSx::FileSystem` — smallest legal Lustre config: `SCRATCH_2` at
  1200 GiB (1.2 TiB), single AZ. Billed per hour — the fixture bounds
  wall clock to one create/update/destroy cycle and `verify.sh` asserts
  the file system is GONE from AWS afterwards (by id AND by tag).
- `AWS::EC2::VPC` + `AWS::EC2::SecurityGroup` — minimal network (1 AZ,
  public subnet only, no NAT). The security group is created by the L2.

## Phases (verify.sh)

1. **Deploy** the baseline file system and assert via
   `aws fsx describe-file-systems` that it is `AVAILABLE` with the
   templated config (SCRATCH_2, 1200 GiB, `DataCompressionType: NONE`),
   that the `DNSName` / `LustreMountName` outputs (`Fn::GetAtt`) match
   the AWS-side values, and that state routes the resource via the SDK
   provider (`provisionedBy=sdk`).
2. **Update** (`CDKD_TEST_UPDATE=true`): `DataCompressionType` `NONE ->
   LZ4` (`UpdateFileSystem` — a mutable Lustre sub-property), tag value
   change AND tag removal (`TagResource` / `UntagResource`). Asserts the
   FileSystemId is unchanged (in-place, no replacement).
3. **Destroy** and assert the file system + VPC are gone from AWS and
   the cdkd state file is removed. A leftover FSx file system is never
   acceptable (per-hour billing) — the cleanup trap force-deletes any
   file system carrying the fixture's constant tag
   (`cdkd-integ=fsx-lustre`).

## Timing

FSx Lustre creation takes ~5-10 minutes and deletion a few more; expect
a total wall clock of 15-30 minutes.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
