# replaced-user-of-removed-resource

Integration test for a replaced resource whose old copy still uses a resource
removed from the template (issue
[#6977](https://github.com/go-to-k/cdkd/issues/6977)).

Renaming a Lambda function that has a `currentVersion` and an alias replaces
the function and the alias, and removes the old version: its logical id is a
hash covering the function name. The old alias still points at the old
version, and Lambda refuses to delete a version an alias references.
CloudFormation's cleanup phase deletes the old alias, then the old version,
then the old function. cdkd used to delete the removed version first, wait
about 5 minutes for the refused delete, keep its record and exit `2`.

## What it covers

- `AWS::Lambda::Function` (replaced: `FunctionName` changed)
- `AWS::Lambda::Alias` (replaced; its old copy references the removed version)
- `AWS::Lambda::Version` (removed from the template)

## Phases

1. Deploy `<stack>-fn-v1`, its `currentVersion` and alias `live`. Assert the alias record depends on the version record.
2. Redeploy with `CDKD_TEST_UPDATE=true` (function renamed `-fn-v2`). Assert exit code 0, the old alias deleted before the removed version, the old function gone, the new alias live, and no record of the old version or of a superseded resource.
3. Destroy. Assert the new function and the state file are gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<account> AWS_REGION=us-east-1 ./verify.sh
```
