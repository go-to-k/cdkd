---
title: Importing Existing Resources
description: "Adopt already-deployed AWS resources into cdkd state with cdkd import: migrate a CloudFormation-managed stack, adopt hand-made resources, and go back."
---

# Importing Existing Resources

`cdkd import` adopts AWS resources that already exist into cdkd state, so the
next `cdkd deploy` updates them in place instead of trying to create
duplicates. It reads your CDK app for the logical IDs and resource types, finds
the real resource behind each one, and writes a state record for it. It does
not create, change or delete any AWS resource.

```bash
cdkd import MyStack --dry-run                      # preview what would be adopted
cdkd import MyStack --migrate-from-cloudformation  # adopt a cdk deploy stack and retire it
cdkd import MyStack --resource MyBucket=acme-uploads  # adopt one hand-made resource
cdkd import MyStack                                # adopt everything cdkd can find
```

```text diagram=import-ownership
  AWS resources, managed by CloudFormation or by nobody
                        │
                        ▼
  cdkd import          reads each physical id, changes no resource
                        │
                        ▼
  cdkd state           one record per adopted resource
                        │
                        ▼
  CloudFormation       only with --migrate-from-cloudformation:
  stack retired        every resource set to Retain, then DeleteStack
                        │
                        ▼
  Same AWS resources, managed by cdkd
```

The examples assume cdkd reads the CDK app command from `cdk.json`. Pass
`--app "<command>"` when you run cdkd outside the CDK project directory.

## Pick your scenario

