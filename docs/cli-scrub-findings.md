---
title: "cdkd scrub: findings and refusals"
description: "Each message behind cdkd scrub's exit code 1 and each refusal code behind exit code 2, with what it means and what to do."
---

# cdkd scrub: findings and refusals

[`cdkd scrub`](cli-scrub.md) fails in two different ways, and they call for
different responses.

| Exit code | Meaning | Response |
| --- | --- | --- |
| `1` | A finding: scrub looked and a leak remains. | Rotate the secret. |
| `2` | A refusal: scrub did not finish looking. | Fix what the message names, then run scrub again. |

Exit code `1` needs `--fail`. Exit code `2` does not.

Under `--dry-run --fail`, any referenced secret found in plaintext is a
finding, because a dry run rewrites nothing. This page covers the findings
that remain after a real run, and every refusal.

## Findings scrub reports but cannot rewrite

A real run rewrites what it can. Some leaks are in places it cannot rewrite.
For each of these, scrub prints a message, scrubs the rest of the stack, and
does not report the stack as clean. With `--fail`, the run exits `1`.

### An output key contains a secret

The message contains this text:

```text
N output KEY(s) in <stack> hold plaintext and CANNOT be scrubbed
```

The name of a stored output contains a secret's value. This happens when an
output's `Export.Name` is built from a secret. Scrub can rewrite a value but
cannot rename a key, because other stacks import by that name.

Rotate the secret, change the `Export.Name`, and redeploy.

