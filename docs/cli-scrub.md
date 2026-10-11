---
title: cdkd scrub
description: "cdkd scrub rewrites plaintext secrets in cdkd state to their {{resolve:...}} references and audits state as a CI gate, without redeploying."
---

# cdkd scrub

`cdkd scrub` rewrites cdkd's state files so that a secret stored there in
plaintext is stored as its `{{resolve:...}}` reference instead. It creates,
updates and deletes no AWS resource. Run it after upgrading cdkd on a stack
you do not want to redeploy, when you suspect a state file predates a
redaction fix, and as a standing CI gate.

```bash
cdkd scrub MyStack --dry-run              # report what would change, write nothing
cdkd scrub MyStack                        # rewrite plaintext secrets to {{resolve:...}}
cdkd scrub --all                          # every stack in the app, producers first
cdkd scrub --all --dry-run --fail         # CI gate: exit 1 if a referenced secret is in plaintext
cdkd scrub MyStack --purge-history        # also purge earlier S3 versions of clean records
cdkd scrub MyStack --verbose              # explain a stack that reports clean
```

## `cdkd scrub` (state secret hygiene: clean + audit)

The command has two uses.

| Mode | Command | What it does |
| --- | --- | --- |
| Clean | `cdkd scrub MyStack` | Rewrites state in place, without redeploying. |
| Audit | `cdkd scrub --all --dry-run --fail` | Writes nothing. Exits `1` when a value the template names through a `{{resolve:...}}` reference is still in state as plaintext. |

Preview first, then clean:

```text
$ cdkd scrub --all --dry-run
No plaintext secrets found in ApiStack (scrub checks only values the template names through a {{resolve:...}} reference)
Would scrub 2 resource record(s) in DbStack

Plan: 1 stack(s) hold plaintext secrets and would be scrubbed (--dry-run, no state
written). ROTATE any exposed secret in Secrets Manager.
```

```text
$ cdkd scrub DbStack
Scrubbed 2 resource record(s) in DbStack

Done: scrubbed 1 stack(s). The rewritten state.json no longer holds the plaintext, and
on a VERSIONED state bucket its earlier versions were purged, unless a warning above
says otherwise. A value that was ever persisted must still be treated as compromised —
ROTATE it in Secrets Manager (scrub matches the current value, so scrub BEFORE
rotating); rotation is what makes any copy cdkd cannot reach harmless.
```

> [!IMPORTANT]
> Scrubbing does not un-expose a secret that was already stored in plaintext.
> Scrub first, then rotate the secret. See
> [Rotate the secret — and scrub first](#rotate-the-secret-and-scrub-first).

As a CI gate:

```yaml
# Fail the build if any cdkd state file holds a {{resolve:...}}-referenced value in plaintext.
- run: cdkd scrub --all --dry-run --fail
```

```text
$ cdkd scrub --all --dry-run --fail
No plaintext secrets found in ApiStack (scrub checks only values the template names through a {{resolve:...}} reference)
No plaintext secrets found in DbStack (scrub checks only values the template names through a {{resolve:...}} reference)

No plaintext secrets found in any target stack state (scrub checks only values the template names through a {{resolve:...}} reference). Nothing to scrub.
```

A normal `cdkd deploy` redacts state the same way as it writes it, so a green
gate is the expected steady state. A green gate means the current `state.json`
is clean. It says nothing about earlier S3 versions of that object; see
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot).