| You have | Run | Section |
| --- | --- | --- |
| A stack deployed with `cdk deploy` that cdkd should take over | `cdkd import MyStack --migrate-from-cloudformation` | [Migrating from `cdk deploy`](#migrating-from-cdk-deploy-cloudformation-to-cdkd) |
| One or a few resources created by hand or by another tool | `cdkd import MyStack --resource <logicalId>=<physicalId>` | [Adopt hand-made resources](#adopt-hand-made-resources) |
| A whole stack of existing resources with explicit names | `cdkd import MyStack` | [Adopt every resource cdkd can find](#adopt-every-resource-cdkd-can-find) |
| An import you want to undo | `cdkd state orphan MyStack` or `cdkd export MyStack` | [Go back](#go-back) |

## Migrating from `cdk deploy` (CloudFormation) to cdkd

`--migrate-from-cloudformation` adopts every resource of a
CloudFormation-managed stack into cdkd state and then retires the
CloudFormation stack. The AWS resources are not deleted. You name no physical
ids: cdkd reads them from CloudFormation.

::: steps
1. Preview the import

   ```bash
   cdkd import MyStack --dry-run
   ```

   Without the migration flag, cdkd still reads the physical ids from the
   CloudFormation stack of the same name, and `--dry-run` writes nothing.
   Check that every row of the plan is `✓`. A row that is not would be left
   unmanaged by the migration; see [Read the import plan](#read-the-import-plan).

2. Adopt the stack and retire the CloudFormation stack

   ```bash
   cdkd import MyStack --migrate-from-cloudformation
   ```

   cdkd asks twice: before it writes state, and before it changes the
   CloudFormation stack. `--yes` answers both, and CI needs it because the
   prompts refuse a non-interactive stdin. The run ends with:

   ```text
   ✓ State written: MyStack (us-east-1)
   [1/4] Inspecting CloudFormation stack 'MyStack'...
   [2/4] Injected DeletionPolicy=Retain and UpdateReplacePolicy=Retain.
   [3/4] Updating CloudFormation stack with Retain policies...
   [4/4] Deleting CloudFormation stack 'MyStack' (resources retained)...
   ✓ CloudFormation stack 'MyStack' retired. AWS resources are now solely managed by cdkd.
   ```

3. Compare the adopted state with your template

   ```bash
   cdkd diff MyStack
   ```

   A property that differs between AWS and the template shows as a change the
   next deploy will apply.

4. Deploy with cdkd from now on

   ```bash
   cdkd deploy MyStack
   ```
:::

If the CloudFormation stack is not named like the cdkd stack, pass its name.
The preview in step 1 reads only a stack of the same name, so it cannot
resolve generated names for such a stack.

```bash
cdkd import MyStack --migrate-from-cloudformation LegacyCfnStackName --yes
```

### What the migration does, in order

1. `DescribeStackResources` reads every logical id and physical id from the
   CloudFormation stack. A `--resource` value you pass wins over
   CloudFormation's.
2. Each provider adopts its resource by that physical id.
3. cdkd writes state.
4. `UpdateStack` sets `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`
   on every resource. This is a metadata-only update.
5. `DeleteStack` removes the stack record. Every resource is retained, so
   CloudFormation deletes none of them.

The state write and the retirement run under the same stack lock, so a
concurrent `cdkd deploy` cannot race the migration. State is written before
the CloudFormation stack is touched. If step 4 or 5 fails, cdkd state is
already in place. Run the command again with `--force` (state now exists), or
retire the stack by hand.

### What can go wrong

| Situation | What happens |
| --- | --- |
| A resource could not be imported (no provider, not found) | cdkd warns before retiring. After `DeleteStack` that resource stays in AWS, managed by neither tool. Import it first, or accept that. |
| `--dry-run` together with the flag | Not supported: the stack update and delete cannot be simulated. Use plain `cdkd import --dry-run`. |
| Template over 51,200 bytes | cdkd uploads it to the state bucket under `cdkd-migrate-tmp/` for `UpdateStack` and deletes it afterwards. |
| Template over 1 MB | CloudFormation cannot accept it and cdkd fails. State is already written by then. |
| YAML source template | Supported. Shorthand intrinsics (`!Ref`, `!Sub`, `!GetAtt`) survive, and the update is submitted as YAML. |

### Nested stacks

A CloudFormation stack with `AWS::CloudFormation::Stack` children is migrated
as a tree, to any depth:

- cdkd writes one state file per nested child, at
  `cdkd/<parent>~<childLogicalId>/<region>/state.json`, and one per grandchild
  at `cdkd/<parent>~<child>~<grandchild>/<region>/state.json`.
- Retain is set on every resource at every depth, and deleting the parent
  CloudFormation stack removes the child stack records with it.
- A nested stack in the template with no matching child in AWS, or the
  reverse, stops the import before any state is written and names the logical
  id.

Only the migration flag walks nested stacks. Plain `cdkd import` reports each
`AWS::CloudFormation::Stack` row as `unsupported`. The mechanics are in
[Import internals](import-internals.md#nested-stack-migration).

### Permissions for the uploaded-template cleanup

The state bucket is versioned, so deleting an uploaded template under
`cdkd-migrate-tmp/` would leave its body readable by `VersionId`. cdkd
therefore purges its noncurrent versions too, which needs
`s3:ListBucketVersions` and `s3:DeleteObjectVersion` on the state bucket.

Without those grants the migration still succeeds and a warning names the two
permissions. The purge reaches the state bucket only: on a replicated bucket
the template body survives in the destination, and cdkd warns when it can read
the replication configuration. [State Management](state-management.md) has a
bucket policy that grants both actions and explains the replication limit.

## Adopt hand-made resources

Use `--resource` when a few resources already exist (a bucket someone made in
the console, a queue another tool created) and the rest of the stack does not.
Only the resources you list are imported.

::: steps
1. Declare the resource in your CDK app

   ```ts
   import * as cdk from 'aws-cdk-lib';
   import * as s3 from 'aws-cdk-lib/aws-s3';

   new s3.Bucket(this, 'Uploads', {
     bucketName: 'acme-uploads',
     removalPolicy: cdk.RemovalPolicy.RETAIN,
   });
   ```

2. Find its logical ID

   The key cdkd expects is the logical ID in the synthesized template, such as
   `Uploads5E5E9B2F`. Run `cdkd synth` and read it from the template in
   `cdk.out/`.

3. Preview, then import

   ```bash
   cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads --dry-run
   cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads
   ```

   A key that is not a logical ID in the template stops the run before any AWS
   call.

4. Review and deploy

   ```bash
   cdkd diff MyStack     # resources you did not list show as to create
   cdkd deploy MyStack
   ```
:::

Every resource you did not list is reported as `out of scope` and left out of
state, so the next `cdkd deploy` creates it. This matches
`cdk import --resource-mapping`.

When the stack already has state, the listed resources are merged into it and
the entries already there are kept. `--force` is needed only when a listed
resource is already in state and would be overwritten.

### Several resources, or a mapping file

```bash
# --resource is repeatable
cdkd import MyStack \
  --resource Uploads5E5E9B2F=acme-uploads \
  --resource ResizeFn9A1B2C3D=acme-resize

# The same mapping as a JSON file: { "Uploads5E5E9B2F": "acme-uploads" }
cdkd import MyStack --resource-mapping mapping.json

# Or inline, for a CI script that does not want a file
cdkd import MyStack --resource-mapping-inline '{"Uploads5E5E9B2F":"acme-uploads"}'
```

`--resource-mapping` and `--resource-mapping-inline` are mutually exclusive.

### Composite physical ids need quoting

Some types are identified by several segments joined with `|`, and that
composite is the value `--resource` expects. It is also what `cdkd state show`
and `cdkd state resources` print, and it is not always the id CloudFormation
shows. Quote it, because an unquoted `|` is the shell pipe:

```bash
cdkd import MyStack \
  --resource 'EventsTable7C1D2E3F=analytics_db|events' \
  --resource 'GetMethod4B5C6D7E=a1b2c3d4e5|xy9z8w|GET'
```

No escaping is needed inside a `--resource-mapping` JSON file. The shapes are
listed per type under [Which resource types can be imported](#provider-coverage),
and the full format table is in [State Management](state-management.md).

## Adopt every resource cdkd can find

With no `--resource` flag, cdkd tries to import every resource in the
template:

```bash
cdkd import MyStack --dry-run
cdkd import MyStack
```

This is also how you adopt a `cdk deploy` stack while leaving its
CloudFormation stack in place. Both tools then hold a record of the same
resources, so use it for a preview or as a step towards
`--migrate-from-cloudformation`.

When the stack already has state, this mode rebuilds the whole resource map
from the template and needs `--force`.

### How cdkd finds each resource

```text diagram=import-resolution
  --resource or a mapping file names it      used as given, in every mode
            │ not named
            ▼
  The template sets a name property          BucketName, RoleName, TopicName
            │ no match
            ▼
  A CloudFormation stack of the same         DescribeStackResources supplies
  name exists                                the physical id
            │ no match
            ▼
  Reported as not found                      pass --resource and run again
```

The lookups below the first row run in auto and hybrid mode. In a selective
import, a resource you did not list is out of scope and is not looked up.

The CloudFormation lookup is what resolves a name CloudFormation generated,
which is the usual CDK shape. It is best-effort: with no stack of that name it
is skipped, and if the call fails (no `cloudformation:DescribeStackResources`
permission, throttling) cdkd warns and continues with the name lookup alone.
cdkd assumes a CloudFormation stack with this stack's name is the same
application, and prints the name of the stack it read from.

There is no lookup by the `aws:cdk:path` tag. AWS resources do not carry that
tag: CloudFormation keeps the construct path in template metadata. A CDK app
that sets no explicit names and has no CloudFormation stack of the same name
must use `--resource`.

### Auto-resolve the rest: `--auto`

`--auto` combines explicit ids with the lookups. Listed resources use the id
you give, and every other resource goes through the lookups above. Use it when one resource cannot
be found automatically:

```bash
cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads --auto
```

| Mode | Flags | Imports | Existing state |
| --- | --- | --- | --- |
| Auto | none | Every resource cdkd can find | Rebuilt; needs `--force` |
| Selective | `--resource`, `--resource-mapping`, `--resource-mapping-inline` | Only the listed resources | Merged; `--force` only to overwrite a listed entry |
| Hybrid | the above plus `--auto` | Listed ids as given, the rest by lookup | Rebuilt; needs `--force` |

### Names built from the account or region

A name such as `` `app-${this.account}` `` on an environment-agnostic stack
synthesizes to an `Fn::Join` or `Fn::Sub` over `AWS::AccountId`. cdkd resolves
such a name before the lookup when it is built only from string literals,
`Fn::Join`, `Fn::Sub` and the pseudo-parameters `AWS::AccountId`,
`AWS::Region`, `AWS::Partition` and `AWS::URLSuffix`.

The account comes from `sts:GetCallerIdentity`. The region is the stack's
`env.region`; an environment-agnostic stack takes `AWS_REGION`, then
`us-east-1` (the deprecated `--region` flag, when passed, wins over both).
That is not the profile's region, so set `AWS_REGION` when the resources live
elsewhere.

Anything else in the name leaves it unresolved: a `Ref` to a resource or
parameter, `Fn::GetAtt`, `Fn::Select`, `AWS::StackName`, or a `{{resolve:...}}`
reference. The CloudFormation lookup or `--resource` then adopts that
resource.

When `sts:GetCallerIdentity` fails and `AWS_ACCOUNT_ID` is unset or not a
12-digit account id, names that need the account stay unresolved. If a
recorded property needs the account too, cdkd warns and records that
resource's properties as the template wrote them, intrinsics included.

### Save the resolved mapping for CI

```bash
cdkd import MyStack --record-resource-mapping ./mapping.json   # writes what cdkd resolved
cdkd import MyStack --resource-mapping ./mapping.json --yes    # replays it without prompts
```

The file is written before the confirmation prompt, and also when you answer
no or pass `--dry-run`.

## Go back

Import writes only cdkd state, so undoing it is a state operation.

| You want to | Run | Effect |
| --- | --- | --- |
| Drop the whole imported record | `cdkd state orphan MyStack` | Removes the state record. AWS resources stay. |
| Drop one imported resource | `cdkd state orphan MyStack --resource Uploads5E5E9B2F` | Removes that record and rewrites references to it. |
| Hand the stack back to CloudFormation | `cdkd export MyStack` | Imports the resources into a CloudFormation stack and deletes cdkd state. |

If you imported without `--migrate-from-cloudformation`, the CloudFormation
stack is still there and still manages the resources, so
`cdkd state orphan MyStack` returns you to where you started.

After a migration the CloudFormation stack is gone. Orphaning then leaves the
resources managed by nobody. To return them to CloudFormation use
[`cdkd export`](cli-export.md); [Exporting to CloudFormation](export.md)
covers the types CloudFormation cannot import and Custom Resources.

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
| `--force` | off | Confirm a write that drops or overwrites existing state entries. |
| `--migrate-from-cloudformation [name]` | off | After the state write, retire the CloudFormation stack (default name: the cdkd stack name). |
| `--use-cdk-bootstrap-assets` | off | Keep CDK bootstrap asset destinations in a cdkd-assets region. |
| `-y`, `--yes` | off | Skip the state-write prompt and the retirement prompt. Required in CI. |

`cdkd import` also takes the common `--app`, `--output`, `--context`,
`--state-bucket`, `--state-prefix`, `--profile`, `--role-arn` and `--verbose`
options described in the [CLI Reference](cli-reference.md).

Both prompts refuse a non-interactive stdin with `NON_INTERACTIVE_CONFIRM`
(exit `1`) instead of hanging, which is why CI needs `--yes`.

### `--force`

`--force` is needed only when the import would lose state:

| Situation | `--force` |
| --- | --- |
| No existing state | Not needed |
| Selective import that only adds resources | Not needed; existing entries are kept |
| Selective import of a resource already in state | Required; that entry is overwritten |
| Auto or hybrid import over existing state | Required; entries not re-imported are dropped |

A selective merge copies every unlisted entry as it stands. It therefore
refuses an existing record that holds an unlisted row that is not a resource
record (`null`, a string, or an object with no `resourceType`), naming the
rows (`STATE_RESOURCES_MALFORMED`, exit `1`).

To repair one broken row, list it:
`cdkd import MyStack --resource <id>=<physicalId> --force` replaces that row
from the provider's answer. If the import of that row fails, cdkd refuses
again before saving. Auto imports and `--migrate-from-cloudformation` rebuild
the whole map and are not refused. See [State Management](state-management.md)
for the per-command behaviour.

## Read the import plan

Every run prints one row per template resource and a summary, then asks before
writing state:

```text
Import plan:
  ✓ Uploads5E5E9B2F (AWS::S3::Bucket) (acme-uploads)
  - ResizeFn9A1B2C3D (AWS::Lambda::Function) — not in --resource / --resource-mapping (use --auto to include)

Summary: 1 imported, 0 not found, 0 unsupported, 1 out of scope, 0 failed
```

| Mark | Summary column | Meaning | What to do |
| --- | --- | --- | --- |
| `✓` | imported | Found; a state record will be written | Nothing |
| `·` | not found | No matching AWS resource | Pass `--resource` for it |
| `?` | unsupported | No provider, or the provider cannot import the type | See [Unsupported](#unsupported) |
| `-` | out of scope | Not listed in a selective import | Add it, or pass `--auto` |
| `✗` | failed | The lookup or verification raised an error | Read the reason on the row |

The import is not atomic. State is written for the rows that succeeded, after
you confirm. With no imported row, no state is written.

## After import

Run `cdkd diff MyStack`. Properties that differ between AWS and the template
show as changes the next `cdkd deploy` applies, and resources you did not
import show as `to create`.

If the stack still has a rollback journal from a failed deploy, the import
marks each resource it adopts on that journal before it writes state. A later
`cdkd rollback` then runs none of the journal's existing operations for those
logical ids, and warns about an operation that recorded a different resource
under the id. Operations a later deploy adds are still reverted. If the import
cannot read or write the journal, it refuses and writes no state. See
[`cdkd rollback`](cli-rollback.md).

An import done by a cdkd binary that predates this marking writes no mark, so
a later rollback still acts on those operations. Run the import again with a
current binary and `--force` first.

## The drift baseline an import records

For each adopted resource, cdkd reads its current AWS state and records it as
the drift baseline (`observedProperties`), so the first `cdkd drift` has
something to compare against. The baseline is a copy of what AWS holds, which
makes two things worth knowing.

> [!WARNING]
> Treat an imported `state.json` as sensitive. The redaction below is
> positional, so a reference cdkd could not line up against the readback can
> still leave a decrypted value in the record.

### Secret references are written back over the decrypted value

A property your template declares as a `{{resolve:secretsmanager:...}}`
reference comes back from AWS decrypted. cdkd writes the reference back over
it, by position.

Where the readback and the record cannot be lined up at such a position, cdkd
writes the mask `***` there. `cdkd drift` reports a masked position as not
compared (exit `2`) while the mask is the only difference, and as drift that
`--accept` refuses if anything else there changed. A masked position also
clears on a deploy that changes nothing, where the resource's own secret
references can certify it. [`cdkd drift`](cli-drift.md) lists the shapes that
reach the mask.

### Resources that get no baseline

cdkd skips the capture, and says so at `--verbose`, when it cannot place the
redaction safely:

| Cause | Recorded reason | How it clears |
| --- | --- | --- |
| The recorded properties no longer spell the template's dynamic reference, or resolution discarded part of the template (such as the untaken branch of an `Fn::If` an import cannot bind) | `incomplete-resolution` | Deploy a change to the resource, or re-import it |
| The resource depends on a template parameter whose deployed value cdkd cannot prove equal to its `Default` | `unverifiable-parameter` | Replace the resource, or re-import it against a CloudFormation stack that proves the value |

For such a resource:

- `cdkd drift` compares against the recorded properties instead, which can
  show as phantom drift, and `cdkd drift --accept` / `--revert` decline it.
- `cdkd state show` prints an `ObservedBaseline: REFUSED` line.
- The refusal is recorded on the resource (`observedBaselineRefused`). Every
  command that would otherwise fill the baseline honours it: the refresh at
  the start of a deploy, `cdkd state refresh-observed`, `cdkd drift --accept`
  and `--revert`, and a later import that leaves the resource in place.
- When a selective import refuses a resource it leaves in place, it also
  removes any baseline an earlier run recorded for it.

For an `incomplete-resolution` refusal, a create, update or replacement of the
resource rebuilds the record from your template and captures a real baseline.
Re-importing the resource does too. A deploy with no change to the resource
does not, and neither does `cdkd state refresh-observed`.

### Parameters deployed with a non-default value

`cdkd import` takes no parameter values, so every template parameter is
recorded at its `Default`. When a CloudFormation stack backs the import, cdkd
reads that stack's deployed parameter values with `DescribeStacks` and
compares them with what it bound. The backing stack is the
`--migrate-from-cloudformation` source and each of its nested children, or, on
any other import, a CloudFormation stack with the cdkd stack's name.

A parameter cdkd cannot prove equal is one of:

- a different deployed value;
- a value deployed as a `{{resolve:...}}` reference over a placeholder
  `Default`;
- any `NoEcho` parameter, since CloudFormation returns `****` for it.

Every resource whose properties depend on such a parameter (through `Ref`,
`Fn::Sub`, a condition) loses its baseline, as does every resource that reads
an attribute of one with `Fn::GetAtt`, and any resource cdkd cannot check for
the dependence. cdkd warns once per stack, naming the parameters. The deployed
values are only compared, never recorded or logged.

The lookup needs `cloudformation:DescribeStacks`. Without it the import still
succeeds, warns, and treats every parameter as unproven. A template in which
nothing references a declared parameter makes no such call (CDK's own
`BootstrapVersion` is referenced only by `Rules`, so it does not count). When
no CloudFormation stack of that name exists, there is nothing to compare and
the import is unchanged.

> [!IMPORTANT]
> The recorded properties of such a resource hold the template `Default`, not
> what was deployed. A deploy that rewrites the property sends that `Default`
> to AWS. Before deploying, put the real value in the template (replace the
> parameter with the `{{resolve:...}}` reference, or make it the parameter's
> `Default`) and review `cdkd diff`.

Deploying a change does not clear this refusal. `cdkd deploy` binds the same
`Default`, an update that leaves the parameter-bound property alone does not
rewrite it, and a baseline captured afterwards would record the deployed
value. An in-place update therefore keeps the refusal and reads nothing back.
There are two ways out:

- A deploy replaces the resource (or deletes and creates it again). The new
  resource is built from the properties cdkd sent and gets a normal baseline.
- A later `cdkd import` re-imports it while a CloudFormation stack can prove
  the parameter was deployed at its `Default`. After
  `--migrate-from-cloudformation` that stack is gone, so a re-import carries
  the refusal forward when the physical id is unchanged.

Editing the template so nothing references the parameter does not clear it: a
re-import clears the refusal only by proving the parameter.

### Stacks imported with cdkd 0.290.35

That version recorded a refusal without its reason, and cdkd 0.290.35 and
0.290.36 both clear a marker that has no reason. If a stack imported with
0.290.35 has since had one of these resources updated by either version, the
deployed parameter value may be in `state.json`. Rotate the secret, then
follow [Import internals](import-internals.md#stacks-imported-with-cdkd-0-290-35).

### A value your template never references is recorded as AWS holds it

The redaction acts only where the template spells a `{{resolve:...}}`
reference. A value with no reference in the template has nothing to be written
back, so the baseline records it exactly as AWS returned it. This is by
design: the baseline records what AWS holds, changes made outside cdkd
included, so that `cdkd drift` can report them. A secret set out of band can
reach `state.json` this way:

- a property the template declares as a placeholder literal (`CHANGEME`) whose
  real value an operator later set in the console or through an API call;
- a field or list element AWS reports that has no counterpart in the
  template, even inside a property that does carry a reference (where a
  reference in that property is left unpaired, the position may be masked as
  `***` instead);
- for a resource imported through the
  [Cloud Control API fallback](#cloud-control-api-fallback), every property in
  the model `GetResource` returns, including the ones the template never sets.

CloudFormation behaves the same way for a property the template sets: its
drift detection reports the actual value (`ActualProperties` in
`DescribeStackResourceDrifts`), leaving out only a value the service never
returns. cdkd's baseline also records the properties the template never sets,
and keeps the baseline in `state.json`.

So `state.json` is sensitive by construction. Limit who can read the state
bucket (see [State Management](state-management.md)). `cdkd drift` prints such
a value when it differs from the baseline, and `cdkd state show` prints a
record's `attributes`, so a drift report or a `state show` listing in a CI log
is another copy.

[`cdkd scrub`](cli-scrub.md) does not find such a value. It recognises a
secret only through a reference the template spells, so
`cdkd scrub --dry-run --fail` reports the record clean. Treat a value ever
stored this way as exposed.

#### Remove such a value

::: steps
1. Rotate it through a reference

   Store the new value in Secrets Manager, write
   `{{resolve:secretsmanager:...}}` at that property in the template, and
   deploy. The update sends the new value to AWS and the next baseline records
   the reference. Confirm with:

   ```bash
   cdkd scrub MyStack --dry-run --fail
   ```

   Rotating in the console instead sets another out-of-band value, which the
   next readback records in turn.

2. Where the template has no property to put a reference on

   For a field AWS added, or a key of a Cloud Control model, no cdkd command
   removes the value in place. Rotate it at its source first, then follow the
   table below. Also check any stack output that publishes the value: it is
   stored in the stack's `outputs` and, for an exported output, in the
   region's exports index.

3. Purge the earlier S3 versions, last

   ```bash
   cdkd scrub MyStack --purge-history
   ```

   This purges the earlier versions of every `state.json` it examines,
   including one it does not rewrite. It does not purge the exports index's
   earlier versions unless the same run rewrote that index; see
   [what that purge does not reach](cli-scrub.md#what-a-real-run-removes-and-what-it-cannot).
:::

| Where the value sits | How to remove it |
| --- | --- |
| A nested field or list element inside a property | Remove it from the AWS resource, then run `cdkd state refresh-observed MyStack` or `cdkd drift MyStack --accept`. |
| A top-level key | Remove it from the AWS resource, or delete that key from the record's `observedProperties` in `state.json` by hand. |
| A Cloud Control resource's `attributes` | Also delete the key from `attributes` by hand; neither command rewrites them. |

Do not hand-edit a nested field out of `observedProperties`: drift compares
nested fields against what AWS returns, so every later `cdkd drift` would
report it and print the value. For a top-level key, delete only that key and
not the whole bag, which any `cdkd deploy` refills from AWS.

A hand edit lasts only until cdkd next reads the resource back while AWS still
holds the value: a deploy that updates it, `cdkd state refresh-observed`, or
`cdkd drift --accept`. An edit to `attributes` lasts until the next deploy
that updates the resource writes the whole model back.

## Importing a stack into a cdkd-assets region

In a region opted into cdkd-owned asset storage (`cdkd bootstrap`), cdkd
rewrites the template's asset references (Lambda `Code`, container image URIs,
the IAM grants CDK generates on the asset bucket) from the CDK bootstrap
locations (`cdk-<qualifier>-assets-*`) to the cdkd-owned ones
(`cdkd-assets-*`).

The resources you adopt still hold the CDK bootstrap values, so cdkd records
those in state and prints an info line with the count. As a result:

- The first `cdkd diff` after the import shows a change for every rewritten
  reference, and the first `cdkd deploy` repoints the live resources at cdkd
  asset storage.
- That deploy is required. Without it, an `AWS::IAM::Policy` that grants read
  on the asset bucket (what `s3deploy.BucketDeployment` generates) keeps
  granting the CDK bootstrap bucket while the custom resource reads from the
  cdkd bucket, and fails at runtime with `AccessDenied`.

To stay on the CDK bootstrap destinations, with no rewrite and no post-import
change, pass `--use-cdk-bootstrap-assets` or set
`context.cdkd.useCdkBootstrapAssets` in `cdk.json`.

## Provider coverage

Whether a resource type can be imported, and what you must pass for it,
depends on its type. Search this section for your type.

| Group | What you pass |
| --- | --- |
| [Auto-resolved](#auto-resolved-no-resource-flag-needed) | Nothing, when the template names the resource or a CloudFormation stack of the same name exists |
| [Override-only](#override-only) | `--resource <logicalId>=<physicalId>`, unless a CloudFormation stack of the same name supplies the id |
| [Cloud Control API fallback](#cloud-control-api-fallback) | `--resource` for any other type Cloud Control supports |
| [Unsupported](#unsupported) | Cannot be imported |

### Auto-resolved (no `--resource` flag needed)

These types resolve in auto and hybrid mode without `--resource`, by the
[lookups above](#how-cdkd-finds-each-resource).

| Service | Types |
| --- | --- |
| ACM | `AWS::CertificateManager::Certificate` |
| API Gateway v2 | `AWS::ApiGatewayV2::Api` |
| AppSync | `AWS::AppSync::GraphQLApi` |
| Budgets | `AWS::Budgets::Budget` |
| CloudFront | `AWS::CloudFront::Distribution` |
| CloudTrail | `AWS::CloudTrail::Trail` |
| CloudWatch, Logs | `AWS::CloudWatch::Alarm`, `AWS::Logs::LogGroup` |
| CodeBuild, CodeCommit | `AWS::CodeBuild::Project`, `AWS::CodeCommit::Repository` |
| Cognito | `AWS::Cognito::UserPool` |
| DLM | `AWS::DLM::LifecyclePolicy` |
| DocumentDB | `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`, `AWS::DocDB::DBSubnetGroup` |
| DynamoDB | `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` |
| EC2 | `AWS::EC2::VPC`, `AWS::EC2::Subnet`, `AWS::EC2::SecurityGroup`, `AWS::EC2::NatGateway`, `AWS::EC2::EIP`, `AWS::EC2::InternetGateway`, `AWS::EC2::RouteTable`, `AWS::EC2::NetworkAcl`, `AWS::EC2::Instance` |
| ECR, ECS | `AWS::ECR::Repository`, `AWS::ECS::Cluster`, `AWS::ECS::Service`, `AWS::ECS::TaskDefinition` |
| EFS, FSx | `AWS::EFS::FileSystem`, `AWS::EFS::AccessPoint`, `AWS::FSx::FileSystem` |
| ElastiCache | `AWS::ElastiCache::CacheCluster`, `AWS::ElastiCache::SubnetGroup` |
| ELB v2 | `AWS::ElasticLoadBalancingV2::LoadBalancer`, `AWS::ElasticLoadBalancingV2::TargetGroup` |
| EMR | `AWS::EMR::Cluster` |
| EventBridge, Pipes | `AWS::Events::EventBus`, `AWS::Events::Rule`, `AWS::Pipes::Pipe` |
| Glue | `AWS::Glue::Database`, `AWS::Glue::Table`, `AWS::Glue::Job`, `AWS::Glue::Crawler`, `AWS::Glue::Connection`, `AWS::Glue::Trigger`, `AWS::Glue::Workflow`, `AWS::Glue::SecurityConfiguration` |
| IAM | `AWS::IAM::Role`, `AWS::IAM::ManagedPolicy`, `AWS::IAM::InstanceProfile`, `AWS::IAM::User`, `AWS::IAM::Group` |
| Kinesis, Firehose | `AWS::Kinesis::Stream`, `AWS::Kinesis::StreamConsumer`, `AWS::KinesisFirehose::DeliveryStream` |
| KMS | `AWS::KMS::Key`, `AWS::KMS::Alias` |
| Lambda | `AWS::Lambda::Function`, `AWS::Lambda::LayerVersion` |
| Neptune | `AWS::Neptune::DBInstance`, `AWS::Neptune::DBCluster`, `AWS::Neptune::DBSubnetGroup` |
| RDS | `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::RDS::DBProxy`, `AWS::RDS::DBProxyEndpoint`, `AWS::RDS::DBSubnetGroup` |
| Route 53 | `AWS::Route53::HostedZone` |
| S3 | `AWS::S3::Bucket`, `AWS::S3Express::DirectoryBucket`, `AWS::S3Tables::TableBucket`, `AWS::S3Vectors::VectorBucket` |
| Secrets Manager, SSM | `AWS::SecretsManager::Secret`, `AWS::SSM::Parameter` |
| Service Discovery | `AWS::ServiceDiscovery::Service`, `AWS::ServiceDiscovery::PrivateDnsNamespace`, `AWS::ServiceDiscovery::HttpNamespace`, `AWS::ServiceDiscovery::PublicDnsNamespace` |
| SNS, SQS | `AWS::SNS::Topic`, `AWS::SQS::Queue` |
| Step Functions | `AWS::StepFunctions::StateMachine` |
| WAF v2 | `AWS::WAFv2::WebACL` |

`AWS::BedrockAgentCore::Browser` and `AWS::BedrockAgentCore::CodeInterpreter`
are adopt-only singletons for the AWS-managed defaults. Their import is a live
lookup (`GetBrowser` / `GetCodeInterpreter`) and needs no `--resource`.

Some of these types accept more than one id form when you do pass
`--resource`:

| Type | `--resource` value |
| --- | --- |
| `AWS::SSM::Parameter` | The parameter name only. An ARN or a `name:version` / `name:label` selector is refused, naming the value to pass. |
| `AWS::EC2::EIP` | An `eipalloc-...` allocation id, a public IP, or `<publicIp>\|<allocationId>`; cdkd stores the composite. |
| `AWS::EC2::InternetGateway` | The `igw-...` id. |
| `AWS::EC2::RouteTable` | The `rtb-...` id. |
| `AWS::EC2::NetworkAcl` | The `acl-...` id. |
| `AWS::EC2::Instance` | The `i-...` id. A terminated or shutting-down instance is not adopted. |
| `AWS::ECS::Service` | The service ARN (the form cdkd stores), or `<clusterArn>\|<serviceName>`. |
| `AWS::Glue::Table` | `<databaseName>\|<tableName>`, or CloudFormation's bare table name paired with the template's `DatabaseName`. See below. |
| `AWS::Pipes::Pipe` | The pipe name. The template `Name` resolves it without a flag. |
| `AWS::Budgets::Budget` | The template `Budget.BudgetName` resolves it without a flag. |
| `AWS::EMR::Cluster` | The cluster id `j-XXXX`. |

An SSM parameter ARN or selector is refused because `GetParameter` accepts
those forms while `PutParameter` and `DeleteParameter` reject them, so
adopting one would break the next deploy and destroy.

#### `AWS::Glue::Table`

The id is stored and displayed as `<databaseName>|<tableName>`. A table or
database name that itself contains `|` is adopted when it is paired with the
template's own `DatabaseName`, either way round. An id with a `|` is also
tried as a whole table name in the template's database, and when more than one
reading names an existing table the import refuses rather than guess.

#### `AWS::Route53::HostedZone`

The zone is resolved from the template's `Name` with `ListHostedZonesByName`.

- **Split-horizon names.** When a public and a private zone share the name,
  the template's own `VPCs` picks the side. A name that is still ambiguous is
  reported as a failed row naming `--resource <logicalId>=<hostedZoneId>`, not
  as not found.
- **Attributes.** The adopted row records the same `Id` and `NameServers`
  attributes a deploy records, so `Fn::GetAtt <Zone>.NameServers` (and the
  `Fn::Join` CDK's `zone.hostedZoneNameServers` emits) resolves on an imported
  zone. A zone with no delegation set records the empty list.
- **When the delegation-set read fails.** On the auto-resolved path it costs
  one extra `GetHostedZone` and is best-effort: the zone is still adopted,
  with a warning, and attributes already in state are kept. With `--resource`
  there is no extra call, so a denied `GetHostedZone` fails that row.

A plain `cdkd deploy` does not repair missing attributes, because an unchanged
zone is not updated. Run the import again for that row with `--force`, or make
a template change that updates the zone.

### Override-only

These types have nothing cdkd can look up by name: they have no standalone
identity, belong to a parent, or are a link between two other resources. Pass
the physical id with `--resource`, `--resource-mapping` or
`--resource-mapping-inline`. Under `--migrate-from-cloudformation`, or with
`--auto` and a CloudFormation stack of the same name, CloudFormation supplies
the id.

#### No name or list API

| Type | `--resource` value and notes |
| --- | --- |
| `AWS::IAM::Policy` | Inline policy. |
| `AWS::IAM::AccessKey` | The `AKIA...` id, verified with `GetAccessKeyLastUsed`. See below. |
| `AWS::CloudWatch::AnomalyDetector` | Any stable id. cdkd derives the descriptor-based id on the next replacement. |
| `AWS::Scheduler::Schedule` | The template `Name` and `GroupName` also resolve it without a flag. |
| `AWS::CloudFormation::WaitConditionHandle` | Recorded as given; a placeholder is used when you pass none. |
| `AWS::ApiGateway::Account` | Any id, recorded without an AWS call. |
| `AWS::CloudFront::OriginAccessControl` | The `E...` id, verified with `GetOriginAccessControl`. |

Also in this group, with the physical id as the value: `AWS::IAM::UserToGroupAddition`.

An imported `AWS::IAM::AccessKey` has no cached `SecretAccessKey`, because IAM
returns it only from `CreateAccessKey`. `Fn::GetAtt [<key>, SecretAccessKey]`
cannot resolve for an imported key; replace the key if the secret is needed.

`AWS::ApiGateway::Account` is one per account and region with no id of its
own. A deploy records `ApiGatewayAccount`, and `cdkd destroy` clears the
region's `CloudWatchRoleArn`. For a `WaitConditionHandle`, CloudFormation's
pre-signed-URL physical id is recorded during `--migrate-from-cloudformation`.

#### Sub-resources of a parent

| Type | `--resource` value and notes |
| --- | --- |
| `AWS::ApiGateway::Method` | `<restApiId>\|<resourceId>\|<httpMethod>` |
| `AWS::AppSync::DataSource` | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | `<apiId>\|<typeName>\|<fieldName>` |
| `AWS::AppSync::ApiKey` | `<apiId>\|<apiKeyId>` |
| `AWS::S3Tables::Namespace` | `<tableBucketARN>\|<namespaceName>` |
| `AWS::S3Tables::Table` | `<tableBucketARN>\|<namespace>\|<name>` |
| `AWS::Route53::RecordSet` | `<hostedZoneId>\|<name>\|<type>`; `<name>` exactly as the template spells it (CDK emits a trailing dot). |
| `AWS::EC2::Route` | `<routeTableId>\|<destination>`; the IPv4 CIDR, IPv6 CIDR or prefix-list id. CloudFormation's id has the same shape. |
| `AWS::EC2::NetworkAclEntry` | `<networkAclId>\|<ruleNumber>\|<egress>`. See below. |
| `AWS::EC2::SecurityGroupIngress` | The `sgr-...` rule id. See below. |

Also in this group, with the physical id as the value: `AWS::ApiGateway::Authorizer`,
`AWS::ApiGateway::Resource`, `AWS::ApiGateway::Deployment`,
`AWS::ApiGateway::Stage`, `AWS::ApiGatewayV2::Stage`,
`AWS::ApiGatewayV2::Integration`, `AWS::ApiGatewayV2::Route`,
`AWS::ApiGatewayV2::Authorizer`, `AWS::AppSync::GraphQLSchema`,
`AWS::ElasticLoadBalancingV2::Listener`, `AWS::EFS::MountTarget`,
`AWS::RDS::DBProxyTargetGroup`.

For the two S3 Tables types, only the parent `AWS::S3Tables::TableBucket`
auto-resolves.

`AWS::EC2::NetworkAclEntry`: CloudFormation's id for an entry is a generated
name that carries no AWS information. With that id, cdkd locates the entry
from the template's `NetworkAclId`, `RuleNumber` and `Egress`, which needs the
parent ACL's id resolved too. Pass the ACL's own `--resource` as well, or add
`--auto` so a CloudFormation stack of the same name supplies it.

`AWS::EC2::SecurityGroupIngress`: the `sgr-...` rule id is CloudFormation's
identifier for the type and the id the EC2 console shows. cdkd verifies it
with `DescribeSecurityGroupRules`, declines an egress rule id, and records its
own composite `<groupId>|<ipProtocol>|<fromPort>|<toPort>` as the physical id
plus the rule id as the `Id` attribute. The composite is not accepted here,
because the same tuple can name several rules.

#### Attachments and links

| Type | `--resource` value and notes |
| --- | --- |
| `AWS::Lambda::Permission` | The bare statement id. The older `<functionArn>\|<statementId>` form is also read. |
| `AWS::Lambda::EventInvokeConfig` | `<functionName>\|<qualifier>`; a bare function name means qualifier `$LATEST`. |
| `AWS::EC2::SubnetRouteTableAssociation` | The `rtbassoc-...` association id. |
| `AWS::EC2::SubnetNetworkAclAssociation` | The `aclassoc-...` association id. |
| `AWS::EC2::VPCGatewayAttachment` | `<internetGatewayId>\|<vpcId>`, or CloudFormation's `IGW\|<vpcId>`. Internet gateways only. |
| `AWS::BedrockAgentCore::Runtime` | The runtime ARN. |
| `AWS::BedrockAgentCore::Evaluator` | The evaluator ARN or bare id; an id is resolved to the ARN with `GetEvaluator`. |
| `AWS::Lambda::MicrovmImage` | The image ARN. A bare name is rejected. |

Also in this group, with the physical id as the value: `AWS::SNS::Subscription`,
`AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy`, `AWS::S3::BucketPolicy`,
`AWS::Lambda::EventSourceMapping`, `AWS::Lambda::Url`,
`AWS::CloudFormation::CustomResource`,
`AWS::CloudFront::CloudFrontOriginAccessIdentity`.

For `AWS::EC2::VPCGatewayAttachment` given as `IGW|<vpcId>`, the gateway comes
from the template's `InternetGatewayId`, or else from the one gateway attached
to that VPC. A VPN gateway attachment is not adopted.

### Cloud Control API fallback

A type in none of the tables above can be imported with
`--resource <logicalId>=<physicalId>` when Cloud Control API supports it. cdkd
runs no automatic lookup over Cloud Control, because that would cost one
`ListResources` call per type.

```bash
cdkd import MyStack --resource 'VpcIpv6Cidr=vpc-cidr-assoc-0abc123|vpc-0def456'
```

Such a resource's state record says `provisionedBy: cc-api`, as a deploy
records it, so later deploys, drift and destroy keep it on Cloud Control.

#### Composite identifiers

When a type's schema `primaryIdentifier` has more than one field, Cloud
Control identifies the resource by the field values joined with `|`
(`AWS::EC2::VPCCidrBlock` is `<Id>|<VpcId>`), and cdkd records that value as
the physical id.

CloudFormation's physical id for such a resource is often one field only (the
bare `vpc-cidr-assoc-...` for a VPCCidrBlock). Under
`--migrate-from-cloudformation`, or with a bare `--resource` value, cdkd
builds the rest from the template's own values for the other fields, after
substituting `Ref`s to other imported resources. This needs
`cloudformation:DescribeType`. When the template does not supply exactly the
other fields as literal values, the import of that resource fails and names
the composite to pass, for example `--resource 'VpcIpv6Cidr=<Id>|<VpcId>'`.

#### What lands in `attributes`

Cloud Control's `GetResource` returns the resource's whole model. cdkd keeps
in `attributes` only the type's schema-declared `readOnlyProperties`, which is
what CloudFormation allows `Fn::GetAtt` to read. Every other model key is
recorded as the mask `***`, so a later `Fn::GetAtt` on it is refused by name
instead of resolving to something wrong.

This needs `cloudformation:DescribeType` (one call per resource type, cached
for the run). Without it cdkd masks the whole model and warns. An `Fn::GetAtt`
against such a resource then fails until that resource is next created or
updated by a deploy. The direct remedy is to grant the permission and run
`cdkd import` again.

The narrowing does not make the record safe to treat as non-sensitive:

- A credential that is itself a read-only attribute is still recorded in the
  clear. The registry schema has no general sensitivity marking.
- It applies to `attributes` only. The drift baseline in `observedProperties`
  is the whole model (see
  [A value your template never references](#a-value-your-template-never-references-is-recorded-as-aws-holds-it)).
- The next deploy that creates or updates the resource writes the whole model
  back into `attributes`.

What a re-import does to masked and unmasked attributes is in
[Import internals](import-internals.md#re-importing-a-cloud-control-resource).

### Unsupported

A type whose provider cannot import, or that has no provider, is reported as
`unsupported` in the plan and skipped.

| Resource type | Note |
| --- | --- |
| `AWS::CloudFormation::Stack` | Plain import cannot adopt a nested stack. Use `--migrate-from-cloudformation`, which walks the tree. |
| `AWS::AutoScaling::AutoScalingGroup` | Create, update, delete and drift detection work; import does not. |
| `AWS::EMR::InstanceGroupConfig` | A cluster sub-resource with no standalone name, listed under a parent `ClusterId`. |
| `AWS::EMR::InstanceFleetConfig` | As above. |

CDK Stages are not nested stacks. Each is a separate top-level stack: pass its
display path or physical name as the stack argument.

## `cdkd import` vs upstream `cdk import`

cdkd mirrors the flags of upstream
[`cdk import`](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-import.html)
where it can, but works differently underneath.

| Topic | `cdk import` | `cdkd import` |
| --- | --- | --- |
| Mechanism | One CloudFormation IMPORT changeset; atomic | Per-resource SDK calls; not atomic |
| On failure | The changeset rolls back | Rows that succeeded are written after you confirm |
| `--resource-mapping <file>` | Supported; unlisted resources fail the changeset | Supported, same file format; unlisted resources are `out of scope` |
| `--resource-mapping-inline` | Supported | Supported, same JSON shape |
| `--record-resource-mapping` | Writes what you typed at the prompt | Writes what cdkd resolved, even on "no" or `--dry-run` |
| `--resource <id>=<physical>` | Not available | Repeatable |
| Interactive prompt for missing ids | Default in a TTY | None; missing ids are looked up or skipped |
| Mistyped logical ID | Aborts before any AWS call | Aborts before any AWS call |
| Whole-stack import with no ids | Not supported | Default with no flags |
| `--auto` (ids plus lookup) | Not supported | Supported |
| Nested stacks | Not supported | With `--migrate-from-cloudformation` only |
| Bootstrap | CDK bootstrap v12 or later | cdkd's state bucket; no CDK bootstrap version needed |
| Type coverage | What CloudFormation can import | The types in [Provider coverage](#provider-coverage) |
| Confirmation before writing | Not applicable | Yes; skip with `--yes` |
| `--force` | Continue even if the diff has updates or deletions | Confirm a write that drops or overwrites state entries |
| `--dry-run` | Through `--no-execute` | Prints the plan and writes nothing |

If your scripts rely on the upstream behaviour:

- A mapping file or inline mapping works unchanged.
- Replace the interactive prompt with `--resource-mapping <file>`. cdkd does
  not prompt for ids.
- There is no atomic rollback. To back out a partial import, run
  `cdkd state orphan MyStack`, which drops the state record only.
- `--force` has the same name and a different meaning.

## Related

- [`cdkd export`](cli-export.md) and [Exporting to CloudFormation](export.md):
  the opposite direction
- [State Management](state-management.md): state records, composite physical
  ids, the bucket policy
- [Supported Resources](supported-resources.md): which types cdkd deploys
- [`cdkd bootstrap`](cli-bootstrap.md): cdkd-owned asset storage
- [Import internals](import-internals.md): nested-stack mechanics and refusal
  markers
