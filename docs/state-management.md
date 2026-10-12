---
title: State Store
description: "Reference for the cdkd state store: which S3 bucket holds state, what is in it, how to read a state record, and where locking, secrets, upgrades, repair and bucket security are documented."
---

# State Store

cdkd records what it deployed in an S3 bucket, as one JSON document per stack
and region. That document is the stack's **state record**. This page says
which bucket cdkd uses, what the bucket contains, and how to read a record.
The other subjects each have their own page, listed under
[In this section](#in-this-section).

```bash
# which bucket cdkd resolved, and how
cdkd state info

# every stack, with resource count and lock status
cdkd state list --long

# one record: outputs, resources, properties
cdkd state show MyStack

# the raw record and lock as JSON
cdkd state show MyStack --json
```

[Manage Stacks Without the App](state-store.md) is the task-level introduction, and
[`cdkd state`](cli-state.md) documents every subcommand and flag.

## Where state lives

State lives in one S3 bucket per AWS account. `cdkd bootstrap` creates the
bucket, and every CDK app deployed to the account shares it.

A `cdkd deploy` that finds no state bucket fails and tells you to run
`cdkd bootstrap`. A deploy never creates the bucket for you.

### Which bucket cdkd uses

cdkd takes the bucket name from the first of these that is set:

| Source | Example |
| --- | --- |
| `--state-bucket` | `cdkd deploy --state-bucket my-team-state` |
| `CDKD_STATE_BUCKET` | `export CDKD_STATE_BUCKET=my-team-state` |
| `cdk.json` | `"context": { "cdkd": { "stateBucket": "my-team-state" } }` |
| Default | `cdkd-state-{accountId}`, from the caller's STS account ID |

The default name contains no region. S3 bucket names are global, so teammates
whose profiles use different regions still resolve the same bucket and see the
same state.

`cdkd state info` prints the bucket cdkd resolved and which of the four
sources supplied the name.

Every key in the bucket that belongs to a stack starts with a prefix, which is
`cdkd` by default. Change it with `--state-prefix`.

### What is in the bucket

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

`state.json` is the object you will read. The others support one command or
one feature each:

| Object | What it holds | When it goes away |
| --- | --- | --- |
| `state.json` | The stack's resources and outputs | The stack is destroyed or orphaned |
| `lock.json` | Who is working on the stack | The command releases the [lock](state-management-locking.md) |
| `rollback-journal.json` | What a failed deploy completed | The next successful deploy, a clean rollback, or a destroy |
| `create-tokens.json` | Tokens for retrying an interrupted create | Deleted with `state.json` |
| `deployments/` | [Deployment events](deployment-events.md) | Kept after a destroy unless you pass `--purge-events` |
| `_index/{region}/exports.json` | Exported values of every stack in the region | Rewritten by each deploy |
| `cdkd-bootstrap/{region}.json` | The region's asset bucket and ECR repository names | `cdkd bootstrap --destroy` |
| `custom-resource-responses/{requestId}.json` | One custom resource handler's response | Deleted after the call, or by a [lifecycle rule](cli-bootstrap.md#re-running-bootstrap) within days |
| `cdkd-migrate-tmp/` | A template too large to send inline to CloudFormation | Deleted by the command that uploaded it |

Three of these need a word more:

- `rollback-journal.json` is the rollback journal. A failed or interrupted
  deploy writes it, and [`cdkd rollback`](cli-rollback.md) reads it to undo
  what that deploy did.
- `_index/{region}/exports.json` is the exports index. It lists the resolved
  value of every export in the region, and `Fn::ImportValue` is answered from
  it.
- `create-tokens.json` lets a re-run find an EFS, FSx or CloudFront origin
  access identity that an interrupted create already made. It holds no secret.

Two more objects exist to keep one stack name to one deployment. They are
described with the checks that use them:

- `_cdkd-registry/{region}/{stackName}.json`, at the top of the bucket, is
  the stack's marker in the [stack registry](state-store-registry.md).
- `retained.json`, beside `state.json`, lists resources the stack kept in AWS
  when it let go of them. The
  [name check](state-store-name-check.md#when-a-taken-name-is-allowed) reads
  it.

A custom resource response that is left in the bucket, because the deploy that
would have deleted it died, is collected by [`cdkd gc`](cli-gc.md).

### One record per stack and region

A record's key contains the stack name and the region, so a stack name
deployed to two regions has two independent records:

```text
cdkd/DatabaseStack/us-east-1/state.json
cdkd/DatabaseStack/us-west-2/state.json
```

The same stack name under two state prefixes, or in two buckets, is a
different matter. In one account and region it is unsupported, and cdkd
refuses it where it can see it. See
[One stack name per account and region](state-store.md#one-stack-name-per-account-and-region).

A nested stack has its own record. Its key joins the parent stack name and the
child's logical ID with `~`:

```text
cdkd/{parentStack}~{childLogicalId}/{region}/state.json
```

### The bucket can be in any region

The state bucket does not have to be in your profile's region or in a region
you deploy stacks into. cdkd looks up the bucket's region with
`GetBucketLocation` and addresses the bucket there. Resources are still
created in the region the CDK app declares.

### Move off the old bucket name with `cdkd state migrate`

Before v0.8 the default bucket name ended in the region:
`cdkd-state-{accountId}-{region}`. If only that bucket exists, cdkd uses it and
prints a deprecation warning. Support for the old name will be removed in a
future release, so copy the state to the current default:

```bash
# preview
cdkd state migrate --region us-east-1 --dry-run

# copy, keep the source
cdkd state migrate --region us-east-1

# copy, then delete the source
cdkd state migrate --region us-east-1 --remove-legacy
```

Run the command once for each region that has an old bucket. Every run copies
into the same destination bucket, and running it again for the same region is
safe.

If the destination `cdkd-state-{accountId}` does not exist, the command
creates it with the same configuration `cdkd bootstrap` uses.

The command refuses to start while any `lock.json` exists in the source
bucket, because a lock means a command may still be writing there. Clear a
lock that a dead process left behind with `cdkd force-unlock` first.

> [!WARNING]
> `--remove-legacy` deletes every object version in the source bucket, so the
> history of every record in it is gone. Check the destination before you pass
> it. Without the flag the source bucket is kept.

### Edge cases

**A record's `region` field disagrees with its key.** The key decides which
region a record belongs to. cdkd writes the same region into the record's
`region` field, so the two agree on every record cdkd wrote. They can disagree
only after a hand edit. cdkd then uses the key's region and warns.

`cdkd destroy`, `cdkd state destroy` and `cdkd rollback` refuse such a record
while it still lists resources. A delete sent to the wrong region would find
nothing, report every resource as already gone, and remove the record while
the resources stay live. To proceed, destroy against the region the resources
are in, or correct the `region` field so that it matches the key.
`cdkd state orphan` still drops the record and leaves the resources standing.

**A record with no region in its key.** Early cdkd versions wrote
`cdkd/{stackName}/state.json`. cdkd still reads that key. The next write saves
the record under the key that contains the region and deletes the old object.

## What a state record contains

A state record is one JSON document that lists the stack's resources and its
outputs. `cdkd state show MyStack` prints it in readable form, and
`cdkd state show MyStack --json` prints the document as stored:

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
      "physicalId":
        "arn:aws:lambda:us-east-1:123456789012:function:MyAppStack-MyFunction",
      "resourceType": "AWS::Lambda::Function",
      "properties": {
        "FunctionName": "MyAppStack-MyFunction",
        "Runtime": "nodejs20.x",
        "Handler": "index.handler",
        "Role": "arn:aws:iam::123456789012:role/MyAppStack-MyFunctionRole"
      },
      "attributes": {
        "Arn":
          "arn:aws:lambda:us-east-1:123456789012:function:MyAppStack-MyFunction"
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

The top level describes the stack. Each entry under `resources` describes one
resource, keyed by its logical ID from the template.

### Stack-level fields

| Field | Meaning |
| --- | --- |
| `version` | The [schema version](state-management-schema-versions.md); currently `11` |
| `stackName`, `region` | The stack, and the region its resources are in |
| `resources` | One entry per resource, keyed by logical ID |
| `outputs` | Each stack output's name and resolved value |
| `exportNames` | The `outputs` keys that are export names |
| `imports` | The exports of other stacks that this stack read with `Fn::ImportValue` |
| `outputReads` | The outputs of other stacks that this stack read with `Fn::GetStackOutput` |
| `skippedOutputs` | Outputs the last deploy [could not resolve](state-management-schema-versions.md#an-output-the-deploy-could-not-resolve) |
| `orphans` | Resources a rollback left in AWS and stopped listing under `resources` |
| `parentStack`, `parentLogicalId`, `parentRegion` | Present only on a nested stack's record |
| `lastModified` | Time of the last write, in Unix milliseconds |

Three of these fields change what a command does:

- `exportNames` decides which outputs another stack can import. Only a name in
  this list can satisfy an `Fn::ImportValue`.
- `imports` blocks the destroy of the stack that produces the export, for as
  long as this stack still reads it. `outputReads` is informational and blocks
  nothing.
- `orphans` lets a later deploy adopt the listed resources again. A rollback
  adds a resource here when the resource's `Retain` policy told the rollback
  to keep it.

An `outputs` value is not always a string. Where CloudFormation defines an
attribute as a list, such as a Route 53 hosted zone's `NameServers`, the
output is stored as a JSON array. The `Outputs:` block that `cdkd deploy`
prints joins the array with commas, so read the stored shape from
`cdkd state show`, which prints a value that is not a string or number as
JSON.

### Resource fields

| Field | Meaning |
| --- | --- |
| `physicalId` | The [ID cdkd uses](state-management-physical-ids.md) to address the resource in AWS |
| `resourceType` | The CloudFormation type |
| `properties` | The resolved template values cdkd sent to AWS |
| `observedProperties` | What AWS reported after the last create or update |
| `attributes` | The values `Fn::GetAtt` returns for this resource |
| `dependencies` | The logical IDs this resource depends on |
| `deletionPolicy`, `updateReplacePolicy` | The template attributes as of the last deploy |
| `provisionedBy` | `sdk` or `cc-api`: [which route](state-management-schema-versions.md#provisionedby-which-route-owns-a-resource) created the resource |
| `observedBaselineRefused` | `cdkd import` did not record `observedProperties` for this resource |
| `constructPath` | The resource's CDK construct path at its last deploy; informational |

How commands use these fields:

- [`cdkd drift`](cli-drift.md) compares the live resource with
  `observedProperties`. That field is the drift baseline.
- A destroy deletes resources in the reverse of `dependencies`, and reads
  `deletionPolicy` to decide whether to keep a resource.
- When `observedBaselineRefused` is set, `cdkd state show` prints
  `ObservedBaseline: REFUSED` for the resource.

`properties` holds what cdkd sent, which can be less than the template
declares. This happens when `--prefer-sdk-route` keeps a resource on cdkd's
own SDK provider and that provider cannot write one of the properties. cdkd
does not send the property and, unless the property is create-only, does not
record it. [`cdkd export`](cli-export.md) rebuilds a template from
`properties`, so the property is missing from the exported template too.

A record can also carry bookkeeping fields that no command asks you to read or
edit: `noEchoLeaves`, `noEchoAttributeNames`, `noEchoExactEchoLeaves`,
`maskedPropertyFingerprints`, `maskedPropertyInputFingerprints`,
`acceptedCreateOnlyDrops`, `observedBaselineRefusalReason` and
`conditionVerdicts`. The contributor page
[State schema internals](state-schema-internals.md#schema-reference) documents
each one.

## How a deploy reads and writes state

A deploy locks the stack, loads the record, saves it after every resource
operation, and releases the lock at the end.

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

Because the record is saved after each resource, a deploy that dies partway
leaves a record of everything it finished. On the next deploy, the resources
that were never recorded are planned as `CREATE` and tried again.

A failed or interrupted deploy also writes the rollback journal.
[`cdkd rollback`](cli-rollback.md) replays the journal without synthesizing
the app.

A destroy works the same way in reverse. It deletes resources in reverse
dependency order and saves the shortened record after each delete. A destroy
that deletes everything also deletes `state.json`.

A destroy that stops partway keeps the record with the resources that remain,
and clears `outputs`. Clearing them stops another stack from importing a value
whose resource is already gone.

## Upgrading cdkd

A newer cdkd reads every older record and saves it in the current schema
version the next time it writes. There is no migration command to run.

An older cdkd refuses a record that a newer one has written. So upgrade every
machine and CI job that deploys a stack at the same time.
[Schema versions and upgrades](state-management-schema-versions.md) lists the
versions and what the first deploy after an upgrade does.

## In this section

- [Physical IDs in state](state-management-physical-ids.md): what a
  `physicalId` is, the composite IDs joined with `|`, and how they differ from
  what `Ref` returns.
- [Secrets in state](state-management-secrets.md): which secret values cdkd
  stores as `***`, which it stores in the clear, and what a masked value
  changes for later deploys.
- [State locking](state-management-locking.md): which commands lock a stack,
  how long a lock lasts, and how to clear one a dead process left behind.
- [Schema versions and upgrades](state-management-schema-versions.md): the
  version table, what happens when cdkd versions are mixed, and the
  `provisionedBy`, `exportNames` and `skippedOutputs` fields.
- [Malformed state records](state-management-malformed-records.md): what each
  command does with a damaged record, and how to repair one.
- [State backup and bucket security](state-management-backup-and-security.md):
  restoring an earlier record, the bucket configuration, the IAM actions cdkd
  needs, and S3 replication.

## Related

- [Manage Stacks Without the App](state-store.md): the introduction to the state store
- [`cdkd state`](cli-state.md): every subcommand and flag
- [Orphan Instead of Destroy](orphan-vs-destroy.md): the commands that remove a
  record, with and without deleting the resources
- [State schema internals](state-schema-internals.md): contributor page with
  the version history, the full field reference and the implementation
