---
title: Import options and the import plan
description: "Every cdkd import flag, when --force is needed, how to read the import plan, the details of a CloudFormation migration, and how cdkd import differs from cdk import."
---

# Import options and the import plan

This page is the reference for `cdkd import`: its flags, the plan it prints,
and the details of a CloudFormation migration. For the walkthroughs, start at
[Import Existing Resources](import.md).

```bash
# print the plan, write nothing
cdkd import MyStack --dry-run

# import one resource
cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads

# that id, and look up the rest
cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads --auto

# rebuild existing state, no prompt
cdkd import MyStack --force --yes
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stack]` | the only stack | Stack to import. Optional when the app synthesizes exactly one stack. |
| `--resource <id=physical>` | none | Physical id for one logical ID. Repeatable. Limits the import to the listed resources. |
| `--resource-mapping <file>` | none | JSON file of `{logicalId: physicalId}`, the `cdk import` format. |
| `--resource-mapping-inline <json>` | none | The same mapping as a string. |
| `--record-resource-mapping <file>` | none | Write the resolved `{logicalId: physicalId}` map to a file. |
| `--auto` | off | With a mapping, also look up every resource not listed. |
| `--dry-run` | off | Print the import plan and write no state. |
| `--force` | off | Confirm a write that drops or overwrites existing state records. |
| `--migrate-from-cloudformation [name]` | off | Retire the CloudFormation stack: set Retain, write state from the ids the stack then holds, delete the stack (default name: the cdkd stack name). |
| `--use-cdk-bootstrap-assets` | off | Keep CDK bootstrap asset destinations in a cdkd-assets region. |
| `-y`, `--yes` | off | Skip the state-write prompt and the retirement prompt. Required in CI. |

`cdkd import` also takes the common `--app`, `--output`, `--context`,
`--state-bucket`, `--state-prefix`, `--profile`, `--role-arn` and `--verbose`
options described in the [CLI Reference](cli-reference.md).

A prompt that is reached without a terminal does not hang. It fails with
`NON_INTERACTIVE_CONFIRM` and exit code `1`, which is why CI needs `--yes`.

## Which resources a run imports

The flags you pass decide whether cdkd imports only what you name, or
everything it can find.

| You pass | cdkd imports |
| --- | --- |
| No mapping flag | Every resource it can find |
| `--resource`, `--resource-mapping` or `--resource-mapping-inline` | Only the resources you list |
| A mapping flag plus `--auto` | The listed resources by the ids you give, and every other resource by lookup |

The three cases also treat existing state differently. Listing resources
without `--auto` adds them to the state that is already there. The other two
cases rebuild every record from the template, which is why they need
`--force` when state exists.

## `--force`

`--force` is needed only when the import would drop or overwrite a record
that is already in state.

| Situation | `--force` |
| --- | --- |
| The stack has no state yet | Not needed |
| You list resources that are not in state | Not needed; existing records are kept |
| You list a resource that is already in state | Required; that record is overwritten |
| You import everything, or use `--auto`, over existing state | Required; records not imported again are dropped |

### A damaged record blocks an import that adds resources

When you list resources without `--auto`, cdkd copies every record you did
not list into the new state unchanged. It refuses to do that when one of those
records is not a valid resource record: a `null`, a string, or an object with
no `resourceType`. The refusal names the damaged records and exits `1` with
`STATE_RESOURCES_MALFORMED`.

To repair one, list it, so that cdkd replaces it with what AWS reports:

```bash
cdkd import MyStack --resource <logicalId>=<physicalId> --force
```

If the import of that resource fails, cdkd refuses again before saving. An
import of everything and `--migrate-from-cloudformation` rebuild all records
and are not refused. [State Store](state-management.md) describes how
other commands treat a damaged record.

## Read the import plan

Every run prints one row per template resource and a summary, then asks before
it writes state:

