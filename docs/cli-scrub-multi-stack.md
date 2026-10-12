---
title: "cdkd scrub: across stacks"
description: "How cdkd scrub handles more than one stack: --all and its order, nested stacks, values one stack reads from another, and the shared exports index."
---

# cdkd scrub: across stacks

[`cdkd scrub`](cli-scrub.md) cleans one stack's state file at a time, but
stacks are connected. A nested stack has its own state file under its parent.
A stack can read a secret that another stack exports. And every stack in a
region publishes its exports to one shared index file. This page covers what
scrub does in each case.

```bash
# every stack in the app, in dependency order
cdkd scrub --all

# ParentStack and every nested stack under it
cdkd scrub ParentStack

# two stacks; the one that exports is scrubbed first
cdkd scrub DbStack ApiStack
```

## `--all`

`--all` scrubs every stack in the synthesized app. It scrubs a stack that
exports a value before the stacks that read that value, and it orders several
named stacks in the same way.

```bash
cdkd scrub --all
```

The order matters because scrubbing a reading stack depends on the exporting
stack: scrub copies the reference from the exporting stack's state. cdkd takes
the order from CDK's stack dependencies and from the `Fn::ImportValue` and
`Fn::GetStackOutput` references in the templates.

When scrub refuses one stack, it still scrubs the others. The run then ends
with exit code `2` and names each stack it could not examine, including every
nested stack under a stack that failed. The summary line never counts a stack
the run did not reach.

### Edge cases

