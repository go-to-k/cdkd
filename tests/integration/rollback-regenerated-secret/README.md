# rollback-regenerated-secret

Integration test for [#6591](https://github.com/go-to-k/cdkd/issues/6591): when a
failed deploy's automatic rollback restores a Secrets Manager secret whose
`GenerateSecretString` the deploy changed, AWS generates a new password, as in
CloudFormation's rollback. A resource reading that secret through a
`{{resolve:secretsmanager:...}}` reference must be restored with that new
password, not the one from before the deploy.

## Fixture

`CdkdRollbackRegeneratedSecret` (`lib/rollback-regenerated-secret-stack.ts`):

- v1 (default): a generated secret (`passwordLength: 20`) and a Lambda whose
  `PW` environment variable is `secret.secretValueFromJson('password')`.
- v2 (`ROLLBACK_SECRET_FAIL=true`): `passwordLength: 24`, `PLAIN` changed, and an
  `AWS::SQS::Queue` with `MessageRetentionPeriod: 10` (valid range
  `[60, 1209600]`) that depends on the function, so both updates complete
  before the queue's create fails.

## Automated run (`verify.sh`)

Env: `AWS_REGION` (default `us-east-1`), `STATE_BUCKET` (required).

1. Deploy v1. Assert the function's `PW` equals the secret's password.
2. Deploy v2 and assert it fails. Assert the rollback regenerated the secret (a
   new 20-character password; the premise), the function's `PW` equals that new
   password, `PLAIN` is back to `one`, neither the log nor state carries the
   plaintext, no queue is left, and `cdkd drift` is clean.
3. Destroy and assert the function, the secret and the state record are gone,
   then sweep the state prefix's object versions.

Secret values are compared inside the script and never printed.