Scrub also detects a secret in a key when invisible characters split it, or
when it is spelled in look-alike compatibility characters such as full-width
letters. If this message appears for state that used to pass, the key was
already leaking. What changed is what cdkd can detect. The detection rules are
in
[cdkd scrub internals](cli-scrub-internals.md#a-state-key-that-renders-a-secret).

### A read from another account could not be verified

The message contains this text:

```text
N cross-stack read(s) in <stack> could NOT be verified
```

The stack reads a secret that a stack in another AWS account exports. cdkd
does not look up another account's secret with the reading stack's
credentials, so scrub cannot check this value. Running scrub again does not
change that.

Export a value that is not secret, such as the secret's ARN, or reference the
secret from within its own account.

The same message has a second cause with a different exit code. When scrub
cannot read the exporting stack's stored outputs at all, the run exits `2`
with
[`SCRUB_PRODUCER_RECORD_UNREADABLE`](#scrub-producer-record-unreadable).

### A scan stopped at a reference that could not be resolved

The message contains this text:

```text
N scan(s) in <stack> were ABANDONED mid-value because a {{resolve:...}} reference could not be resolved
```

Scrub could not look up one reference. It then skipped every later reference
in the same value, so a plaintext behind those references was not searched
for.

Restore the parameter or secret the reference names, or fix the `Fn::Sub`
variable inside it, and run scrub again.

A failure stops only the top-level property it occurred in, and the warning
names that property. Other properties of the same resource are still checked.

Only failures that you can clear count toward `--fail`:

- **Counted, exit `1`.** The reference itself failed: a deleted parameter, a
  secret you are denied access to, or a missing JSON key. Restoring it clears
  the finding.
- **Counted, exit `1`.** An `Fn::Sub` placeholder inside the reference names
  nothing the template declares. Fixing the template clears the finding.
- **Warning only.** A `Ref` or `Fn::GetAtt` could not be resolved, or a
  parameter has no `Default`. Scrub has no `--parameters` flag, so it could
  never supply these, and a failed gate could not be cleared.
- **Warning only.** The reference's own text still contains a `${...}` that no
  `Fn::Sub` fills. Such a reference could never be looked up, for the same
  reason.

A property that scrub could not check may still hold a plaintext from an
older cdkd. Give the parameter a `Default`, or make the reference resolvable,
so that the next run can check it.

### A name read from another stack holds a rotated secret

The message contains this text:

```text
N cross-stack read name(s) in <stack> hold a plaintext scrub could NOT repair
```

State records the names of the exports a stack reads. One of those names
contains a secret's value from before the secret was rotated, which scrub
cannot match. See
[A name built around a secret that has since been rotated](cli-scrub-multi-stack.md#a-name-built-around-a-secret-that-has-since-been-rotated).

### A leftover output key was kept

The message ends with `were LEFT as they are`.

State holds an output key that the template no longer declares, and scrub
kept it. Either another stack still reads the key, or the key may be an export
name that scrub could not work out. See
[Leftover output keys that scrub keeps](cli-scrub-what-it-covers.md#leftover-output-keys-that-scrub-keeps).

## Refusals

A refusal means scrub declined to examine something. Scrub stops work on that
stack and does not report it as clean. The run exits `2`, with or without
`--fail`. Each refusal message carries one of the codes below.

One situation looks like a refusal and is not. When a template has a `Ref` to
a resource that state does not contain, scrub checks the rest of that
resource and continues.

### Reads from another stack

#### `SCRUB_CROSS_STACK_READ_UNRESOLVED`

Scrub could not resolve an `Fn::ImportValue` or `Fn::GetStackOutput`. Typical
causes are a deleted exporting stack and a missing state file.

Deploy the exporting stack or correct the reference, then run scrub again.

#### `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`

The read worked, but the exporting stack's own state still holds the secret in
plaintext. Scrub has no reference to copy into the reading stack.

Run `cdkd scrub '<exporting stack>'` first, then run scrub again. For a chain
of stacks, scrub each one, starting with the stack that declares the secret.
`cdkd scrub --all` does this in one run. See
[The exporting stack still stores the plaintext](cli-scrub-multi-stack.md#the-exporting-stack-still-stores-the-plaintext).

#### `SCRUB_PRODUCER_RECORD_UNREADABLE`

A stack imports from a stack whose stored outputs cannot be read, so scrub
cannot tell whether that stack still holds the plaintext. Scrub raises this
with or without `--fail`, `--dry-run` included. The importing stack was still
scrubbed for everything else.

Repair the exporting stack's state file, scrub that stack, then run scrub
again.

#### `SCRUB_CROSS_REGION_SECRET_UNRESOLVED`

A secret reference whose ARN names another region could not be read in that
region. Scrub does not fall back to the stack's own region.

Grant read access in that region, or restore the secret.

### Nested stacks

#### `SCRUB_NESTED_CHILD_UNRESOLVABLE`

A nested stack has a state file, but scrub could not work out which parameter
values its parent deployed it with. Every other stack was still scrubbed.

The message names the cause. The causes and their remedies are listed under
[`SCRUB_NESTED_CHILD_UNRESOLVABLE`](cli-scrub-multi-stack.md#scrub-nested-child-unresolvable)
on the multi-stack page.

#### `SCRUB_NESTED_TEMPLATE_TREE_MALFORMED`

The nested templates under a stack form a cycle, are nested too deeply or are
too large, or one names an absolute `aws:asset:path` or a path outside the
cloud assembly. Nothing in that stack or under it was written.

Synthesize the app again with CDK.

### State files

#### `STATE_RESOURCES_MALFORMED`

A state file is damaged. Scrub refuses the stack in these cases:

- `resources` is absent, `null`, or not an object.
- One entry of `resources` is not an object, or has no `resourceType`.
- `outputs` is `null` or not an object. An absent `outputs` is fine.
- `orphans` is not a list. An absent `orphans` is fine.
- One entry of `orphans` is not an object, has no string `logicalId`, shares
  its `logicalId` with another entry, or holds a resource entry that cannot be
  read.

Inspect the file and repair or remove it:

```bash
cdkd state show MyStack --stack-region us-east-1 --json
```

A real run refuses because saving would replace the damaged part with a
well-formed empty one, and that would destroy the evidence of the damage.
`cdkd deploy` and `cdkd destroy` refuse the same damage.

A dry run cannot write, so it checks the parts it can read, warns about the
part it skipped, and still exits `2`. The `2` takes priority over the `1` of
`--fail`. Exit code `1` would tell you to rotate a secret on the strength of a
file scrub could not fully read.

#### `SCRUB_LEGACY_STATE_KEY_SURVIVES`

The state file was in the old key layout, `<state-prefix>/<stack>/state.json`.
Scrub wrote it to the region-scoped key, but could not delete the old key,
which still holds the content from before the scrub.

Delete the old key by hand, then purge its earlier versions as described in
[What a real run removes, and what it cannot](cli-scrub.md#what-a-real-run-removes-and-what-it-cannot).
A second run does not detect the old key again.

#### `SCRUB_LEGACY_STATE_KEY_UNVERIFIED`

The same rewrite happened, but scrub could not read the old key back to
confirm the delete. Causes include throttling, a server error and a denied
read.

Check the old key yourself. If it exists, delete it and purge its earlier
versions. A second run does not check it again.

### Outputs and the exports index

#### `SCRUB_DROPPED_OUTPUT_READERS_UNVERIFIED`

Scrub had a leftover output key to remove. Before removing one, it confirms
that no other stack reads it, and here it could not list the bucket or read
another stack's state file. Scrub raises this after the summary. No key was
removed.

Fix the read and run scrub again. The cause is usually an S3 permission, or a
damaged state file that the warning names. See
[Outputs the template no longer declares](cli-scrub-what-it-covers.md#outputs-the-template-no-longer-declares).

#### `SCRUB_EXPORT_INDEX_INCOMPLETE`

Scrub rewrote `state.json` but could not write one of the stack's entries in
[the exports index](cli-scrub-multi-stack.md#the-exports-index).

Fix the cause, which is usually an S3 permission on
`<state-prefix>/_index/`, and run scrub again. The second run writes only the
entries that still differ.

### The whole run

#### `SCRUB_STACKS_FAILED`

Under `--all`, at least one stack ended in a refusal. The other stacks were
still scrubbed, and each stack's own reason was printed when it happened.

Fix each stack the message names.

#### `SCRUB_STAGE_LOAD_FAILED`

The cloud assembly of a CDK Stage could not be read. Scrub raises this before
it selects any stack or reads any state, `--dry-run` included.

Synthesize the app again so that the Stage is written, or point `--app` at a
complete cloud assembly.
[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md) describes a
Stage that fails to load.

## Related

- [`cdkd scrub`](cli-scrub.md): the commands, options and exit codes
- [cdkd scrub: what it covers](cli-scrub-what-it-covers.md): which values scrub rewrites and which it cannot see
- [cdkd scrub: across stacks](cli-scrub-multi-stack.md): `--all`, nested stacks and values read from other stacks
- [cdkd scrub internals](cli-scrub-internals.md): the matching rules behind each finding
