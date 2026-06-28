# replacement-immutable-name

cdkd immutable-`Name` replacement integration test (Kinesis Stream + SecretsManager Secret).

`AWS::Kinesis::Stream` and `AWS::SecretsManager::Secret` `Name` are immutable in
CloudFormation ("Update requires: Replacement"). cdkd previously had **no**
replacement rule for either type, so the registry defaulted them to updateable: a
rename was attempted as an in-place update, AWS has no rename API, so the change
was silently dropped and cdkd's state diverged from AWS (the deploy reported
success while the resource kept its old name). Found by the 2026-06-29 bug-hunt
sweep. This fixture proves cdkd now **replaces** (DELETE old + CREATE new) on a
rename.

## What it covers

- `AWS::Kinesis::Stream`
- `AWS::SecretsManager::Secret`

## Phases

1. **Deploy** v1 — assert the `-v1` stream and `-v1` secret exist.
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` renaming both to `-v2` — assert the
   `-v2` resources exist AND the `-v1` resources are **gone** (replacement, not an
   in-place no-op). A pre-fix run leaves `-v1` alive and `-v2` absent.
3. **Destroy** — assert both `-v2` resources are gone and the cdkd state file is
   removed.

Both resources use `removalPolicy: DESTROY` (so `UpdateReplacePolicy: Delete`),
ensuring the old resource is deleted on replacement rather than CDK's default
Retain.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
