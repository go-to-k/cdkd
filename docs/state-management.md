---
title: State Management
description: "Reference for the cdkd state store: the S3 bucket layout, what a state record contains, how the stack lock behaves, schema upgrades, backups, and the bucket's security configuration."
---

# cdkd State Management Specification

cdkd records what it deployed in an S3 bucket, one JSON record per stack and
region. This page is the reference for that store: where the objects live, how
to read a record, how the stack lock behaves, how upgrades are handled, and how
to back up and secure the bucket. [State Store](state-store.md) is the shorter
introduction.

```bash
cdkd state info                       # which bucket cdkd resolved, and how
cdkd state list --long                # every stack, with resource count and lock status
cdkd state show MyStack               # one record: outputs, resources, properties
cdkd state show MyStack --json        # the raw record and lock as JSON
cdkd force-unlock MyStack             # clear a lock a dead process left behind
```

Every subcommand and flag is on [`cdkd state`](cli-state.md). The schema
version history, the full field reference and the implementation notes are on
the contributor page [State schema internals](state-schema-internals.md).

## S3 Storage Structure

`cdkd bootstrap` creates the state bucket once per account, with versioning,
AES-256 encryption and a bucket policy that denies access from outside the
account. A `cdkd deploy` that finds no state bucket fails and tells you to run
`cdkd bootstrap`; it never creates one implicitly.

### Default Bucket Name

cdkd takes the bucket name from the first of these that is set:

| Source | Example |
| --- | --- |
| `--state-bucket` | `cdkd deploy --state-bucket my-team-state` |
| `CDKD_STATE_BUCKET` | `export CDKD_STATE_BUCKET=my-team-state` |
| `cdk.json` | `"context": { "cdkd": { "stateBucket": "my-team-state" } }` |
| Default | `cdkd-state-{accountId}`, from the caller's STS account ID |

The default name carries no region. S3 bucket names are global, so teammates
with different profile regions resolve the same bucket and see the same state.

Keys inside the bucket start with a prefix, `cdkd` by default. Change it with
`--state-prefix`.

### Directory Layout

```text diagram=state-bucket-layout
s3://cdkd-state-{accountId}/
├── cdkd/                              the state prefix
│   ├── {stackName}/{region}/
│   │   ├── state.json                 the state record
│   │   ├── lock.json                  while a command holds the lock
│   │   ├── rollback-journal.json      after a failed or interrupted deploy
│   │   ├── create-tokens.json         create-token ledger
│   │   └── deployments/               deployment event history
│   └── _index/{region}/exports.json   exports index
├── cdkd-bootstrap/{region}.json       asset-storage marker
├── custom-resource-responses/         one object per custom resource call
└── cdkd-migrate-tmp/                  transient CloudFormation templates
```

