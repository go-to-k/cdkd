# Intrinsics Torture Example

A real-AWS integration test designed to **surface intrinsic-function-resolution
bugs** in cdkd.

cdkd resolves EVERY CloudFormation intrinsic function itself in
[`src/deployment/intrinsic-function-resolver.ts`](../../../src/deployment/intrinsic-function-resolver.ts),
unlike the AWS CDK CLI, which hands the unresolved template to CloudFormation
and lets the CFn engine resolve them server-side. The less-common intrinsics
and deeply-nested expressions are exactly where cdkd's hand-rolled resolver is
most likely to diverge from CloudFormation's behavior — so this fixture
deliberately concentrates on those.

## How it works

Each harder intrinsic computes the `Value` of an `AWS::SSM::Parameter`. After
`cdkd deploy`, [`verify.sh`](./verify.sh) reads every parameter back from AWS
(`aws ssm get-parameter`) and asserts it equals an **expected concrete value
computed independently in the script** from the account / region. A wrong
resolution therefore produces a wrong parameter value, and the assertion
**pinpoints exactly which intrinsic cdkd resolved incorrectly**.

Every SSM parameter is built with the raw CloudFormation escape hatch
(`new ssm.CfnParameter` + `addPropertyOverride('Value', <intrinsic>)`), so the
synthesized template carries the EXACT intrinsic shape under test — CDK's L2
helpers would otherwise pre-fold some of these at synth time.

## Intrinsics exercised

This goes **beyond** the existing
[`intrinsic-functions`](../intrinsic-functions/) fixture, which covers only
`Ref` / `Fn::GetAtt` / `Fn::Join` / `Fn::Sub` on an S3 bucket + IAM role.

| SSM parameter | Intrinsic under test | Expected value (computed in verify.sh) |
| --- | --- | --- |
| `cidr-select` | `Fn::Select[3]` of `Fn::Cidr['10.0.0.0/16', 8, 8]` | `10.0.3.0/24` |
| `cidr-join` | `Fn::Join(',')` of the full `Fn::Cidr` list (eight /24 blocks) | `10.0.0.0/24,...,10.0.7.0/24` |
| `findinmap-default` | `Fn::FindInMap[EnvMap, DEFAULT, tier]` | `default-prod` |
| `findinmap-region` | `Fn::FindInMap[EnvMap, {Ref: AWS::Region}, retentionDays]` | per-region row (skipped in unmapped regions) |
| `first-az` | `Fn::Select[0]` of `Fn::GetAZs('')` | first AZ from `describe-availability-zones` (cdkd sorts) |
| `base64` | `Fn::Base64('cdkd-intrinsics-torture')` | `Y2RrZC1pbnRyaW5zaWNzLXRvcnR1cmU=` |
| `split-select-join` | nested `Fn::Join` of three `Fn::Select`-of-`Fn::Split` picks | `a\|c\|e` |
| `nested-sub` | two-arg `Fn::Sub`: literal-map var (nested `Fn::Join`) + `${AWS::Region}` + `${TortureQueue.Arn}` GetAtt | `label=cdkd-torture-sub;region=<r>;queueArn=arn:<p>:sqs:<r>:<acct>:...` |
| `pseudo` | `Fn::Sub` over ALL pseudo-params: `${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` / `${AWS::StackName}` / `${AWS::URLSuffix}` / `${AWS::NotificationARNs}` | `account=<acct>;region=<r>;partition=aws;stack=<stack>;urlsuffix=amazonaws.com;notif=undefined` |
| `topic-ref-sub` | `Fn::Sub` with pseudo params + a `Ref` to the SNS topic | `arn-prefix=arn:<p>:sns:<r>:<acct>;topicRef=arn:<p>:sns:<r>:<acct>:...` |

### Note on `AWS::NotificationARNs`

cdkd resolves the `AWS::NotificationARNs` list pseudo-parameter to `undefined`
(there is no CloudFormation notification-ARN list in cdkd's
CloudFormation-free model). Inside `Fn::Sub` that stringifies to the literal
`undefined`. The `pseudo` assertion **pins this documented behavior** — a
regression that changed it (to an empty string, or a crash) would flip the
assertion. This is intentional: the test exists to catch divergence, including
in cdkd's own deliberate semantics.

## Resources

- `AWS::SNS::Topic` — `Ref` target (the topic physical id IS its ARN)
- `AWS::SQS::Queue` — `Fn::GetAtt` (`.Arn`) target for the nested `Fn::Sub`
- 10 × `AWS::SSM::Parameter` — each carrying one resolved intrinsic as its `Value`

No VPC, no NAT, no Lambda. Deploys and destroys in well under a minute.

## Run

```bash
export STATE_BUCKET="your-cdkd-state-bucket"
export AWS_REGION="us-east-1"
bash verify.sh
```

`verify.sh` is BSD/macOS-portable (no `grep -P`, no `date -d`), captures the
real deploy exit code, asserts every intrinsic, then destroys and asserts a
clean teardown (state.json gone + zero orphan SSM parameters). It prints
`[verify] PASS` only on full success. If deploy fails it prints the failing
resource + error for triage.
