# `cdkd export` — real-AWS integ test

End-to-end real-AWS test for `cdkd export` (cdkd → CloudFormation migration). Exercises the 2-phase IMPORT + UPDATE flow, the parameter / cross-stack / drift-baseline gates, and the underlying single-key + composite identifier resolution. The `VARIANT` env var selects between four flows that exercise different `cdkd export` flag combinations against the same fixture stack.

## Stack contents

- 1× `AWS::S3::Bucket` — single-key importable (`BucketName`).
- 1× `AWS::SNS::Topic` — single-key importable (`TopicArn`).
- 1× `AWS::IAM::Role` — single-key importable (`RoleName`), execution role for the CR Lambda.
- 1× `AWS::Lambda::Function` — single-key importable (`FunctionName`), backs the Custom Resource.
- 1× `AWS::CloudFormation::CustomResource` — Custom Resource, goes through phase-2 CREATE when `--include-non-importable` is set. The backing Lambda is idempotent AND does the cfn-response PUT (works against both cdkd's return-value fast path and real CFn's wire protocol).
- 1× `AWS::CloudFormation::CustomResource` (template-declared shape) plus a `CfnParameter` `Environment` (default `test`) used by the `parameter-override` variant.

## Variants

`VARIANT=<name>` selects the flow. All four leave AWS clean on success (cdkd state empty, no CFn stack).

| Variant | Flag exercised | Assertion |
| --- | --- | --- |
| `default` (no `VARIANT`) | full `--include-non-importable -y` | 2-phase IMPORT + UPDATE; every resource type present in CFn |
| `dry-run` | `--dry-run -y` | no CFn stack created; cdkd state preserved (rollback via `cdkd destroy`) |
| `cfn-stack-name` | `--cfn-stack-name CdkdExportExampleCfnRenamed -y` | CFn stack exists under the renamed name; default-name stack does NOT |
| `parameter-override` | `--parameter Environment=prod -y` | `describe-stacks` reports `Environment=prod` in CFn stack Parameters (overriding template default `test`) |

## What every variant checks

1. `cdkd deploy` succeeds.
2. `cdkd export [flags] -y` succeeds (exit 0).
3. Per-variant terminal-state assertion (see above table).
4. cdkd state for the cdkd stack is gone (S3 `HeadObject` 404 on the state key) on every variant **except `dry-run`** which preserves state.
5. CFn stack deleted at the end (no AWS leftovers).

## Running

```bash
bash tests/integration/export/verify.sh                          # default variant
VARIANT=dry-run          bash tests/integration/export/verify.sh
VARIANT=cfn-stack-name   bash tests/integration/export/verify.sh
VARIANT=parameter-override bash tests/integration/export/verify.sh
```

Or via the cdkd integ skill (default variant only — the skill does not yet plumb `VARIANT` through; pass `bash ... verify.sh` directly for non-default variants):

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
