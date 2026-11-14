# Custom resource payload JSON types (issue #6309)

Asserts the JSON types a custom resource handler receives in
`ResourceProperties` / `OldResourceProperties`, on `Create`, `Update` and
`Delete`, against what CloudFormation delivered for the same template
(measured in us-east-1 for [#6309](https://github.com/go-to-k/cdkd/issues/6309)).

## What it tests

- `Echo` (`Custom::Echo`, inline Python handler) carries one property per
  measured case: template literals (`5`, `1.5`, `true`), `Fn::GetAtt` of an
  `AWS::IAM::ManagedPolicy` (`AttachmentCount`, `IsAttachable`) and of a second
  custom resource `Src` (`Data: {"Num": 5, "Bool": true, "Obj": {"n": 5}}`), a
  `Ref` of `Number` / `List<Number>` parameters, `Fn::Select` / `Fn::If` /
  `Fn::FindInMap` over literals and over an `Fn::GetAtt`, literals nested in a
  literal object or list, and `Fn::GetAtt` values inside a literal list or
  object.
- The handler writes each payload it receives to the SSM parameter
  `/cdkd-integ/cr-payload-types/<RequestType>`; `verify.sh` compares it with
  CloudFormation's: literals are strings, `Fn::GetAtt` values keep their JSON
  type, a custom resource's scalar attribute is a string.
- Phase 2 changes one string literal (`CDKD_TEST_PHASE=two`), so the `Update`
  carries `OldResourceProperties`, typed by the coordinates the Create
  recorded (`typedPayloadLeaves`). Phase 3's `Delete` reads them too.

## Run

```bash
STATE_BUCKET=<cdkd-state-bucket> AWS_REGION=us-east-1 ./verify.sh
```

Every named resource (`CdkdIntegCrPayloadTypesEcho`, its log group, the
`CdkdIntegCrPayloadTypesRole` role, the `CdkdIntegCrPayloadTypesPol` policy,
the echo parameters) is cleaned up and asserted gone. The role has no
`logs:CreateLogGroup`, so a late log write cannot re-create the deleted group.