```text diagram=scrub-touches
 Synthesize the CDK app       only the template names the {{resolve:...}}
   │                          references
   ▼
 Resolve each reference       the current secret value, held in memory only
   │
   ▼
 Rewrite state.json, under the stack lock
   each target stack and every nested stack under it:
   properties, attributes, observedProperties,
   rollback-orphan records, outputs, cross-stack read names
   │  after the lock is released
   ▼
 Rewrite the exports index entries      one exports.json per region
   │  versioned bucket
   ▼
 Purge earlier S3 versions              only of the keys this run rewrote

 Never touched: AWS resources, rollback-journal.json, physical ids,
                values the template does not reference
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to scrub. Physical name or CDK display path. The [nested stacks](#nested-stacks) under each are scrubbed too. |
| `--all` | off | Scrub every stack in the synthesized app, Stage stacks included. |
| `--dry-run` | off | Report what would be scrubbed without writing state. |
| `--fail` | off | Exit non-zero when a referenced secret is found in plaintext. See [`--fail`](#fail). |
| `--purge-history` | off | Also purge the earlier S3 versions of every `state.json` the run examined, not only the ones it rewrites. Cannot be combined with `--dry-run`. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Accepted for consistency with the other mutating commands. `cdkd scrub` asks no confirmation, so it changes nothing. |
| `--verbose` | off | Verbose logging. Turns on the per-read detail behind a stack that reports clean. |

`--region` is deprecated — prefer `AWS_REGION` or your AWS profile — but it is
still honored if passed, and it is not a no-op.

Scrub needs the CDK app (`--app`, `CDKD_APP` or `cdk.json`), unlike the
`cdkd state ...` family. A state file records a resolved value with no marker
of which values are secrets. Only the template carries the `{{resolve:...}}`
references.

Scrub takes no `--parameters`. It resolves the template with each parameter's
`Default`, which limits what it can see; see
[What scrub cannot see](#what-scrub-cannot-see).

A stack argument that matches nothing is refused, and the message lists the
stacks the app does have.

## `--fail`

`--fail` turns a finding into a non-zero exit.

| Run | Exits `1` when |
| --- | --- |
| `--dry-run --fail` | Any plaintext of a value the template names through a `{{resolve:...}}` reference is found, or an output key would be [dropped](#a-key-the-template-can-no-longer-name-is-dropped). |
| A real run with `--fail` | A leak remains that scrub cannot rewrite. See [Findings scrub reports but cannot rewrite](#findings-scrub-reports-but-cannot-rewrite). |

One kind of plaintext is not counted: a physical name derived from a secret,
which state has to hold (see
[How secrets stay out of state](#how-secrets-stay-out-of-state)).

A green `--dry-run --fail` does not by itself mean every record was examined.
A record scrub could not scan is named in a warning at default verbosity, so
read the warnings.

## What scrub rewrites, and what it leaves alone

Scrub synthesizes the template, re-resolves each resource's properties to
learn the current secret values, and replaces those values in state with the
reference. The values are held in memory, never printed and never written.

| In the state bucket | What scrub does |
| --- | --- |
| A resource record's `properties`, `attributes`, `observedProperties` | Replaces a resolved secret with its `{{resolve:...}}` expression. |
| A `NoEcho` parameter's value | Stores `***`, the way a deploy does. |
| Rollback-orphan records (`orphans`) | Rewritten like a resource record, including one whose resource you removed from the app. |
| `outputs` | Rewritten. A key the template no longer declares may be [dropped](#a-key-the-template-can-no-longer-name-is-dropped). |
| [Cross-stack read names](#cross-stack-read-names) | Rewritten where a secret was assembled into the name. |
| The record of each [nested stack](#nested-stacks) under a target | Rewritten the same way, under its own lock. |
| [The exports index](#the-exports-index) | Entries of the scrubbed stacks are set to the state value. |
| Earlier S3 versions of each key it rewrote | [Purged](#what-a-real-run-removes-and-what-it-cannot) on a versioned bucket. |

| Left alone | Why |
| --- | --- |
| Every AWS resource | Scrub only writes the state bucket. |
| A stack's `rollback-journal.json` | Not rewritten. A nested stack keeps its journal until its top-level stack's deploy succeeds, so a repaired value can survive there until then. |
| A `physicalId`, and other resources' stored copies of that name | The name is the resource's identity. See [How secrets stay out of state](#how-secrets-stay-out-of-state). |
| [A value your template never references](#a-value-your-template-never-references) | Scrub learns a secret only by resolving a reference. |
| Earlier S3 versions of a key it did not rewrite | Kept as recovery history unless you pass `--purge-history`. |
| A reference you edited but have not deployed | Rewriting it would hide the edit from the next deploy. |

One gap in the orphan records: a record whose resource is gone from the
template and which holds plaintext with no `{{resolve:...}}` expression left
in it can go unmatched, and a clean verdict does not rule it out. `cdkd diff`
still shows the record, and `cdkd state show` prints it.

How a single value is matched (two spellings of one secret, secrets inside a
list, a reference embedded in a longer string) is in
[cdkd scrub internals](cli-scrub-internals.md#what-gets-redacted-inside-a-record).

## Rotate the secret — and scrub first

A value that was ever stored in plaintext should be treated as compromised and
rotated in Secrets Manager. Scrub only stops it being read back out of state
from now on.

::: steps
1. Scrub

   ```bash
   cdkd scrub MyStack
   ```

   Scrub matches the secret's current value against what state holds. Once
   the secret is rotated, the stale value in state no longer matches and scrub
   cannot rewrite it.

2. Rotate the secret in Secrets Manager

   Rotation is what makes any copy cdkd cannot reach harmless.

3. Redeploy if you rotated before scrubbing

   ```bash
   cdkd deploy MyStack
   ```

   The rotation invalidates the stale value, and a redeploy then rewrites the
   record with the expression.
:::

If you rotated first, scrub reports nothing to scrub in most positions. A
cross-stack read name is the exception; see
[What this does not repair](#what-this-does-not-repair).

### What a real run removes, and what it cannot

`cdkd bootstrap` turns S3 versioning on for the state bucket. With versioning
on, rewriting `state.json` turns the pre-scrub body into a noncurrent version
of the same key, still readable, plaintext included, by anyone who can
`GetObject` it with a `VersionId`.

So a real `cdkd scrub` purges the noncurrent versions of each `state.json` it
rewrote, and of the exports index (`exports.json`) in each region whose entries
it rewrote. On an unversioned bucket there is nothing to purge. If you supplied
your own bucket, check it:

```bash
aws s3api get-bucket-versioning --bucket <state-bucket>
```

What the purge does not reach, and so what `Done: scrubbed ...` does not claim:

| Not purged | Why | What to do |
| --- | --- | --- |
| A key scrub did not rewrite | An already-clean record is not written, so its earlier versions are kept as recovery history. A deploy under a fixed cdkd leaves this case behind. | `cdkd scrub MyStack --purge-history` |
| A stack with no current record (destroyed, orphaned, or no longer in the app) | It is not examined, flag or not. | The `aws s3api` commands below. |
| A record scrub refused | It is never purged, flag or not. | Fix the refusal and re-run. |
| A purge that failed | It needs `s3:ListBucketVersions` and `s3:DeleteObjectVersion`. Without them scrub still succeeds, and a warning names the key. | Grant them and re-run, or purge by hand. |
| A replicated bucket's destination | S3 never replicates a version-id delete. Scrub warns only when it can read the replication configuration (`s3:GetReplicationConfiguration`). | See [S3 replication defeats the purge](state-management.md#s3-replication-defeats-the-purge-and-cdkd-cannot-fix-it-for-you). |
| Anything under `--dry-run` | It writes and purges nothing, and refuses `--purge-history`. | Run without `--dry-run`. |

`--purge-history` covers every record the run examined: each target stack and
every nested stack under it that has a readable record. It does not widen the
exports-index purge.

> [!WARNING]
> `state.json`'s noncurrent versions are also the state-recovery history S3
> versioning is enabled for. `--purge-history` and the commands below drop it.

To see whether any versions survive, and to remove them yourself:

```bash
# List the noncurrent versions of one stack's state key. `cdkd` is the default
# --state-prefix; substitute yours if you set one. A nested stack's <stack> is
# its state name, `<Parent>~<Child>`.
aws s3api list-object-versions --bucket <state-bucket> \
  --prefix "<state-prefix>/<stack>/<region>/state.json" \
  --query 'Versions[?IsLatest==`false`].{Key:Key,Id:VersionId,Modified:LastModified}' \
  --output table

