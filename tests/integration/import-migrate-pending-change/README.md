# import-migrate-pending-change

`cdkd import --migrate-from-cloudformation` over a stack whose CDK code
changed after its last `cdk deploy` (issues
[#6840](https://github.com/go-to-k/cdkd/issues/6840) and
[#6841](https://github.com/go-to-k/cdkd/issues/6841)).

The migration's Retain update keeps CloudFormation's own template, so AWS
keeps the last-deployed configuration. Import used to record the NEW
synthesized properties, so `cdkd diff` said "no changes" and the code change
never deployed. It now records what CloudFormation deployed, and the change is
the next `cdkd diff` / `cdkd deploy`, as it would be the next `cdk deploy`.

The role's CDK `DefaultPolicy` (`AWS::IAM::Policy`) has a CloudFormation
`PhysicalResourceId` that is a generated id, not its name. Import must record
the name, or the first `cdkd drift` reports the policy DELETED.

## Configuration

- An IAM role (fixed name `cdkd-integ-pending-change-<region>`) trusted by
  `lambda.amazonaws.com` under a `StringLike` `aws:SourceArn` condition: one
  pattern by default, two with `CDKD_TEST_UPDATE=true`.
- The role's `DefaultPolicy` with one statement.

## Flow

1. `cdk deploy` without `CDKD_TEST_UPDATE` (one pattern).
2. `cdkd import --migrate-from-cloudformation --yes` with
   `CDKD_TEST_UPDATE=true`. The run asserts state records the ONE pattern AWS
   holds and the policy under its name.
3. `cdkd diff` reports only the role's UPDATE.
4. `cdkd drift` exits 0 and `cdkd state refresh-observed --yes` succeeds.
5. `cdkd deploy` applies the change: `aws iam get-role` holds two patterns, and
   the next diff and drift are clean.
6. `cdkd destroy --force`; the role, state file and CloudFormation stack are
   gone.

## Run

```bash
STATE_BUCKET=<bucket> AWS_REGION=us-east-1 ./verify.sh
```
