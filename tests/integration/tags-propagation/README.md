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

One VPC with no NAT gateway, Elastic IP or instance, and an on-demand
Kinesis stream: nothing waits on capacity, so the fixture stays fast.

### Tags on the create call (issue [#4971](https://github.com/go-to-k/cdkd/issues/4971))

The deploy runs as a throwaway role (`CdkdTagsPropagationExample-TagRequired`)
that may do anything except create an IAM Role, SSM Parameter, Kinesis
Stream, EC2 VPC, Subnet, InternetGateway, RouteTable, NetworkAcl or
SecurityGroup whose create request lacks the `CdkdTagOwner` tag: an explicit
deny on `aws:RequestTag/CdkdTagOwner`, the shape of an organization SCP that
requires tags on create. A provider that creates a resource untagged and tags
it afterwards is refused there, where `cdk deploy` succeeds. Each EC2 deny
names only the resource type its create makes, as such an SCP does: a create
is also authorized against its parent VPC, which carries no request tag.
Before the deploy, `verify.sh` proves every deny statement binds: an untagged
create of each of the nine types meets the explicit deny (EC2 as dry runs).
It deletes the role at the end, and after each destroy checks that the stream
and the EC2 resources are gone.

After the first destroy, the same role is rewritten to deny only
`ec2:CreateTags`, and the stack is deployed again as it. A tagged EC2 create
needs `ec2:CreateTags`, while the old post-create `CreateTags` only warned, so
such a role used to create the EC2 resources untagged. The deploy must still
succeed: each EC2 create is re-sent once without its tags and the follow-up
`CreateTags` warns. `verify.sh` asserts the re-send and the warning for each of
the six EC2 resources, and that none carries the stack tags.

## What it does

1. `cdkd deploy CdkdTagsPropagationExample`, as the tag-requiring role above
   — applies 3 stack-level tags
   (`CdkdTagOwner=cdkd-integ`, `CdkdTagEnv=test`, `CdkdTagCostCenter=cc-1234`,
   set via `cdk.Tags.of(app)` in `bin/app.ts`) to all 16 taggable resources.
   A wrong-Tags-shape crash on any type (e.g. the SSM map regression), or a
   create sent without its tags, fails the deploy here with specifics.
2. Reads `state.json` and asserts the routing split (15 `sdk` + 1 `cc-api`).
3. For **each** of the 16 types, reads the live AWS-side tags via that
   type's type-specific list/describe API and asserts **all 3** stack-level
   tags are present with the correct value. A type missing a tag (a dropped
   tag) **FAILs naming the type**.
4. `cdkd drift` immediately after deploy must report **exit 0** — a tag-list
   reorder from AWS must not show as a false-positive drift (issue
   [#802](https://github.com/go-to-k/cdkd/issues/802)
   `canonicalizeTagListsDeep`), nor a map-vs-list readback-shape mismatch.
5. `cdkd destroy --force`.
6. Redeploy as the role with only `ec2:CreateTags` denied (above), assert each
   EC2 create was re-sent untagged and warned, then `cdkd destroy --force` and
   delete the role.

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
| `AWS::Kinesis::Stream`   | sdk    | `kinesis list-tags-for-stream --stream-name`                       | `Tags[{Key,Value}]`    |
| `AWS::EC2::*` (6 types)  | sdk    | `ec2 describe-tags --filters Name=resource-id,Values=<id>`         | `Tags[{Key,Value}]`    |
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
