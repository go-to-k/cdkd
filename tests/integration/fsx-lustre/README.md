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
   - **Removal** (`CDKD_TEST_REMOVAL=true`, issue #1160):
     `DataCompressionType` is dropped from the template while its live
     value is `LZ4`, and `WeeklyMaintenanceStartTime` is added in the same
     deploy. `UpdateFileSystem` keeps a field it is not sent and cdkd sends
     no reset, so this asserts that:
     - the deploy succeeds;
     - the deploy warns, naming `LustreConfiguration.DataCompressionType`;
     - the value stays `LZ4`;
     - the maintenance window landed, which proves the call fired.

     Phase 2's output is the negative control: that deploy removes nothing,
     so it must not carry the warning.
   - **Fix-forward of a failed CREATE** (issue #4606): a `--no-rollback`
     deploy adding `OrphanFs` (`INJECT_FS_ORPHAN=true`) runs under a role
     the script creates, denied `fsx:DescribeFileSystems` and
     `fsx:DeleteFileSystem`. `CreateFileSystem` succeeds, while the wait and
     the cleanup delete are refused, so the journal holds the file system as
     a proven orphan. The `FS_FIX_FORWARD=true` redeploy runs as the caller.
     It changes the security group, so FSx makes a new file system instead of
     returning the earlier one. That deploy must succeed, delete the earlier
     file system, keep the new one and exit `0`. A plain deploy then removes
     `OrphanFs`. The caller needs `iam:CreateRole` / `PutRolePolicy` /
     `DeleteRolePolicy` / `DeleteRole` / `ListRoles` / `ListRoleTags` and
     `sts:AssumeRole` on the role, whose trust policy expires 2 hours after
     it is created.
3. **Destroy** and assert the file system + VPC are gone from AWS and
   the cdkd state file is removed. A leftover FSx file system is never
   acceptable (per-hour billing) — the cleanup trap force-deletes any
   file system carrying the fixture's constant tag
   (`cdkd-integ=fsx-lustre`).

## Timing

FSx Lustre creation takes ~5-10 minutes and deletion a few more; expect
a total wall clock of 45-60 minutes. The fix-forward arm creates two more
file systems and deletes them.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
