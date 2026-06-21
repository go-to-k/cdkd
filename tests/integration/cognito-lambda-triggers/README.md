# Cognito UserPool Lambda Triggers

A `UserPool` with `lambdaTriggers` (preSignUp + postConfirmation) — a daily CDK
pattern that wires a UserPool `LambdaConfig` (one ARN per trigger) plus one
`AWS::Lambda::Permission` per trigger granting `cognito-idp.amazonaws.com`
invoke.

## What it verifies

1. **LambdaConfig reached AWS**: `describe-user-pool` returns both the
   `PreSignUp` and `PostConfirmation` ARNs.
2. **Triggers actually fire**: a real `sign-up` auto-confirms the user (the
   preSignUp handler sets `autoConfirmUser=true` and runs INLINE during
   `SignUp`), so a `CONFIRMED` user proves the LambdaConfig + Lambda permission
   work end-to-end — a missing permission makes `SignUp` fail.
3. **Clean destroy**: the UserPool and cdkd state are gone afterward.

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```
