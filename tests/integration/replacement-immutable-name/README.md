# replacement-immutable-name

cdkd immutable-`Name` replacement integration test across six resource types.

Each resource's name property is immutable in CloudFormation ("Update requires:
Replacement"). cdkd previously had **no** replacement rule for these types, so the
registry defaulted them to updateable: a rename was attempted as an in-place
update and silently diverged cdkd state from AWS. AWS has no rename API, so the
change was dropped — and for `Events::Rule` / `CloudWatch::Alarm` the in-place
`PutRule` / `PutMetricAlarm` with the new name even **created a second resource
and orphaned the old one**. Found by the 2026-06-29 bug-hunt sweep (Rounds 4 + 5).
This fixture proves cdkd now **replaces** (DELETE old + CREATE new) on a rename.

## What it covers

- `AWS::Kinesis::Stream` (Name)
- `AWS::SecretsManager::Secret` (Name)
- `AWS::StepFunctions::StateMachine` (StateMachineName)
- `AWS::Events::Rule` (Name)
- `AWS::SSM::Parameter` (Name)
- `AWS::CloudWatch::Alarm` (AlarmName)

## Phases

1. **Deploy** v1 — assert all six `-v1` resources exist.
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` renaming all to `-v2` — assert the
   `-v2` resources exist AND the `-v1` resources are **gone** (replacement, not an
   in-place no-op / orphan). A pre-fix run leaves `-v1` alive (and `-v2` absent,
   or — for Rule/Alarm — a `-v2` orphan alongside the surviving `-v1`).
3. **Destroy** — assert all six `-v2` resources are gone and the cdkd state file
   is removed.

Resources use `removalPolicy: DESTROY` (so `UpdateReplacePolicy: Delete`) where
applicable, ensuring the old resource is deleted on replacement rather than CDK's
default Retain. The assertion helpers tolerate the async deletion of
`Kinesis::Stream` and `StepFunctions::StateMachine` (both report `DELETING` for a
window after delete).

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
