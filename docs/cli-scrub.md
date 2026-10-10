---
title: cdkd scrub
description: "State secret hygiene — clean secrets out of persisted state and audit it with cdkd scrub."
---

# cdkd scrub

`cdkd scrub` rewrites persisted cdkd state so a resolved secret is stored as
its `{{resolve:...}}` expression instead of its plaintext value, and audits
that state stays that way. Reach for it after upgrading cdkd on a stack you do
not want to re-provision, whenever you suspect a state file predates a
redaction fix, and as a standing CI gate. It creates, updates and deletes no
AWS resource; what it writes is the state bucket — each targeted stack's
`state.json` (and those of the [nested stacks](#nested-stacks) under it), and
the entries a scrubbed stack publishes in the shared
[exports index](#the-exports-index).

```bash
cdkd scrub MyStack                        # rewrite plaintext secrets to {{resolve:...}}
cdkd scrub MyStack --dry-run              # report what would change, write nothing
cdkd scrub MyStack --dry-run --fail       # CI gate: exit 1 if a {{resolve:...}}-referenced value is still plaintext
cdkd scrub --all                          # every stack in the app, producers first
cdkd scrub MyStack --verbose              # explain a stack that reports clean
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to scrub. Physical name or CDK display path. The [nested stacks](#nested-stacks) under each are scrubbed too. |
| `--all` | off | Scrub every stack in the synthesized app, Stage stacks included. |
| `--dry-run` | off | Report what would be scrubbed without writing state. |
| `--fail` | off | Exit non-zero when plaintext of a value the template names through a `{{resolve:...}}` reference is found (a [physical name derived from one](#how-secrets-stay-out-of-state) aside, except in an output or exports index entry the template no longer declares). With `--dry-run`, any such plaintext; on a real run, a leak scrub cannot rewrite. |
| `--purge-history` | off | Also purge the earlier S3 versions of every `state.json` the run examined, not only the ones it rewrites. Drops those records' state-recovery history; a record scrub refuses is never purged; cannot be combined with `--dry-run`. See [What a real run removes](#what-a-real-run-removes-and-what-it-cannot). |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Accepted for consistency with the other mutating commands; `cdkd scrub` asks no confirmation, so it changes nothing. |
| `--verbose` | off | Verbose logging. Turns on the per-read detail behind a stack that reports clean. |

`--region` is deprecated — prefer `AWS_REGION` or your AWS profile — but it is
still honored if passed, and it is not a no-op.

A stack argument that matches nothing is refused with the patterns and the
stacks the app does have. A CDK `Stage` whose cloud assembly cannot be read
stops the run before any stack is selected, whatever was named, so scrub never
reports the state clean over the stacks that did load
([the failed-Stage note](cli-deploy-safety.md)). That is a refusal, exit `2`
(`SCRUB_STAGE_LOAD_FAILED`): scrub declined to look, so a gate must not read it
as `--fail`'s `1`, plaintext found.

`cdkd scrub` takes no `--parameters`, which is load-bearing in two places
below: which `Fn::If` branch it evaluates, and which `Export.Name` values it
can compute.

## `cdkd scrub` (state secret hygiene: clean + audit)

Two modes, both useful long after any one-time cleanup:

- **Clean** — rewrite existing state in place, WITHOUT redeploying. This is
  what you run after upgrading cdkd on a stack you do not want to
  re-provision, or any time you suspect a state file predates a redaction fix.
- **Audit** — `--dry-run --fail` exits `1` when a value the template names
  through a `{{resolve:...}}` reference is still in state as plaintext (a
  physical name derived from one aside — see
  [How secrets stay out of state](#how-secrets-stay-out-of-state)), so it
  works as a standing CI gate rather than incident-only tooling. Secrets landing in infrastructure state is a structural, recurring
  concern — the same class Terraform has — so it is worth asserting
  continuously.

```yaml
# CI: fail the build if any cdkd state file holds a {{resolve:...}}-referenced value in plaintext.
- run: cdkd scrub --all --dry-run --fail
```

A normal `cdkd deploy` scrubs state this way as a side effect, so a green gate
is the expected steady state rather than something you have to maintain. What
that first deploy under a fixed binary does is SUPERSEDE the legacy plaintext
`state.json`, not erase it: on a versioned state bucket the earlier versions
may still hold the plaintext, readable with `GetObject` and a `VersionId`, and
a deploy never purges them, because they are also the state-recovery history.
So a green gate means the CURRENT object is clean and nothing more. To remove
those earlier versions, run `cdkd scrub --purge-history` while the stack is
still deployed: a plain `cdkd scrub`
purges a key's history only when it rewrites that key, and a record a deploy
already rewrote has nothing left to rewrite. See
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot).

## How secrets stay out of state

cdkd resolves CloudFormation dynamic references —
`{{resolve:secretsmanager:...}}`, and `{{resolve:ssm:...}}` pointing at a
**SecureString** parameter — to their concrete value so the secret can be
handed to the AWS API on create or update. When the DEPLOY path persists state,
it stores the UNRESOLVED expression rather than the resolved plaintext, so the
secret does not land in the `state.json` a deploy writes, nor in
`cdkd state show`, `cdkd diff` or `cdkd drift` output for such a record.

That describes what the deploy path is designed to do; it is not a guarantee
about `state.json`. The redaction substitutes only at positions it can certify
against the template, and where it cannot — a readback whose container was
reshaped, an identity key AWS normalised, a bag refreshed with no recorded
secrets to match on — it leaves the value it was handed. That configuration is
reachable on the deploy path itself, through the observed-properties refresh of
an unchanged resource. Other commands widen it further: `cdkd state
refresh-observed` when the stored properties hold a raw intrinsic shape rather
than the reference as a string, and `cdkd import` for the `attributes` bag it
captures from a live read.

So treat a value ever persisted in plaintext as compromised and rotate it, and
run `cdkd scrub --dry-run --fail` as a standing check rather than assuming any
command never writes one.

That is a statement about what cdkd WRITES from here on. It says nothing about
a `state.json` version an older binary already wrote: on a versioned state
bucket the next deploy supersedes such a version rather than removing it — see
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot).

This matches CloudFormation, which keeps the reference in the template and
resolves it service-side. Two consequences follow: a rotated secret behind an
unchanged reference is a no-op on the next deploy, again matching
CloudFormation, and `cdkd diff` makes no live secret fetch.

Neither the redaction nor `cdkd scrub` covers a secret the template never
names through a `{{resolve:...}}` reference. The drift baseline records what
AWS returns, so a password an operator set out of band over a placeholder
literal is stored as AWS returned it, and scrub, which learns a secret's value
only from a reference, cannot see it. That is by design; see
[A value your template never references](#a-value-your-template-never-references).

Nor do they cover a physical name derived from a secret — a
`{{resolve:...}}` reference or a `NoEcho` parameter in a name or other
identifier property. The name is the resource's identity, so its `physicalId`
holds it, and other resources' resolved `Ref`, `Fn::GetAtt` and `Fn::Sub`
copies of it, and the outputs and exports index entries that carry it, are
stored as resolved. `cdkd scrub` does not rewrite the physical id or other
resources' recorded copies, and reports those records clean. Leftovers that
carry the name are the exception:

- an output key the template no longer declares is rewritten to the
  expression where it holds or embeds the secret's resolved value, and is
  otherwise handled like any undeclared key;
- another resource's `orphans` record is rewritten the same way (its stored
  bags; not its physical id);
- an exports index entry with no output left is reported when it holds a
  recorded secret's value.

The resource's own properties keep the reference (`***` for a `NoEcho`
parameter).
CloudFormation does the same; keep secrets out of identifier properties, as
[its documentation advises](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references.html).

## What scrub needs, and what it changes

**It needs the CDK app.** Unlike the `cdkd state ...` family, `scrub` requires
`--app` (or `CDKD_APP` / `cdk.json`), because a state file records the
resolved value with no marker of which values are secrets — only the template
carries the `{{resolve:...}}` references.

So `scrub` synthesizes the template, re-resolves each resource's properties to
learn the resolved secret VALUES — recorded in memory, never printed and never
re-persisted — and replaces those values in the state record's `properties`,
`attributes` and `observedProperties` with the expression.

### Rollback-orphan records

A rollback that leaves a `DeletionPolicy: Retain` resource behind records what
it left, as `orphans` in the state file. Each record carries a whole resource
state — `properties` and `attributes` — so `scrub` examines it too.

Those records need their own treatment, because the sentence that opens this
section does not hold for them: an orphan's logical id may be GONE from the
template, which is what happens when you remove the failing resource from your
CDK app. There is then nothing to re-resolve for it. So `scrub` derives that
record's secrets from the record ITSELF — any `{{resolve:...}}` expression it
still holds — in addition to every secret the run learned from the live
resources and outputs.

Both sources are needed, and they cover different failures. The record's own
expressions find a secret in a record the template can no longer describe. The
run-wide set finds a PLAINTEXT the write side should have replaced and did not
— that value carries no expression to derive from, but it is usually the same
secret a live resource still references.

One gap remains, and a clean verdict does not rule it out: a record whose
logical id is gone from the template AND which holds plaintext matches neither
source, because nothing in the run knows that plaintext. `cdkd diff` will still
show you the record, and `cdkd state show` prints it.

It performs no AWS create, update or delete. What it WRITES is the state
bucket: each targeted stack's `state.json`, under that stack's lock, and then
the entries that stack publishes in the shared
[exports index](#the-exports-index) — as a separate step, after the lock is
released, because the lock guards one stack's `state.json` while `exports.json`
is a region-wide object with its own optimistic lock. On a versioned state
bucket it then purges the earlier versions of each key it rewrote — see
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot).

## Multi-stack runs (`--all`)

`cdkd scrub --all` scrubs **producers before consumers**, using CDK's own
stack dependencies plus raw `Fn::ImportValue` / `Fn::GetStackOutput` edges
inferred from the templates. One run therefore normally scrubs a producer and
then resolves its expression in the consumer.

A refusal is per stack: the remaining stacks are still scrubbed, and the run
ends non-zero naming the ones it could not examine — including each nested
stack under a stack that failed, which is refused rather than scrubbed. The summary line never
counts a stack the run could not reach.

`--dry-run` writes nothing, so the producer is never rewritten — a dry run
over a not-yet-scrubbed producer is exactly where the producer-plaintext
refusal below is expected.

## Nested stacks

A nested stack (`cdk.NestedStack`) keeps its own state record, at
`<state-prefix>/<Parent>~<Child>/<region>/state.json`, but it is not a stack of
the synthesized app, so it cannot be named on the command line. **Scrubbing a
stack scrubs every nested stack under it**, at any depth, each one right after
the stack that deploys it and under its own lock. `cdkd scrub --all` and the
`--dry-run --fail` CI gate therefore cover nested stacks too. A stack argument
spelled like a child's state name (`Parent~Child`) matches nothing, and the
refusal names the parent to pass instead.

A child's template consumes a secret through a parameter — `{Ref: DbPassword}`
— so the child alone does not say which values are secrets. `scrub` learns them
from the PARENT: it resolves the `Parameters` the parent passes the child, and
scrubs the child with those values and the secrets they came from, exactly as a
deploy hands them down. A secret is looked for in the records of the child
resources that consumed the parameter, not in an unrelated resource whose
literal merely contains the same text. This is what repairs a child record a cdkd
older than the nested-parameter redaction wrote with the decrypted secret — a
record no redeploy rewrites while the child's resources stay unchanged.

When `scrub` cannot derive what a child was deployed with, a child that HAS a
record is refused with `SCRUB_NESTED_CHILD_UNRESOLVABLE` (exit `2`) rather than
reported clean. The message says which cause applies:

- the parent's template no longer declares the child — deploying the parent
  destroys the child, record included;
- the parent's record has no row for the child — deploy the parent so it
  records the row, then re-run `scrub` (if a `Condition` keeps the row out of
  the deploy, the child record is left over: remove it);
- no row in the parent's template or record reaches the record at all — the
  parent's own record was removed (`cdkd state orphan <Parent>` removes only
  the parent's key), or both sides dropped the row. `scrub` finds these by
  listing the state records under `<Parent>~` in the parent's region, and
  refuses each one, its own nested records included;
- the scrub of the stack that deploys it failed — that failure is reported
  too; fix it and re-run;
- a value in the `Parameters` the parent passes could not be resolved, or the
  child's own parameter declaration rejects it — the message, or `--verbose`,
  shows which value;
- the synthesized template names no template file for the child's row.

A child that never had a record is skipped silently. A stack argument spelled
like a child's state name that matches nothing is warned about even when other
arguments matched, since it was not scrubbed.

The parent's own row mirrors each child output as an `Outputs.<Name>`
attribute, and on a parent record older than the redaction of nested-stack
outputs that attribute can hold the plaintext of a child output sourced from
the CHILD's own `{{resolve:...}}`. The parent is scrubbed before its children
and has no needle for it, so after each child's scrub `scrub` re-opens the
parent's record, under the parent's lock, and rewrites such an attribute to
the child's output — reported as `Scrubbed N nested-stack output attribute(s)
in <Parent>`. It rewrites one only when the attribute is EXACTLY what the
child's output resolves to in this run, so an unrelated value is never
touched. An attribute that still holds a plaintext this run recorded but does
not match any output exactly is reported instead, and like the rewrite it keeps
`--dry-run --fail` red; deploying the child rewrites it. The parent's own
per-stack line says it covers the parent's own records only.

A nested template tree
that is cyclic or points outside the assembly is refused for the whole stack
before anything is written, with `SCRUB_NESTED_TEMPLATE_TREE_MALFORMED`; any nested
record under that stack is refused as well.

Rewriting a child's record, or the parent's row, is purged like any other: on
a versioned state bucket the earlier versions of each key scrub rewrote are
deleted — see
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot).

## Rotate the secret — and scrub first

**Scrubbing does not un-expose an already-leaked secret.** A value that was
ever stored in plaintext should be treated as compromised and ROTATED in
Secrets Manager; `scrub` only stops it being read back out of state going
forward.

**Run `scrub` BEFORE rotating.** It matches the CURRENT resolved secret value
against what state holds, so once the secret is rotated the stale value in
state no longer matches and `scrub` cannot rewrite it. In most positions it
then reports nothing to scrub; a cross-stack read name is the exception, and is
reported while your template still reads a secret-bearing name of its shape (see [What this does not repair](#what-this-does-not-repair)). The
rotation invalidates the stale value; a redeploy then rewrites the record with
the expression.

### What a real run removes, and what it cannot

`scrub` rewrites `state.json` and the exports index, never a stack's
`rollback-journal.json`, which holds copies of state records. A nested stack
keeps its journal after a successful deploy until its top-level stack's deploy
succeeds, so a value a scrub repairs can survive there until then.

`scrub` rewrites `state.json` with a plain S3 `PutObject`, and `cdkd bootstrap`
turns **versioning** on for the state bucket (it skips that step for a bucket
that already existed, unless you pass `--force`, so confirm with
`aws s3api get-bucket-versioning --bucket <state-bucket>` if you supplied your
own). Where versioning is on, the rewrite makes the pre-scrub body a
NONCURRENT VERSION of the same key, readable — plaintext and all — to anyone
who can `GetObject` the key with a `VersionId`.

So after each `state.json` it rewrites, a real `cdkd scrub` **purges that
key's noncurrent versions**, keeping only the current object. It does
the same for the shared exports index at
`{state-prefix}/_index/{region}/exports.json`, once per region whose entries it
rewrote. That object is shared by every cdkd-managed stack in the region, so
its purged history includes other stacks' earlier entries; nothing is lost by
that, because the index is a derived view that cdkd rebuilds from the state
records. The index is purged after any write scrub attempted on it, failed or
not, because its history has no recovery value. A `state.json` is purged when
its write succeeded or may have landed: a server error other than a throttle, a
timeout, a dropped connection, or any failure the SDK reached after retrying
(an earlier attempt may have committed). A definite refusal on the FIRST
attempt, such as a precondition failure or a denied `PutObject`, wrote nothing,
so that record keeps its history. On an unversioned bucket there is nothing to
purge. A record still in the pre-region
layout (`<state-prefix>/<stack>/state.json`) is migrated by the rewrite, as
any other state write migrates it: written to the region-scoped key, the old
key deleted, and the old key's earlier versions purged too. If that delete
fails, the old key still holds the pre-scrub record as its current object, so
the stack fails with `SCRUB_LEGACY_STATE_KEY_SURVIVES` rather than being
reported scrubbed.

What the purge does NOT reach, so what `Done: scrubbed ...` does not claim:

- **A key `scrub` did not rewrite, unless you pass `--purge-history`.** A
  record that is already clean — for example because a `cdkd deploy` under a
  fixed binary rewrote it first — is not written, so by default its earlier
  versions are kept as its recovery history. `--purge-history` purges them for
  every record the run examined: each target stack and every nested stack under
  it that has a readable record. A stack with NO current record — destroyed,
  orphaned with `cdkd state orphan`, or no longer in the synthesized app — is
  not examined, so its leftover versions are out of reach; use the commands
  below for those. It does not widen the exports-index purge,
  which stays limited to regions whose entries the run rewrote. A record scrub
  refuses before writing it is never purged, flag or not.
- **A purge that failed.** It needs `s3:ListBucketVersions` and
  `s3:DeleteObjectVersion` on the state bucket. Without them `scrub` still
  succeeds, and a warning above the summary names the key whose versions
  survive. The summary says the versions were purged "unless a warning above
  says otherwise" for this reason.
- **A replicated bucket.** S3 never replicates a version-id delete, so the
  destination keeps its own copies. `scrub` warns when replication covers the
  key, but only when it can read the bucket's replication configuration
  (`s3:GetReplicationConfiguration`); without that grant, or when that read
  fails, it cannot tell and says nothing — see
  [S3 replication defeats the purge](state-management.md#s3-replication-defeats-the-purge-and-cdkd-cannot-fix-it-for-you).
- **`--dry-run`**, which writes and purges nothing, and refuses
  `--purge-history`.

Rotation is therefore still the load-bearing remedy, not a belt-and-braces
extra: it is what makes a copy cdkd cannot reach harmless.

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

The same commands apply to the exports index with its own key substituted.
Think before running the second command: `state.json`'s noncurrent versions are
also the **state-recovery capability** S3 versioning is enabled for, which is
why a deploy never purges them, `cdkd scrub` purges only what it rewrites, and
purging the rest takes the explicit `--purge-history` (see
[State Management](state-management.md#s3-storage-structure)).

## Example output

A stack that held plaintext:

```text
$ cdkd scrub MyStack
Scrubbed 3 resource record(s) in MyStack

Done: scrubbed 1 stack(s). The rewritten state.json no longer holds the plaintext, and
on a VERSIONED state bucket its earlier versions were purged, unless a warning above
says otherwise. A value that was ever persisted must still be treated as compromised —
ROTATE it in Secrets Manager (scrub matches the current value, so scrub BEFORE
rotating); rotation is what makes any copy cdkd cannot reach harmless.
```

A CI gate that fails:

```text
$ cdkd scrub --all --dry-run --fail
No plaintext secrets found in ApiStack (scrub checks only values the template names through a {{resolve:...}} reference)
Would scrub 2 resource record(s) in DbStack

Plan: 1 stack(s) hold plaintext secrets and would be scrubbed (--dry-run, no state
written). ROTATE any exposed secret in Secrets Manager.
```

A CI gate that passes:

```text
$ cdkd scrub --all --dry-run --fail
No plaintext secrets found in ApiStack (scrub checks only values the template names through a {{resolve:...}} reference)
No plaintext secrets found in DbStack (scrub checks only values the template names through a {{resolve:...}} reference)

No plaintext secrets found in any target stack state (scrub checks only values the template names through a {{resolve:...}} reference). Nothing to scrub.
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | State was scrubbed, or there was nothing to scrub. |
| `1` | `--fail` found plaintext of a value the template names through a `{{resolve:...}}` reference (a physical name derived from one aside, except in an output or exports index entry the template no longer declares): under `--dry-run`, any such plaintext, or an output key it [would drop](#a-key-the-template-can-no-longer-name-is-dropped); on a real run, a leak scrub cannot rewrite, an undeclared key another stack still reads or one that may be a live export alias, or an exports index entry that has no key left in `state.outputs` and still holds a secret this run recorded. |
| `2` | scrub refused to examine something, could not classify a producer it imports from, a stack failed outright, the exports index was left incomplete, or the other stacks' state could not be read before a drop (`SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED`). |

The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

The two non-zero codes call for opposite responses, which is why they are
distinct: `1` means scrub looked and found a leak (rotate the secret), while
`2` means scrub declined to look (fix the reference and re-run).

**A state record whose `resources` map cannot be read exits `2`.** A
hand-edited or truncated `state.json` can carry a `resources` field that is
absent, `null`, or not an object at all. A real run REFUSES such a record
outright, because scrub saves whenever anything changed — an `Outputs` change
alone is enough — and saving would replace the unreadable map with a
well-formed empty one, destroying the only evidence that the record is broken.

Under `--dry-run`, where scrub provably cannot write, it audits the record's
outputs instead, warns that the resource half was never examined, and **still
exits `2`** — ranked above `--fail`'s exit `1` on purpose. Reporting `1` there
would name the opposite remedy ("scrub looked and found a leak — rotate the
secret") for a record scrub could not look at, and exit `0` would be the
false-clean this whole check exists to prevent, in the mode a CI gate uses.

Either way the message names the record. `cdkd deploy` and `cdkd destroy`
refuse the same map themselves, so neither can be run against it by accident.

**One row of a readable `resources` map that is not a resource record exits `2`
the same way.** A row that is `null`, a string, a list, or an object with no
`resourceType` is one the rewrite scrub saves cannot handle: a `null` row either
stops it on a bare `TypeError` under the lock (when the template still
positions the row and the stack recorded any secret) or is copied into the
rebuilt map as it stands — reported clean when no secret was recorded at all,
saved back the moment another record changed; a string or number the template
positions is spread into an object and saved as one; and a row with no type is
rewritten and saved still without one. A real run refuses, naming the rows;
`--dry-run` drops them,
warns, audits the rest of the record, and still exits `2` through the same
audited-record refusal.

**A record whose `outputs` map cannot be read exits `2` as well**, and it is
decided separately: a record can be damaged in either container alone, so the
message names the one that is actually broken. The reasoning is the same and
the consequence is different. Scrub REBUILDS the outputs bag before saving it,
and `Object.entries` walks a string as readily as a map — a six-character
value comes back as a well-formed six-key map, a `null` one as `{}` — so a
real run refuses rather than laundering the record. What is at stake is not
the stack being re-created (the resource map is intact) but the shared exports
index: `state.outputs` is what a redeploy republishes into
`cdkd/_index/<region>/exports.json`, which every other stack's
`Fn::ImportValue` resolves against.

Under `--dry-run` scrub audits the resource half instead, warns that the
outputs were never examined, and still exits `2` — otherwise every
outputs-side counter is legitimately zero and the run would print
`No plaintext secrets found` over a bag it replaced with an empty one.

An **absent** `outputs` field is not a defect and is never refused: a record
with no outputs is one cdkd writes on purpose, and scrub round-trips it
without materializing `{}`.

**What a real run can report as `1`.** `--fail` is documented as a
`--dry-run` CI gate, but a real run exits non-zero too when it found a leak it
cannot rewrite. Five shapes qualify, and all five are also reported in words:

- a **state KEY** holding a secret, which needs an `Export.Name` change plus a
  redeploy: `N output KEY(s) in <stack> hold plaintext and CANNOT be scrubbed`;

  A key counts when it **renders** a secret, not only when it contains one
  literally. An `Export.Name` is a resolved, template-controlled string, so it
  can carry invisible characters — control bytes, bidi marks, zero-width
  joiners, and zero-width combining marks (nonspacing diacritics) — and one
  placed inside a secret splits the plaintext so a literal scan misses it
  while a reader of the log sees the secret unbroken. Such a key is now
  reported and the run exits `1`; an earlier cdkd passed over it silently.

  The same holds for a secret spelled in **compatibility characters** —
  full-width letters and digits, mathematical alphanumerics, superscripts,
  ligatures, circled digits, an ideographic space — which Unicode NFKC folds to
  their plain forms. A key caught only through a combining mark, a precomposed
  letter standing for its decomposed spelling (the two render identically), or
  a compatibility character is reported with its name withheld, since the
  printed text keeps a name's own characters. Look-alike letters from another
  script (Cyrillic small a, `U+0430`, standing for a Latin `a`) have no
  compatibility mapping and are not detected, nor is a secret with a Hangul
  jamo at its start or end, or ending in an open Hangul syllable, whose other
  letters are spelled in compatibility characters, since that edge can join
  a neighbouring jamo in the name into a different syllable.

  **If this starts firing on a state that used to pass, the key was already
  leaking** — the change is what cdkd can see, not what the state holds.
  Rotate the secret and change the `Export.Name`.

- a **cross-stack read that could not be verified**:
  `N cross-stack read(s) in <stack> could NOT be verified`.

  Two shapes land here and they call for different things, so the per-read
  warning above the summary is what names the remedy. One is a read cdkd
  **declines by design** — a cross-account reference whose producer stores a
  secret expression cdkd will not resolve under the consumer's credentials —
  and no re-run clears it; export a non-secret value such as the secret's ARN,
  or reference it from within its own account. The other is a producer whose
  own `outputs` map **cannot be read**, which is repairable: fix that record
  and scrub it first.

  The two also exit differently, because the remedies differ. The by-design
  read is a `--fail` finding: exit `1`, and only with the flag. **A producer
  whose `outputs` map cannot be read exits `2` on its own, with or without
  `--fail`** — including under `--dry-run`. It means scrub could not tell
  whether that producer still holds the plaintext this stack imports, which is
  "cdkd did not finish", not "cdkd looked and found a leak".

  Neither shape refuses the stack. Refusing would strand this stack's own
  plaintext over a record that belongs to another stack — possibly one the
  operator does not own — so scrub reports the finding, scrubs everything
  else, and declines to call the stack clean.

- a **record whose `{{resolve:...}}` scan was ABANDONED part-way**:
  `N scan(s) in <stack> were ABANDONED mid-value because a {{resolve:...}}
  reference could not be resolved`.

  The resolver stops at the first `{{resolve:...}}` token it cannot resolve —
  a deleted SSM parameter, a secret with no `SecretString`, a missing
  `JSON_KEY`, a secret that is not JSON, or an AWS rejection such as
  `ParameterNotFound` / `AccessDeniedException` — and every later token in the
  SAME value is then never resolved, so it contributes no needle. A plaintext
  sitting behind such a token survives a scan that finds nothing. cdkd cannot
  rewrite it (there is no needle to match) and does not refuse the stack, so it
  is reported and counted instead. Restore the parameter or secret and re-run.

  The same finding covers a reference an `Fn::Sub` placeholder left
  unresolvable: `{{resolve:secretsmanager:${Typo}-db:...}}`, where `Typo` names
  nothing the template declares (no resource, no parameter), keeps its
  `${Typo}` (the `keeping placeholder` warning), so the reference is never
  looked up — also when the `{{resolve:` around it comes from an enclosing
  `Fn::Join` or `Fn::Sub`. Declare the variable, fix its name, or escape it as
  `${!Typo}`, and re-run.

  A placeholder naming a DECLARED parameter with no `Default` (scrub takes no
  `--parameters`, so it cannot bind one), or a declared resource, is different:
  it gets only the `keeping placeholder` warning. No `ABANDONED` line is
  printed, `--fail` does not count it, and the stack can still print
  `No plaintext secrets found`. A parameter that
  has a non-empty `Default` is bound even when another parameter of the stack has none.

- a **cross-stack read name holding a secret's value from before a
  rotation**: `N cross-stack read name(s) in <stack> hold a plaintext scrub
  could NOT repair`. See [What this does not repair](#what-this-does-not-repair).

- an **undeclared output key scrub keeps rather than drop** — one another
  stack still reads, or one that may be a live export alias: see
  [A key the template can no longer name is dropped](#a-key-the-template-can-no-longer-name-is-dropped).

### A scan `--fail` warns about but does not count

Not every abandoned scan raises the exit code. One failure aborts the whole
properties bag, and some of those have nothing to do with fetching a reference:

| What stopped the scan | `--fail` | Why |
| --- | --- | --- |
| The reference itself — deleted parameter, denied secret, missing `JSON_KEY` | exits `1` | Restoring the reference clears it. |
| An unresolvable `Ref` / `Fn::GetAtt`, or a parameter with no `Default` | warns only | `scrub` resolves with template defaults and takes no `--parameters`, so it cannot bind these. A gate failure could not be cleared. |
| An `Fn::Sub` placeholder naming no resource or parameter of the template, kept inside the reference | exits `1` | Fixing the template clears it; no `--parameters` is involved. |
| A reference whose own argument still holds a `${...}` no `Fn::Sub` substitutes | warns only | The token was never fetchable — same reason. |

A failure is scoped to the PROPERTY that caused it — an unresolvable `Ref` in
one property no longer stops the scan of a `{{resolve:...}}` in another
property of the same resource — so the warning names the property, not just the
record. It is scoped to the top-level property only: inside one property's
value, a failing key still stops the keys after it.

**Each record left unscanned is named in a warning at default verbosity**, and
a property that fails while carrying no reference of its own is silent, because
nothing was lost when it stopped. So a green `--dry-run --fail` does
not by itself mean every record was examined: read the warnings. A record cdkd
could not certify may still hold a plaintext from an older binary, and giving
the parameter a `Default` — or resolving the reference — is what lets a re-run
certify it. Where neither is possible, cdkd cannot certify that record at all.

## Refusals

These error codes stop the run rather than reporting it clean. All exit `2`.

| Code | What triggers it | What to do |
| --- | --- | --- |
| `SCRUB_CROSS_STACK_READ_UNRESOLVED` | An `Fn::ImportValue` / `Fn::GetStackOutput` the pre-pass could not resolve. | Deploy the producer stack, or correct the reference, then re-run. |
| `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` | The read succeeded, but the producer's own state still stores the plaintext instead of the expression. | `cdkd scrub '<producer>'` first, then re-run. For a chain, every stack in it, head first. |
| `SCRUB_CROSS_REGION_SECRET_UNRESOLVED` | A secret reference whose ARN names another region could not be read in that region. | Grant the read there, or restore the secret. scrub will not fall back to the stack's own region. |
| `SCRUB_STACKS_FAILED` | Under `--all`, one or more stacks ended in one of the above. | Fix each named stack; the others were still scrubbed. Each stack's own reason was logged as it happened. |
| `STATE_RESOURCES_MALFORMED` | A state record's `resources` map is absent, `null`, or not an object, or holds a row that is not an object or carries no `resourceType`; its `outputs` map is `null` or not an object; or its `orphans` field is present but not a list, or holds a record that is not an object, has no string `logicalId` or shares it with another record, or whose `state` is not a readable resource entry with a non-empty string `physicalId` — including that entry's `properties` and `attributes` maps. A real run refuses the stack, which under `--all` is reported as `SCRUB_STACKS_FAILED`; `--dry-run` audits the other containers and reports this code rather than a clean result. An ABSENT `outputs` map or `orphans` list is not a defect and is never refused. | Inspect the record with `cdkd state show '<stack>' --stack-region '<region>' --json` and repair or remove it. `cdkd deploy` and `cdkd destroy` refuse every one of these shapes themselves. |
| `SCRUB_PRODUCER_RECORD_UNREADABLE` | A stack imports from a PRODUCER whose own `outputs` map cannot be read, so this run could not tell whether that producer still holds the plaintext. Raised with or without `--fail`, `--dry-run` included. | `cdkd scrub '<producer>'` cannot run until that record is repaired — inspect it with `cdkd state show '<producer>' --stack-region '<region>' --json`, repair it, scrub the producer, then re-run. The importing stack was still scrubbed for everything else (audited, under `--dry-run`). |
| `SCRUB_NESTED_CHILD_UNRESOLVABLE` | A [nested stack](#nested-stacks) has a state record, but `scrub` could not derive what its parent deployed it with. | Follow the remedy the message names for its cause. Every other stack was still scrubbed; when the cause is the parent's own failure, that failure is reported too. |
| `SCRUB_NESTED_TEMPLATE_TREE_MALFORMED` | The nested template tree under a stack is cyclic, too deep or too large, or names an absolute or escaping `aws:asset:path` — a hand-modified or non-CDK assembly. | Re-synthesize the app with CDK. Nothing in that stack or under it was written; any nested record under it is refused too. |
| `SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED` | scrub had an undeclared output key to [drop](#a-key-the-template-can-no-longer-name-is-dropped), and the state bucket's listing or another stack's record could not be read to confirm nothing reads it. Raised after the summary, with or without `--fail`. | Fix the read (usually an S3 permission, or a damaged record the warning names) and re-run. The stack was still scrubbed for everything else; no key was dropped. |
| `SCRUB_STAGE_LOAD_FAILED` | A CDK Stage's own cloud assembly could not be read, so the app's stacks cannot all be examined. Raised before any stack is selected or any state is read, `--dry-run` included. | Re-synthesize the app so the Stage is written, or point `--app` at a complete cloud assembly. |
| `SCRUB_LEGACY_STATE_KEY_SURVIVES` | A record still in the pre-region layout was rewritten to the region-scoped key, but its old key could not be deleted and still holds the pre-scrub record as its current object. | Delete the old key (`<state-prefix>/<stack>/state.json`) by hand, then purge its earlier versions with the commands under [What a real run removes](#what-a-real-run-removes-and-what-it-cannot). A re-run does not detect it again: the stack's record now lives at the region-scoped key, which every later read prefers. |
| `SCRUB_LEGACY_STATE_KEY_UNVERIFIED` | A record still in the pre-region layout was rewritten to the region-scoped key, but reading its old key back to confirm the delete failed (a throttle, a 5xx, a denied read). | Check the old key (`<state-prefix>/<stack>/state.json`) yourself; if it exists, delete it and purge its earlier versions as for `SCRUB_LEGACY_STATE_KEY_SURVIVES`. A re-run does not check it again. |
| `SCRUB_EXPORT_INDEX_INCOMPLETE` | `state.json` was rewritten and an entry of the [exports index](#the-exports-index) was not — a refused write, or a region whose index could not be read. | Clear the cause (usually an S3 permission on `{state-prefix}/_index/...`) and re-run. The re-run writes only the entries still differing. |

Everything else the per-item best-effort handler swallows is unchanged: a
`Ref` to a resource absent from state still degrades to a partial scrub rather
than failing the run, which is what that handler is for.

### A cross-stack read that cannot be resolved

`scrub` learns which plaintexts to hunt for by re-resolving the template, so a
leaf that arrives through `Fn::ImportValue` / `Fn::GetStackOutput` yields a
needle only if the producer's state can actually be read. With no needle,
nothing matches, and the command would report no plaintext found over state
that may still hold it.

Such a read is therefore attempted before the main pass, and a failure refuses
the stack, naming the resource or output it could not resolve. A stack whose
producer state is unreadable — a deleted producer, a cross-account export, a
missing state file — exits `2`.

A conditional import does NOT refuse when its branch is not taken: the
pre-pass walks `Fn::If` the way the resolver does, selected branch only.
Neither does an `Fn::ImportValue` inside an output that this run's conditions
SUPPRESS — such an output wrote no state key, so there is nothing behind it to
protect.

### A reference built from a parameter

A parameter is resolved from today's template: its `Default`, or for an
SSM-typed parameter the value Parameter Store holds now; a value a nested
stack's parent passes is resolved the same way from the parent's parameters. If
the deploy used a different value, scrub cannot tell, and the plaintext the
deploy wrote can stay in state while the stack prints clean. Three things cause
it:

- the parameter's `Default` changed after the last deploy, so scrub looks up a
  DIFFERENT reference than the deploy resolved;
- an SSM-typed parameter's value changed after the last deploy, with the same
  effect;
- the parameter's `Default` was removed after the last deploy, so scrub cannot
  resolve the reference at all and only warns.

This holds for any reference built from a parameter, in the stack's own region
too. There is no flag for it: in any of these cases, inspect the record with
`cdkd state show` rather than trusting a clean result.

### Which `Fn::If` branch scrub selects

Branch selection is evaluated against the template's **default parameter
values**. `scrub` takes no `--parameters`, so it has nothing else to evaluate
a `Conditions` entry with, and a condition it cannot evaluate reads as false.

When a parameter's `Default` or SSM value changed after the last deploy, that
means scrub can pick a branch the deploy never took. In a RESOURCE position a
cross-stack read on that branch still refuses, so the stack can be refused over
a producer that legitimately does not exist for the parameters it was actually
deployed with.

An output position is spared this: `state.outputs` records what the deploy
really wrote, and a key absent from it disarms the refusal. There is no
equivalent record for a resource-position branch, so the remedy is to make the
read resolvable — deploy or scrub the producer that branch names, which
`cdkd scrub --all` does in one run — rather than to re-run unchanged.

The same branch selection decides whether the PRODUCER's export counts as
secret-bearing at all, so one selection feeds both halves of the question.

### A producer that still stores the plaintext

`scrub` can only replace a stored plaintext with the `{{resolve:...}}`
expression the PRODUCER holds. A producer whose own state has not been
scrubbed yet still holds the plaintext itself, so the read succeeds, there is
no expression to write, and the consumer would be reported clean over a record
that still holds the secret.

The verdict is taken by READING the producer's own stored value, not by
inspecting what the read returned: the read RESOLVES a stored expression to
plaintext before handing it over, so a healthy producer and an unscrubbed one
are indistinguishable from the consumer's side. The refusal names the producer
and the fix.

### Which exports count as secret-bearing

Whether the export is secret-bearing at all is the half of the question the
stored value cannot answer — a bucket name and a leaked password are both bare
strings, so refusing on the stored value alone would refuse every multi-stack
app that imports anything. That half is taken from the app's TEMPLATES, and
the refusal fires only when they say the value carries a secret:

- the producer declares that export from a `{{resolve:...}}` expression; or
- the producer RE-EXPORTS a value that a stack further up the chain declares
  from one.

Both arms read the export through the `Fn::If` branch selection above, so an
expression sitting only in a branch this run does not select answers neither
of them: a secret reachable only through that branch is not detected. An
ordinary import of a bucket name or an ARN is unaffected under either arm.

The chain arm is not a refinement. A middle stack's output IS the
`Fn::ImportValue`, so asking that one template alone answers "not
secret-bearing", and `cdkd scrub <the stack at the end of the chain>` would
then report clean over its own surviving plaintext. The walk follows
`Fn::ImportValue` / `Fn::GetStackOutput` through the synthesized templates and
terminates on a cycle by never revisiting a `(stack, export)` pair. For a
chain the remedy names EVERY stack in it, head first, because a middle stack
cannot store the expression until its own producer has been scrubbed.

Four shapes stay unclassifiable from the consumer's side and are NOT refused:

- a producer outside the synthesized app;
- one whose export cdkd resolved through CloudFormation rather than through
  cdkd state;
- a re-export whose upstream reference cannot be read statically — an
  assembled export name, or an `Fn::GetStackOutput` whose stack or output name
  is itself an intrinsic;
- one whose upstream export is declared under a name this run cannot
  reproduce, which usually means an intrinsic `Export.Name` one hop up, so a
  stack DOES declare it and the walk simply cannot match it.

When the DIRECT producer's `Export.Name` is an intrinsic this run cannot
reproduce, the check widens to every output of that producer — an
over-approximation in the safe direction, and the message says so rather than
claiming the producer declares that particular key from an expression.

The asymmetry between that widening and the dropped case one hop up is
deliberate. At the root the key came from an actual read, so some output of
that producer really did answer it, and refusing over the set is the safe
reading. One hop up the key is a literal name read out of a template, so a
miss means that template does not declare it, and widening there would refuse
the consumer over an unrelated secret two stacks away in a refusal no
`cdkd scrub` could clear.

### Assembled references and cross-region secrets

A reference the intrinsics build out of parts — an `Fn::Sub` placeholder
inside it, an `Fn::Join` that splits it — does not exist as a complete
expression until it is resolved, so scrub's region pre-pass cannot classify it
and hands it to the resolver instead of refusing. The resolver decides the
region AFTER assembly and either routes the read to the region the ARN names
or refuses it as ambiguous.

If such a reference then goes UNRESOLVED — the region refuses the read, the
secret was deleted, or an `Fn::Sub` placeholder it needs names nothing the
template declares — the record is reported as an
abandoned scan (see Exit codes above): the stack is not summarised clean and `--fail` exits `1`. It is a finding rather than the
`SCRUB_CROSS_REGION_SECRET_UNRESOLVED` refusal a complete reference gets,
because the failure belongs to one assembled value, and refusing would strand
every other secret in the stack.

**Known residual: a placeholder scrub cannot bind still leaves the stack
summarised CLEAN.** When the `Fn::Sub` placeholder inside such a reference
names a declared parameter with no `Default`, or a declared resource, the
reference is never looked up and the only sign is the `keeping placeholder`
warning. Run
`cdkd scrub --verbose` when a stack you expect findings from reports clean.

A reference built from a parameter has the limit described in
[A reference built from a parameter](#a-reference-built-from-a-parameter).

### A read cdkd declines by design is a finding, not a refusal

The cross-account `Fn::GetStackOutput` of a redacted value is never resolved:
cdkd will not look up a producer account's secret with the consumer's
credentials. That read cannot be made to succeed by re-running, so refusing
the whole stack would strand every other secret in it.

Instead the stack is scrubbed for everything else, the read is reported
(`N cross-stack read(s) in <stack> could NOT be verified`), the summary says
so, and `--fail` exits non-zero — the same treatment a secret-bearing output
KEY gets. That treatment is scoped to THAT ONE read.

Other refusals the resolver raises deliberately — a stale placeholder ARN, an
unresolvable account id, an unenriched `Fn::GetAtt`, `--strict-getatt`, a
malformed `Fn::Split` — are all things you can FIX in the template, so they
refuse the stack (exit `2`) with the resolver's own message, and a re-run
after the fix scrubs it. They are reachable here whenever the reference's
export name is built by an `Fn::Sub` over one of them.

## SSM parameters are redacted by type, not by spelling

The plain `{{resolve:ssm:...}}` form resolves with `WithDecryption`, so it
yields a real secret whenever the parameter is a `SecureString` — the same
disclosure class as `{{resolve:secretsmanager:...}}`. cdkd reads the
parameter's `Type` off the same `GetParameter` response that carries the value
and treats the two cases differently:

| Parameter `Type` | Treatment |
| --- | --- |
| `SecureString` | Handled exactly like a Secrets Manager reference: the decrypted value goes to the AWS API, state stores the `{{resolve:ssm:...}}` expression, and `cdkd scrub` cleans it out of state written by an older cdkd. |
| `String` / `StringList` | Public config, stored RESOLVED in state, so a parameter-backed property is not a perpetual spurious UPDATE. |

On the diff and no-op comparison path cdkd still has to learn the type, so it
issues `GetParameter` with `WithDecryption: false`. A `SecureString` comes
back as its encrypted blob, which is never substituted, cached or persisted,
and the comparison stays expression-versus-expression. Once a reference is
known to be `SecureString`, later comparisons short-circuit with no AWS call
at all.

## What gets redacted inside a record

Scrub rewrites the leaves that hold secret material, not whole records. Two
cases decide what a leaf becomes.

### Two spellings of one secret value

Two dynamic references that resolve to the SAME value — the same JSON key
written once with and once without an explicit version stage, for example —
must each keep their own expression, or both sites persist whichever
expression was recorded last and the stack reports a spurious UPDATE on every
deploy. No plaintext is exposed by that; the wrong EXPRESSION would be stored.

cdkd therefore redacts by POSITION as well as by value: each leaf is matched
against the UNRESOLVED template at the same path, so it keeps its own
expression. Where the template leaf is an intrinsic — `Fn::Join` / `Fn::Sub`,
what CDK emits whenever the secret's ARN is a `Ref`, so the common case — the
reference is identified by the shape of that intrinsic instead.

A narrow residual remains, and it degrades to the old behaviour rather than to
anything worse. When the intrinsic's literal parts cannot tell the two
references apart — the part that differs is itself behind a `Ref` — cdkd
declines to guess and both leaves persist the same expression. The same
applies to a pair of `{{resolve:ssm:...}}` references whose parameter `Type`
AWS did not report. If you hit a spurious UPDATE on a resource holding two
spellings of one secret, make the differing part a literal in the template.

### Secrets inside a list

A reference nested in an array — an ECS task definition's
`ContainerDefinitions[].Environment[]` is the usual shape — is redacted like
any other leaf, including on a resource that did not change on that deploy.

cdkd matches list elements by their identity field (`Name` / `Key`) rather
than by position, which does not depend on the order AWS returns them in.
Elements that carry no such identity field are left alone rather than guessed
at, so nothing is ever written onto the wrong element; a redaction cdkd cannot
place falls back to matching by value.

### A secret whose value is itself a reference

Such a value is byte-identical to an already-redacted expression, so cdkd asks
a narrower question: does the reference it is being compared against describe
the SAME generation of the resource? Only a resource's own stored properties
can answer yes; a template never can, whichever command is running.

When the answer is no, the leaf is matched by VALUE instead — so a plaintext
cdkd resolved this run is still replaced by its own reference, while a
reference already in state is left exactly as it is. A legacy leaf of this
shape is cleaned the next time either `cdkd deploy` or `cdkd scrub` resolves
that secret.

### Fragments inside a complete reference

A stored value can hold a reference inside surrounding text —
`jdbc://appdb:{{resolve:secretsmanager:appdb/creds:SecretString:password}}@host`
is what a joined connection string looks like after redaction — and a later
deploy can record a secret whose plaintext (`appdb`) also occurs inside that
reference's own text. Rewriting it there would produce
`{{resolve:secretsmanager:{{resolve:ssm:/app/dbname}}/creds:...}}`, which no
service can resolve: `cdkd rollback` reads it as a request for the secret id
`{{resolve:ssm:/app/dbname` and either refuses or applies the wrong value.

cdkd therefore replaces every match of a recorded secret EXCEPT one that lies
wholly inside a complete reference and is shorter than it. "Reference" means a
`secretsmanager`, `ssm` or `ssm-secure` one: a `{{resolve:...}}` of any other
service is not something cdkd resolves, so a secret inside it
(`{{resolve:<secret>}}`, which an `Fn::Sub` placing a secret where the service
name goes produces) is replaced like any other text. A stored secret
whose own value IS a reference is still replaced, and so is one that CONTAINS
a whole reference plus surrounding text — dropping those would leave the
plaintext in state, which is worse than the mangling this rule prevents. An
embedded secret in ordinary text is repaired exactly as before.

Three limits are worth knowing, all of them narrow. A STRAY `{{resolve:` — an
opener that is not part of a real reference — is read by the same grammar the
resolver uses, and which way it falls depends on what follows it in that same
value:

- With **no later `}}`** it is not a reference at all, so it protects nothing
  and a secret after it is still replaced. Leaving the plaintext there instead
  would hide it behind two characters any string can contain.
- With a **`}}` anywhere later**, the opener and that `}}` bracket one region,
  and when the opener spells one of the three services above
  (`{{resolve:ssm:` ...) a secret inside it is left alone. This is the one shape where cdkd
  redacts less than a naive value match would. Reading the braces
  differently is not the fix: that would disagree with the resolver about the
  same string, and would re-mangle values an older cdkd already mangled. Such
  a value cannot come from a template — it would fail to resolve at deploy
  time — so the way it arrives is a drift read-back
  (`observedProperties`), which is arbitrary text from AWS.

And a value already mangled by an older cdkd is not repaired: it parses as a
valid reference now, so neither a redeploy nor `cdkd scrub` rewrites it.
Fixing such a record means editing it out of state, or redeploying the
resource so the leaf is written afresh.

### A reference you have edited but not deployed

Such a reference is never rewritten — by `cdkd scrub` or by `cdkd deploy`. If
state holds `...:AWSPREVIOUS` and the template now says `...:AWSCURRENT`,
scrub leaves the record alone and reports nothing to scrub, and a deploy that
fails and rolls back leaves the reverted reference in place.

Rewriting either would make the next `cdkd deploy` compare the new expression
against itself, see no change, and never push the edit to AWS — a credential
rotation that silently never happens, invisible to `cdkd drift` because the
baseline would have been rewritten too. The same rule covers the drift
baseline: `observedProperties` keeps the reference AWS was last seen holding,
so `cdkd drift --revert` cannot push an undeployed one.

### A value AWS reports at a position your template does not name

The drift baseline in `observedProperties` is whatever AWS returned, so it
routinely carries fields the template never set and list elements the template
does not have — and a secret can land in one of them: a copied environment
variable, an entry AWS added. Those positions have no template leaf to match
against.

cdkd takes the plaintext it learned at a position it COULD match — the same
secret's own leaf, elsewhere in the same record — and replaces the remaining
occurrences of that value in that record with the same reference. Positions
the template already accounted for keep the answer the template gave them, so
this only ever ADDS a replacement.

Nothing is fetched and no extra permission is needed: the value comes out of
the read-back cdkd already has. A value that is NOT one of those secrets is
left exactly as AWS reported it, so the baseline still describes the live
resource.

### A value your template never references

A secret that no `{{resolve:...}}` reference in the template names — one an
operator set out of band, or one AWS returns in a field the template never
sets — is not something scrub can find: it learns a secret's value only by
resolving a reference, so the record reports clean and every no-finding line
says `(scrub checks only values the template names through a {{resolve:...}} reference)`.
The drift baseline records such a value as AWS returned it, by design. How to
remove one is in
[`cdkd import`'s note on it](import.md#a-value-your-template-never-references-is-recorded-as-aws-holds-it);
the last step is `cdkd scrub <stack> --purge-history`.

The same scope leaves two other kinds of value out of scrub's check. A
credential a provider records in `attributes` so that `Fn::GetAtt` can read
it — an `AWS::IAM::AccessKey`'s `SecretAccessKey`, a Cognito user pool
client's `ClientSecret` — is stored as returned.

A `NoEcho` parameter's value is masked the way a `cdkd deploy` stores it (see
[`version: 11` stores `NoEcho` values as `***`](state-management.md#version-11-stores-noecho-values-as-current-writers)):

- **By position.** Every property today's template fills from a `NoEcho`
  parameter holds `***`, whatever the value's type or length, and the record
  names the position in `noEchoLeaves`. So does the observed baseline there.
  A record that already names its positions keeps them, as a deploy does. A
  nested child's parameter its parent's row fills from a `NoEcho` source
  counts as one too. One whose every `NoEcho` read sits inside an `Fn::If`
  counts whichever branch reads the source, because scrub cannot tell which
  branch the deploy took (and so does a grandchild's parameter filled from
  it): the child stores `***` there, but a plaintext it held there is not
  masked elsewhere in the record (it may be the other branch's literal). A
  position marked this way when the deploy took the plain branch reads back
  from AWS until the next deploy rewrites it.
- **By the stored value.** Where the record still holds a plaintext at such a
  position (a stack deployed before state `version: 11`, or under an older
  `Default`), that value is masked wherever else the same record holds it, a
  leaf embedding it included (4 characters or more). Another record holding
  the same literal is left alone, and so is a value only an `Fn::If` row
  parameter positions.
- **Attributes.** An attribute of the same name as such a property that
  equals its value (an SSM parameter's `Value`) is masked at any length and
  declared `NoEcho`, so a resource reading it through `Fn::GetAtt` is
  positioned too, whatever order the records are in.
- **Outputs.** A declared output the parameter serves holds `***`, and so do
  its own export alias and any key no other output publishes that holds the
  same stored value. The exports index entry is converged onto `***`.
- **Not found:** a value at a position a record that names no positions no
  longer reads. A `cdkd deploy` of the stack masks it.

## Stack outputs

Stack outputs are scrubbed too, including an output you have since DELETED.

A stored output key today's template can still name — a declared output, or an
`Export.Name` alias this run can fully resolve — is redacted by POSITION
against that template, like any resource property.

A key the template can no longer name is repaired whenever its stored value
MATCHES a secret plaintext recorded anywhere in this run, including one only a
RESOURCE still references, which is the usual shape after deleting the output
that used to expose it.

A deleted output is the motivating case but not the whole population: **any
stored key this run cannot COMPUTE** is repaired the same way. The standing
example is a parameterized `Export.Name` — `scrub` takes no `--parameters`, so
a name that resolves to a literal `prefix-${Foo}` here leaves the real alias
key your deploy wrote unaccounted for on every run, and that key is
value-matched rather than positioned for as long as the parameter stays
unresolvable. Declare the export name literally, or give the parameter a
`Default` the template resolves from, if you want that key positioned instead.

### A key the template can no longer name is dropped

A stored key the template can no longer name, whose value no pass rewrote, is
**removed** from the outputs a scrub writes. Its value is one scrub cannot
identify — most often the output was deleted, and the value may be a plaintext
an older cdkd stored — and left beside the `{{resolve:...}}` references scrub
writes, it would be read by `cdkd diff` as part of a redacted record and
printed on the output's removal row. A deploy of today's template does not
write the key either. Each dropped key is named, never its value:

```text
Dropped 1 output key(s) from MyStack that its template no longer declares: OldDbUrl. ...
```

`--dry-run` says `Would drop`, and counts the stack as one it would scrub, so
`--dry-run --fail` exits `1` until a real run (or a deploy) removes the key. A
name that holds a secret, or the key's own stored value, is masked or withheld;
a name that may be an export alias and carries a character an output's logical
id cannot is withheld outright, as `cdkd diff` withholds it.
An `Export.Name` a deploy now refuses because it holds or reads a `NoEcho`
parameter's value is never published, so its missing key does not make every
other key a possible alias. An alias key an older cdkd published under such a
value is reported as a key that renders a secret (scrub cannot rewrite a key;
a deploy drops it).
A dropped export alias leaves the record's export set too; its entry in the
[exports index](#the-exports-index) is reported as a name `state.outputs` no
longer holds, and a redeploy rewrites the index.

The drop runs only when this run recorded at least one secret for the stack —
the pass that rewrites the outputs at all. A stack whose template resolves no
secret is not rewritten, and its undeclared keys stay as they are.

These keys are **kept**:

- one a pass rewrote, whole or in part — it now carries the reference, and the
  [exports index](#the-exports-index) entry of that name is converged to it.
  Text a part-rewritten value keeps beside the reference
  (`postgres://u:{{resolve:...}}@host`) is withheld by `cdkd diff` itself;
- one no string of which can be a plaintext — only whole `{{resolve:...}}`
  references, or no string at all;
- one whose name holds a secret this run recorded — the
  [state KEY leak](#exit-codes) scrub reports and cannot rewrite, because the
  exports index still publishes that name;
- one that may be a **live export alias** whose name this run could not
  reproduce. A key the record lists as an export (or any key, for a record
  written before cdkd recorded which keys are exports) is dropped only when
  every `Export.Name` in today's template resolved to a key the record holds
  and lists as an export (a literal name that collides with another output is
  exempt, since a deploy never publishes it; on a record with no export list,
  or one listing anything but names, an intrinsic name matching a declared
  output name proves nothing). Otherwise — a parameterized name whose
  `Default` or SSM value changed after the last deploy, one that does not
  resolve here, or an export the last deploy did not write — scrub cannot tell
  that alias from a deleted one, keeps the key, and warns:
  `... were LEFT as they are`. Such a key's value can still be
  printed by `cdkd diff`, so the stack is not reported clean and `--fail` exits
  `1`; a deploy rewrites the outputs;
- one **another stack still reads**. Before dropping, scrub reads every state
  record in the bucket once per run. A key another stack records reading, with
  `Fn::ImportValue` or `Fn::GetStackOutput`, is kept and named with that
  stack. Every key the stack would drop is kept when such a read's name or
  producer is stored redacted or damaged and cannot be compared, and when
  another record predates the field that records such reads (`imports`
  before schema v4, `outputReads` before v8). Dropping it would break the read.
  The rest of the record is still scrubbed, the stack is not reported clean,
  and `--fail` exits `1`. Stop the consumer reading it (or declare the output
  again) and deploy, then re-run.

  This protects the reads cdkd **recorded**, and no others. Two residuals of the
  version test: it misses a record older than schema v8 that a command other
  than `cdkd deploy` has rewritten since (`cdkd scrub`, `cdkd drift --accept`,
  `cdkd import`, the `cdkd state` commands), because every write stamps the
  current version while carrying no `outputReads` — such a record reads as
  having no readers; and it over-refuses, because one old record ANYWHERE in the
  bucket, related or not, keeps every stack's drop candidates, and `--fail`
  red, until that record is redeployed.

When the listing or any record cannot be read — a listed record that reads as
absent counts — **no** key is dropped from that stack, the rest of it is still
scrubbed, and the run ends with
`SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED` (exit `2`, with or without `--fail`).

## Cross-stack read names

`state.imports` and `state.outputReads` record which producer a stack read a
cross-stack value from. Three of their fields come from the TEMPLATE and can
carry a secret when an `Fn::Sub` assembled the name around a resolved
`{{resolve:...}}` reference: `imports[].exportName`,
`outputReads[].sourceStack` and `outputReads[].outputName`. Scrub repairs those
three the same way it repairs any other stored value — by matching against the
plaintexts this run recorded.

`sourceRegion` and `imports[].sourceStack` are left exactly as stored. The
first is an AWS region. The second is the literal key `cdkd destroy` matches a
producer against when it refuses to delete a stack another stack still imports
from, so rewriting it would drop that protection.

### What this does not repair

A name whose secret has since been **rotated** is left as it is. Scrub learns
which plaintexts to look for by re-resolving your template, so it holds the
secret's CURRENT value, while the stored name holds the one it had when that
record was written — a value nothing in the run can see. Rotating again does
not help; a deploy that updates the stack rewrites both lists from the reads
it performs. A deploy that finds nothing to change keeps the stale entry.

Scrub still **reports** such a name, so the stack is not called clean and
`--fail` exits `1`. The warning names the list and index
(`state.imports[1]`), never the stored value. A stored entry counts when all
of these hold:

| Condition | Why |
| --- | --- |
| No read in today's template produces the same entry | An ordinary import this run re-read is healthy, even from a producer that also publishes a secret. |
| A read in today's template of the same producer and region has a name that carries a secret | The stored entry has to be tied to a secret-bearing reference. |
| The stored name matches that read's name, each secret reference standing for any text, and one such position still holds text | A rotated name differs only where the secret sits; with two secrets and one rotated, the old one stays text. |

An entry left behind by a reference you REMOVED from the template can also
match, when its name happens to have the same shape as a secret-bearing read
of the same producer. It is reported the same way; a deploy that updates the
stack drops it.

A name that is never re-resolved is the case this repair exists for: a stable
stack resolves its cross-stack reference once and the resource never changes
again, so no later deploy would rewrite it.

As everywhere else in this command, repairing a record does not un-expose a
value that was already stored in plaintext. A real run purges the rewritten
record's earlier versions, within the limits listed in
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot).
Rotate the secret.

### What scrub deliberately does not do here

`state.outputs` is re-applied VERBATIM to other stacks — cdkd's exports index
and every `Fn::ImportValue` / `Fn::GetStackOutput` read it — so a value
rewritten that was never a secret would ship a literal `{{resolve:...}}` token
into a CONSUMER stack's AWS call. Hence three rules:

- **It never guesses.** When nothing this run recorded that plaintext — the
  secret was deleted, rotated away, or its reference is gone from the template
  as well — the value is never rewritten onto a reference and no key is
  invented. A key the template still names is left exactly as it is; one it
  cannot name is dropped, as
  [above](#a-key-the-template-can-no-longer-name-is-dropped), which ships no
  token to a consumer — a key another stack reads is kept. ROTATE the secret and redeploy; that rewrites the record. A
  degenerately short plaintext, under 4 characters, is excluded from the
  WIDENED match specifically: it is never used as a cross-resource needle,
  since it would match unrelated values. A key the template still names is
  unaffected — it is redacted by template POSITION, so a short secret stored
  there is still repaired.
- **It matches inside a value, and that has a stated cost.** A recorded
  plaintext of 4 characters or more is repaired even when it is EMBEDDED in a
  longer stored value, which is what repairs a connection string built around
  a password — the shape this exists for. The consequence is that a short,
  word-like secret (`admin` as a `secretValueFromJson('username')`) occurring
  inside an unrelated key the template can no longer name is rewritten too,
  and a consumer importing that key then receives a literal `{{resolve:...}}`
  token. The trade is deliberate: that failure is loud and fixable on the next
  deploy, whereas an unrepaired plaintext under a key no template declares is
  silent and no redeploy ever clears it. If it bites, edit the key out of the
  state record — and rotate the secret, which was exposed either way.
- **It does not widen the match for a key the template still names.** Those
  keep their template position, so one resource's secret value can never
  rewrite a declared output's coinciding literal into that resource's
  reference. The residual: a declared output whose template value no longer
  resolves a secret, but whose STORED value is still the stale plaintext of
  one, is not repaired by `scrub` either — a redeploy rewrites it.

## The exports index

Beside the per-stack `state.json` records, cdkd keeps one object per region at
`{state-prefix}/_index/{region}/exports.json`. It maps each export name to the
producing stack's RESOLVED Output value, so an `Fn::ImportValue` does not have
to scan every state file in the bucket. It is a single object shared by every
cdkd-managed stack in that region, and reading it needs `s3:GetObject` and
nothing else — no version id.

`cdkd scrub` runs one pass over that object per region it touched, as a step
after the `state.json` write for each stack. For every entry the index already
holds whose `producerStack` / `producerRegion` name a stack this run scrubbed:

- when `state.outputs` holds a value under the same name, that value contains
  `{{resolve:` or carries the redaction mask `***` (any masked output, such as
  one a `NoEcho` parameter serves), and the entry's value differs from it, the
  entry is rewritten to the state value. Until it is written, the entry is a
  finding: `--dry-run --fail` exits 1 over it;
- when it does not differ, nothing is written.

The rule is a comparison against the state record, not against the plaintext
`scrub` resolved. `scrub` builds its plaintext map by resolving the template's
references against Secrets Manager / SSM, so the map holds the secret's value
AS IT IS NOW; an entry written before a rotation holds the value as it was
THEN, and the two are different strings. Comparing against `state.outputs`
instead reads the value a redeploy writes, which is the same value whether or
not the secret has rotated since.

`--dry-run` performs the read and issues no write. The audit is a real read
because scrub's map comes from live resolution rather than from the state
record, so `cdkd scrub --all --dry-run --fail` exits `1` on a divergence here
even when every `state.json` already holds the expression.

### What the index pass reports rather than writing

Three cases produce a message and no write. The first exits `2`; the other two
do not affect the exit code, with one exception noted under the second.

- **An entry it could not write.** S3 refused the `PutObject`, or a concurrent
  writer exhausted the If-Match retry budget. The run fails with
  `SCRUB_EXPORT_INDEX_INCOMPLETE`, naming each entry and its region, because
  such an entry keeps the value it holds. An entry whose name holds a secret
  this run recorded, or carries any character outside printable ASCII, is
  named as withheld rather than printed. Re-run the same command once the
  cause is cleared: an entry already matching `state.outputs` is left alone, so
  the re-run writes the remainder.
- **An owned entry whose name is not a key of `state.outputs`.** There is no
  value to converge it to, so it keeps what it holds. Redeploy that producer,
  which rewrites the index from its own outputs. When that entry's value still
  holds a secret this run recorded — typically after scrub
  [dropped the key](#a-key-the-template-can-no-longer-name-is-dropped) — it is
  a FINDING instead: the stack is not reported clean and `--fail` exits `1`.
  An alias-shaped name this run dropped or kept is withheld on these lines,
  as it was on the drop line; and an absent entry's name that carries a
  character an output's logical id cannot is withheld on every run, even once
  the template no longer references a secret (the entry is still the one an
  earlier drop left). The stack and region still print.
- **An entry published by a producer this run did not scrub.** `--all` targets
  every stack in the SYNTHESIZED APP, not every stack with a state record, and
  one bucket and region are legitimately shared by several CDK apps. Those
  entries are reported as coverage and never fail the gate — a gate that
  reddened on another app's entries could not be cleared from here. Coverage
  composes: each app clears its own entries by running its own `cdkd scrub`.

### What the index pass does not do

- **It changes no membership.** Only the value of an entry the index already
  holds is rewritten; no name is added and none is removed. `scrub` takes no
  `--parameters` and reads a state record whose template may not be the one
  that produced it, so any export SET it derived would be a guess.
- **Its write needs no additional IAM permission.** The index key sits under
  the same prefix as the state records, and `cdkd deploy` already writes that
  exact object, so any principal that can deploy the stack can write it. A
  policy hand-narrowed to `{state-prefix}/{stackName}/*` breaks here — and
  already breaks cross-stack deploys for the same reason. Purging the index's
  earlier versions needs the same two version grants as the `state.json`
  purge, and warns rather than fails without them.
- **It does not widen `--all`.** A stack outside the synthesized app has no
  template in reach, so scrub could not learn which of its values are secrets
  even if the entry were targeted.

A region whose index was rewritten here has its earlier versions purged — see
[What a real run removes, and what it cannot](#what-a-real-run-removes-and-what-it-cannot),
which covers `exports.json` as well as `state.json`.

## Limitations

Two paths do not inherit this redaction, both because they resolve a reference
through a context that does not record secrets:

- A secret reference used as a NESTED STACK's `Parameters` value is resolved
  by the parent and handed to the child as a literal, so `cdkd diff
  --recursive` decrypts it at plan time. (The child's STATE is redacted by the
  deploy, and a child record an older cdkd wrote is repaired through its
  parent — see [Nested stacks](#nested-stacks).)
- [`cdkd export`](cli-export.md) writes the resolved value into the exported
  CloudFormation template's Parameter value, so the plaintext lands in the
  template it hands to CloudFormation.

Both apply to `{{resolve:secretsmanager:...}}` as well as to a `SecureString`
parameter.

A third object is repaired by a separate step of the same run — see
[The exports index](#the-exports-index) for what that step reads, what it
writes, and the three cases it reports rather than writing.

## Related

- [`cdkd drift`](cli-drift.md) — how a redacted state record is compared against AWS
- [`cdkd diff`](cli-diff.md) — which stored output values it withholds, and why
- [State Management](state-management.md) — the state records `scrub` rewrites
- [Cross-Stack References](cross-stack-references.md) — the exports index the cross-stack refusals protect
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
