---
title: cdkd state
description: "The cdkd state subcommands: inspect the S3 state store, and orphan, destroy, migrate or re-baseline its records without a CDK app."
---

# cdkd state

`cdkd state` reads and edits the records in cdkd's S3 state bucket directly.
No subcommand synthesizes, so none needs the CDK app that deployed a stack:
they work from a CI runner after the branch is gone, or on a machine that
never had the repository. Stacks are named by their physical name, as
`cdkd state list` prints them.

```bash
cdkd state info                               # which bucket cdkd uses, and what is in it
cdkd state list                               # one "Stack (region)" per line
cdkd state resources MyStack                  # logical id, type, physical id
cdkd state show MyStack                       # the whole record, with properties
cdkd state orphan MyStack --resource MyQueue  # stop tracking one resource; it stays in AWS
cdkd state destroy MyStack --yes              # delete the AWS resources, then the record
cdkd state refresh-observed MyStack           # re-read the drift baseline from AWS
```

## Subcommands

Read-only subcommands. A held lock never blocks them.

| Subcommand | Use it to |
| --- | --- |
| [`info`](#cdkd-state-info) | See which bucket cdkd resolved, its region, and how many stacks it holds. |
| [`list`](#cdkd-state-list) | List the stacks in the bucket, flat or as a nested-stack tree. |
| [`resources`](#cdkd-state-resources) | List one stack's resources with their physical ids. |
| [`show`](#cdkd-state-show) | Read one stack's full record: lock, outputs, and every resource's properties. |

Subcommands that write. Each asks for confirmation first.

| Subcommand | Changes | Use it to |
| --- | --- | --- |
| [`orphan`](#cdkd-state-orphan) | the state record | Stop tracking a stack, or one resource in it, and leave the AWS resources running. |
| [`destroy`](#cdkd-state-destroy) | AWS resources, then the record | Delete a stack when you no longer have its CDK app. |
| [`refresh-observed`](#cdkd-state-refresh-observed) | the state record | Re-read the drift baseline from AWS without deploying. |
| [`migrate`](#cdkd-state-migrate) | which bucket holds the records | Copy a legacy region-suffixed state bucket into the region-free one. |

To remove a stack, the choice between `orphan` and `destroy` is whether the AWS
resources should survive:

```text diagram=state-cli-cleanup-choice
Should the AWS resources be deleted?
├─ yes ─▶ cdkd state destroy MyStack
│         deletes the resources, then the record
└─ no ──▶ How much of the record goes?
          ├─ one resource ─▶ cdkd state orphan MyStack --resource MyQueue
          │                  drops one entry; the stack stays deployed
          └─ whole stack ──▶ cdkd state orphan MyStack
                             deletes the whole record; nothing stays tracked
```

[Orphan vs Destroy](orphan-vs-destroy.md) compares these with `cdkd destroy`
and `cdkd orphan`, which need the CDK app.

## Shared options

Every subcommand takes these, except that `state migrate` takes neither
`--state-bucket` nor `--state-prefix`.

| Flag | Default | Description |
| --- | --- | --- |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Skip the confirmation prompt. No effect on the read-only subcommands. |
| `--verbose` | off | Verbose logging. |

`--region` is deprecated in favour of `AWS_REGION` or your AWS profile, but is
still honored. Two subcommands differ: `state info` rejects it, and on
`state migrate` it is a regular option that names the legacy bucket.

### `--stack-region`: which of a name's records

The same stack name can have a record in several regions. `--stack-region
<region>` picks one. It is separate from `--region`, which sets the AWS
client's region.

```bash
cdkd state show MyStack --stack-region us-west-2
```

Without it, a name with records in several regions is handled per subcommand:

| Subcommand | Without `--stack-region` on an ambiguous name |
| --- | --- |
| `resources`, `show` | Error. |
| `orphan` | Removes the record in every region. |
| `orphan --resource` | Error. |
| `destroy` | Error. |
| `refresh-observed <stack>` | Error. |
| `refresh-observed --all` | Not ambiguous: the flag is a filter, and omitting it refreshes every region. |

## `cdkd state info`

Answers "which bucket is cdkd using, and what is in it".

```bash
cdkd state info
```

```text
State bucket:    cdkd-state-123456789012
Region:          us-east-1 (auto-detected via GetBucketLocation)
Source:          default (account ID from STS)
Schema version:  11
Stacks:          4
Asset storage:   legacy (CDK bootstrap) — run cdkd bootstrap to opt in
```

| Flag | Default | Description |
| --- | --- | --- |
| `--json` | off | Print the report as one JSON object on stdout, and nothing else. |

`Source:` says how the bucket name was resolved:

| `Source:` | Meaning |
| --- | --- |
| `--state-bucket flag` | Passed on the command line. |
| `CDKD_STATE_BUCKET env` | From the environment variable. |
| `cdk.json (context.cdkd.stateBucket)` | From the app's `cdk.json`. |
| `default (account ID from STS)` | The default name, `cdkd-state-{account}`. |
| `default (legacy region-suffixed name; cdkd state migrate recommended)` | An older bucket name is in use. Run [`cdkd state migrate`](#cdkd-state-migrate). |

Other commands do not print the bucket name, because the default name contains
your AWS account id and would end up in screenshots and public CI logs.
`--verbose` shows it in their debug output.

`state info` reports rather than fails where it can. A bucket whose region
cannot be read shows `unknown`, and so does the schema version of an empty
bucket or an unparsable record. The schema version is read from one record,
not reconciled across all of them.

## `cdkd state list`

Lists the stacks that have a record in the bucket. `ls` is an alias.

```bash
cdkd state list           # one "Stack (region)" per line
cdkd state list --long    # resource count, last-modified time, lock status
cdkd state list --tree    # nested stacks under their parents
cdkd state list --json
```

```text
ApiStack (us-east-1)
MyStack (us-east-1)
MyStack (us-west-2)
```

| Flag | Default | Description |
| --- | --- | --- |
| `-l`, `--long` | off | Show resource count, last-modified time and lock status per stack. |
| `--tree` | off | Draw the parent-to-child tree of nested stacks. Cannot be combined with `--long`. |
| `--json` | off | Print the listing as JSON. Works with `--long` and with `--tree`. |

[`cdkd list`](cli-list.md) is a different command. It lists the stacks your
local CDK app defines; `cdkd state list` lists what is recorded in the bucket.

stdout carries only the listing in every mode, so it is safe to pipe. Warnings
and log lines go to stderr:

```bash
cdkd state list | while read -r stack region; do
  echo "$stack is recorded in $region"   # region arrives in parentheses
done
```

The plain listing reads no record. `--long` costs two extra S3 requests per
stack (the record and its lock), and `--tree` one.

### `--long`

```bash
cdkd state list --long
```

```text
ApiStack (us-east-1)
  Region: us-east-1
  Resources: 23
  Last Modified: 2026-10-08T09:14:02.000Z
  Lock: unlocked

MyStack (us-east-1)
  Region: us-east-1
  Resources: 2
  Last Modified: 2026-10-10T16:40:51.000Z
  Lock: locked
```

`--long --json` emits one object per stack:

| Field | Value |
| --- | --- |
| `stackName`, `region` | The reference. `region` is `null` for a legacy record without one. |
| `resourceCount` | Number of resources, or `null` when it could not be counted. |
| `lastModified` | ISO timestamp, or `null`. |
| `locked` | `true`, `false`, or `null` when the lock could not be read. |
| `stateReadError`, `stateReadErrorKind` | Why the record could not be read or counted. Both `null` otherwise. |
| `lockReadError` | Why the lock could not be read. `null` otherwise. |

### Rows cdkd could not read

One unreadable stack does not fail the listing. Its row says what is missing,
a warning on stderr counts such rows, and the command still exits `0`.

| Read that failed | Text row | `--long --json` |
| --- | --- | --- |
| The state record, or its `resources` could not be counted | `Resources: unknown (...)`; the lock is still reported | `resourceCount: null`, `stateReadError` and `stateReadErrorKind` set |
| The lock | `Lock: unknown (...)`; the resource count is still reported | `locked: null`, `lockReadError` set |

Run `cdkd state show` on that stack to see the underlying error.

`stateReadErrorKind` separates the two record failures for a script:

| `stateReadErrorKind` | Meaning | Retrying helps? |
| --- | --- | --- |
| `read-failed` | The record could not be read. | Possibly. The failure may be transient. |
| `resources-malformed` | The record was read, but its `resources` is not a JSON object. | No. The record has to be fixed. |

Treat a value you do not recognise as a failure. More kinds may be added.

### `--tree`

```bash
cdkd state list --tree
```

```text
NestedStackDeep (us-east-1)
└── NestedStackDeep~Child (us-east-1)
    └── NestedStackDeep~Child~Grandchild (us-east-1)
```

A child whose parent record is missing appears at the root instead of
disappearing. `--tree --json` emits the same tree as nested objects with
`stackName`, `region`, `parentStack`, `parentLogicalId`, `parentRegion` and
`children`.

The tree is capped at 100 levels. A record that would sit deeper is shown at
the root instead, and its chain continues from there, so every record appears
exactly once. CloudFormation stops at five levels of nested stacks, so only an
app that deploys solely through cdkd can reach the cap. A parent chain more
than 100 levels deep is therefore drawn in several pieces, with no record
dropped.

### Names that are quoted or cut

A stack name or region is printed as it is when it is a plain identifier,
which every real one is. A value with a space, a bracket, a quote or a
non-ASCII character is printed inside double quotes, so that it cannot be
read as a different stack's row. A very long value is cut and ends with
`[cut: N more characters withheld, tail sha256:<32 hex>]`.

The quotes mark a boundary for a reader. They are not shell quoting. Use
`--json` when a script needs the exact stored values: `--json` output is never
altered this way, and control characters in it are written as `\uXXXX` escapes
so the values parse back unchanged. That holds for the `--json` mode of every
`cdkd state` subcommand.

### Listing the bucket without cdkd

```bash
aws s3 ls s3://cdkd-state-123456789012/cdkd/ --recursive \
  | grep state.json \
  | awk '{print $4}' \
  | sed 's|cdkd/||; s|/state.json||'
# Prints <stackName>/<region>, one row per record.
```

## `cdkd state resources`

Lists what cdkd recorded for one stack, sorted by logical id.

```bash
cdkd state resources MyStack
```

```text
JobsTable1A2B3C4D      AWS::DynamoDB::Table  MyStack-JobsTable1A2B3C4D-9QK2M
UploadsBucket5E5E9B33  AWS::S3::Bucket       mystack-uploadsbucket5e5e9b33-k2j4h8x1
```

The columns are logical id, resource type and physical id. There is no header
row, so the output can be piped.

| Flag | Default | Description |
| --- | --- | --- |
| `-l`, `--long` | off | Print each resource as a block with its dependencies and attributes. |
| `--json` | off | Print the resources as a JSON array. Takes precedence over `--long`. |
| `--stack-region <region>` | — | Region of the record to read. |

```bash
cdkd state resources MyStack --long
```

```text
JobsTable1A2B3C4D
  Type: AWS::DynamoDB::Table
  PhysicalID: MyStack-JobsTable1A2B3C4D-9QK2M
  Dependencies: (none)
  Attributes:
    Arn: arn:aws:dynamodb:us-east-1:123456789012:table/MyStack-JobsTable1A2B3C4D-9QK2M
```

No mode of this subcommand prints resource properties. Use
[`cdkd state show`](#cdkd-state-show) for those.

For resource types that AWS identifies by more than one field, the physical id
is several values joined with `|`. That value is not what `Ref` returns;
[State Management](state-management.md) explains these ids.

## `cdkd state show`

Prints one stack's whole record: metadata, the lock, outputs, and every
resource with its properties, attributes, dependencies and the layer that
provisioned it.

```bash
cdkd state show MyStack
```

```text
Stack: MyStack
  Region: us-east-1
  Version: 11
  Last Modified: 2026-10-10T16:40:51.000Z
  Lock: unlocked

Outputs:
  QueueUrl: https://sqs.us-east-1.amazonaws.com/123456789012/MyStack-JobsQueue7C2B1F0E-Zk3mQ

Resources (1):

JobsQueue7C2B1F0E
  Type: AWS::SQS::Queue
  PhysicalID: https://sqs.us-east-1.amazonaws.com/123456789012/MyStack-JobsQueue7C2B1F0E-Zk3mQ
  ProvisionedBy: sdk
  Dependencies: (none)
  Attributes:
    Arn: arn:aws:sqs:us-east-1:123456789012:MyStack-JobsQueue7C2B1F0E-Zk3mQ
  Properties:
    VisibilityTimeout: 300
```

| Flag | Default | Description |
| --- | --- | --- |
| `--json` | off | Print the stored record and its lock as JSON: `{state, lock}`. |
| `--show-nested` | off | Also print every nested stack under this one. |
| `--stack-region <region>` | — | Region of the record to read. |

`--json` is the mode to use when you need the stored values exactly, for
example to inspect a record another command refused.

### `--show-nested`

```bash
cdkd state show MyParent --show-nested
```

```text
Stack: MyParent
  ...

Nested stack: MyParent~Child
Stack: MyParent~Child
  ...
```

Each nested stack's block follows its parent's, depth first, each behind its
own `Nested stack:` header. With `--json` the shape becomes
`{state, lock, children: [...]}`, where `children` is always present and is
empty on a leaf.

A parent that lists a nested stack whose record does not exist is an error,
and no partial tree is printed. To repair it, re-deploy the parent or finish
the operation that was interrupted. Failing both, remove the parent's record
with [`cdkd state orphan`](#cdkd-state-orphan) and re-import the stack.

### Skipped outputs

A `Skipped outputs:` block lists the output keys the last deploy could not
resolve, each with a digest of that output's template inputs:

```text
Skipped outputs:
  ApiUrl: 1f3c9a0b7d42…

The last deploy could not resolve the keys listed under `Skipped outputs:`
above, and recorded a digest of their template inputs. While the record
binds and a key is still absent from the stored outputs, `cdkd diff`
previews it as ABSENT — no row, no warning. A key whose earlier value
was retained is also stored under `Outputs:` here, where the record does
NOT suppress it: the ordinary rules apply, up to `cdkd diff` suppressing
its whole Outputs section if the key still cannot resolve.
Binding rule: `bindingSkippedOutputs` in src/analyzer/skipped-outputs.ts.
```

This is where to look when `cdkd diff` shows nothing for an output you expect.
A skipped key gets no diff row and no warning, so this block is the
explanation.

Three things to know when reading it:

- The block appears only when something was recorded. A record without it does
  not prove that nothing was skipped.
- `Outputs:` is omitted when no output has a value, so the block can appear
  without it.
- The digest is cut to 12 characters. Two different prefixes mean two different
  records, but equal prefixes prove nothing. Compare whole digests through
  `--json`.

### When a nested resource shows the wrong `provisionedBy`

`ProvisionedBy` records which layer created a resource: `sdk` or `cc-api`
(Cloud Control). A resource in a nested stack can carry `cc-api` from an older
cdkd release, in which `--recreate-via-cc-api <LogicalId>` also matched a
child's resource with the same logical id. The value stays, the recreate flags
cannot target a nested child, and no `state` subcommand edits it: the two
layers store different physical ids for many types, so changing the label
alone would hand the SDK provider an id it cannot use.

First check whether the type moves back by itself.
[Deploy: safety](cli-deploy-safety.md) and
[State Management](state-management.md) list the types that do.

Otherwise, rename the construct in the nested stack, which changes its logical
id:

```ts
// Before: new sqs.Queue(this, 'Jobs');
new sqs.Queue(this, 'JobsV2');
```

The next deploy creates the new logical id through the default layer and
deletes the old resource through the layer that created it.

> [!CAUTION]
> This destroys and re-creates the resource, and the deploy does not ask
> first. A stateful resource comes back empty. With a `Snapshot` deletion
> policy, the RDS default, the old one is deleted after a final snapshot.

The deploy creates before it deletes, so prepare these cases before renaming:

| The old resource | Do this first |
| --- | --- |
| Is a non-empty S3 bucket without `autoDeleteObjects` | Empty it. Otherwise its delete fails, and the rollback deletes the new bucket again (`--no-rollback` leaves both). |
| Has deletion protection | Deploy the property set to `false` on its own, before the rename. A deploy never lifts protection, and the renamed resource would be created protected, so the rollback could not delete it either. |
| Has a fixed physical name | Give the new one a different name, or deploy the removal first and add the construct back in a second deploy. |
| Has `DeletionPolicy: Retain` | Nothing, but it stays in AWS afterwards, only dropped from state. Delete it yourself, and before the re-add deploy if it has a fixed physical name. |

## Malformed state records

A state record is JSON in S3, and a hand edit or a truncated write can leave
it in a shape cdkd does not expect. The read-only subcommands show what they
can and say what they could not. The subcommands that write refuse.

### What the human views do to a malformed record

The text output of `cdkd state resources` and `cdkd state show` treats every
value in the record as untrusted text:

- Control characters are removed from names, types, ids and dependency lists,
  so a value cannot forge an extra output line or run a terminal escape
  sequence.
- A value of the wrong type is still printed: a number as that number, an
  object as JSON, and a value that cannot be serialized as `(unserializable)`.
- A lock with an unreadable expiry reads `expires at an unknown time`.

A record that is broken at its root is refused, with a message naming the
problem:

- `state.json` is not valid JSON.
- Its body is not a JSON object.
- Its schema version is one this cdkd does not read.

`cdkd state list --long` degrades only that stack's row instead, as described
under [Rows cdkd could not read](#rows-cdkd-could-not-read).

`cdkd state show --json` prints the stored values without any of this
filtering. `cdkd state resources --json` does not: it prints the resource
list cdkd derived from the record.

### When `resources` is not an object

`resources` is a map from logical id to resource. If a record holds a string, a
list, a number or a boolean there, the read-only views treat the stack as
having no resources and print a warning on stderr.

| Command | What it prints |
| --- | --- |
| `cdkd state resources`, plain and `--long` | Nothing, plus the warning. |
| `cdkd state resources --json` | `[]`, plus the warning. |
| `cdkd state show`, `--show-nested` included | `Resources (0):` with no resource blocks, plus one warning per record read that way. |
| `cdkd state show --json` | The stored value, unchanged, with no warning. |
| `cdkd state show --show-nested --json` | The stored value, unchanged, with one warning per record. |
| `cdkd state list --long` | `Resources: unknown (...)` for that row. |

An absent or `null` `resources` is reported the same way, except that
`cdkd state list --long` counts it as `0` without a reason.

> [!WARNING]
> `cdkd deploy` and `cdkd destroy` refuse such a record. Read as empty, it
> would make a deploy re-create every resource and a destroy delete none of
> them while removing the record. Repair the record or remove it.
> [State Management](state-management.md) lists what each command does.

Under `--show-nested` each record is judged separately. A healthy parent with a
malformed nested stack prints the parent's resources and reports the child
with none.

### When a value container is not an object

The same rule applies to four other maps: `outputs` and `skippedOutputs` on the
record, and `attributes` and `properties` on each resource. One that holds a
string, a list, a number or a boolean is read as empty, with one warning per
record naming each container that was emptied.

| Command | What it prints |
| --- | --- |
| `cdkd state show` | The record without that block: no `Outputs:`, no `Skipped outputs:`, `Attributes: (none)`, `Properties: (none)`. Plus the warning. |
| `cdkd state show --show-nested` | The same, with the warning naming the stack whose record it was. |
| `cdkd state resources --long` | `Attributes: (none)`, plus the warning. |
| `cdkd state resources --json` | `"attributes": {}`, plus the warning. |
| `cdkd state resources`, plain | The three-column listing, with no warning. It prints no attributes. |
| `cdkd state show --json`, `--show-nested` included | The stored value, unchanged, with no warning. |

An absent or `null` container is normal and is not reported.

[cdkd state internals](cli-state-internals.md) has the full rendering rules.

## `cdkd state orphan`

Removes cdkd's record of a stack and leaves every AWS resource running. cdkd
no longer knows the stack exists. With `--resource`, it removes only the named
resources' entries and keeps the rest of the record.

```bash
cdkd state orphan MyStack                                    # every region's record for MyStack
cdkd state orphan MyStack --stack-region us-east-1           # one region's record
cdkd state orphan StackA StackB --force                      # no prompt, even if locked
cdkd state orphan MyStack --stack-region us-east-1 --resource MyQueue
```

| Flag | Default | Description |
| --- | --- | --- |
| `<stacks...>` | — | Stack names to orphan. At least one; exactly one with `--resource`. |
| `--resource <logicalId>` | — | Remove only this resource's entry. Repeatable. |
| `-f`, `--force` | off | Skip the prompt and remove the record even when the stack is locked. With `--resource`: skip the prompt and allow cached values for unresolvable references; a lock still refuses. |
| `--stack-region <region>` | — | Orphan only the record in this region. Required with `--resource` when the name has records in several regions. |

Orphaning a stack that has no record does nothing and exits `0`, so the command
can be re-run.

On a stack that is still deployed, removing the whole record means the next
`cdkd deploy` creates every resource again or collides with the existing ones.
Use `--resource` there.

### Locked stacks

| Flag | Prompt | A held lock |
| --- | --- | --- |
| none | asks | Refuses, printing the `cdkd force-unlock` command to run first. |
| `-y`, `--yes` | skipped | Refuses the same way. |
| `-f`, `--force` | skipped | Deletes the lock and removes the record. |
| `--resource`, with any flag | as above | Refuses. No flag bypasses a lock here. |

`--force` deletes whatever lock is present, including one that belongs to a
deploy in progress. The command warns when it is about to do that.

### Removing one resource from the record

```bash
cdkd state orphan MyStack --resource MyQueue
cdkd state orphan MyStack --resource MyQueue --resource MyTopic
```

`--resource <logicalId>` removes one resource's entry and keeps the stack
deployed. The resource stays in AWS, untracked, and every other resource stays
under cdkd. Because it reads the record and not your CDK app, it also reaches
a resource whose construct has already left the template, such as one whose
delete `cdkd deploy` skipped. `cdkd orphan` cannot address that one, because it
finds resources by construct path in the synthesized template.

What it does to the rest of the record:

- Every `Ref`, `Fn::GetAtt` and `Fn::Sub` that another resource or a stack
  output holds to the removed resource is replaced with the value it resolved
  to.
- The removed resource is dropped from every `dependencies` list.
- A `Fn::GetAtt` value the record does not hold is read live from AWS in the
  stack's region.

It refuses, writing nothing, in these cases:

| Refused when | What to do |
| --- | --- |
| A reference to the removed resource cannot be resolved | Pass `--force` to use the value cached in the removed entry. Where there is none, or it is a credential or a masked value, the original reference is kept. |
| The stack is locked | Run the printed `cdkd force-unlock` command. `--force` does not bypass the lock. |
| The record has no such logical id | Pick one from the list the error prints. |
| The record, its outputs, or an entry it would keep is malformed | Repair the record. See [Malformed state records](#malformed-state-records). |
| The resource is a nested stack whose own record still exists | Run the printed `cdkd state orphan '<parent>~<logicalId>'` first. |

What the next `cdkd deploy` does with the resource depends on your template:

| The construct is | The next deploy |
| --- | --- |
| No longer in the template | Leaves the resource alone. cdkd has no record of it. |
| Still in the template | Creates it again. A resource with a fixed or generated name collides with the one in AWS, so delete that by hand first or bring it back with [`cdkd import`](import.md). |

This is the wrong tool for getting past a destroy that another stack's
reference blocks. [Cross-Stack References](cross-stack-references.md) explains
why.

## `cdkd state destroy`

Deletes a stack's AWS resources and then its state record, working from the
record instead of the CDK app. It runs the same per-stack steps as
[`cdkd destroy`](cli-destroy.md), so the data guards, `DeletionPolicy`
handling, cross-stack reference blocks, locking and exit codes are the same.

```bash
cdkd state destroy MyStack                       # asks for confirmation
cdkd state destroy MyStack OtherStack --yes
cdkd state destroy MyStack --stack-region us-west-2
cdkd state destroy MyStack --remove-protection --yes
```

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack names to destroy. Required. |
| `--remove-protection` | off | Turn per-resource deletion protection off before deleting. |
| `--skip-final-snapshot` | off | Delete `DeletionPolicy: Snapshot` resources without taking the final snapshot. |
| `--allow-unsupported-types <types>` | — | Comma-separated types to attempt through Cloud Control although cdkd reports them unsupported. |
| `--resource-warn-after <duration>` or `<TYPE>=<duration>` | `5m` | Warn when one resource operation runs longer than this. Repeatable. |
| `--resource-timeout <duration>` or `<TYPE>=<duration>` | `30m` | Abort one resource operation that exceeds this. Repeatable. |
| `--stack-region <region>` | — | Act on the record in this region, and on any record that names no region. A name whose only record is elsewhere is warned about and skipped. |

Differences from `cdkd destroy`:

| Difference | `cdkd state destroy` |
| --- | --- |
| Stack selection | Physical names only. No CDK display paths, no wildcards. A nested stack can be named directly as `<parent>~<child>`. |
| `--all` | Does not exist. Passing it fails with exit `1` before anything is read. |
| `-f`, `--force` | Does not exist. `-y` / `--yes` is the only way to skip the prompts. |
| `--purge-events` | Does not exist. Use [`cdkd events prune`](cli-events.md). |
| A name with no record | An error, not a silent skip. |

There is no `--all` because the state bucket is shared by every CDK app
deployed to the account, so such a flag would destroy other apps' stacks.
Name each stack, or run `cdkd destroy --all` from the CDK app, which destroys
only that app's top-level stacks (`cdkd destroy '**'` also destroys its CDK
Stage stacks).

Each stack and region the command runs against records one deployment-event
run under `command: destroy`, including a failed, skipped or declined target.
[`cdkd events`](cli-events.md) can read it after the record is gone.

The flags, data guards and prompts are documented on
[Destroy flags & guards](cli-destroy.md), and the two duration flags on
[Deploy: tuning](cli-deploy-tuning.md).

## `cdkd state migrate`

Copies a legacy state bucket, `cdkd-state-{account}-{region}`, into the
region-free default, `cdkd-state-{account}`. Run it when
[`cdkd state info`](#cdkd-state-info) reports the legacy name. Objects are
copied key for key and no record is rewritten.

::: steps
1. Preview

   ```bash
   cdkd state migrate --region us-east-1 --dry-run
   ```

   Prints the two bucket names, the source bucket's region and the object
   count, then stops without asking for confirmation.

2. Copy

   ```bash
   cdkd state migrate --region us-east-1
   ```

   The source bucket is kept. Run this once per region you have a legacy
   bucket in.

3. Remove the legacy bucket, once you are satisfied with the new one

   ```bash
   cdkd state migrate --region us-east-1 --remove-legacy
   ```
:::

> [!CAUTION]
> `--remove-legacy` cannot be undone. It deletes every object version and
> delete marker in the source bucket, then the bucket.

| Flag | Default | Description |
| --- | --- | --- |
| `--region <region>` | `AWS_REGION` / `us-east-1` | Which region's legacy bucket to migrate. |
| `--legacy-bucket <name>` | derived from the account and region | Source bucket name. |
| `--new-bucket <name>` | `cdkd-state-{accountId}` | Destination bucket name. |
| `--dry-run` | off | Report what would be copied and change nothing. |
| `--remove-legacy` | off | Delete the source bucket after the copy has been verified. |

The command can be re-run. It reuses an existing destination, each object copy
is repeatable, and the verification accepts a destination that already holds
objects, so a second run resumes a partial migration. The source bucket is
deleted only after the object count at the destination has been verified.

It refuses to start while any `lock.json` exists in the source bucket, and
names the keys. Wait for the operation in progress, or clear a stale lock with
[`cdkd force-unlock`](cli-force-unlock.md).

[State Management](state-management.md) covers the destination bucket's
settings and a manual `aws s3 sync` alternative.

## `cdkd state refresh-observed`

Re-reads every resource of a stack from AWS and stores the result as the
stack's drift baseline, without deploying. The baseline, `observedProperties`
in the record, is the snapshot of what AWS held: your template's values, the
defaults AWS filled in, and keys your template never set.
[`cdkd drift`](cli-drift.md) compares AWS against it.

```bash
cdkd state refresh-observed MyStack
cdkd state refresh-observed --all --dry-run   # count what would be refreshed
cdkd state refresh-observed --all --yes
```

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack names to refresh. Required unless `--all` is given. |
| `--all` | off | Refresh every stack in the state bucket. |
| `--dry-run` | off | Print the per-stack count. Takes no lock, reads no resource from AWS, writes nothing. The records are still read from S3. |
| `--stack-region <region>` | — | Region of the record to refresh. With `--all` it filters. |

### When to run it

`cdkd deploy` keeps the baseline current for every resource it creates,
updates or replaces, and fills in a missing one. It does not re-read a resource
that was unchanged and already had a baseline. Run this command when:

- A stack has not been deployed for a while and you want `cdkd drift` to
  compare against what AWS holds now.
- The stack was deployed with `--no-capture-observed-state`, so no baseline was
  captured ([Deploy: tuning](cli-deploy-tuning.md)).
- You are about to hand the stack to CloudFormation with
  [`cdkd export`](cli-export.md).

With a baseline, `cdkd drift` also reports a console edit to a key your
template never mentions. Without one it compares only the keys in state.

### Resources it does not refresh

| Resource | What happens | Exit code |
| --- | --- | --- |
| Its provider cannot read current state | Counted as unsupported. Keeps its previous baseline. | unaffected |
| AWS reports it as not found | Named in a warning and counted as failed. Keeps its previous baseline. | `2` |
| Its read fails for another reason | Reported individually. | `2` |
| A `cdkd import` run refused it a baseline | Skipped and counted separately. | unaffected |

The last row is deliberate. When [`cdkd import`](import.md) could not place
the secret redaction for a resource, it records that on the resource, and this
command will not read a value back for it, since that could store a resolved
secret in plaintext. `cdkd state show` marks such a resource with an
`ObservedBaseline: REFUSED` line that names its remedy. Re-running this
command does not clear it:

- Deploy a change to the resource. That rebuilds its record from your template
  and captures a baseline. A deploy that changes nothing does not.
- If the refusal was over a template parameter whose deployed value cdkd could
  not prove, an in-place update keeps the refusal. Replace the resource, or
  re-import it while a CloudFormation stack can prove the value.

### Secrets in the baseline

The values AWS returns can include decrypted secrets. cdkd writes the
`{{resolve:secretsmanager:...}}` reference from the record back over such a
value, matching by position.

- Run [`cdkd scrub`](cli-scrub.md) first on state written by a cdkd release
  that predates its secret-redaction fixes. A record whose own properties
  already hold the plaintext gives this command nothing to match against.
- Where the readback and the record cannot be lined up, cdkd writes the mask
  `***` at that position. `cdkd drift` then reports the position as not
  compared (exit `2`). A `cdkd deploy` repairs it; re-running this command
  afterwards writes the masks back. See [`cdkd drift`](cli-drift.md).
- An older record can hold a `{{resolve:ssm:...}}` reference inside a longer
  value. The value AWS reports is kept there only when the parameter is a
  `String` or `StringList`; for a `SecureString` the reference is written
  back. The check calls `ssm:GetParameter` without decryption. Without that
  permission the reference is written back and the command still succeeds.

### Malformed records are refused

This subcommand rewrites the record, so it does not proceed over one it cannot
read. It refuses, naming the stack and region, before taking the lock and
before reading anything from AWS, when:

- `resources` is not a JSON object (`null`, absent, a list, a number, a string
  or a boolean), or
- an entry in `resources` is not an object or has no resource type. The
  message names up to five logical ids and counts the rest.

With `--all` or several names, every record is checked before the first one is
refreshed, so one malformed record stops the whole run with nothing written. A
legacy record without a region is also refused before any stack is refreshed.
Any cdkd write, such as a deploy, migrates it.

Inspect the record, then repair or remove it:

```bash
cdkd state show MyStack --json
cdkd state orphan MyStack   # removes the record, not the AWS resources
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, including a declined confirmation prompt and a run with nothing to do. |
| `1` | Failure: a missing record, an ambiguous region, a held lock, a prompt in a non-interactive shell, or an AWS or S3 error. |
| `2` | Partial completion. `state destroy`: per-resource delete failures, skips, or an interruption with targets left. `state refresh-observed`: per-resource read failures, including a resource AWS reports as not found. |
| `130` | A destroy force-quit with {kbd:ctrl+c}: a second press, or one before the stack's graceful stop was armed. A stack lock may be left behind; the message names `cdkd force-unlock`. |

In a non-interactive shell, a writing subcommand refuses its confirmation
prompt with exit `1` instead of waiting. Pass `-y` / `--yes`, or `--force` for
`state orphan`, to run it unattended.

## Related

- [State Store](state-store.md): the same subject, summarised for a first read
- [State Management](state-management.md): the record schema, the key layout and the lock
- [Orphan vs Destroy](orphan-vs-destroy.md): which cleanup command to reach for
- [Destroy flags & guards](cli-destroy.md): the guards and prompts `cdkd state destroy` shares
- [`cdkd drift`](cli-drift.md): the comparison `state refresh-observed` supplies the baseline for
- [CLI Reference](cli-reference.md): every command and the full exit-code table
- [Troubleshooting](troubleshooting.md): what to do when a state record and AWS disagree
- [cdkd state internals](cli-state-internals.md): rendering and refusal rules, for contributors
