---
title: cdkd state
description: "The cdkd state subcommands — inspect the S3 state store, and orphan, destroy, migrate, or re-baseline the records in it without a CDK app."
---

# cdkd state

`cdkd state` is the command family that talks to cdkd's S3 state store
directly. Every subcommand reads the bucket rather than your CDK app, so none
of them synthesizes and none of them needs the source that deployed a stack —
which is what makes them work from a CI runner after the branch is gone, or
from a laptop that never had the repository. The unit of work is the state
record, not the stack in your app: `cdkd state list` shows everything the
bucket knows about, and `--all` — on `state destroy` and
`state refresh-observed` — acts across the whole estate in one invocation.

```bash
cdkd state info                          # which bucket, which region, how many stacks
cdkd state list                          # one "Stack (region)" per line
cdkd state list --tree                   # parent → child hierarchy for nested stacks
cdkd state resources MyStack             # logical id / type / physical id
cdkd state show MyStack --json           # the whole record, including properties
cdkd state destroy MyStack --yes         # delete the AWS resources, then the record
cdkd state orphan MyStack                # delete ONLY the record; AWS resources survive
cdkd state refresh-observed MyStack      # repopulate the drift baseline without deploying
```

## Subcommands

| Subcommand | What it changes | What it does |
| --- | --- | --- |
| [`info`](#cdkd-state-info) | nothing | Reports the bucket cdkd resolved, its region, where the name came from, and how many records it holds. |
| [`list`](#cdkd-state-list) | nothing | Lists the stacks registered in the bucket, flat or as a nested-stack tree. |
| [`resources`](#cdkd-state-resources) | nothing | Lists one stack's recorded resources. |
| [`show`](#cdkd-state-show) | nothing | Prints one stack's full record — metadata, lock, outputs, resources with properties. |
| [`orphan`](#cdkd-state-orphan) | the state record | Removes a state record and leaves the AWS resources running. |
| [`destroy`](#cdkd-state-destroy) | AWS resources, then the record | Deletes the AWS resources and then the record, with no CDK app. |
| [`migrate`](#cdkd-state-migrate) | the bucket the records live in | Copies a legacy region-suffixed state bucket into the region-free one. |
| [`refresh-observed`](#cdkd-state-refresh-observed) | the state record | Repopulates `observedProperties` — the drift baseline — from live AWS. |

## Shared options

These rows are identical across the subcommands below, apart from
`state migrate`, which takes neither `--state-bucket` nor `--state-prefix`. Each
subcommand's own table lists only what is specific to it.

| Flag | Default | Description |
| --- | --- | --- |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Skip the confirmation prompt. No effect on the read-only subcommands. |
| `--verbose` | off | Verbose logging. |

`--region` is deprecated — prefer `AWS_REGION` or your AWS profile — but it is
still honored if passed, and it is not a no-op.

Two subcommands treat `--region` differently.
[`cdkd state info`](#cdkd-state-info) does not accept it at all, and errors on
it; the region it reports is the bucket's own, detected from S3. On
[`cdkd state migrate`](#cdkd-state-migrate) it is a real selector rather than
the deprecated option: it names which legacy bucket to migrate.

Every subcommand that acts on a named record — all of them except `info`,
`list`, and `migrate` — also takes `--stack-region <region>`, which selects
which of a name's records to use. It is deliberately not spelled `--region`:
the deprecated global option picks the AWS client's region, whereas
`--stack-region` picks which record to act on.

What happens when you omit it and the name has records in several regions is
not uniform across the subcommands, so each one's table below states it.

## `cdkd state info`

```bash
cdkd state info
cdkd state info --json
```

Answers "which bucket is cdkd actually using, and what is in it" — the bucket
name, its region (auto-detected via `GetBucketLocation`), the source the name
came from, the schema version, the record count, and the per-region
`cdkd bootstrap` asset-storage opt-ins.

| Flag | Default | Description |
| --- | --- | --- |
| `--json` | off | Emit the report as a JSON object on stdout, and nothing else. |

Routine commands (`deploy`, `destroy`, `diff`, …) do not print the bucket
banner, because the default bucket name embeds your AWS account id and would
leak through screenshots and public CI logs. `cdkd state info` is the explicit
on-demand answer; `--verbose` surfaces the same name in the other commands'
debug logs.

The `Source:` line names how the bucket was resolved — `--state-bucket flag`,
`CDKD_STATE_BUCKET env`, `cdk.json (context.cdkd.stateBucket)`, or one of the
two defaults. The legacy default is called out as
`default (legacy region-suffixed name; cdkd state migrate recommended)`, which
is the cue to run [`cdkd state migrate`](#cdkd-state-migrate).

This subcommand degrades rather than failing: an unreadable bucket region
reports `unknown`, and an empty bucket or an unparsable record reports an
`unknown` schema version. The reported version is read from one record, not
reconciled across all of them.

## `cdkd state list`

```bash
cdkd state list                # one "Stack (region)" reference per line
cdkd state ls --long           # resource count, last-modified, lock status
cdkd state list --json
cdkd state list --tree         # parent → child tree for nested stacks
cdkd state list --tree --json  # the same tree, nested JSON
```

| Flag | Default | Description |
| --- | --- | --- |
| `-l`, `--long` | off | Show resource count, last-modified time, and lock status per stack. |
| `--tree` | off | Render the parent → child stack tree. Rejected together with `--long`, at parse time. |
| `--json` | off | Emit the listing as JSON. Composes with `--long` and with `--tree`. |

`ls` is an accepted alias. Note that `cdkd list` (also aliased `ls`) is a
different question — it lists stacks from the local CDK app via synthesis, for
CDK CLI parity, whereas `cdkd state list` reports what is registered in the S3
bucket.

**`cdkd state list`'s stdout is a payload in every mode, `--json` or not.** The
default one-reference-per-line shape is exactly what a `while read -r ref` loop
consumes, so everything cdkd's logger prints goes to stderr instead. The other
subcommands with a `--json` mode (`resources`, `show`, `info`) keep the
`--json` gate, because their flagless output is a formatted human view rather
than a record set. See
[Output streams: when stdout is a payload](cli-reference.md#output-streams-when-stdout-is-a-payload).

`--tree` walks each record's v6 `parentStack` / `parentRegion` fields, which a
nested-stack deploy and the recursive
`cdkd import --migrate-from-cloudformation` both populate, to draw
`tree(1)`-style box-drawing:

```text
NestedStackDeep (us-east-1)
└── NestedStackDeep~Child (us-east-1)
    └── NestedStackDeep~Child~Grandchild (us-east-1)
```

Flat output stays the default so scripts that grep `cdkd state list` keep
working. A child whose parent record is missing — parent destroyed
out-of-band, or state hand-deleted — surfaces at the root rather than
vanishing. `--long` and `--tree` both read every record, so they cost extra
S3 requests per stack — two for `--long` (the record and its lock), one for
`--tree`. The plain listing reads none of them.

The equivalent low-level query, when you want it without cdkd:

```bash
aws s3 ls s3://cdkd-state-bucket/cdkd/ --recursive \
  | grep state.json \
  | awk '{print $4}' \
  | sed 's|cdkd/||; s|/state.json||'
# Output: <stackName>/<region>, one row per (stackName, region) pair.
```

## `cdkd state resources`

```bash
cdkd state resources MyStack
cdkd state resources MyStack --long
cdkd state resources MyStack --json
```

Lists what cdkd recorded for one stack, sorted by logical id. The default view
is three aligned columns — logical id, resource type, physical id — with no
header row, which makes it pipe-friendly.

| Flag | Default | Description |
| --- | --- | --- |
| `-l`, `--long` | off | Expand each resource into a block including its dependencies and attributes. |
| `--json` | off | Emit the resource array as JSON. Takes precedence over `--long`. |
| `--stack-region <region>` | — | Region of the record to read. Omitting it on a name with records in several regions is an error. |

### What the human views do to a malformed record

A state record is read as JSON and used as typed data without a field-by-field
shape check, so a hand-edited one can hold anything. Both human views of
`cdkd state resources` and every row of `cdkd state show` therefore treat what
they print as untrusted text:

- **Control characters are removed from every name, type, id, dependency list
  and nested-stack header.** Two rows take no removal here because neither
  needs it: the lock row's `owner` and `operation` are sanitized where the
  lock record is read, before `cdkd state show` sees them, and `Version` is
  refused where the state record is read unless it is a known schema number or
  absent. The rows of these views are joined by newlines, so a newline inside
  a field would not merely colour the output — it would invent a row that
  reads exactly like a real one. The escape BYTE is removed and the characters
  around it are kept, so a name carrying `ESC[31m` prints as `[31m`: the
  sequence is broken, the name is not censored.
- **A value whose type the record got wrong still prints, rather than ending the
  output.** A number where a string belongs prints as that number, an object as
  JSON, and a value nothing can serialize as `(unserializable)`. A few fields are
  decided before any of that: a falsy `region` omits its whole row, a falsy
  `parentRegion` drops only the parenthesized region from the `Parent:` row, and
  an absent or null `provisionedBy` reports the legacy default. A
  `lastModified` that cannot be read as a time prints as itself instead of an
  instant. In `cdkd state show`, a
  `dependencies` that is not a list prints as itself, and `(none)` is supplied
  only for an absent one or an empty list; `cdkd state resources --long` supplies
  it for a `null` too, so the two views differ on that one value. The marker is
  ordinary text, so a record whose dependency list literally contains `(none)`
  renders the same thing -- read `--json` when you need to tell them apart.
- **The refusals these views raise are held to the same rule.** When a record
  is malformed enough that the view refuses instead of rendering, the message is
  where the record's own text appears — an unreadable `state.json` or `lock.json` is quoted back by
  the JSON parser, an ambiguous stack has its regions listed, and a nested-stack
  walk names the child it could not find. cdkd's output is line-oriented, so
  the same removal applies there: the diagnostic reports the bad
  value flattened onto one line rather than letting it invent a row. Anything
  that strips to nothing is reported as an explicit placeholder rather than an
  empty slot, and the underlying cause a refusal reports is flattened the same
  way. This covers the refusals these two commands raise; an error reaching you
  from the AWS SDK itself is that service's own text.
- **`--json` applies none of this**, and is the mode to reach for when you need
  the stored value rather than a readable one. It is not byte-for-byte in every
  mode: `cdkd state show` emits the record as parsed, while
  `cdkd state resources --json` substitutes an empty list or object for an absent
  `dependencies` or `attributes`, and the lock `cdkd state show` reports has already
  had its `owner` and `operation` put through the shared display sanitizer
  (`cdkd state resources` never reads a lock).

This tolerance covers the VALUES these views render. A record can still be
malformed in a way that fails earlier than that — a `resources` entry holding
`null` rather than a resource, or a lock whose `expiresAt` holds an object that
cannot be coerced to a number — and there the command reports an error and
renders nothing.

Plain `cdkd state show --json` is the way to read such a record: it emits the
record as parsed, without walking it or rendering a lock summary. The other two
JSON modes walk the resources before emitting anything, so the `null` resource
entry fails `cdkd state resources --json` and
`cdkd state show --show-nested --json` as well. The lock case does not reach
them: neither renders a lock summary.

**Resource properties are deliberately excluded from every mode here** — use
[`cdkd state show`](#cdkd-state-show) when you need them. A physical id may be
a composite, pipe-delimited value for resource types AWS identifies by more
than one field; see
[State Management](state-management.md#composite-pipe-delimited-physicalids)
for what those mean and why they are not what `Ref` returns.

## `cdkd state show`

```bash
cdkd state show MyStack
cdkd state show MyStack --json
cdkd state show MyParent --show-nested
cdkd state show MyParent --show-nested --json
```

The deepest read: stack metadata, the lock record, outputs, skipped outputs,
and every resource with its properties, attributes, dependencies, and
`provisionedBy` routing.

### Skipped outputs

A `Skipped outputs:` block appears when `skippedOutputs` contains entries. Its
rows are the Outputs keys the last deploy could not resolve, each mapped to a
digest of that output's template inputs.

It sits after `Outputs:` where that section is rendered at all. `Outputs:` is
omitted when the outputs bag is empty, which includes the first-deploy case
this record exists for, every output having failed — so the two blocks do not
always appear together:

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

The explanation sits at column zero, unlike the key rows, so it cannot be
mistaken for another entry. Under `--show-nested` it is printed ONCE for the
whole tree rather than after every child that skipped something.

This block is the reason to look here rather than at `cdkd diff`: a suppressed
key gets **no diff row and no warning**, so the text view is where the
explanation lives. Suppression takes both conditions above — the record still
binding, and the key still absent from the stored outputs.

For an output whose resolver THREW, the deploy's own warning already names it;
for one that merely resolved to `undefined` there is no per-output warning at
all. For such a key while it is ABSENT from the stored outputs, this block is
the first place it is named in the human-readable view without `--verbose`,
which logs the same decision from `cdkd diff` at debug level. A key whose earlier
value was retained is ALSO stored under `Outputs:` — it appears in both
sections — and is NOT suppressed by the record. It takes the ordinary resolve
path, which can end in `cdkd diff` suppressing its whole Outputs section with
a warning if the key fails again. `--json` and the stored `state.json` carry the
record either way.

The digest is TRUNCATED to 12 characters here, after control characters are
stripped — so an ESC costs no preview space, though a sequence's printable
tail (`[2J`) still does. One value is exempt: `(unserializable)`, which is
what prints for a digest nothing can serialize, is longer than the window and
is shown whole, because cut to `(unserializa…` it would read as a hash prefix.
A trailing `…` marks a value that was actually cut, so a value exactly 12
characters long is not mistaken for a truncated one. A prefix DIFFERENCE tells
you at a glance that two records differ; a prefix MATCH proves nothing, so
compare digests through `--json`, which carries them whole, as does the stored
`state.json`.

The block is omitted when the field is present but empty, and when it is
absent. Absence means only that no skipped set was RECORDED, not that nothing
was skipped: records written before the field existed never carried one, and
several state writers deliberately drop it. The `--json` shape is unchanged
either way.

| Flag | Default | Description |
| --- | --- | --- |
| `--json` | off | Emit the raw state record and lock as JSON. |
| `--show-nested` | off | Recursively include every nested-stack child under the target. |
| `--stack-region <region>` | — | Region of the record to read. Omitting it on a name with records in several regions is an error. |

`--show-nested` reuses the same recursive walker as `cdkd export`: for every
`AWS::CloudFormation::Stack` row in the target's resources it derives the child
key `<parent>~<childLogicalId>`, loads
`cdkd/<parent>~<childLogicalId>/<region>/state.json`, and recurses. Each
descendant's block follows the parent's in depth-first order, flat at column
zero rather than indented, behind its own header:

```text
Stack: MyParent
  ...

Nested stack: MyParent~Child
Stack: MyParent~Child
  ...
```
 It fails
fast on a torn tree — a parent listing a nested-stack row whose child record
does not exist — rather than printing a partial tree. Repair it by re-deploying
the parent, by finishing whatever partial operation tore it, or, failing both,
by [`cdkd state orphan <parent>`](#cdkd-state-orphan) and re-importing.

The `--json` shape under `--show-nested` is recursive
`{state, lock, children: [...]}`, with `children` always present (an empty
array on leaves) so the key set is stable. Without `--show-nested` the
single-stack `{state, lock}` shape is preserved verbatim, so existing tooling
keeps working.

A held lock never blocks any of the read subcommands; `show` reports it as part
of the record.

## `cdkd state orphan`

```bash
cdkd state orphan MyStack
cdkd state orphan MyStack --stack-region us-east-1
cdkd state orphan StackA StackB --force
```

Removes cdkd's state record for one or more stacks and **leaves every AWS
resource running**. After this, cdkd no longer knows the stack exists; the
resources become untracked rather than deleted.

| Flag | Default | Description |
| --- | --- | --- |
| `<stacks...>` | — | Stack name(s) to orphan, as physical CloudFormation names. At least one is required. |
| `-f`, `--force` | off | Skip the confirmation prompt **and** remove the record even when the stack is locked. |
| `--stack-region <region>` | — | Orphan only the record in this region. Omitting it removes every record for the name — `orphan` does not refuse an ambiguous name. |

`-y` / `--yes` skips the prompt but does *not* bypass the lock guard; only
`--force` does both. A locked stack otherwise fails with the exact
`cdkd force-unlock` command to run first. Orphaning a stack that has no record
is a no-op, not an error, so the command is safe to re-run.

Force-releasing a lock this way deletes whatever lock is present, including a
live one belonging to an in-flight deploy — deliberately, so a stuck lock can
never make a record unremovable. The command warns when it is about to do that.

When to reach for it, and when not to:
[Orphan vs Destroy](orphan-vs-destroy.md) draws the line against `cdkd orphan`,
which is synth-driven and works per resource;
[Cross-Stack References](cross-stack-references.md#what-about-cdkd-state-orphan)
explains why it is the wrong tool for escaping a strong-reference destroy
block.

## `cdkd state destroy`

```bash
cdkd state destroy MyStack --yes
cdkd state destroy StackA StackB --yes
cdkd state destroy --all --yes
cdkd state destroy MyStack --remove-protection --yes
```

Deletes a stack's AWS resources and then its state record, reading the record
instead of synthesizing — the CDK-app-free counterpart of `cdkd destroy`. Both
run the identical per-stack pipeline, so the data guards, `DeletionPolicy`
handling, strong-reference blocks, lock behavior, and exit codes are the same.

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to destroy, as physical CloudFormation names. Required unless `--all` is given. |
| `--all` | off | Destroy every stack in the state bucket. |
| `--remove-protection` | off | Turn per-resource deletion protection off in place before deleting. |
| `--skip-final-snapshot` | off | Delete `DeletionPolicy: Snapshot` resources without taking the final snapshot. |
| `--allow-unsupported-types <types>` | — | Comma-separated escape hatch routing otherwise-unprovisionable types through Cloud Control. |
| `--resource-warn-after <duration>` or `<TYPE>=<duration>` | `5m` | Warn when one resource operation has been running longer than this. Repeatable. |
| `--resource-timeout <duration>` or `<TYPE>=<duration>` | `30m` | Abort one resource operation that exceeds this. Repeatable. |
| `--stack-region <region>` | — | Act on the record in this region, plus any record that does not name a region at all. A name whose only record is elsewhere is warned about and skipped; omitting the flag on a name with records in several regions is an error, `--all` included. |

Three differences from `cdkd destroy` are worth knowing before you script it:

- **Names only.** Nothing is synthesized, so stacks are matched by physical
  CloudFormation name — CDK display paths and wildcards are not available. A
  nested-stack child can be targeted directly by its `<parent>~<child>` name.
- **No `-f` / `--force`.** `-y` / `--yes` is the only way to skip the prompts.
- **No `--purge-events`.** Use [`cdkd events prune`](cli-events.md) to drop
  deployment-event history for a stack instead.

Naming a stack that has no record at all is an error, not a silent skip.

`--all` raises a single batch prompt listing every stack before anything is
touched, and the per-stack prompts are then skipped. Interrupting at that
prompt exits `130` with nothing read, locked, or deleted.

The flag semantics, the data guards, and the confirmation matrix are documented
once, on the destroy page:
[Destroy flags & guards](cli-destroy.md) — in particular
[stack selection](cli-destroy.md#stack-selection),
[confirmation prompts](cli-destroy.md#confirmation-prompts),
[`--remove-protection`](cli-destroy.md#remove-protection-bypass-deletion-protection-on-destroy),
and [skipped resources](cli-destroy.md#skipped-resources-on-destroy).

Note that `cdkd state destroy` records no deployment events at all — see
[Deployment Events](deployment-events.md).

The two per-resource duration flags behave exactly as they do on deploy; they
are documented on
[Deploy: tuning](cli-deploy-tuning.md#per-resource-timeout).

## `cdkd state migrate`

```bash
cdkd state migrate --region us-east-1 --dry-run
cdkd state migrate --region us-east-1
cdkd state migrate --region us-east-1 --remove-legacy
```

Copies a legacy region-suffixed state bucket (`cdkd-state-{account}-{region}`)
into the region-free default (`cdkd-state-{account}`). This is a bucket-name
migration, not a schema or key-layout one: objects are copied key-for-key and
no record body is rewritten.

| Flag | Default | Description |
| --- | --- | --- |
| `--region <region>` | `AWS_REGION` / `us-east-1` | Which legacy bucket to migrate. Run the command once per region you have one in. |
| `--legacy-bucket <name>` | derived from the account and region | Override the source bucket name. |
| `--new-bucket <name>` | `cdkd-state-{accountId}` | Override the destination bucket name. |
| `--dry-run` | off | Stop before any mutation, after reporting what would be copied. |
| `--remove-legacy` | off | Delete the source bucket after the copy is verified. Irreversible: it empties every object version and delete marker first, so the source bucket's version history is gone. |

`migrate --dry-run` prints its plan — the two bucket names, the source
bucket's real region, and the object count — and stops there without asking
for confirmation, so it is safe to run unattended.

The migration is idempotent: the destination is reused when it already exists,
each object copy is idempotent per key, and the post-copy verification tolerates
a destination that already holds objects, so a re-run resumes a partial
migration. The source bucket is kept unless `--remove-legacy` is passed, and it
is only deleted after the object count at the destination has been verified.
Leave it in place until you are satisfied with the migrated bucket — that
deletion is the one step here you cannot undo.

It refuses to start while any `lock.json` exists in the source bucket, naming
the offending keys — wait for the in-flight operation, or clear a stale lock
with `cdkd force-unlock`.

The full behavior list, the destination bucket's hardening, and the manual
`aws s3 sync` fallback are on
[State Management](state-management.md#migration-path-cdkd-state-migrate).

## `cdkd state refresh-observed`

```bash
cdkd state refresh-observed MyStack
cdkd state refresh-observed --all --dry-run
cdkd state refresh-observed --all --yes
```

Repopulates `observedProperties` for every resource in a stack by reading each
one back from AWS, without deploying. `observedProperties` is the drift
baseline: the snapshot of what AWS actually held, including AWS-managed
defaults and keys your template never set.

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to refresh, as physical CloudFormation names. Required unless `--all` is given. |
| `--all` | off | Refresh every stack in the state bucket. |
| `--dry-run` | off | Print the per-stack refresh count without taking a lock, reading resources back from AWS, or writing state. The records themselves are still read from S3. |
| `--stack-region <region>` | — | Region of the record to refresh. Omitting it on a *named* stack with records in several regions is an error; under `--all` the flag is a filter instead, and omitting it refreshes every region. |

Why it exists: `cdkd deploy` already maintains the baseline in two ways — it
captures a fresh one for every resource it creates, updates, or replaces, and
it reads back any resource whose baseline is missing, including ones that
deploy left unchanged. Both of those reach only the resources whose provider
can read state back. What deploy does not do is re-read a resource that was
unchanged *and* already had a baseline; that one keeps whatever was captured
the last time the resource was touched, however long ago.

This command re-reads the whole stack on demand, so it covers that case, and
it is how you refresh a baseline without deploying at all — including on a
stack deployed with
[`--no-capture-observed-state`](cli-deploy-tuning.md#no-capture-observed-state),
where nothing was captured in the first place.

The baseline is what makes the comparison thorough. With one present,
`cdkd drift` walks the union of the recorded and the live keys, so a
console-side edit to a key your template never mentions still surfaces;
without one, it falls back to comparing only the keys in state.

**One kind of resource this command deliberately declines.** If a
[`cdkd import`](import.md#the-drift-baseline-an-import-records) run refused to
capture a baseline — because that resource's recorded properties can no longer
position the secret redaction — the refusal is recorded on the record, and this
command skips it rather than reading a value back against those properties,
which could persist a resolved secret into `state.json` in plaintext. Such
resources are counted and reported separately from `unsupported` ones, and
`cdkd state show` marks each with an `ObservedBaseline: REFUSED` line. Re-running
this command will not clear it: **deploy a change to the resource**, which
rebuilds its record from your template and captures a real baseline.

Run [`cdkd scrub`](cli-scrub.md) first on state written by a pre-GHSA binary.
The readback is redacted **by position** against the existing record: the
record's own properties are expected to hold the unresolved
`{{resolve:secretsmanager:...}}` expression, which is written back over the
decrypted value AWS echoes. A record whose properties already hold plaintext
has nothing to redact from.

Where the readback and the record cannot be lined up at a reference-bearing
position — AWS restructured the property, normalised a list element's identity
field, reordered a list, or the record holds a raw `Fn::Join` object where the
readback holds a string — cdkd cannot tell a resolved secret from an ordinary
literal, so it writes the mask `***` at that position rather than the value AWS
reported. Such a position then reports as drifted on every `cdkd drift` run and
is refused by `--accept`; a `cdkd deploy` of the resource repairs it. See
[Redacted baselines](cli-drift.md#the-other-cause-of-a-masked-baseline-a-position-cdkd-could-not-certify).

Resources whose provider cannot read current state, and resources AWS reports
as not found, are counted as unsupported and keep their previous baseline —
a transient not-found can never null one out. Per-resource read failures are
reported individually and make the run exit `2`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success, including a declined confirmation prompt and a no-op run. |
| `1` | The command failed — missing record, ambiguous region, lock contention, a refused prompt in a non-interactive shell, or an AWS/S3 error. |
| `2` | Partial completion. `state destroy`: per-resource delete failures, skips, or an interruption with targets left. `state refresh-observed`: per-resource readback failures. |
| `130` | Interrupted at the `state destroy --all` batch prompt, or by a second Ctrl-C during a destroy. |

Every mutating subcommand refuses its confirmation prompt with exit `1` in a
non-interactive shell rather than hanging or assuming yes — pass `-y` / `--yes`
(or `--force`, for `state orphan`) to run it unattended. The full cross-command
table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [State Store](state-store.md) — the same subject, summarised for a first read
- [State Management](state-management.md) — the record schema, the key layout, and the lock mechanism
- [Orphan vs Destroy](orphan-vs-destroy.md) — which of the four cleanup commands to reach for
- [Destroy flags & guards](cli-destroy.md) — the guards and prompts `cdkd state destroy` inherits
- [`cdkd drift`](cli-drift.md) — the comparison `state refresh-observed` supplies the baseline for
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
- [Troubleshooting](troubleshooting.md) — what to do when a state record and AWS disagree