| Object | What it holds | When it exists |
| --- | --- | --- |
| `state.json` | The stack's resources and outputs | From the first deploy until the stack is destroyed or orphaned |
| `lock.json` | Who is working on the stack | While a command holds the [lock](#locking) |
| `rollback-journal.json` | What a failed deploy completed, for [`cdkd rollback`](cli-rollback.md) | Until the next successful deploy, a clean rollback, or a destroy |
| `create-tokens.json` | Tokens that let a re-run find an EFS, FSx or CloudFront OAI resource an interrupted create made; no secret | Deleted with `state.json` |
| `deployments/` | [Deployment events](deployment-events.md) | Survives a destroy unless you pass `--purge-events` |
| `_index/{region}/exports.json` | Resolved export values of every stack in the region, for `Fn::ImportValue` | Rewritten by each deploy |
| `cdkd-bootstrap/{region}.json` | The region's cdkd asset bucket and ECR repository names | Until `cdkd bootstrap --destroy` |
| `custom-resource-responses/{requestId}.json` | A custom resource handler's full response | Deleted after the call; [`cdkd gc`](cli-gc.md) collects stranded ones |
| `cdkd-migrate-tmp/` | A template too large to send inline to CloudFormation | Transient; deleted by the command that uploaded it |

A stack name deployed to two regions has two independent records:

```text
cdkd/DatabaseStack/us-east-1/state.json
cdkd/DatabaseStack/us-west-2/state.json
```

A nested stack has its own record, keyed by the parent stack name and the
child's logical ID joined with `~`:
`cdkd/{parentStack}~{childLogicalId}/{region}/state.json`.

**The key decides which region a record belongs to.** cdkd writes the same
region into the record's `region` field, so the two agree on any record cdkd
wrote. If a hand-edited record disagrees with its key, cdkd uses the key's
region and warns.

Two operations refuse such a record while it still lists resources:
`cdkd destroy` / `cdkd state destroy` and `cdkd rollback`. Deleting in the
wrong region would report every resource as already gone and remove the record
while the resources stay live. To proceed, destroy against the region the
resources are in, or correct the `region` field to match the key.
`cdkd state orphan` still drops the record and leaves the resources standing.

Records written by early cdkd versions used a key with no region,
`cdkd/{stackName}/state.json`. cdkd still reads that layout, and the next write
moves the record to the region-scoped key and deletes the old one.

### State Bucket Region

The state bucket can be in any region. It does not have to match your profile
region or the regions you deploy stacks into. cdkd looks up the bucket's region
with `GetBucketLocation` and addresses the bucket there; resources are still
created in the region the CDK app declares.

### Migration path: `cdkd state migrate`

Before v0.8 the default bucket name was `cdkd-state-{accountId}-{region}`. If
only that bucket exists, cdkd uses it and prints a deprecation warning. Support
for the old name will be removed in a future release, so move the state to the
current default:

```bash
cdkd state migrate --region us-east-1 --dry-run         # preview
cdkd state migrate --region us-east-1                   # copy, keep the source
cdkd state migrate --region us-east-1 --remove-legacy   # copy, then delete it
```

- Run it once per region that has a legacy bucket. The destination bucket is
  shared, and re-running for the same region is safe.
- The destination `cdkd-state-{accountId}` is created with the same
  configuration as `cdkd bootstrap` if it does not exist.
- The command refuses to start while any `lock.json` exists in the source
  bucket. Clear a stale one with `cdkd force-unlock` first.
- The source bucket is kept unless you pass `--remove-legacy`. That flag
  deletes every object version, so the history is gone; check the destination
  first.

`cdkd state info` shows which bucket was resolved and from which source.

## State Schema

A state record is one JSON document. `cdkd state show MyStack --json` prints
the raw record.

```json
{
  "version": 11,
  "stackName": "MyAppStack",
  "region": "us-east-1",
  "resources": {
    "MyBucket": {
      "physicalId": "myappstack-mybucket-abc123xyz",
      "resourceType": "AWS::S3::Bucket",
      "properties": {
        "BucketName": "myappstack-mybucket-abc123xyz",
        "VersioningConfiguration": { "Status": "Enabled" }
      },
      "attributes": {
        "Arn": "arn:aws:s3:::myappstack-mybucket-abc123xyz"
      },
      "dependencies": [],
      "provisionedBy": "sdk"
    },
    "MyFunction": {
      "physicalId": "arn:aws:lambda:us-east-1:123456789012:function:MyAppStack-MyFunction",
      "resourceType": "AWS::Lambda::Function",
      "properties": {
        "FunctionName": "MyAppStack-MyFunction",
        "Runtime": "nodejs20.x",
        "Handler": "index.handler",
        "Role": "arn:aws:iam::123456789012:role/MyAppStack-MyFunctionRole"
      },
      "attributes": {
        "Arn": "arn:aws:lambda:us-east-1:123456789012:function:MyAppStack-MyFunction"
      },
      "dependencies": ["MyFunctionRole", "MyBucket"],
      "provisionedBy": "sdk"
    }
  },
  "outputs": {
    "BucketArn": "arn:aws:s3:::myappstack-mybucket-abc123xyz"
  },
  "exportNames": ["BucketArn"],
  "lastModified": 1710835200000
}
```

### Stack-level fields

| Field | Meaning |
| --- | --- |
| `version` | Schema version. Current writers emit `11`; see [Schema versions and upgrades](#schema-versions-and-upgrades) |
| `stackName`, `region` | The stack and the region its resources are in |
| `resources` | Logical ID to resource record |
| `outputs` | Output name to resolved value |
| `exportNames` | The `outputs` keys that are export names, the only names `Fn::ImportValue` can bind to |
| `imports` | `Fn::ImportValue` references this stack resolved; they block the producer's destroy |
| `outputReads` | `Fn::GetStackOutput` references this stack resolved; informational |
| `skippedOutputs` | Outputs the last deploy could not resolve; see [below](#skippedoutputs-informational-no-version-bump) |
| `orphans` | Resources a rollback kept under `Retain` and removed from `resources`, so a later deploy can adopt them again |
| `parentStack`, `parentLogicalId`, `parentRegion` | Set only on a nested stack's record |
| `lastModified` | Time of the last write, in Unix milliseconds |

An `outputs` value is not always a string. An `Fn::GetAtt` that CloudFormation
defines as a list, such as a Route 53 hosted zone's `NameServers`, is stored as
a JSON array. The `Outputs:` block `cdkd deploy` prints joins an array with
commas, so read the stored shape from `cdkd state show`, which prints
non-scalar values as JSON.

### Resource fields

| Field | Meaning |
| --- | --- |
| `physicalId` | The ID cdkd uses to address the resource in AWS; see [physical IDs](#physical-ids) |
| `resourceType` | The CloudFormation type |
| `properties` | The resolved template values cdkd sent to AWS |
| `observedProperties` | What AWS reported after the last create or update; the baseline [`cdkd drift`](cli-drift.md) compares against |
| `attributes` | Values served to `Fn::GetAtt` |
| `dependencies` | Logical IDs this resource depends on; a destroy deletes in reverse order |
| `deletionPolicy`, `updateReplacePolicy` | The template attributes at the last deploy; a destroy reads `deletionPolicy` to decide whether to keep the resource |
| `provisionedBy` | `sdk` or `cc-api`; see [below](#version-7-adds-provisionedby-v7-writers) |
| `observedBaselineRefused` | `cdkd import` declined to capture a drift baseline; `cdkd state show` prints `ObservedBaseline: REFUSED` |
| `constructPath` | The resource's CDK construct path at its last deploy; informational |

`properties` holds what cdkd sent, which can be narrower than the template.
When `--prefer-sdk-route` keeps a resource on the SDK route, a property that
route cannot write is not sent and, unless it is create-only, not recorded.
Because `cdkd export` rebuilds a template from `properties`, such a property is
absent from the exported template too.

A record can also carry bookkeeping fields that no command asks you to read or
edit: `noEchoLeaves`, `noEchoAttributeNames`, `noEchoExactEchoLeaves`,
`maskedPropertyFingerprints`, `maskedPropertyInputFingerprints`,
`acceptedCreateOnlyDrops`, `observedBaselineRefusalReason` and
`conditionVerdicts`. The
[internals page](state-schema-internals.md#schema-reference) documents each.

### Physical IDs

The physical ID is whatever the provider that created the resource needs to
address it again. For most types it is the value CloudFormation's `Ref`
returns:

| Resource type | Example `physicalId` |
| --- | --- |
| `AWS::S3::Bucket` | `my-bucket-name` |
| `AWS::Lambda::Function` | `arn:aws:lambda:us-east-1:123456789012:function:MyFunc` |
| `AWS::IAM::Role` | `MyRole` |
| `AWS::DynamoDB::Table` | `MyTable` |
| `AWS::SQS::Queue` | `https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue` |
| `Custom::MyResource` | Any string the handler returned |

It can differ from the ID CloudFormation records for the same resource. When
you need an ID to pass back to cdkd, read it from `cdkd state show` or
`cdkd state resources`, not from the AWS console.

### Composite (pipe-delimited) physicalIds

Some resources have no single AWS identifier: a Glue table is addressed by
database and table, an API Gateway method by API, resource and HTTP method. For
these cdkd stores the identifying segments joined with `|`, the convention
Cloud Control API uses.

The composite value is what `cdkd state show` prints and what
`cdkd import --resource '<logicalId>=<physicalId>'` expects.

| Resource type | `physicalId` format |
| --- | --- |
| `AWS::ApiGateway::Method` | `<restApiId>\|<resourceId>\|<httpMethod>` |
| `AWS::AppSync::ApiKey` | `<apiId>\|<apiKeyId>` |
| `AWS::AppSync::DataSource` | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | `<apiId>\|<typeName>\|<fieldName>` |
| `AWS::EC2::EIP` | `<publicIp>\|<allocationId>` |
| `AWS::EC2::NetworkAclEntry` | `<networkAclId>\|<ruleNumber>\|<egress>`, where `egress` is `true` or `false` |
| `AWS::EC2::Route` | `<routeTableId>\|<destination>`, the CIDR block or prefix list the route declares |
| `AWS::EC2::SecurityGroupIngress` | `<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>`; an omitted port is `-1` |
| `AWS::EC2::VPCGatewayAttachment` | `<internetGatewayId>\|<vpcId>`; CloudFormation's own order is VPC first |
| `AWS::Glue::Table` | `<databaseName>\|<tableName>` |
| `AWS::Lambda::EventInvokeConfig` | `<functionName>\|<qualifier>`; a bare function name means `$LATEST` |
| `AWS::Route53::RecordSet` | `<hostedZoneId>\|<name>\|<type>` |
| `AWS::S3Tables::Namespace` | `<tableBucketARN>\|<namespaceName>` |
| `AWS::S3Tables::Table` | `<tableBucketARN>\|<namespace>\|<name>` |

```json
{
  "MyGlueTable": { "physicalId": "my_database|my_table" },
  "MyGetMethod": { "physicalId": "a1b2c3d4e5|xy9z8w|GET" },
  "MyARecord":   { "physicalId": "Z1D633PJN98FT9|www.example.com.|A" },
  "MyEip":       { "physicalId": "52.1.2.3|eipalloc-0abc123def456789a" }
}
```

Two more types accept a composite ID without producing one. For
`AWS::ECS::Service` cdkd stores the service ARN, and `--resource` also accepts
`<clusterArn>|<serviceName>`. For `AWS::Lambda::Permission` cdkd stores the
bare statement ID, and also reads the `<functionArn>|<statementId>` form an
older record may hold.

> [!IMPORTANT]
> `|` is the shell pipe character. Quote a composite ID on a command line:
>
> ```bash
> cdkd import MyStack --resource 'MyGlueTable=my_database|my_table'
> ```
>
> JSON mapping files (`--resource-mapping`) need no escaping.

The separator is not escaped. If a segment would contain `|`, `cdkd deploy`
refuses before creating anything and names the segment. Glue table and
database names and Route 53 record names are the exceptions: cdkd splits those
IDs using the names recorded in `properties`. The
[internals page](state-schema-internals.md#composite-pipe-delimited-physicalids)
has the exact rules.

### The composite id is NOT what `Ref` returns

CloudFormation's `Ref` for these types returns its own value, usually one
segment of the composite. cdkd translates the stored ID before handing it to a
`Ref`, `Fn::Sub` or output, so a template gets the value it would get from
`cdk deploy`. You do not need to do anything; the difference shows only when
you compare `cdkd state show` with a stack output.

| Resource type | `Ref` returns |
| --- | --- |
| `AWS::ApiGateway::Method` | An AWS-generated ID; cdkd passes the composite through |
| `AWS::AppSync::ApiKey` | The API key ARN |
| `AWS::AppSync::DataSource` | The data source ARN |
| `AWS::AppSync::Resolver` | The resolver ARN |
| `AWS::EC2::EIP` | The public IP |
| `AWS::Glue::Table` | The table name |
| `AWS::Route53::RecordSet` | The record name |
| `AWS::S3Tables::Namespace`, `AWS::S3Tables::Table` | The namespace or table name |

For the three AppSync types the ARN is not a segment, so cdkd reads it from an
attribute the provider records. A record can lack that attribute when an older
cdkd wrote it, or when `cdkd import` could not build the ARN (it warns at
import time). On such a record `Ref` falls back to the composite ID, and an
`Fn::GetAtt` on the ARN makes `cdkd deploy` read the resource from AWS once and
record the real ARN, or fail if it cannot.

[`cdkd export`](cli-export.md) needs the same recorded attribute for the types
CloudFormation imports by ARN. If export blocks a resource and names a missing
attribute, deploy the stack once to record it, then export again.

## Secrets and masked values

cdkd keeps secret values out of the record where it can tell what is secret.

| Source of the value | What the record holds |
| --- | --- |
| A `{{resolve:secretsmanager:...}}` or `{{resolve:ssm-secure:...}}` reference | The reference text, not the value |
| A `NoEcho: true` template parameter | `***` |
| A custom resource response declared `NoEcho` | `***` |
| The `Fn::Base64` encoding of a secret reference, such as EC2 `UserData` | `***` |

AWS always receives the real value. Only what cdkd writes down changes. Some
values are stored in the clear regardless; see
[Security and Best Practices](#security-and-best-practices).

### `version: 11` stores `NoEcho` values as `***` (current writers)

Where a `NoEcho: true` template parameter supplied a value, cdkd stores `***`:

| Surface | What is stored |
| --- | --- |
| `properties`, `observedProperties` | `***` at every position the parameter fills, whatever the type or length |
| `attributes` | `***` for an attribute declared `NoEcho`, and for one that echoes the value back, such as an SSM parameter's `Value` |
| `outputs`, the exports index | `***` for an output whose value reads the parameter |
| `rollback-journal.json` | The same masks |

A string that contains the value is stored as `***` whole.

#### How a deploy compares a masked value

The record only says `***`, so cdkd resolves the parameter again on every
deploy and decides per property:

| The property | What the deploy does |
| --- | --- |
| Updatable, and AWS reports it back | Reads the resource; skips an unchanged value, updates a changed one |
| Updatable, but AWS does not report it (an RDS `MasterUserPassword`) | Sends it on every deploy, with one info line per resource |
| Create-only, and AWS was seen to report it exactly | Reads the resource; a changed value replaces the resource |
| Create-only otherwise | Never replaces; warns on every deploy while the value cannot be confirmed |
| Create-only, and the readback failed | The resource fails with a message to re-run |

To apply a new value to a create-only property that cdkd will not replace, use
`--recreate-via-cc-api <logicalId>` or `--recreate-via-sdk-provider <logicalId>`.

A replacement found this way goes through the usual stateful-resource guard
(`--force-stateful-recreation`). The pre-deploy approval prompt cannot see it,
so under `--require-approval=destructive` or `any-change` the deploy asks again
when it reaches the replacement; `--yes` approves it.

A stack whose only difference is that its resources read a `NoEcho` parameter
is reported as `No changes`. `cdkd diff` cannot read AWS, so it compares the
masks and notes once per stack how many unchanged resources read a `NoEcho`
parameter. That note does not count as a change for `--fail`.

#### What else a masked value changes

| Situation | Behaviour |
| --- | --- |
| A nested stack's parameter filled from a `NoEcho` source | Treated as `NoEcho` in the child, whatever the child template declares |
| Another stack reads an output served by a `NoEcho` parameter | Works only when both stacks deploy in one run (`cdkd deploy --all`); a separate run reads `***` and is refused |
| An `Export.Name` holding a `NoEcho` value | Not published; the deploy warns |
| A delete needs a property a `NoEcho` parameter fills | `cdkd destroy`, or a deploy that removes the resource, skips the delete, keeps the record and exits non-zero. Delete the resource by hand, then run `cdkd state orphan` |
| `cdkd drift` | Reports a masked position in its own group, prints neither side, and does not affect the exit code; `--accept` and `--revert` leave it alone |
| `cdkd rollback` | Reads a masked position back from AWS and sends that value; refuses when it cannot read it |
| `cdkd import`, `cdkd scrub` | Store `***` at every position today's template fills from a `NoEcho` parameter |
| `cdkd export` | Exports the record; the exported template reads the parameter |

A resource's physical ID is never masked. A `NoEcho` value used as a name is
stored in the clear and the deploy warns; see
[Security and Best Practices](#security-and-best-practices).

These still reach the record in plain text:

- a value shorter than 4 characters, or a number, that lands somewhere the
  template does not name directly, such as inside a longer string read through
  an attribute;
- a record the template no longer names, such as a resource being deleted or
  an `orphans` entry;
- outputs saved after a failed outputs pass.

The [internals page](state-schema-internals.md#version-11-stores-noecho-values-as-current-writers)
has every case.

#### Upgrading to `version: 11`

There is nothing to do. The first `cdkd deploy` after the upgrade compares each
value with the plaintext the old record still holds, updates or replaces
nothing for an unchanged value, and saves `***`.

> [!WARNING]
> Rotate any `NoEcho` value a stack held before the upgrade. Earlier object
> versions of `state.json` still contain it, and cdkd does not purge them.

Only a `cdkd deploy` masks a record. Commands that hold no template, such as
`cdkd state refresh-observed` or `cdkd drift --accept`, write `version: 11`
without masking anything, so the version number alone does not mean a record's
values are masked.

### Custom resources that read a `NoEcho` parameter

cdkd cannot read a custom resource back, so its handler is called on every
deploy:

| Request | What the handler receives |
| --- | --- |
| `Update` | `ResourceProperties` holds the real value; `OldResourceProperties` holds `***` at that position |
| `Delete` | The real value, when cdkd can resolve it again from the template; otherwise the delete is skipped |

`cdkd destroy` run with the CDK app resolves the value again and sends the
delete. So does `cdkd deploy --recreate-via-cc-api <logicalId>`. The handler
receives the value bound today: if the parameter changed since the last deploy,
it gets the new one.

The delete is skipped, and the record kept, when:

- the command holds no template: `cdkd state destroy`, a deploy that removed
  the resource, or a rollback;
- the position read an attribute a custom resource or nested stack declared
  `NoEcho`;
- the template no longer reads a `NoEcho` parameter there, the property's
  template text or resolved inputs changed since the last deploy, the resource
  changed type, the template carries a `Transform`, or it was synthesized for
  another region;
- on `cdkd destroy`, the expression reads anything other than parameters,
  pseudo parameters and literals, or a parameter cannot be bound;
- the record holds `***` at a position it does not name as `NoEcho`, as a
  record from an earlier cdkd does. Run `cdkd deploy` (or `cdkd scrub`) once to
  record the positions, then destroy.

After a skipped delete, remove what the handler manages by hand and drop the
record with `cdkd state orphan`.

A handler whose `Update` is not idempotent, or that compares old and new
properties, should take the name or ARN of a secret and read the value itself.

### `NoEcho` custom-resource responses

A custom resource handler can mark its response `Data` as sensitive by setting
`NoEcho: true` on the response:

```js
// in the handler
return {
  PhysicalResourceId: id,
  Data: { Token: mintedToken },
  NoEcho: true,
};
```

cdkd then stores every string in that `Data` as `***`: in the custom resource's
own `attributes`, in the `properties` of every resource that read it through
`Fn::GetAtt`, and in `outputs`. A longer string built around the value is
stored as `***` whole. Resources that depend on the value are still created
with the real one, as in CloudFormation.

Without `NoEcho: true`, the record holds the handler's values in the clear.

Once the mask is in the record, cdkd has nothing to recover the value from:

| Situation | Behaviour |
| --- | --- |
| A later deploy must write the value, but the custom resource is unchanged | Refused; change one of the custom resource's properties so its handler runs again |
| The handler runs and returns the same value again | Each consumer takes one redundant update; a consumer that is a custom resource has its own handler invoked again |
| The value sits in a create-only property of a consumer | The consumer is read back first, and replaced only when AWS cannot confirm it holds the new value |
| A consumer in another stack | Gets the value only when both stacks deploy in one `cdkd deploy` run |
| `cdkd drift` | Masks the live value; `--accept` refuses to write it into the baseline |
| `cdkd rollback` | Refuses to replay a baseline that holds the mask |
| `cdkd export` | Blocks a resource whose properties hold the mask |

Redeploying the producer stack alone does not help a consumer stack: the value
is masked again on the way into the producer's record. Deploy both in one run.

The `Fn::Base64` encoding of a secret reference is masked the same way and
refused in the same places, but no custom resource is involved, so forcing one
to run does nothing. A deploy that changes the resource sends the encoding
again. Have the consuming resource build the value from the secret's own
reference instead of reading the encoded copy from another resource.

The full rules, including which longer strings are kept, are on the
[internals page](state-schema-internals.md#noecho-custom-resource-responses).

## Locking

A lock covers one stack in one region. Every command that writes a stack's
record takes it: `cdkd deploy`, `cdkd destroy`, `cdkd rollback`, `cdkd import`,
`cdkd export`, `cdkd orphan`, `cdkd scrub`, and the `cdkd state` and
`cdkd drift` forms that write. `cdkd diff` takes no lock.

```text diagram=state-lock-lifecycle
        A command starts work on a stack
                      │  writes lock.json only if the key is absent
                      ▼
                  Lock held
                      │  renewed about every 2 minutes;
                      │  each renewal moves expiresAt 30 minutes ahead
          ┌───────────┴─────────────┐
          ▼                         ▼
      Released                  Left behind
 the command finished,       SIGKILL, a crash, a second
 failed, or took a first     Ctrl-C, a cancelled CI job
 Ctrl-C or SIGTERM                  │
                                    ▼
                                 Cleared
                    the next command takes it over once
                    expiresAt passes, or cdkd force-unlock
                    deletes it now
```

`lock.json` names the holder:

```json
{
  "owner": "goto@macbook:12345",
  "timestamp": 1710835200000,
  "expiresAt": 1710837000000,
  "operation": "deploy"
}
```

| Field | Meaning |
| --- | --- |
| `owner` | `user@hostname:pid` of the holding process |
| `timestamp` | When the lock was taken, in Unix milliseconds |
| `expiresAt` | The deadline by which the holder must renew |
| `operation` | The command holding it, such as `deploy` |

### How long a lock is held

The lock is held while the command works on that stack. In a multi-stack run
each stack's lock is released as that stack finishes. It is released when
cdkd's work ends, not when the resources finish coming up, so a second deploy
can start while resources from the first are still provisioning;
[`cdkd deploy`](cli-deploy.md) covers what that second deploy meets.

The TTL is 30 minutes, and the holder renews it about every 2 minutes for as
long as it runs. So the TTL measures how long the holder has been silent, not
how long the operation has run. A deploy that takes two hours stays locked for
two hours.

### When another command holds the lock

A command that finds a live lock does not proceed. `cdkd deploy` and
`cdkd rollback` retry three times, 2 seconds apart, and then fail; most other
commands fail at once. The error names the owner, the operation and the expiry,
and prints the `cdkd force-unlock` command for that exact lock.

### What an interrupted command leaves behind

This applies to `cdkd deploy`, `cdkd destroy`, `cdkd state destroy` and
`cdkd rollback`.

| How the command stops | Lock | State |
| --- | --- | --- |
| It finishes or fails | Released | Saved |
| First {kbd:ctrl+c} or `SIGTERM` | Released, after in-flight operations finish | Saved; a deploy also writes the rollback journal |
| Second {kbd:ctrl+c} or `SIGTERM` | May be left behind | The process exits with code 130 without waiting |
| `SIGKILL`, a crash, a machine that sleeps | Left behind | Whatever the last per-resource save recorded |

After a first {kbd:ctrl+c} you can re-run immediately. An interrupted destroy
leaves a record that lists only the resources that still exist, so the re-run
does not repeat completed deletes.

A cancelled CI job can still strand the lock. Runners send `SIGTERM` and then
`SIGKILL` after a short grace period (about 10 seconds on GitHub Actions), and
a long AWS call may not finish in time. See
[Troubleshooting](troubleshooting.md#stale-lock-after-a-cancelled-ci-job) for
workflow patterns.

### Clear a stale lock

A lock left behind stops being renewed. The next command that needs it takes it
over once `expiresAt` passes, and warns naming the previous owner. To clear it
sooner:

```bash
cdkd state list --long                               # which stacks are locked
cdkd force-unlock MyStack --stack-region us-east-1   # delete the lock now
```

> [!CAUTION]
> `cdkd force-unlock` deletes the lock whether or not its owner is alive.
> Running it against a live deploy leaves two processes writing the same
> stack. Confirm the owner is gone first.

[`cdkd force-unlock`](cli-force-unlock.md) covers the cases where a lock does
not clear on its own.

## How a deploy reads and writes state

```text diagram=state-deploy-sequence
cdkd deploy MyStack
   │
   ▼
Synthesize the app, publish assets     the stack is not locked yet
   │
   ▼
Acquire the stack lock                 lock.json
   │
   ▼
Load state.json                        an older schema version is upgraded
   │
   ▼
Create, update, delete resources       state.json is saved after each resource
   │
   ▼
Resolve outputs, save state.json       written as the current schema version
   │
   ▼
Release the lock                       on failure and on the first Ctrl-C too
```

The record is saved after each resource operation, so a run that dies partway
leaves a record of what it finished. On the next deploy, resources that were
never recorded plan as `CREATE` and are retried.

A failed or interrupted deploy also writes `rollback-journal.json`, which
[`cdkd rollback`](cli-rollback.md) replays without synthesizing the app.

A destroy works the same way in reverse. It deletes resources in reverse
dependency order and saves the trimmed record after each delete. A fully
successful destroy deletes `state.json`; a partial one keeps the record with
the remaining resources and with `outputs` cleared, so no other stack resolves
an export whose resource is gone.

[Orphan vs Destroy](orphan-vs-destroy.md) compares the commands that remove a
record with and without deleting the resources.

## Schema versions and upgrades

Every record carries a schema `version`. The current one is `11`.

- **Newer cdkd, older record.** cdkd reads every earlier version and upgrades
  it in memory. The next write saves the record in the current version. There
  is no migration command and nothing to run.
- **Older cdkd, newer record.** The older binary refuses the record and exits:

  ```text
  Unsupported state schema version 11 for stack MyStack. This cdkd binary supports versions 1, 2, 3, 4, 5, 6, 7, 8, 9, 10. Upgrade cdkd to a version that supports schema 11.
  ```

cdkd stamps the current version on every record it writes. Once a newer binary
has written a stack's record, every older binary fails on that stack, so
upgrade every machine and CI job that deploys a stack together.

| Version | What it added |
| --- | --- |
| 1 | The original layout, with no region in the key; still readable |
| 2 | The region in the key |
| 3 | `observedProperties`, the drift baseline |
| 4 | `imports` |
| 5 | `deletionPolicy`, `updateReplacePolicy` |
| 6 | The nested-stack parent fields |
| 7 | `provisionedBy` |
| 8 | `outputReads` |
| 9 | `exportNames` |
| 10 | `observedBaselineRefused` |
| 11 | `NoEcho` values stored as `***` |

The first deploy after an upgrade can do a little extra work:

- From before version 3, it captures `observedProperties` for existing
  resources in the background. `--no-capture-observed-state` disables that;
  `cdkd state refresh-observed MyStack` does it without a deploy.
- From before version 5, it reports an `UPDATE` for every resource whose
  template carries a `DeletionPolicy` or `UpdateReplacePolicy`. It only records
  the attribute; no AWS call is made for it.
- From before version 11, it masks `NoEcho` values, as described
  [above](#upgrading-to-version-11).

The [internals page](state-schema-internals.md#schema-version-history) has the
full history of each version.

### `version: 7` adds `provisionedBy` (v7+ writers)

`provisionedBy` records which provisioning layer owns a resource: `sdk` for
cdkd's own providers, or `cc-api` for the Cloud Control API fallback.
[Provisioning Layers](provisioning-layers.md) explains the two routes. A custom
resource is recorded as `sdk`.

`cdkd destroy` reads the field to pick the delete path and `cdkd drift` to pick
how to read the resource. `cdkd state show` prints it as
`ProvisionedBy: sdk | cc-api | (sdk, legacy default)`.

A recorded `cc-api` keeps the resource on Cloud Control on later deploys, even
after cdkd gains an SDK provider for the type, because switching could change
the physical ID. A record with no field, written before version 7, is not
pinned; routing decides again on the next deploy.

A few types return to the SDK provider on their own. cdkd admits a type only
when its SDK provider addresses the resource by the same physical ID, so the
switch replaces nothing. `cdkd diff` marks such a resource
`[returning to SDK provider]`, and `--pin-cc-api <logicalId>` declines the
switch for that deploy. Types that Cloud Control cannot manage correctly switch
regardless of the pin. The
[internals page](state-schema-internals.md#version-7-adds-provisionedby-v7-writers)
lists the types and the conditions.

### `version: 9` adds `exportNames`

`outputs` holds plain output names and export names side by side. `exportNames`
lists which keys are exports, and only those can satisfy an `Fn::ImportValue`.

| `exportNames` | Meaning |
| --- | --- |
| A list of names | Only these keys are importable |
| `[]` | The stack exports nothing |
| Absent | A record from before version 9; every output key is importable until the stack's next deploy |

The next deploy of a producer writes the field, including a deploy with no
template change. If two stacks export the same name, the most recent deploy
wins and cdkd warns. CloudFormation refuses the second producer, so rename one.

### `skippedOutputs` (informational, no version bump)

When a deploy cannot resolve an output, it skips the output, stores no value
for it, and records the output's name in `skippedOutputs`. One cause is a
secret reference naming a JSON key the secret does not hold.

The record exists for `cdkd diff`. Diff does not resolve secrets, so without
it, every diff of the unchanged stack would preview an `ADD` for that output
and `cdkd diff --fail` would stay red. With it, diff shows no row for the
output until the template inputs the output reads change, or a resource the
output references is itself changing in that diff.

Fixing the output in the template brings the row back, and the next deploy
publishes it. A fix outside the template, such as adding the missing key to the
secret, is not visible to diff; the next deploy resolves the output and clears
the entry.

## When a state record is malformed

cdkd does not write malformed records. They come from a hand edit or a
truncated upload. Commands that would act on the damage refuse with
`STATE_RESOURCES_MALFORMED`; commands that only display the record repair it
in memory and warn. Reading a damaged map as empty is never the safe choice for
a command that writes or deletes, because an empty map means "this stack has
no resources".

To repair a record, inspect the stored value and put a corrected one back:

```bash
cdkd state show MyStack --stack-region us-east-1 --json   # the record as stored
cdkd state orphan MyStack --stack-region us-east-1        # or drop the record, keep the resources
```

[Back up and restore](#back-up-and-restore) shows how to restore an earlier
version. The reasoning behind each row below is on the
[internals page](state-schema-internals.md#schema-reference).

### When `resources` is not an object

`resources` holds a string, a list, a number, a boolean or `null`, or is
absent. An empty `{}` is healthy.

| Command | Answer |
| --- | --- |
| `cdkd deploy`, including `--dry-run` | Refuses at the load, exit `1`; otherwise every resource would plan as a `CREATE` |
| `cdkd destroy`, `cdkd state destroy` | Refuses before the prompt and the lock, exit `1`; otherwise it would delete nothing and remove the record |
| `cdkd orphan`, `cdkd import`, `cdkd rollback` | Refuse, exit `1` |
| `cdkd export` | Refuses the named stack and every nested child record, exit `1`, under `--dry-run` too |
| `cdkd scrub` | Refuses on a real run, exit `2`; audits and reports under `--dry-run` |
| `cdkd diff` | Repairs in memory and warns; reports the deploy's refusal under `Blocking` and exits `3` |
| `cdkd state show` | Repairs in memory and warns; `--json` still prints the stored value |
| `cdkd state resources` | Repairs in memory and warns; `--json` prints `[]` |
| `cdkd local *` with `--from-state` | Repairs in memory and warns; references to this record's resources resolve to nothing |

### When `outputs` is not an object

`outputs` holds something other than a map. An absent `outputs` and an empty
`{}` are both healthy. Each container is judged on its own, and the refusal
names the damaged one.

| Command | Answer |
| --- | --- |
| `cdkd deploy` | Refuses at the load, exit `1` |
| `cdkd destroy`, `cdkd state destroy` | Refuses before the prompt, exit `1`; the map decides whether other stacks still import from this one |
| `cdkd orphan`, `cdkd import` | Refuse, exit `1` |
| A nested stack's child record | Refuses the parent's deploy and its destroy, exit `1` |
| `cdkd scrub` | Refuses on a real run, exit `2`; audits and reports under `--dry-run` |
| `cdkd diff` | Repairs in memory and warns; reports the deploy's refusal under `Blocking` and exits `3` |
| `cdkd state show`, `cdkd state resources` | Repair in memory and warn; `--json` still prints the stored value |
| `cdkd local *` with `--from-state` | Repairs in memory and warns; the run continues with no outputs from that record |
| An `Fn::GetStackOutput` read of that record | The reference is refused and the consumer's deploy fails |
| The exports index rebuild | Publishes nothing from that record, warns, and indexes every other producer |

### When one `resources` RECORD cannot be read

The map is an object, but one entry is `null`, a string, a list, or an object
with no string `resourceType`. An entry that names its type but no `physicalId`
is readable here; the command that reaches it reports what the missing ID
costs.

| Command | Answer |
| --- | --- |
| `cdkd deploy`, including `--dry-run` | Refuses at the load, exit `1`, naming the entries |
| `cdkd destroy`, `cdkd state destroy` | Refuses before the prompt and the lock, naming the entries |
| `cdkd import` | Refuses a selective import that would keep the entry; importing that entry with `--resource <id>=<physicalId> --force` repairs it |
| `cdkd orphan` | Refuses for an entry it would keep, under `--dry-run` too; an entry you are orphaning is dropped |
| `cdkd scrub` | Refuses on a real run, exit `2`; under `--dry-run` drops the entries and reports them |
| `cdkd state refresh-observed`, `cdkd drift --accept`, `cdkd drift --revert` | Refuse before the lock, naming the entries |
| `cdkd diff`, plain `cdkd drift` | Drop the entries, warn, and report the rest; `cdkd diff` also exits `3` |
| `cdkd local *` with `--from-state` | Drops the entries in memory and warns |

### When a resource `properties` map is not an object

One resource's `properties` is not a map, or is absent. An empty `{}` is
healthy. Compared against the template, a damaged map makes every declared
property look missing, which for a create-only property such as a bucket name
means a replacement.

| Command | Answer |
| --- | --- |
| `cdkd deploy`, including `--dry-run` | Refuses at the load, before any provider call, exit `1`, naming the resources |
| `cdkd destroy`, `cdkd state destroy` | Refuses before the prompt and the lock, exit `1` |
| `cdkd orphan` | Refuses, exit `1`, for a map on a resource it would keep; never for one you are orphaning |
| `cdkd export` | Refuses the named stack and every nested child record, exit `1`, under `--dry-run` too |
| `cdkd diff` | Repairs those maps to empty in memory and warns; exits `3` |

The same refusal covers a kept resource's `attributes` when it is `null` or not
an object. An absent `attributes` is healthy.

You have three ways out:

1. **Repair the record by hand.** Print the stored value, fix the map, and put
   the record back. This is the only option that keeps the resource managed by
   cdkd.

   ```bash
   cdkd state show MyStack --stack-region us-east-1 --json
   ```

2. **Drop the whole record.** Every live resource stays in AWS and nothing
   tracks it any more. This needs no CDK app.

   ```bash
   cdkd state orphan MyStack --stack-region us-east-1
   ```

3. **Orphan only the damaged resource.** The live resource stays in AWS and
   the rest of the record is repaired and kept.

   ```bash
   # by construct path; the CDK app must still declare the resource
   cdkd orphan MyStack/TheDamagedResource

   # by logical ID; needs no CDK app
   cdkd state orphan MyStack --stack-region us-east-1 --resource TheDamagedResource
   ```

The refusal prints the commands that apply, with the `--profile`,
`--state-bucket` and `--state-prefix` you passed, so pasting one reaches the
same bucket.

### When `orphans` is not a list

`orphans` holds a string, a number, an object or `null`. An absent field and an
empty `[]` are both healthy.

| Command | Answer |
| --- | --- |
| `cdkd deploy` | Refuses at the load, before any resource operation, exit `1` |
| `cdkd destroy`, `cdkd state destroy` | Refuses at its first read and again under the lock |
| `cdkd rollback` | Refuses before any replay |
| `cdkd import` | Refuses |
| `cdkd orphan` | Refuses, under `--dry-run` too |
| `cdkd scrub` | Refuses on a real run, exit `2`; audits and reports under `--dry-run` |
| `cdkd diff` | Repairs in memory and warns; lists `orphans` in `--json`'s `unreadableContainers`; exits `3` |

### When one `orphans` RECORD cannot be read

An entry is usable only if it is an object with a string `logicalId`, a `state`
that is a readable resource record with a non-empty `physicalId`, and a
`logicalId` no other entry shares.

| Command | Answer |
| --- | --- |
| `cdkd deploy` | Refuses at the load |
| `cdkd destroy`, `cdkd state destroy` | Refuses at both reads |
| `cdkd rollback` | Refuses before any replay |
| `cdkd import` | Refuses |
| `cdkd orphan` | Refuses, under `--dry-run` too |
| `cdkd scrub` | Refuses on a real run, exit `2`; under `--dry-run` drops the entry and reports it |
| `cdkd diff` | Drops the entry, lists it in `--json`'s `unreadableOrphans`, previews the rest, and exits `3` |

Repair the entry instead of deleting the record. No command removes a single
`orphans` entry, and the entry is the only evidence that a failed deploy left
its resource live in AWS. When two entries share a `logicalId`, keep one; cdkd
then no longer tracks the other resource.

## Back up and restore

The bucket is versioned, so every earlier `state.json` is kept as a noncurrent
object version. That is the primary recovery path.

::: steps
1. List the versions of the record

   ```bash
   aws s3api list-object-versions \
     --bucket cdkd-state-123456789012 \
     --prefix cdkd/MyStack/us-east-1/state.json
   ```

2. Download the version you want

   ```bash
   aws s3api get-object \
     --bucket cdkd-state-123456789012 \
     --key cdkd/MyStack/us-east-1/state.json \
     --version-id 3HL4kqtJlcpXroDTDmJ.rUAR3z7fFpPc \
     state-restore.json
   ```

3. Put it back as the current version

   Make sure no cdkd command is running on the stack first.

   ```bash
   aws s3 cp state-restore.json \
     s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json
   ```
:::

A restored record describes the stack as it was when that version was written.
Run `cdkd diff` and `cdkd drift MyStack` afterwards to see where AWS has moved
on. A record in an older schema version is upgraded on the next write.

For a copy outside the bucket, sync the state prefix on a schedule:

```bash
aws s3 sync s3://cdkd-state-123456789012/cdkd/ \
  s3://my-state-backups/$(date +%Y%m%d)/
```

A backup holds the same values as the bucket, including any that cdkd later
purges or scrubs from the original. Protect it the same way.

If the record and AWS disagree and no version helps:

| Goal | Command |
| --- | --- |
| See what differs | [`cdkd drift MyStack`](cli-drift.md) |
| Stop tracking the stack, keep its resources | `cdkd state orphan MyStack` |
| Track existing resources again | [`cdkd import`](import.md) |

## Security and Best Practices

**Treat `state.json` as sensitive.** cdkd keeps secret references and `NoEcho`
values out of the record ([above](#secrets-and-masked-values)), but several
kinds of value are stored as they are, and `cdkd scrub` detects none of them:

- what the drift baseline `observedProperties` records from AWS, and
  `attributes` for a resource provisioned through Cloud Control, including
  values the template never references
  ([details](import.md#a-value-your-template-never-references-is-recorded-as-aws-holds-it));
- a credential a provider records in `attributes` so `Fn::GetAtt` can read it,
  such as an `AWS::IAM::AccessKey`'s `SecretAccessKey`;
- a `NoEcho` parameter's value in a record written before `version: 11`, until
  the next `cdkd deploy`, and in every earlier object version of it;
- a custom resource's response `Data`, unless the handler sets `NoEcho: true`;
- a name derived from a secret.

**A name derived from a secret is stored as resolved.** A `{{resolve:...}}`
reference or a `NoEcho` parameter used in a name, such as an SQS `QueueName`,
becomes the resource's identity. It is stored in:

- that resource's `physicalId`;
- other resources' resolved copies of the name, or of an identifier that embeds
  it, such as an IAM policy's `Resource` ARN;
- stack outputs, the exports index, `rollback-journal.json`, and the resource's
  `orphans` entry if a rollback retains it;
- a [deployment event](deployment-events.md)'s `physicalId` field.

The resource's own `properties` keep the reference, or `***` for a `NoEcho`
parameter. cdkd masks the name in logs and `cdkd diff` output where it
recognises the read; commands that print a stored record, such as
`cdkd state show` and `cdkd events`, print it as stored. CloudFormation behaves
the same way and
[advises against](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references.html)
putting sensitive data in an identifier property. Do not use a secret as a
name.

Limit who can read the state bucket and its earlier object versions
accordingly.

### What `cdkd bootstrap` configures

| Setting | Value |
| --- | --- |
| Versioning | Enabled |
| Default encryption | SSE-S3 (`AES256`) |
| Bucket policy | Denies access from outside the account |

A bucket you create yourself and pass with `--state-bucket` should match.
Versioning is what makes [restore](#back-up-and-restore) possible:

```bash
aws s3api put-bucket-versioning \
  --bucket my-team-state \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket my-team-state \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

To encrypt with a KMS key instead, set `SSEAlgorithm` to `aws:kms` and add
`KMSMasterKeyID` with the key ARN.

### Recommended: Bucket Policy with Least Privilege

The principal that runs cdkd needs these actions on the state bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/CdkdDeployRole"
      },
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:DeleteObjectVersion",
        "s3:GetReplicationConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::cdkd-state-123456789012",
        "arn:aws:s3:::cdkd-state-123456789012/*"
      ]
    }
  ]
}
```

| Action | Applies to | Why cdkd needs it |
| --- | --- | --- |
| `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` | Objects | Read, write and delete records, locks and the other objects |
| `s3:ListBucket` | Bucket | List stacks |
| `s3:ListBucketVersions` | Bucket | Find earlier versions of an object cdkd deleted |
| `s3:DeleteObjectVersion` | Objects | Remove those versions |
| `s3:GetReplicationConfiguration` | Bucket | Optional. Lets cdkd warn when replication keeps copies a purge cannot reach |

#### Why the two version actions matter

On a versioned bucket, deleting an object only adds a delete marker. Every
earlier version stays readable with a `VersionId`. Some objects cdkd deletes
can hold secrets, so cdkd also purges their earlier versions:

| Object | Purged by | What its earlier versions can hold |
| --- | --- | --- |
| `rollback-journal.json` | A successful `cdkd deploy`, a clean `cdkd rollback`, `cdkd destroy`, `cdkd state destroy` | The properties of a failed write, verbatim, such as a literal password |
| `custom-resource-responses/` objects | `cdkd deploy` and `cdkd gc` | The handler's full response, `Data` included |
| `cdkd-migrate-tmp/` templates | `cdkd import --migrate-from-cloudformation`, `cdkd export`, and macro expansion in `cdkd deploy` / `cdkd diff` | The template body |
| `deployments/` event streams | `cdkd events prune`, `cdkd destroy --purge-events`, and the writer's own pruning | Event text, which cdkd treats as sensitive |
| `cdkd-bootstrap/{region}.json` | `cdkd bootstrap --destroy` | Bucket and repository names; no secret |
| `lock.json` | Every lock release, an expired-lock takeover, `cdkd force-unlock` | The lock holder; no secret |

`state.json` is not in this table. Its earlier versions are the recovery path,
and only [`cdkd scrub`](cli-scrub.md) purges them. The exports index
`_index/{region}/exports.json` is likewise purged only by `cdkd scrub`.

**Without the two actions nothing fails.** The command succeeds and prints a
warning that counts and names the affected keys and the two actions to grant.
The earlier versions stay readable by anyone who can read the bucket with a
`VersionId`. A failed purge of `lock.json` on an ordinary release is logged
only under `--verbose`, because it holds no secret and runs after every
command.

Grant both actions or neither. With only `s3:ListBucketVersions`, the purge
lists the versions and each delete is refused; the only sign is the warning.

Adding the two actions to an older policy fixes future runs. Versions already
stranded have to be removed by hand with `aws s3api list-object-versions` and
`aws s3api delete-object --version-id`.

### S3 REPLICATION defeats the purge, and cdkd cannot fix it for you

If the state bucket has Cross-Region or Same-Region Replication enabled, the
purge removes earlier versions from the source bucket only. The copies in the
destination bucket remain, readable with `GetObject` and a `VersionId`.

No cdkd setting changes this. S3 never replicates a delete that names a version
ID, and a purge is such a delete. cdkd does not delete from a bucket other than
the state bucket.

cdkd warns when it applies, if the principal has
`s3:GetReplicationConfiguration`. After a purge that removed an object body, it
reads the bucket's replication configuration once per run and, when a rule
covers the purged keys, prints a warning that names the destination buckets.
Without the permission it stays silent, and the purge itself is unaffected. The
check errs toward warning: a rule filtered by tags, or a disabled rule that has
already copied objects, is reported.

Your options:

- **Purge the destination bucket yourself**, with `list-object-versions` and
  `delete-object --version-id`.
- **Narrow the replication rule** to exclude the prefixes cdkd purges under.
- **Accept that the replica keeps the history**, and restrict
  `s3:GetObjectVersion` on the destination.

| Prefix cdkd purges under | What it holds | Cost of excluding it from replication |
| --- | --- | --- |
| `cdkd/` (your `--state-prefix`) | The rollback journal, `lock.json`, `deployments/` | Also stops replicating `state.json` and its history |
| `custom-resource-responses/` | Handler responses | None |
| `cdkd-migrate-tmp/` | Transient templates | None |
| `cdkd-bootstrap/` | The asset-storage marker | None |

Read the prefixes from your own bucket before writing a rule; the first one is
whatever `--state-prefix` you use.

The same applies to any other copy of the bucket, including the `aws s3 sync`
backup [above](#back-up-and-restore). A purge on the state bucket says nothing
about what a backup or a replica still holds.

## Related

- [State Store](state-store.md): the short introduction to the store
- [`cdkd state`](cli-state.md): every subcommand and flag
- [`cdkd force-unlock`](cli-force-unlock.md): clearing a lock
- [`cdkd scrub`](cli-scrub.md): removing secrets from existing records
- [State schema internals](state-schema-internals.md): version history, field
  reference and implementation