# Delete one, after confirming it is not the version you want to recover from.
aws s3api delete-object --bucket <state-bucket> \
  --key "<state-prefix>/<stack>/<region>/state.json" --version-id <VersionId>
```

The same commands apply to the exports index with its own key,
`<state-prefix>/_index/<region>/exports.json`. That object is shared by every
cdkd-managed stack in the region, so its purged history includes other stacks'
earlier entries. Nothing is lost: the index is a derived view that cdkd
rebuilds from the state records.

A record still in the pre-region layout (`<state-prefix>/<stack>/state.json`)
is migrated by the rewrite: written to the region-scoped key, the old key
deleted, and the old key's earlier versions purged. If that delete fails, the
stack fails with `SCRUB_LEGACY_STATE_KEY_SURVIVES` rather than being reported
scrubbed. If cdkd cannot confirm the delete, it fails with
`SCRUB_LEGACY_STATE_KEY_UNVERIFIED`. In both cases delete the old key yourself
and purge its versions with the commands above; a re-run does not check it
again.

When a `state.json` write fails, its history is purged only if the write may
have landed; the rule is in
[cdkd scrub internals](cli-scrub-internals.md#how-the-version-purge-decides).

## How secrets stay out of state

cdkd resolves two kinds of CloudFormation dynamic reference to their value so
it can hand the secret to the AWS API: `{{resolve:secretsmanager:...}}`, and
`{{resolve:ssm:...}}` pointing at a `SecureString` parameter. When a deploy
saves state, it stores the unresolved expression in place of the value. The
secret then does not appear in `state.json`, nor in `cdkd state show`,
`cdkd diff` or `cdkd drift` output for that record.

This matches CloudFormation, which keeps the reference in the template and
resolves it service-side. Two consequences follow:

- A rotated secret behind an unchanged reference is a no-op on the next
  deploy.
- `cdkd diff` makes no live secret fetch.

An SSM parameter is treated by its type:

| Parameter `Type` | Treatment |
| --- | --- |
| `SecureString` | Handled like a Secrets Manager reference: state stores the `{{resolve:ssm:...}}` expression, and `cdkd scrub` cleans it out of older state. |
| `String` / `StringList` | Public configuration, stored resolved, so a parameter-backed property is not a spurious UPDATE on every deploy. |

### This is a design, not a guarantee

The redaction substitutes only at positions it can match against the template.
Where it cannot, it leaves the value it was handed. That can happen on the
deploy path itself, through the observed-properties refresh of an unchanged
resource, and also in `cdkd state refresh-observed` and in the `attributes`
that `cdkd import` captures from a live read.

So treat any value that was ever persisted in plaintext as compromised and
rotate it, and run `cdkd scrub --dry-run --fail` as a standing check.

A `state.json` version an older cdkd already wrote is a separate matter. On a
versioned bucket the next deploy supersedes it and does not remove it; see
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot).

### A physical name derived from a secret is stored

When a `{{resolve:...}}` reference or a `NoEcho` parameter feeds a name or
another identifier property, the resulting name is the resource's identity.
Its `physicalId` holds it, and so do other resources' resolved `Ref`,
`Fn::GetAtt` and `Fn::Sub` copies of it and the outputs and exports index
entries that carry it. `cdkd scrub` does not rewrite those and reports the
records clean. The resource's own properties keep the reference (`***` for a
`NoEcho` parameter).

Leftovers that carry the name are handled:

| Leftover | What scrub does |
| --- | --- |
| An output key the template no longer declares | Rewritten to the expression where it holds or embeds the secret's value; otherwise handled like any undeclared key. |
| Another resource's `orphans` record | Its stored properties and attributes are rewritten the same way. Its physical id is not. |
| An exports index entry with no output left | Reported when it holds a recorded secret's value. |

CloudFormation does the same. Keep secrets out of identifier properties, as
[its documentation advises](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references.html).

## Multi-stack runs (`--all`)

```bash
cdkd scrub --all
```

`--all` scrubs every stack in the synthesized app, producers before consumers.
The order comes from CDK's stack dependencies plus the `Fn::ImportValue` and
`Fn::GetStackOutput` references in the templates. One run therefore scrubs a
producer and then resolves its expression in the consumer.

A refusal is per stack. The remaining stacks are still scrubbed, and the run
ends non-zero naming the ones it could not examine, including each nested
stack under a stack that failed. The summary line never counts a stack the run
could not reach.

`--dry-run` writes nothing, so a producer is never rewritten during it. A dry
run over a not-yet-scrubbed producer is where the
`SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` refusal is expected.

`--all` means every stack in this app, not every stack in the state bucket. A
bucket shared by several CDK apps is covered by each app running its own
`cdkd scrub`.

## Nested stacks

A nested stack (`cdk.NestedStack`) keeps its own state record, at
`<state-prefix>/<Parent>~<Child>/<region>/state.json`. It is not a stack of
the synthesized app, so it cannot be named on the command line. Scrubbing a
stack scrubs every nested stack under it, at any depth, each right after the
stack that deploys it. `--all` and the `--dry-run --fail` gate cover nested
stacks too.

A stack argument spelled like a child's state name (`Parent~Child`) matches
nothing. The refusal names the parent to pass instead.

A child's template receives a secret through a parameter, so scrub learns the
child's secrets from the parameters its parent passes. When it cannot work out
what a child was deployed with, a child that has a record is refused with
`SCRUB_NESTED_CHILD_UNRESOLVABLE` (exit `2`) and is not reported clean. The
message says which cause applies:

| Cause | What to do |
| --- | --- |
| The parent's template no longer declares the child | Deploying the parent destroys the child, record included. |
| The parent's record has no row for the child | Deploy the parent so it records the row, then re-run. If a `Condition` keeps the row out, the child record is left over: remove it with `cdkd state destroy`. |
| Nothing reaches the record: the parent's own record was removed (`cdkd state orphan <Parent>` removes only the parent's key), or both sides dropped the row | Inspect it with `cdkd state show`. If it is left over, remove it with `cdkd state destroy` (resources too) or `cdkd state orphan` (record only). |
| The scrub of the stack that deploys it failed | That failure is reported too. Fix it and re-run. |
| A value in the parameters the parent passes could not be resolved, or the child's parameter declaration rejects it | The message, or `--verbose`, shows which value. |
| The synthesized template names no template file for the child's row | Re-synthesize with a CDK version that emits it, then re-run. |

Scrub finds the unreachable records of the third row by listing the state
records under `<Parent>~` in the parent's region, and refuses each one.

A child that never had a record is skipped silently. A stack argument spelled
like a child's state name is warned about even when other arguments matched,
since it was not scrubbed.

After each child's scrub, scrub also repairs the parent's row. The parent
mirrors each child output as an `Outputs.<Name>` attribute, which on an old
record can hold a child output's plaintext. It is reported as
`Scrubbed N nested-stack output attribute(s) in <Parent>`. An attribute that
holds a recorded plaintext but matches no child output exactly is reported
and keeps `--dry-run --fail` red; deploying the child rewrites it.

A nested template tree that is cyclic or points outside the assembly is
refused for the whole stack before anything is written, with
`SCRUB_NESTED_TEMPLATE_TREE_MALFORMED`.

## Stack outputs

Stored outputs are scrubbed too, including an output you have since deleted.

| Stored output key | How it is handled |
| --- | --- |
| One today's template can name: a declared output, or an `Export.Name` scrub can fully resolve | Redacted by position against the template, like a resource property. |
| One the template can no longer name, whose value matches a secret recorded anywhere in this run | Rewritten to that secret's reference. |
| One the template can no longer name, whose value nothing identified | [Dropped](#a-key-the-template-can-no-longer-name-is-dropped), with exceptions. |

A deleted output is the usual case for the second and third rows. A
parameterized `Export.Name` is the other: scrub takes no `--parameters`, so a
name that resolves to `prefix-${Foo}` here leaves the alias key your deploy
really wrote unaccounted for. Declare the export name literally, or give the
parameter a `Default`, if you want that key matched by position.

Scrub never guesses. A stored value that nothing in the run recorded as a
secret is never rewritten onto a reference, because `outputs` are handed to
other stacks as they are, and a wrongly rewritten value would send a literal
`{{resolve:...}}` token into a consumer's AWS call. The matching rules and
their one stated cost (a short, word-like secret can match inside an unrelated
undeclared key) are in
[cdkd scrub internals](cli-scrub-internals.md#what-scrub-deliberately-does-not-do).

### A key the template can no longer name is dropped

A stored key the template can no longer name, whose value no pass rewrote, is
removed from the outputs scrub writes. Its value is one scrub cannot identify.
Most often the output was deleted and the value may be a plaintext an older
cdkd stored. Each dropped key is named, never its value:

```text
Dropped 1 output key(s) from MyStack that its template no longer declares: OldDbUrl. ...
```

`--dry-run` says `Would drop` and counts the stack as one it would scrub, so
`--dry-run --fail` exits `1` until a real run or a deploy removes the key.

The drop runs only when this run recorded at least one secret for the stack. A
stack whose template resolves no secret is not rewritten, and its undeclared
keys stay.

These keys are kept:

| Kept key | Effect |
| --- | --- |
| One a pass rewrote, whole or in part | It now carries the reference, and its exports index entry is set to match. |
| One that holds no string that could be plaintext | Nothing to protect. |
| One whose name holds a secret this run recorded | Reported as a finding; scrub cannot rename a key. |
| One that may be a live export alias scrub could not reproduce | Kept with the warning `... were LEFT as they are`. The stack is not reported clean and `--fail` exits `1`. A deploy rewrites the outputs. |
| One another stack still reads | Kept and named with that stack. The stack is not reported clean and `--fail` exits `1`. |

For the last row, scrub reads every state record in the bucket once per run to
find readers. Stop the consumer reading the key, or declare the output again,
then deploy and re-run.

If the bucket listing or any record cannot be read, no key is dropped from
that stack, the rest of it is still scrubbed, and the run ends with
`SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED` (exit `2`, with or without `--fail`).

One old record anywhere in the bucket can also keep every stack's drop
candidates until it is redeployed. That and the exact alias test are in
[cdkd scrub internals](cli-scrub-internals.md#a-key-the-template-can-no-longer-name).

## Cross-stack read names

State records which producer a stack read a cross-stack value from. Three of
those fields come from the template and can carry a secret when an `Fn::Sub`
assembled the name around a resolved reference: `imports[].exportName`,
`outputReads[].sourceStack` and `outputReads[].outputName`. Scrub repairs
those three by matching against the plaintexts this run recorded.

`sourceRegion` and `imports[].sourceStack` are left as stored. The second is
the key `cdkd destroy` matches when it refuses to delete a stack another stack
still imports from, so rewriting it would drop that protection.

### What this does not repair

A name whose secret has since been rotated is left as it is. Scrub holds the
secret's current value, while the stored name holds the value from when the
record was written.

Scrub still reports such a name, so the stack is not called clean and `--fail`
exits `1`. The warning names the list and index (`state.imports[1]`), never
the stored value. Rotating again does not help. A deploy that updates the
stack rewrites both lists; a deploy that finds nothing to change keeps the
stale entry.

An entry left behind by a reference you removed from the template can be
reported the same way, when its name has the shape of a secret-bearing read of
the same producer. The exact test is in
[cdkd scrub internals](cli-scrub-internals.md#when-a-stale-name-is-reported).

## The exports index

Beside the per-stack `state.json` records, cdkd keeps one object per region at
`{state-prefix}/_index/{region}/exports.json`. It maps each export name to the
producing stack's resolved output value, so an `Fn::ImportValue` does not have
to scan every state file. It is shared by every cdkd-managed stack in that
region.

After writing each stack's `state.json`, scrub checks the index entries that
stack publishes:

| Index entry | What scrub does |
| --- | --- |
| State holds a redacted value under the same name (a `{{resolve:` expression or `***`) and the entry differs | Rewrites the entry to the state value. Until then it is a finding, and `--dry-run --fail` exits `1`. |
| The entry already matches | Nothing. |
| The entry could not be written | The run fails with `SCRUB_EXPORT_INDEX_INCOMPLETE` (exit `2`). Clear the cause and re-run; only the remaining entries are written. |
| The entry's name is not a key of `state.outputs` | Left as it is. Redeploy that producer. If its value still holds a recorded secret, it is a finding and `--fail` exits `1`. |
| The entry belongs to a stack this run did not scrub | Reported as coverage. It never fails the gate. |

Because the index is read for real under `--dry-run`,
`cdkd scrub --all --dry-run --fail` can exit `1` over an index entry even when
every `state.json` already holds the expression.

Scrub only changes the value of entries the index already holds. It adds no
name and removes none. The write needs no IAM permission beyond what
`cdkd deploy` already uses on that object; a policy narrowed by hand to
`{state-prefix}/{stackName}/*` breaks here, as it already breaks cross-stack
deploys.

## What scrub cannot see

Scrub learns which values are secrets by resolving today's template with
default parameter values. A clean result is limited by that.

### A value your template never references

A secret that no `{{resolve:...}}` reference in the template names is
invisible to scrub: one an operator set out of band, or one AWS returns in a
field the template never sets. The record reports clean, and every no-finding
line says so:

```text
No plaintext secrets found in MyStack (scrub checks only values the template names through a {{resolve:...}} reference)
```

The drift baseline records such a value as AWS returned it, by design. How to
remove one is in
[`cdkd import`'s note on it](import.md#a-value-your-template-never-references-is-recorded-as-aws-holds-it);
the last step is `cdkd scrub <stack> --purge-history`.

Two more kinds of value are outside the check:

- A credential a provider records in `attributes` so that `Fn::GetAtt` can
  read it, such as an `AWS::IAM::AccessKey`'s `SecretAccessKey` or a Cognito
  user pool client's `ClientSecret`. It is stored as returned.
- A `NoEcho` parameter's value is not found by reference. Scrub masks it as
  `***` at every position today's template fills from the parameter, the way a
  deploy stores it (see
  [`version: 11` stores `NoEcho` values as `***`](state-management.md#version-11-stores-noecho-values-as-current-writers)).
  The per-position rules are in
  [cdkd scrub internals](cli-scrub-internals.md#how-a-noecho-parameter-value-is-masked).

### A reference built from a parameter

A parameter is resolved from today's template: its `Default`, or for an
SSM-typed parameter the value Parameter Store holds now. If the deploy used a
different value, scrub cannot tell, and the plaintext the deploy wrote can
stay in state while the stack prints clean.

| What changed after the last deploy | Effect |
| --- | --- |
| The parameter's `Default` | Scrub looks up a different reference than the deploy resolved. |
| An SSM-typed parameter's value | Same. |
| The `Default` was removed | Scrub cannot resolve the reference at all and only warns. |

There is no flag for this. In any of these cases, inspect the record with
`cdkd state show` rather than trusting a clean result.

### Which `Fn::If` branch scrub evaluates

Conditions are evaluated with default parameter values too, and a condition
scrub cannot evaluate reads as false. So scrub can pick a branch the deploy
never took.

If a cross-stack read sits on that branch in a resource, the stack can be
refused over a producer that does not exist for the parameters you really
deployed with. Make the read resolvable: deploy or scrub the producer that
branch names, which `cdkd scrub --all` does in one run.

### A placeholder scrub cannot fill

When an `Fn::Sub` placeholder inside a reference names a declared parameter
with no `Default`, or a declared resource, the reference is never looked up.
The only sign is a `keeping placeholder` warning, and the stack can still
print `No plaintext secrets found`. Run `cdkd scrub --verbose` when a stack
you expect findings from reports clean.

### A reference you edited but have not deployed

If state holds `...:AWSPREVIOUS` and the template now says `...:AWSCURRENT`,
scrub leaves the record alone and reports nothing to scrub. Rewriting it
would make the next `cdkd deploy` see no change and never push the edit to
AWS.

## Findings scrub reports but cannot rewrite

A real run exits `1` under `--fail` when it found a leak it cannot rewrite.
Each is also reported in words.

| Message | Meaning | What to do |
| --- | --- | --- |
| `N output KEY(s) in <stack> hold plaintext and CANNOT be scrubbed` | An output key (an `Export.Name`) renders a secret, also when it is split by invisible characters or spelled in compatibility characters such as full-width letters. | Rotate the secret, change the `Export.Name`, redeploy. |
| `N cross-stack read(s) in <stack> could NOT be verified` | A cross-account read of a secret export, which cdkd will not resolve with the consumer's credentials. | Export a non-secret value such as the secret's ARN, or reference it within its own account. |
| `N scan(s) in <stack> were ABANDONED mid-value because a {{resolve:...}} reference could not be resolved` | A reference failed to resolve, so later references in the same value were never checked. | Restore the parameter or secret, or fix the `Fn::Sub` variable, and re-run. |
| `N cross-stack read name(s) in <stack> hold a plaintext scrub could NOT repair` | A read name holds a secret's value from before a rotation. | See [What this does not repair](#what-this-does-not-repair). |
| `... were LEFT as they are` | An undeclared output key was kept: another stack reads it, or it may be a live export alias. | See [A key the template can no longer name is dropped](#a-key-the-template-can-no-longer-name-is-dropped). |

None of these refuses the stack. Scrub reports the finding, scrubs everything
else, and declines to call the stack clean.

What exactly counts for each message is in
[cdkd scrub internals](cli-scrub-internals.md#findings-a-real-run-reports-as-exit-1).

If the first message starts firing on a state that used to pass, the key was
already leaking. What changed is what cdkd can detect.

The second message has a second form: a producer whose own `outputs` map
cannot be read. That one is repairable and exits `2`
(`SCRUB_PRODUCER_RECORD_UNREADABLE`), with or without `--fail`.

### A scan `--fail` warns about but does not count

Not every abandoned scan raises the exit code. Scrub counts only the failures
you can clear.

| What stopped the scan | `--fail` | Why |
| --- | --- | --- |
| The reference itself — deleted parameter, denied secret, missing `JSON_KEY` | exits `1` | Restoring the reference clears it. |
| An unresolvable `Ref` / `Fn::GetAtt`, or a parameter with no `Default` | warns only | `scrub` resolves with template defaults and takes no `--parameters`, so it cannot bind these. A gate failure could not be cleared. |
| An `Fn::Sub` placeholder naming no resource or parameter of the template, kept inside the reference | exits `1` | Fixing the template clears it; no `--parameters` is involved. |
| A reference whose own argument still holds a `${...}` no `Fn::Sub` substitutes | warns only | The token was never fetchable — same reason. |

A failure stops only the top-level property it occurred in, and the warning
names that property. A record cdkd could not scan may still hold a plaintext
from an older cdkd. Giving the parameter a `Default`, or making the reference
resolvable, lets a re-run check it.

## Refusals

A refusal means scrub declined to examine something. It stops that stack
instead of reporting it clean, and exits `2`.

| Code | What triggers it | What to do |
| --- | --- | --- |
| `SCRUB_CROSS_STACK_READ_UNRESOLVED` | An `Fn::ImportValue` / `Fn::GetStackOutput` scrub could not resolve: a deleted producer, a missing state file. | Deploy the producer stack, or correct the reference, then re-run. |
| `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` | The read succeeded, but the producer's own state still stores the plaintext instead of the expression. | `cdkd scrub '<producer>'` first, then re-run. For a chain, every stack in it, head first. `cdkd scrub --all` does this in one run. |
| `SCRUB_CROSS_REGION_SECRET_UNRESOLVED` | A secret reference whose ARN names another region could not be read in that region. | Grant the read there, or restore the secret. Scrub will not fall back to the stack's own region. |
| `SCRUB_STACKS_FAILED` | Under `--all`, one or more stacks ended in a refusal. | Fix each named stack; the others were still scrubbed. Each stack's own reason was logged as it happened. |
| `STATE_RESOURCES_MALFORMED` | A state record is damaged: its `resources`, `outputs` or `orphans` container, or a record inside one, has the wrong shape. | Inspect it with `cdkd state show '<stack>' --stack-region '<region>' --json` and repair or remove it. |
| `SCRUB_PRODUCER_RECORD_UNREADABLE` | A stack imports from a producer whose own `outputs` map cannot be read. Raised with or without `--fail`, `--dry-run` included. | Repair the producer's record, scrub the producer, then re-run. The importing stack was still scrubbed for everything else. |
| `SCRUB_NESTED_CHILD_UNRESOLVABLE` | A [nested stack](#nested-stacks) has a state record, but scrub could not derive what its parent deployed it with. | Follow the remedy the message names. Every other stack was still scrubbed. |
| `SCRUB_NESTED_TEMPLATE_TREE_MALFORMED` | The nested template tree under a stack is cyclic, too deep or too large, or names an absolute or escaping `aws:asset:path`. | Re-synthesize the app with CDK. Nothing in that stack or under it was written. |
| `SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED` | Scrub had an undeclared output key to [drop](#a-key-the-template-can-no-longer-name-is-dropped), and could not read the bucket listing or another stack's record to confirm nothing reads it. Raised after the summary, with or without `--fail`. | Fix the read (usually an S3 permission, or a damaged record the warning names) and re-run. No key was dropped. |
| `SCRUB_STAGE_LOAD_FAILED` | A CDK Stage's cloud assembly could not be read. Raised before any stack is selected or any state is read, `--dry-run` included. | Re-synthesize the app so the Stage is written, or point `--app` at a complete cloud assembly. See [the failed-Stage note](cli-deploy-safety.md). |
| `SCRUB_LEGACY_STATE_KEY_SURVIVES` | A record in the pre-region layout was rewritten to the region-scoped key, but its old key could not be deleted and still holds the pre-scrub record. | Delete the old key (`<state-prefix>/<stack>/state.json`) by hand, then purge its versions as in [What a real run removes](#what-a-real-run-removes-and-what-it-cannot). A re-run does not detect it again. |
| `SCRUB_LEGACY_STATE_KEY_UNVERIFIED` | The same rewrite, but reading the old key back to confirm the delete failed (a throttle, a 5xx, a denied read). | Check the old key yourself; if it exists, delete it and purge its versions. A re-run does not check it again. |
| `SCRUB_EXPORT_INDEX_INCOMPLETE` | `state.json` was rewritten and an entry of the [exports index](#the-exports-index) was not. | Clear the cause (usually an S3 permission on `{state-prefix}/_index/...`) and re-run. The re-run writes only the entries still differing. |

A `Ref` to a resource absent from state does not refuse. It degrades to a
partial scrub of that record.

### A producer that still stores the plaintext

Scrub can only replace a consumer's stored plaintext with the expression the
producer holds. A producer that has not been scrubbed yet holds the plaintext
itself, so there is no expression to write. Scrub refuses the consumer and
names the producer.

The refusal fires only for an export the templates say carries a secret: one
the producer declares from a `{{resolve:...}}` expression, or re-exports from
a stack further up the chain that does. An ordinary import of a bucket name or
an ARN is unaffected. The exact rules, and four shapes scrub cannot classify,
are in
[cdkd scrub internals](cli-scrub-internals.md#which-exports-count-as-secret-bearing).

### A conditional import

A conditional import does not refuse when its `Fn::If` branch is not selected,
and neither does an `Fn::ImportValue` inside an output that this run's
conditions suppress.

### A damaged state record

`STATE_RESOURCES_MALFORMED` covers these shapes:

| Field | Refused when | An absent field |
| --- | --- | --- |
| `resources` | It is `null` or not an object. | Refused. |
| One row of `resources` | It is not an object, or carries no `resourceType`. | — |
| `outputs` | It is `null` or not an object. | Fine. |
| `orphans` | It is not a list, or holds a record that is not an object, has no string `logicalId` or shares it with another, or whose stored resource entry cannot be read. | Fine. |

A real run refuses the stack, because saving would replace the damaged
container with a well-formed empty one and destroy the evidence. Under `--all`
that is reported as `SCRUB_STACKS_FAILED`.

`--dry-run` cannot write, so it audits the readable containers, warns about
the one it skipped, and still exits `2`. That outranks `--fail`'s `1` on
purpose: `1` would tell you to rotate a secret for a record scrub could not
look at.

`cdkd deploy` and `cdkd destroy` refuse the same shapes themselves.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | State was scrubbed, or there was nothing to scrub. |
| `1` | `--fail` found plaintext of a value the template names through a `{{resolve:...}}` reference. See [`--fail`](#fail). |
| `2` | Scrub refused to examine something, could not classify a producer it imports from, a stack failed outright, the exports index was left incomplete, or the other stacks' state could not be read before a drop. See [Refusals](#refusals). |

The two non-zero codes call for opposite responses. `1` means scrub looked and
found a leak: rotate the secret. `2` means scrub declined to look: fix what
the message names and re-run. A CI gate should treat `2` as "not checked",
never as "plaintext found".

The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Limitations

Two paths do not inherit this redaction. Both apply to
`{{resolve:secretsmanager:...}}` and to a `SecureString` parameter.

- A secret reference used as a nested stack's `Parameters` value is resolved
  by the parent and handed to the child as a literal, so
  `cdkd diff --recursive` decrypts it at plan time. The child's state is still
  redacted by the deploy.
- [`cdkd export`](cli-export.md) writes the resolved value into the exported
  CloudFormation template's parameter value, so the plaintext lands in the
  template it hands to CloudFormation.

## Related

- [`cdkd drift`](cli-drift.md) — how a redacted state record is compared against AWS
- [`cdkd diff`](cli-diff.md) — which stored output values it withholds, and why
- [State Management](state-management.md) — the state records `scrub` rewrites
- [Cross-Stack References](cross-stack-references.md) — the exports index the cross-stack refusals protect
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
