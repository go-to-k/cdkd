# secrets-rotation-schedule

A Secrets Manager secret with an automatic rotation schedule backed by a
rotation Lambda — a common daily pattern with no prior integ coverage.

- `AWS::SecretsManager::Secret`
- `AWS::SecretsManager::RotationSchedule`
- `AWS::Lambda::Function` (rotation lambda) + `AWS::Lambda::Permission`

`AWS::SecretsManager::RotationSchedule` has **no dedicated cdkd SDK provider**,
so it routes through the Cloud Control API fallback. This fixture is the
regression guard for the CC-API create/destroy of a RotationSchedule that
references both the Secret and the Lambda.

## What it verifies

1. **Phase 1 (deploy)** — rotation is enabled on the secret, the
   `RotationLambdaARN` points at the stack's rotation function, and the schedule
   interval is 30 days.
2. **Phase 2 (destroy)** — the secret is deleted (or scheduled for deletion),
   the cdkd state file is removed, and the rotation Lambda's log group is swept.

## No UPDATE phase (by design)

CDK's `addRotationSchedule` does not emit `RotateImmediatelyOnUpdate`, so AWS
defaults it to true and auto-triggers an immediate rotation on CREATE. With the
trivial no-op rotation Lambda this fixture uses, that initial rotation never
completes, so any later UPDATE of `RotationRules` is rejected by AWS with
"A previous rotation isn't complete" — **CloudFormation behaves identically**.
Testing a rule UPDATE would require a full 4-step rotation Lambda plus polling
for the rotation to finish, which is out of scope; this fixture covers
CREATE + DESTROY only.

## Run

```bash
/run-integ secrets-rotation-schedule
```
