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

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
