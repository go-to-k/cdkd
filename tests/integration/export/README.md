# `cdkd export` — real-AWS integ test

End-to-end real-AWS test for `cdkd export` (cdkd → CloudFormation migration). Exercises the 2-phase IMPORT + UPDATE flow added by PR3, the parameter / cross-stack / drift-baseline gates from PR4 / PR5, and the underlying single-key + composite identifier resolution from PR1 / PR2.

## Stack contents

- 1× `AWS::S3::Bucket` — single-key importable (`BucketName`).
- 1× `AWS::SNS::Topic` — single-key importable (`TopicArn`).
- 1× `AWS::IAM::Role` — single-key importable (`RoleName`), execution role for the CR Lambda.
- 1× `AWS::Lambda::Function` — single-key importable (`FunctionName`), backs the Custom Resource.
- 1× `Custom::AWSCDK*` — Custom Resource, goes through phase-2 CREATE when `--include-non-importable` is set. The backing Lambda's handler is idempotent (returns a fixed `PhysicalResourceId` on every event) so the phase-2 re-invocation is a no-op.

## What `verify.sh` checks

1. `cdkd deploy` succeeds.
2. `cdkd export --include-non-importable -y` succeeds (exit 0).
3. CFn stack exists in `UPDATE_COMPLETE` or `IMPORT_COMPLETE`.
4. Every cdkd-deployed resource type (S3 / SNS / Lambda / IAM Role) is present in the CFn stack.
5. At least one `Custom::*` resource is present in the CFn stack (proves phase 2 ran).
6. cdkd state for the stack is gone (S3 `HeadObject` 404 on the state key).
7. `aws cloudformation delete-stack` tears down both phase-1 and phase-2 resources cleanly.

## Running

```bash
bash tests/integration/export/verify.sh
```

Or via the cdkd integ skill:

```bash
/run-integ export
```

Requires:

- AWS credentials with admin-equivalent permissions (cdkd does NOT route through CloudFormation, so CDK CLI bootstrap roles are not sufficient — same constraint as every other cdkd integ).
- `cdkd bootstrap` to have created the state bucket.
- `cdk bootstrap` to have created the asset bucket (Lambda Code asset).
- Docker NOT required (no container Lambda fixtures here).

## Caveats

- The CR handler is inline JavaScript; CDK packages it as a ZIP asset uploaded to the CDK bootstrap bucket. Post-migration `cdk deploy` would see the same asset hash and not re-upload.
- The stack uses explicit physical names (`bucketName`, `topicName`, `roleName`, `functionName`) so the post-export `cdk deploy` does NOT propose a replacement on auto-generated-name diffs (the documented replacement-risk caveat).
- This integ does NOT verify post-migration `cdk deploy` works against the now-CFn-managed stack; that would require CDK CLI installation and is out of scope. Verified manually if the user wants end-to-end-end coverage.