```text
Import plan:
  ✓ Uploads5E5E9B2F (AWS::S3::Bucket) (acme-uploads)
  - ResizeFn9A1B2C3D (AWS::Lambda::Function) — not in --resource / --resource-mapping (use --auto to include)

Summary: 1 imported, 0 not found, 0 unsupported, 1 out of scope, 0 failed
```

| Mark | Summary column | Meaning and what to do |
| --- | --- | --- |
| `✓` | imported | cdkd found the resource and will write a state record. |
| `·` | not found | No matching AWS resource. Pass `--resource` for it. |
| `?` | unsupported | cdkd cannot import the type. See [the types that cannot be imported](import.md#cannot-be-imported). |
| `-` | out of scope | You listed other resources and not this one. Add it, or pass `--auto`. |
| `✗` | failed | Looking the resource up or verifying it raised an error. The row gives the reason. |

A physical id whose name the template takes from a secret, such as a
`RoleName` that is a `{{resolve:secretsmanager:...}}` reference, prints as
`***` in the plan, inside an ARN or URL too. The state record keeps the real
id.

An import is not all-or-nothing. After you confirm, cdkd writes state for the
rows marked `✓` and leaves the others out. When no row is marked `✓`, cdkd
writes no state.

## How the lookups can fall short

[How cdkd finds each resource](import.md#how-cdkd-finds-each-resource)
describes the two lookups: by the name the template sets, then in a
CloudFormation stack of the same name. This section covers when each one does
not find a resource. In every case, `--resource` names the resource directly.

### The CloudFormation lookup is skipped or fails

The CloudFormation lookup is skipped when no CloudFormation stack has the
cdkd stack's name. When the call fails, for example because
`cloudformation:DescribeStackResources` is denied or throttled, cdkd warns and
continues with the name lookup alone.

cdkd assumes a CloudFormation stack with the same name belongs to the same
application, and prints the name of the stack it read from.

### Names built from the account or region

A name such as `` `app-${this.account}` `` is not a plain string in the
template. On a stack with no fixed account, it synthesizes to an `Fn::Join`
or `Fn::Sub` over `AWS::AccountId`. cdkd works such a name out before it looks
the resource up, as long as the name is built only from:

- string literals,
- `Fn::Join` and `Fn::Sub`,
- the pseudo-parameters `AWS::AccountId`, `AWS::Region`, `AWS::Partition` and
  `AWS::URLSuffix`.

A name that uses anything else stays unresolved: a `Ref` to a resource or
parameter, `Fn::GetAtt`, `Fn::Select`, `AWS::StackName`, or a
`{{resolve:...}}` reference. The CloudFormation lookup or `--resource` then
has to supply that resource.

cdkd takes the account from `sts:GetCallerIdentity`. It takes the region from
the stack's `env.region`. A stack with no fixed region uses the
[region resolution order](cli-reference-region.md#resolution-order):
`AWS_REGION`, `AWS_DEFAULT_REGION`, your profile's region, then `us-east-1`; the
deprecated `--region` flag, when passed, takes precedence over all of them. A
stack that already has state only in `us-east-1` keeps using it unless you name
a region.

When `sts:GetCallerIdentity` fails and `AWS_ACCOUNT_ID` is unset or is not a
12-digit account id, a name that needs the account stays unresolved. If a
recorded property needs the account too, cdkd warns and records that
resource's properties as the template wrote them, intrinsic functions
included.

## `--record-resource-mapping`

This flag writes the ids cdkd resolved to a JSON file. Run it once where the
lookups work, then replay the file in CI so that the run needs no lookup and
no prompt:

```bash
# writes what cdkd resolved
cdkd import MyStack --record-resource-mapping ./mapping.json

# replays it without prompts
cdkd import MyStack --resource-mapping ./mapping.json --yes
```

cdkd writes the file before the confirmation prompt, so it is also written
when you answer no or pass `--dry-run`.

## `--migrate-from-cloudformation`

[Migrating from `cdk deploy`](import.md#migrating-from-cdk-deploy-cloudformation-to-cdkd)
walks through a migration. The details below matter for a nested, large or
YAML-authored stack.

### Nested stacks

cdkd writes one state file per nested stack:

```text
cdkd/<parent>~<childLogicalId>/<region>/state.json
cdkd/<parent>~<child>~<grandchild>/<region>/state.json
```

It sets Retain on every resource at every depth. Deleting the parent
CloudFormation stack then removes the child stack records with it.

Before it writes any state, cdkd compares the nested stacks in the template
with the ones in AWS. A nested stack that exists on one side only stops the
import with an error that names the logical ID.

### Template size and format

To set Retain, cdkd submits a modified copy of the stack's template to
CloudFormation.

| Template | What happens |
| --- | --- |
| Up to 51,200 bytes | Submitted directly. |
| Larger, up to 1 MB | Uploaded to the state bucket under `cdkd-migrate-tmp/` for the update, then deleted. |
| Over 1 MB | CloudFormation cannot accept it, so cdkd fails before it writes any state. |

A YAML template is supported. Shorthand intrinsic functions (`!Ref`, `!Sub`,
`!GetAtt`) are preserved, and cdkd submits the update as YAML.

### Permissions for the uploaded-template cleanup

The state bucket is versioned, so deleting an uploaded template would leave
its content readable as an earlier version of the object. cdkd therefore
deletes those earlier versions too, which needs `s3:ListBucketVersions` and
`s3:DeleteObjectVersion` on the state bucket.

Without those two permissions the migration still succeeds, and a warning
names them.

The cleanup reaches the state bucket only. If the bucket is replicated, the
template's content survives in the destination bucket, and cdkd warns when it
can read the replication configuration.
[State Store](state-management.md) has a bucket policy that grants both
actions and explains the replication limit.

## `cdkd import` vs upstream `cdk import`

cdkd accepts the same mapping flags as upstream
[`cdk import`](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-import.html),
but works differently underneath. `cdk import` submits one CloudFormation
IMPORT changeset, which either applies in full or rolls back. `cdkd import`
calls each service directly, one resource at a time, and writes state for the
resources that succeeded.

| Topic | `cdk import` | `cdkd import` |
| --- | --- | --- |
| A resource fails | The changeset rolls back | The other resources are still written, after you confirm |
| `--resource-mapping <file>` | Unlisted resources fail the changeset | Same file format; unlisted resources are `out of scope` |
| `--resource-mapping-inline` | Supported | Supported, same JSON shape |
| `--record-resource-mapping` | Writes what you typed at the prompt | Writes what cdkd resolved, even on "no" or `--dry-run` |
| `--resource <id>=<physical>` | Not available | Repeatable |
| Prompt for missing ids | Default in a terminal | None; missing ids are looked up or skipped |
| Mistyped logical ID | Stops before any AWS call | Stops before any AWS call |
| Whole-stack import with no ids | Not supported | The default with no flags |
| `--auto` | Not supported | Supported |
| Nested stacks | Not supported | With `--migrate-from-cloudformation` only |
| Bootstrap | CDK bootstrap v12 or later | cdkd's state bucket; no CDK bootstrap version needed |
| Type coverage | What CloudFormation can import | [These types](import.md#which-resource-types-can-be-imported) |
| Confirmation before writing | Not applicable | Yes; skip with `--yes` |
| `--force` | Continue even if the diff has updates or deletions | Confirm a write that drops or overwrites state records |
| `--dry-run` | Through `--no-execute` | Prints the plan and writes nothing |

If your scripts rely on the upstream behaviour:

- A mapping file or inline mapping works unchanged.
- Replace the interactive prompt with `--resource-mapping <file>`, because
  cdkd does not prompt for ids.
- There is no automatic rollback. To back out of a partial import, run
  `cdkd state orphan MyStack`, which drops the state record only.
- `--force` has the same name and a different meaning.

## Related

- [Import Existing Resources](import.md): the walkthroughs
- [Importing by resource type](import-resource-types.md): the `--resource`
  value for each type
- [After an import](import-after.md): the first diff, the drift baseline, and
  removing a secret from state
- [Import internals](import-internals.md): how the nested-stack migration
  works
