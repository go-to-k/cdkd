# import-retain-destroy

`cdkd destroy` run right after `cdkd import --migrate-from-cloudformation`
keeps a `DeletionPolicy: Retain` resource (issue
[#3645](https://github.com/go-to-k/cdkd/issues/3645)).

`cdkd destroy` reads `DeletionPolicy` from state only. `cdkd import` used to
write records without the template's policies. So between an import and the
first deploy, destroy deleted `Retain` resources, and CDK retains stateful
resources by default.

## Configuration

- **`Kept`**: an SSM parameter with `DeletionPolicy: Retain`. It must survive the destroy.
- **`Gone`**: an SSM parameter with no policy. It must be deleted, which shows
  the destroy really ran over both records.

## Flow

1. `cdk deploy` (the CloudFormation stack to migrate).
2. `cdkd import --migrate-from-cloudformation --yes`. The run asserts the
   `Kept` record carries `deletionPolicy: Retain`.
3. `cdkd destroy --force`, with no deploy in between.
4. The run asserts `Kept` is still in AWS, `Gone` and the state file are gone.
5. The retained parameter is deleted, followed by a gone-probe.

## Arm R: rollback after import (issue [#4523](https://github.com/go-to-k/cdkd/issues/4523))

A second stack, `CdkdImportRollback`, is deployed by cdkd only. Its parameter
`Named` has an explicit name, which is its physical id.

1. The first deploy, with `INJECT_FAIL=true` and `--no-rollback`, fails on
   `FailingQueue`. It keeps a rollback journal whose completed CREATE is `Named`.
2. `cdkd orphan` drops `Named` from state. The parameter is deleted and
   re-created by hand, and `cdkd import --resource Named=<name>` adopts it. The
   run asserts that the journal marks `Named` as imported.
3. `cdkd rollback --force` must exit 0 and leave the hand-made parameter in
   place, with its value and its state record. Before the fix, the replay
   deleted it.
4. Issue [#4552](https://github.com/go-to-k/cdkd/issues/4552): a stray
   parameter is created by hand, and R2's journal is re-uploaded as one
   segment holding a failed CREATE of `Named` that recorded the stray
   parameter, with the import mark stripped (the shape a cdkd older than #4547
   leaves). `cdkd rollback --revert-failed --force` must exit 2, name the stray
   parameter as needing manual attention, and delete neither parameter. Before
   the fix, it planned "left nothing to revert" and exited 0.
5. `cdkd destroy --force` deletes it, followed by gone-probes.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
