---
title: "cdkd state: writing subcommands"
description: "The cdkd state subcommands that change something: orphan, destroy, migrate and refresh-observed, with their flags, prompts and refusals."
---

# cdkd state: writing subcommands

Four [`cdkd state`](cli-state.md) subcommands change something: a state
record, the AWS resources behind it, or the bucket the records live in. Like
the read-only subcommands, they work from the state record alone and do not
need your CDK app.

| Subcommand | What it changes |
| --- | --- |
| [`orphan`](#cdkd-state-orphan) | Removes a record, or one resource's entry. AWS is untouched. |
| [`destroy`](#cdkd-state-destroy) | Deletes the AWS resources, then the record. |
| [`migrate`](#cdkd-state-migrate) | Copies every record from an older bucket to the current one. |
| [`refresh-observed`](#cdkd-state-refresh-observed) | Rewrites the drift baseline stored in a record. |

Each of them asks for confirmation before it writes. In a shell without a
terminal, such as a CI job, the subcommand cannot ask, so it exits `1` instead
of waiting. Pass `-y` / `--yes` to run it unattended. `state orphan` also
accepts `--force`.

The [shared options](cli-state.md#shared-options) and the
[exit codes](cli-state.md#exit-codes) are on the `cdkd state` page.

## `cdkd state orphan`

`state orphan` deletes cdkd's record of a stack and leaves every AWS resource
running. Afterwards cdkd no longer knows the stack exists. With `--resource`
it removes only the named resources' entries and keeps the rest of the record.

```bash
# every region's record for MyStack
cdkd state orphan MyStack

# one region's record
cdkd state orphan MyStack --stack-region us-east-1

# no prompt, even if locked
cdkd state orphan StackA StackB --force
cdkd state orphan MyStack --stack-region us-east-1 --resource MyQueue
```

| Flag | Default | Description |
| --- | --- | --- |
| `<stacks...>` | — | Stack names to orphan. At least one; exactly one with `--resource`. |
| `--resource <logicalId>` | — | Remove only this resource's entry. Repeatable. |
| `-f`, `--force` | off | Skip the prompt and ignore a lock. Weaker with `--resource`; see below. |
| `--stack-region <region>` | — | Orphan only the record in this region. |

Orphaning a stack that has no record does nothing and exits `0`, so you can
run the command again safely.

Orphaning a whole stack also hands the stack name over. It removes the
stack's marker in the [stack registry](state-store-registry.md), when the
marker names this prefix, and empties the stack's `retained.json`. Another
prefix can then deploy the stack, and a deploy here no longer takes back the
resources left running. cdkd does this in every region that still holds
anything of the stack, even when no record is left.

> [!WARNING]
> Do not remove the whole record of a stack you still deploy. The next
> `cdkd deploy` finds no record, so it creates every resource again or
> collides with the ones that exist. Use `--resource` on such a stack.

### Locked stacks

While a deploy or destroy runs, cdkd holds a lock on the stack: a file next to
the record that keeps a second command out. `state orphan` refuses a locked
stack and prints the [`cdkd force-unlock`](cli-force-unlock.md) command to run
first. `-y` / `--yes` skips the prompt but does not change that.

`-f` / `--force` skips the prompt, deletes the lock and removes the record.
It deletes whatever lock is present, including the lock of a deploy that is
still running, and the command warns when it is about to do that.

With `--resource`, no flag gets past a lock. `--force` still skips the prompt
there, and it has one more effect that is described under
[A reference that cannot be resolved](#a-reference-that-cannot-be-resolved).

### Removing one resource from the record

`--resource <logicalId>` removes one resource's entry and keeps the stack
deployed. The resource stays in AWS, and cdkd stops tracking it. Every other
resource in the stack stays under cdkd.

```bash
cdkd state orphan MyStack --resource MyQueue
cdkd state orphan MyStack --resource MyQueue --resource MyTopic
```

When a stack name has records in several regions, add `--stack-region` to say
which record you mean.

The command reads the record and does not read your CDK app. It can therefore
remove a resource whose construct has already left your code, such as a
resource whose delete `cdkd deploy` skipped. `cdkd orphan` cannot reach that
resource, because it finds resources by construct path in the synthesized
template.

Other resources in the stack may refer to the one you remove. cdkd rewrites
the record so that nothing in it points at the missing entry:

- Every `Ref`, `Fn::GetAtt` and `Fn::Sub` that another resource or a stack
  output holds to the removed resource is replaced with the value it resolved
  to.
- The removed resource is dropped from every other resource's `dependencies`
  list.
- When the record does not hold a `Fn::GetAtt` value, cdkd reads it live from
  AWS, in the stack's region.

### What the next deploy does with the resource

That depends on whether the construct is still in your CDK code.

If you removed the construct, the next `cdkd deploy` leaves the resource
alone, because cdkd has no record of it.

If the construct is still there, the next deploy creates the resource again. A
resource with a fixed or generated name then collides with the one in AWS.
Delete that one by hand first, or bring it back under cdkd with
[`cdkd import`](import.md).

### When `--resource` refuses

A refusal writes nothing. These are the cases:

- **The stack is locked.** Run the printed `cdkd force-unlock` command.
  `--force` does not bypass the lock.
- **The record has no such logical id.** Pick one from the list the error
  prints.
- **The record is malformed.** This covers the record itself, its outputs, and
  any entry the command would keep. Repair the record; see
  [cdkd state: malformed records](cli-state-malformed.md).
- **The resource is a nested stack whose own record still exists.** Run the
  printed `cdkd state orphan '<parent>~<logicalId>'` first.
- **A reference to the removed resource cannot be resolved.** See below.

#### A reference that cannot be resolved

cdkd replaces each reference to the removed resource with a real value. When
it cannot find that value, it refuses. `--force` tells cdkd to use the value
cached in the removed entry instead. Where the entry has no cached value, or
the value is a credential or a masked value, cdkd keeps the original
reference.

### Not a way past a blocked destroy

When another stack's reference blocks a destroy, removing the referenced
resource from the record does not help.
[Use Another Stack's Outputs](cross-stack-references.md) explains why.

## `cdkd state destroy`

`state destroy` deletes a stack's AWS resources and then its state record. It
is [`cdkd destroy`](cli-destroy.md) for a stack whose CDK app you no longer
have: it takes the list of resources from the record.

Like `cdkd destroy`, it refuses when another `--state-prefix` of the bucket
records the same stack and region. See
[The same stack name under another state prefix](cli-destroy.md#the-same-stack-name-under-another-state-prefix).

```bash
cdkd state destroy MyStack                       # asks for confirmation
cdkd state destroy MyStack OtherStack --yes
cdkd state destroy MyStack --stack-region us-west-2
cdkd state destroy MyStack --remove-protection --yes
```

It runs the same per-stack steps as `cdkd destroy`. The data guards, the
`DeletionPolicy` handling, the cross-stack reference blocks, the locking and
the exit codes are therefore the same, and
[cdkd destroy](cli-destroy.md) documents them.

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack names to destroy. Required. |
| `--remove-protection` | off | Turn per-resource deletion protection off before deleting. |
| `--skip-final-snapshot` | off | Delete `DeletionPolicy: Snapshot` resources without taking the final snapshot. |
| `--allow-unsupported-types <types>` | — | Comma-separated types to attempt through Cloud Control although cdkd reports them unsupported. |
| `--resource-warn-after <duration>` or `<TYPE>=<duration>` | `5m` | Warn when one resource operation runs longer than this. Repeatable. |
| `--resource-timeout <duration>` or `<TYPE>=<duration>` | `30m` | Abort one resource operation that exceeds this. Repeatable. |
| `--stack-region <region>` | — | Act on the record in this region. |

[cdkd deploy: tuning](cli-deploy-tuning.md) documents the two duration flags.

`--stack-region` also acts on a record that names no region. A stack whose
only record is in a different region is skipped with a warning.

### Differences from `cdkd destroy`

- **You name stacks by physical name only.** There are no CDK display paths
  and no wildcards. You can name a nested stack directly, as
  `<parent>~<child>`.
- **A name with no record is an error.** `cdkd destroy` skips such a name
  silently.
- **There is no `--all`.** Passing it fails with exit `1` before anything is
  read.
- **There is no `-f` / `--force`.** `-y` / `--yes` is the only way to skip the
  prompts.
- **There is no `--purge-events`.** Use
  [`cdkd events prune`](cli-events.md).

`--all` is missing on purpose. Every CDK app deployed to the account shares
the state bucket, so the flag would destroy other apps' stacks. Name each
stack instead. Or run `cdkd destroy --all` from the CDK app, which destroys
only that app's top-level stacks. `cdkd destroy '**'` also destroys the app's
CDK Stage stacks.

### The event history survives the record

cdkd records each run in its deployment-event history, which
[`cdkd events`](cli-events.md) reads. `state destroy` records one run under
`command: destroy` for each stack and region it runs against. That includes a
target that failed, was skipped, or that you declined at the prompt. The run
can still be read after the record is gone.

## `cdkd state migrate`

Older cdkd releases named the state bucket `cdkd-state-{account}-{region}`.
The current default is `cdkd-state-{account}`, without the region.
`state migrate` copies an older bucket into the current one. Run it when
[`cdkd state info`](cli-state.md#cdkd-state-info) reports the legacy name.

The copy is key for key. No record is rewritten. The
[stack registry](state-store-registry.md) markers under `_cdkd-registry/` are
copied with the records.

::: steps
1. Preview

   ```bash
   cdkd state migrate --region us-east-1 --dry-run
   ```

   This prints the two bucket names, the source bucket's region and the object
   count. It then stops without asking for confirmation.

2. Copy

   ```bash
   cdkd state migrate --region us-east-1
   ```

   The source bucket is kept. Run this once for each region in which you have
   a legacy bucket.

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

### Running it again

You can run the command again after a failure, and the second run resumes the
partial migration. It reuses an existing destination bucket, each object copy
can be repeated, and the verification accepts a destination that already holds
objects.

`--remove-legacy` deletes the source bucket only after cdkd has verified the
object count at the destination.

### A lock in the source bucket

The command refuses to start while any `lock.json` exists in the source
bucket, because a lock means a deploy or destroy may be writing there. The
error names the lock keys. Wait for that operation to finish, or clear a stale
lock with [`cdkd force-unlock`](cli-force-unlock.md).

[State Store](state-management.md) covers the destination bucket's
settings and a manual `aws s3 sync` alternative.

## `cdkd state refresh-observed`

`state refresh-observed` reads every resource of a stack from AWS and stores
the result in the state record, without deploying.

The stored result is the stack's **drift baseline**: a snapshot of what AWS
held for each resource. It contains your template's values, the defaults AWS
filled in, and keys your template never set. [`cdkd drift`](cli-drift.md)
compares AWS against this snapshot. In the record it is the
`observedProperties` field.

```bash
cdkd state refresh-observed MyStack
cdkd state refresh-observed --all --dry-run   # count what would be refreshed
cdkd state refresh-observed --all --yes
```

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack names to refresh. Required unless `--all` is given. |
| `--all` | off | Refresh every stack in the state bucket. |
| `--dry-run` | off | Print the per-stack count and write nothing. |
| `--stack-region <region>` | — | Region of the record to refresh. With `--all` it filters. |
| `--accept-refused <logicalId>` | — | Clear one resource's import baseline refusal and capture its baseline. Needs `--template` and exactly one stack. See [Accepting a refused baseline](#accepting-a-refused-baseline). |
| `--template <file>` | — | With `--accept-refused`: the synthesized template (JSON or YAML) the stack was last deployed from. |

`--dry-run` takes no lock and reads no resource from AWS. It still reads the
records from S3.

### When to run it

`cdkd deploy` already keeps the baseline current for every resource it
creates, updates or replaces, and it fills in a missing baseline. A deploy
does not re-read a resource that was unchanged and already had one. So run
this command when:

- A stack has not been deployed for a while, and you want `cdkd drift` to
  compare against what AWS holds now.
- The stack was deployed with `--no-capture-observed-state`, so no baseline
  was captured ([cdkd deploy: tuning](cli-deploy-tuning.md)).
- You are about to hand the stack to CloudFormation with
  [`cdkd export`](cli-export.md).

The baseline matters because of what `cdkd drift` can see. With a baseline,
`cdkd drift` also reports a console edit to a key your template never
mentions. Without one, it compares only the keys in state.

### Resources it does not refresh

The command can finish without refreshing every resource. There are four
reasons, and two of them change the exit code.

- **The resource's provider cannot read current state.** The resource is
  counted as unsupported and keeps its previous baseline. The exit code is not
  affected.
- **AWS reports the resource as not found.** A warning names it and it is
  counted as failed. It keeps its previous baseline. The command exits `2`.
- **The read fails for another reason.** The failure is reported for that
  resource. The command exits `2`.
- **A `cdkd import` run refused the resource a baseline.** The resource is
  skipped and counted separately. The exit code is not affected.

### A baseline that `cdkd import` refused

[`cdkd import`](import.md) sometimes cannot tell where a secret sits in a
resource's properties. It then records on the resource that no baseline may be
stored, because reading the values back could write a resolved secret to state
in plaintext. `state refresh-observed` respects that and skips the resource.

`cdkd state show` marks such a resource with an `ObservedBaseline: REFUSED`
line that names its remedy. Running `state refresh-observed` again does not
clear the mark. To clear it:

- Deploy a change to the resource. That rebuilds its record from your template
  and captures a baseline. A deploy that changes nothing does not.
- If the refusal was over a template parameter whose deployed value cdkd could
  not prove, an in-place update keeps the refusal. Replace the resource, import
  it again while a CloudFormation stack can prove the value, or accept the
  refusal yourself as described next.

### Accepting a refused baseline

After `--migrate-from-cloudformation` the CloudFormation stack is gone, so a
refusal over a template parameter can usually be cleared only by replacing the
resource. If you know the resource no longer holds a value cdkd did not send,
you can say so for one resource:

```bash
cdkd state refresh-observed MyStack \
  --accept-refused MyFunction \
  --template cdk.out/MyStack.template.json
```

For example, you moved the secret into a `{{resolve:secretsmanager:...}}`
reference in your template and deployed it.

The command asks you to confirm that the template is deployed, and that AWS
holds no secret at any position of the resource that the template does not
spell as a dynamic reference. Whatever AWS
holds there is written to `state.json` as the baseline. With `-y` / `--yes` the
statement is printed as a warning instead of asked. Without `--yes`, a
non-interactive run is refused.

It then reads that one resource from AWS and stores the baseline, matched by
position against the record like any refresh. Both the refusal and its reason
are removed only after the read succeeds. A failed read keeps the refusal and
writes nothing.

It refuses, before taking the lock, when:

- the resource carries no refusal, or its refusal is not over a template
  parameter. That kind clears with a deploy that changes the resource.
- the template does not define the resource, defines another type there, or
  cannot be read.
- in the template the resource still reads a template parameter, directly or
  through another resource's attribute. Deploy the template that no longer does,
  then run it again.
- the record does not hold exactly what the template defines for the
  resource. cdkd compares every value, working out `Ref`, `Fn::GetAtt`,
  `Fn::Join`, `Fn::Sub` and `Fn::Select` from the stack's other records. For a
  value that differs, deploy the template, then run the command again. A deploy
  does not send a literal equal to the value the record already holds, so AWS
  can still hold an earlier value there: the check passes, and only your
  confirmation covers it. Any other
  function, or a property cdkd does not record for the resource, is not changed
  by a deploy; only replacing the resource clears the refusal then.
- a value in the record holds a parameter's `Default` from the template, as the
  whole value, or inside a longer value for a `Default` of four or more
  characters. The record may then still hold the placeholder the refusal
  distrusted.

A refusal recorded by an older cdkd without a reason is accepted, and is treated
as one over a template parameter. `--accept-refused` takes exactly one logical
id and one stack name, and is refused with `--all`. For a nested stack, pass
the child's own template. `--dry-run` runs the same checks and writes nothing.

### Secrets in the baseline

The values AWS returns can include decrypted secrets. Where the record holds a `{{resolve:secretsmanager:...}}` reference,
cdkd writes that reference back over the value AWS returned, matching the two
by position.

Three cases need care:

- **State written by an old cdkd release.** A release that predates cdkd's
  secret-redaction fixes may have stored the plaintext in the record's own
  properties. This command then has no reference to match against. Run
  [`cdkd scrub`](cli-scrub.md) first.
- **Values that cannot be lined up.** Where cdkd cannot match the value AWS
  returned to the record, it writes the mask `***` at that position.
  `cdkd drift` then reports the position as not compared and exits `2`. A
  `cdkd deploy` repairs it, but running this command afterwards writes the
  masks back. See [`cdkd drift`](cli-drift.md).
- **An SSM reference inside a longer value.** An older record can hold a
  `{{resolve:ssm:...}}` reference inside a longer value. cdkd keeps the value
  AWS reports there only when the parameter is a `String` or `StringList`. For
  a `SecureString` it writes the reference back. To tell them apart, cdkd
  calls `ssm:GetParameter` without decryption. Without that permission it
  writes the reference back, and the command still succeeds.

### Malformed records are refused

This subcommand rewrites the record, so it does not continue over a record it
cannot read. It refuses before it takes the lock and before it reads anything
from AWS, and the message names the stack and region. It refuses when:

- `resources` is not a JSON object (`null`, absent, a list, a number, a string
  or a boolean), or
- an entry in `resources` is not an object or has no resource type. The
  message names up to five logical ids and counts the rest.

With `--all` or several names, cdkd checks every record before it refreshes
the first one. One malformed record therefore stops the whole run with nothing
written.

A legacy record without a region is refused the same way, before any stack is
refreshed. Any cdkd command that writes the record, such as a deploy, migrates
it.

Inspect the record, then repair or remove it:

```bash
cdkd state show MyStack --json
cdkd state orphan MyStack   # removes the record, not the AWS resources
```

## Related

- [`cdkd state`](cli-state.md): the subcommand map, the shared options and the read-only subcommands
- [cdkd state: malformed records](cli-state-malformed.md): what a damaged record looks like in each subcommand
- [Orphan Instead of Destroy](orphan-vs-destroy.md): which cleanup command to reach for
- [cdkd destroy](cli-destroy.md): the guards and prompts `cdkd state destroy` shares
- [`cdkd drift`](cli-drift.md): the comparison `state refresh-observed` supplies the baseline for
