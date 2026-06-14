# Tags Propagation E2E Test

Failure-seeking real-AWS end-to-end test that **stack-level tags**
(`cdk.Tags.of(app).add(k, v)`) propagate to **all taggable resources
across many types**, on **both** the cdkd SDK-provider path **and** the
Cloud Control API path.

## Why this exists

`cdk.Tags.of(...)` is the idiomatic way to tag an entire CDK app/stack: it
injects the same N tags into the CFn `Tags` property of every taggable
resource at synth time. cdkd must then forward those tags to AWS correctly
for **every** resource type — but each AWS type accepts tags in a
**different wire shape**, and the per-type tag handling lives in each
provider independently:

| Tags wire shape           | Types in this fixture                                          |
| ------------------------- | ------------------------------------------------------------- |
| `{Key,Value}[]` list      | S3 Bucket, SNS Topic, IAM Role, DynamoDB Table, Athena WorkGroup |
| `{ k: v }` map            | SQS Queue, SSM Parameter, Logs LogGroup, Lambda Function      |

Per the `feedback_ssm_parameter_tags_is_a_map` lesson,
`AWS::SSM::Parameter.Tags` is a key->value **MAP** in CFn (CFn type `Json`),
not the `{Key,Value}[]` list almost every other type uses — a provider
doing `properties.Tags.map()` on it crashed `cdkd deploy`, and the bug hid
because the unit tests + the only SSM-tag fixtures used the wrong (list)
shape. This fixture deliberately tags an SSM Parameter so that regression
is caught end-to-end against real AWS.

### Both provisioning paths

cdkd routes resources either through a dedicated SDK provider or, for types
with no SDK provider (or that hit the #614 silent-drop auto-route), through
the Cloud Control API, which forwards the full CFn property map. Tag
handling differs between the two paths, so this fixture exercises both:

- **SDK-provider path** (registered in `src/provisioning/register-providers.ts`):
  S3 Bucket, SNS Topic, SQS Queue, SSM Parameter, IAM Role, Logs LogGroup,
  Lambda Function, DynamoDB Table.
- **Cloud Control API path**: Athena WorkGroup has **no** SDK provider, so
  cdkd routes it through Cloud Control. `verify.sh` asserts
  `state.resources.*.provisionedBy == 'cc-api'` for it and `'sdk'` for the
  rest (heterogeneous routing in one stack).

No VPC / NAT / instances — every resource is control-plane-only and cheap,
so the fixture stays fast and quota-free.

## What it does

1. `cdkd deploy CdkdTagsPropagationExample` — applies 3 stack-level tags
   (`CdkdTagOwner=cdkd-integ`, `CdkdTagEnv=test`, `CdkdTagCostCenter=cc-1234`,
   set via `cdk.Tags.of(app)` in `bin/app.ts`) to all 9 taggable resources.
   A wrong-Tags-shape crash on any type (e.g. the SSM map regression) fails
   the deploy here with specifics.
2. Reads `state.json` and asserts the routing split (8 `sdk` + 1 `cc-api`).
3. For **each** of the 9 types, reads the live AWS-side tags via that
   type's type-specific list/describe API and asserts **all 3** stack-level
   tags are present with the correct value. A type missing a tag (a dropped
   tag) **FAILs naming the type**.
4. `cdkd drift` immediately after deploy must report **exit 0** — a tag-list
   reorder from AWS must not show as a false-positive drift (issue
   [#802](https://github.com/go-to-k/cdkd/issues/802)
   `canonicalizeTagListsDeep`), nor a map-vs-list readback-shape mismatch.
5. `cdkd destroy --force` — clean up.

### Per-type tag-read API

| Resource type            | Path   | AWS read API                                                       | Returned shape         |
| ------------------------ | ------ | ------------------------------------------------------------------ | ---------------------- |
| `AWS::S3::Bucket`        | sdk    | `s3api get-bucket-tagging`                                         | `TagSet[{Key,Value}]`  |
| `AWS::SNS::Topic`        | sdk    | `sns list-tags-for-resource --resource-arn`                        | `Tags[{Key,Value}]`    |
| `AWS::SQS::Queue`        | sdk    | `sqs list-queue-tags --queue-url`                                  | `Tags{ k: v }` map     |
| `AWS::SSM::Parameter`    | sdk    | `ssm list-tags-for-resource --resource-type Parameter`            | `TagList[{Key,Value}]` |
| `AWS::IAM::Role`         | sdk    | `iam list-role-tags --role-name`                                   | `Tags[{Key,Value}]`    |
| `AWS::Logs::LogGroup`    | sdk    | `logs list-tags-for-resource --resource-arn`                       | `tags{ k: v }` map     |
| `AWS::Lambda::Function`  | sdk    | `lambda list-tags --resource <arn>`                                | `Tags{ k: v }` map     |
| `AWS::DynamoDB::Table`   | sdk    | `dynamodb list-tags-of-resource --resource-arn`                    | `Tags[{Key,Value}]`    |
| `AWS::Athena::WorkGroup` | cc-api | `athena list-tags-for-resource --resource-arn`                     | `Tags[{Key,Value}]`    |

## Run

```bash
bash tests/integration/tags-propagation/verify.sh
```

The script:

- Resolves the AWS account ID via `aws sts get-caller-identity`.
- Picks the cdkd state bucket as `cdkd-state-${accountId}` (override with
  the `STATE_BUCKET` env var).
- Builds cdkd from the repo root.
- Reads each resource's physical id from `state.json` and reads its live
  AWS tags via the type-specific API above; hard-fails with a pointed
  message naming the type that dropped (or mis-valued) a tag. On any
  failure it still attempts a final `cdkd destroy --force` so a botched run
  does not leave AWS resources behind, and only prints `[verify] PASS` on
  full success.

BSD/macOS-portable (no `grep -P`, no `date -d`); the real exit code of each
`cdkd` invocation is captured.
