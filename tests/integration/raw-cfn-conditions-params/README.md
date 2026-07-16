# Raw CFn Template (CfnInclude) — Parameters / Conditions Diff Parity

Regression fixture for issues [#1027](https://github.com/go-to-k/cdkd/issues/1027)
and [#1028](https://github.com/go-to-k/cdkd/issues/1028).

## Purpose

Raw CloudFormation templates ingested via CDK's `cloudformation_include.CfnInclude`
(the common CFn -> CDK migration shape) carry notations CDK-synthesized templates
rarely emit:

- `Parameters` with `Default` values, consumed by `Ref` / `Fn::Sub` / `Fn::FindInMap`
- `Mappings` + `Fn::FindInMap` keyed by a parameter `Ref`
- `Conditions` on **resources** and on **outputs**
- `Fn::Select` / `Fn::Split` over `AWS::Region`

Pre-fix behavior this fixture pins against regressions:

- **#1027**: `cdkd diff` did not bind template parameters or evaluate conditions
  (deploy did), so a **no-op diff on a freshly deployed stack** reported a phantom
  `[requires replacement]` on the queue's `QueueName`, a phantom `to create` for
  the condition-false resource, and spurious value changes.
- **#1028**: every deploy warned `Failed to resolve output ProdParamName` for an
  output whose `Condition` is false (CFn silently omits such outputs).

## Flow (verify.sh)

1. **Deploy baseline** (`RetentionSeconds` from its template `Default` = 120).
   Asserts: queue retention 120, `Fn::Sub` over parameter + `GetAtt` resolved,
   condition-false resource + output absent, no `Failed to resolve output` warn.
2. **No-op `cdkd diff --fail`** exits 0 (the #1027 core assertion).
3. **UPDATE** (`CDKD_TEST_UPDATE=true` inlines `RetentionSeconds=600` via
   `CfnInclude`'s `parameters` option): the diff shows exactly
   `0 to create, 1 to update, 0 to delete` with no replacement; the deploy
   updates in place (same QueueUrl).
4. **Post-update no-op diff** exits 0 again.
5. **Destroy** + assert queue / parameters / state gone.

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```

## Resources

- `AWS::SQS::Queue` (`cdkd-raw-cfn-cond-dev-q`) — name via `Fn::Join` +
  `Fn::FindInMap`, retention via `Ref` to a Number parameter, tags via
  parameter `Ref` + `Fn::Select`/`Fn::Split` over `AWS::Region`
- `AWS::SSM::Parameter` (`/cdkd-raw-cfn-cond/env`, condition `IsDev` = true)
- `AWS::SSM::Parameter` (`/cdkd-raw-cfn-cond/prod-only`, condition `IsProd` =
  false — must never be created)