- **`--all --dry-run` on an app that has never been scrubbed.** A dry run
  writes nothing, so the exporting stack is not cleaned before the reading
  stack is checked. The reading stack is then refused with
  `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`. That is expected. See
  [The exporting stack still stores the plaintext](#the-exporting-stack-still-stores-the-plaintext).
- **A state bucket shared by several CDK apps.** `--all` means every stack in
  this app. It does not mean every stack in the bucket. Run `cdkd scrub --all`
  from each app.

## Nested stacks

Scrubbing a stack also scrubs every nested stack (`cdk.NestedStack`) under it,
at any depth. `--all` and the `--dry-run --fail` gate cover nested stacks too.

A nested stack has its own state file, at
`<state-prefix>/<Parent>~<Child>/<region>/state.json`. It is not one of the
app's stacks, so you cannot name it on the command line. Pass its parent:

```bash
cdkd scrub ParentStack
```

A name in the `Parent~Child` form matches no stack. Scrub refuses it and
names the parent to pass. When your other arguments did match, scrub runs for
those and warns that the nested stack was not scrubbed.

A nested stack receives a secret through a parameter that its parent passes.
So scrub learns the nested stack's secrets from the parent's template, and
scrubs each nested stack right after the stack that deploys it.

### `SCRUB_NESTED_CHILD_UNRESOLVABLE`

Scrub refuses a nested stack that has a state file when it cannot work out
which parameter values the parent deployed it with. The nested stack is not
reported clean, the other stacks are still scrubbed, and the run exits `2`.
The message says which of these causes applies.

- **The parent's template no longer declares the nested stack.** Deploy the
  parent. The deploy destroys the nested stack and removes its state file.
- **The parent's state has no entry for the nested stack.** Deploy the parent
  so that it records the entry, then run scrub again. If a `Condition` keeps
  the nested stack out of the deploy, its state file is a leftover. Remove it
  with `cdkd state destroy`.
- **Nothing leads to the state file.** Either the parent's own state file was
  removed (`cdkd state orphan <Parent>` removes only the parent's file), or
  the entry is missing from both the parent's template and its state. Scrub
  finds these files by listing the state files under `<Parent>~` in the
  parent's region. Inspect the file with `cdkd state show`. If it is a
  leftover, remove it with `cdkd state destroy` (which also deletes its
  resources) or `cdkd state orphan` (which removes only the state file).
- **Scrub of the stack that deploys it failed.** That failure is reported too.
  Fix it and run scrub again.
- **A parameter value the parent passes could not be resolved, or the nested
  stack's parameter declaration rejects it.** The message, or `--verbose`,
  shows which value.
- **The synthesized template names no template file for the nested stack.**
  Synthesize again with a CDK version that writes it, then run scrub again.

A nested stack that never had a state file is skipped without a message.

### The parent's copy of a nested stack's outputs

A parent's state keeps a copy of each nested stack output, as an attribute
named `Outputs.<Name>` on the nested stack's entry. In a state file written by
an older cdkd, that copy can hold an output's plaintext. After scrubbing each
nested stack, scrub rewrites the parent's copy to match. It reports the change
in a line that starts
`Scrubbed N nested-stack output attribute(s) in <Parent>`.

Scrub rewrites a copy only when it equals exactly what the nested stack's
output resolves to. A copy that holds a known secret value but equals no output is reported
instead, and `--dry-run --fail` exits `1` until a deploy of the nested stack
rewrites it.

### Edge cases

- **A broken tree of nested templates.** When the nested templates refer to
  each other in a cycle, are nested too deeply, or one points outside the
  cloud assembly, scrub refuses the whole top-level stack before it writes
  anything. The code is `SCRUB_NESTED_TEMPLATE_TREE_MALFORMED`. Synthesize the
  app again with CDK.

## Values read from another stack

A stack can read another stack's exported value with `Fn::ImportValue` or
`Fn::GetStackOutput`. When the exported value is a secret, the reading stack's
state can hold it in plaintext too. Scrub replaces that plaintext with the
reference stored in the exporting stack's state.

For that to work, scrub must be able to read the exporting stack's state, and
that state must already hold the reference. `cdkd scrub --all` arranges both
by scrubbing the exporting stack first.

### The exporting stack still stores the plaintext

When the exporting stack has not been scrubbed, its state holds the plaintext
and no reference. Scrub then has nothing to write into the reading stack. It
refuses the reading stack with `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` and
names the exporting stack.

Scrub the exporting stack first, then the reading stack:

```bash
cdkd scrub DbStack
cdkd scrub ApiStack
```

When the value passes through several stacks, scrub them in order, starting
with the stack that declares the secret. `cdkd scrub --all` does this in one
run.

Scrub refuses only for an export that the templates show to carry a secret:
one the exporting stack declares from a `{{resolve:...}}` reference, or one it
passes on from a stack further up the chain that does. An ordinary import,
such as a bucket name or an ARN, is unaffected. The exact rules, and four
cases scrub cannot classify, are in
[cdkd scrub internals](cli-scrub-internals.md#which-exports-count-as-secret-bearing).

### The read cannot be resolved

When scrub cannot resolve an `Fn::ImportValue` or `Fn::GetStackOutput`, it
cannot learn the value to search for. Typical causes are a deleted exporting
stack and a missing state file. Scrub refuses the reading stack with
`SCRUB_CROSS_STACK_READ_UNRESOLVED`. Deploy the exporting stack or correct the
reference, then run scrub again.

Scrub does not refuse over a read it does not need. A read inside an `Fn::If`
branch that is not selected is skipped, and so is an `Fn::ImportValue` inside
an output that the template's conditions leave out.

### Names of values read from another stack

Beside the values, a stack's state records what it read: the export name of
each `Fn::ImportValue`, and the stack and output name of each
`Fn::GetStackOutput`.

A name can contain a secret when the template builds it from one:

```json
{
  "Fn::ImportValue": {
    "Fn::Sub": "{{resolve:secretsmanager:prod/tenant}}-queue-url"
  }
}
```

Here the stored export name contains the tenant secret's value. Scrub replaces
the value inside the stored name with the reference. It does this for three
fields:

- `imports[].exportName`,
- `outputReads[].sourceStack`,
- `outputReads[].outputName`.

Scrub leaves `sourceRegion` and `imports[].sourceStack` as stored.
`cdkd destroy` compares `imports[].sourceStack` with stack names when it
refuses to delete a stack that another stack still imports from. Rewriting the
field would remove that protection.

### A name built around a secret that has since been rotated

Scrub cannot repair a stored name whose secret was rotated after the name was
written. Scrub knows the secret's current value, and the stored name contains
the old one, so nothing matches.

Scrub still reports the name. The stack is not reported clean, and `--fail`
exits `1`. The warning identifies the entry by its position, such as
`state.imports[1]`, and never prints the stored value.

Rotating the secret again does not help. A deploy that updates the stack
rewrites both lists of reads. A deploy that finds nothing to change keeps the
old entry.

Scrub can report an entry in the same way after you remove its reference from
the template, when the entry's name looks like a secret-bearing read of the
same exporting stack. The exact test is in
[cdkd scrub internals](cli-scrub-internals.md#when-a-stale-name-is-reported).

## The exports index

After scrub rewrites a stack's `state.json`, it also updates that stack's
entries in the exports index, so the index does not keep a plaintext that
state no longer holds.

The exports index is one file per region, at
`<state-prefix>/_index/<region>/exports.json`. It maps each export name to the
exporting stack's output value, so that an `Fn::ImportValue` does not have to
read every state file. Every cdkd stack in the region shares it.

For each entry that a scrubbed stack publishes, scrub compares the entry with
the stack's stored output of the same name:

- **The stored output is a reference or `***`, and the entry differs.** Scrub
  sets the entry to the stored output. Until it does, the entry is a finding,
  and `--dry-run --fail` exits `1`.
- **The entry already matches.** Scrub writes nothing.

Scrub reads the index under `--dry-run` as well. So
`cdkd scrub --all --dry-run --fail` can exit `1` over an index entry even when
every `state.json` already holds the reference.

Scrub only changes the value of entries the index already has. It adds no
export name and removes none.

### Edge cases

- **An entry could not be written.** The run fails with
  `SCRUB_EXPORT_INDEX_INCOMPLETE` (exit `2`). Fix the cause, which is usually
  an S3 permission on `<state-prefix>/_index/`, and run scrub again. The
  second run writes only the entries that still differ.
- **An entry has no stored output of the same name.** Scrub leaves the entry
  as it is. Redeploy the exporting stack, which rewrites its index entries. If
  the entry's value still contains a known secret value, it is a finding and
  `--fail` exits `1`.
- **An entry belongs to a stack this run did not scrub.** Scrub reports it for
  information. It never fails the gate, because another CDK app that shares
  the bucket may own it.
- **A narrowed IAM policy.** Writing the index needs no permission beyond
  those `cdkd deploy` uses on the same file. A policy that someone restricted
  to `<state-prefix>/<stackName>/*` fails here, as it already fails for
  deploys that use cross-stack references.

The comparison rules and the wording of each report are in
[cdkd scrub internals](cli-scrub-internals.md#the-exports-index-pass).

## Related

- [`cdkd scrub`](cli-scrub.md): the commands, options and exit codes
- [cdkd scrub: what it covers](cli-scrub-what-it-covers.md): which values scrub rewrites and which it cannot see
- [cdkd scrub: findings and refusals](cli-scrub-findings.md): each message and code, with what to do
- [Use Another Stack's Outputs](cross-stack-references.md): how exports, imports and the exports index work
