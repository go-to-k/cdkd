---
title: "Destroy: interruption and damaged state"
description: "What happens when you interrupt cdkd destroy, why a damaged state record is refused and how to repair it, and how to destroy when the CDK app does not synthesize."
---

# Destroy: interruption and damaged state

This page covers three situations in which a destroy does not run from start
to finish: you interrupt it, the stack's state record is damaged, or the CDK
app does not synthesize. It is part of
[Destroy flags & guards](cli-destroy.md).

## Interrupting a destroy (Ctrl-C / SIGTERM)

Pressing {kbd:ctrl+c} once stops a destroy cleanly, and running the same
command again finishes it. CI cancellation sends SIGTERM, which cdkd treats
the same way. This applies to `cdkd destroy` and `cdkd state destroy`.

```bash
# Ctrl-C: in-flight deletes finish, state is preserved
cdkd destroy MyStack

# the re-run picks up the remaining resources
cdkd destroy MyStack
```

After the first {kbd:ctrl+c}, cdkd starts no new deletes. The deletes that are
already running finish, cdkd saves the state record with what is left, and it
releases the stack lock. It prints
`Destroy interrupted by Ctrl-C. State preserved` and exits `2`. Under `--all`
it also stops before the next stack starts.

The interrupted stack keeps its `state.json` and its deployment-event history.
That is why `--purge-events` does nothing for it.

### A second Ctrl-C quits at once

A second {kbd:ctrl+c} quits without waiting for the running AWS call. The exit
code is `130`, and the stack lock may be left behind. cdkd prints the command
that clears the lock:

```bash
cdkd force-unlock MyStack --stack-region us-east-1
cdkd destroy MyStack
```

### Edge cases

- **A signal just after a stack is picked up.** For a short time after cdkd
  starts on a stack, the clean stop is not yet in place. A first {kbd:ctrl+c}
  in that window quits at once, as a second one does.
- **A forced quit between two stacks.** When the signal arrives between two
  stacks, or before a stack's teardown started, cdkd cannot know which lock to
  name. It prints `cdkd force-unlock <stack-name>` for you to fill in.
- **A signal after the last stack was destroyed.** Nothing is left to re-run,
  so that run exits `0`.

## A damaged state record refuses the destroy

cdkd refuses to destroy a stack whose state record has the wrong shape in a
field the destroy depends on. It refuses before the confirmation prompt, with
the code `STATE_RESOURCES_MALFORMED` and exit `1`, and names the record and
its region. A state record gets into this shape when it was edited by hand or
cut short.

cdkd refuses because every guess would lose something. If it read a damaged
resource list as empty, for example, it would delete the record and leave
every resource running in AWS with nothing left to say what they were.

### Repairing the record

Look at the record, repair it in the state bucket, and run the destroy again:

```bash
cdkd state show MyStack --stack-region us-east-1 --json
```

If you want the record gone and the AWS resources left running,
`cdkd state orphan` drops it without touching AWS:

```bash
cdkd state orphan MyStack --stack-region us-east-1
```

This works when the damaged field is `resources`, `outputs` or `orphans` as a
whole. Leave out `--stack-region` for an old record that carries no region of
its own. Prefer repairing when the resources still matter, because orphaning
leaves them untracked.

### What is checked

| Field | Refused when it is | When the field is absent |
| --- | --- | --- |
| `resources` | Not an object | Refused |
| One entry of `resources` | Not an object, or has no `resourceType` | — |
| An entry's `properties` | Not an object | Refused |
| `outputs` | Not an object | Accepted |
| `orphans` | Not a list, or holds an unusable or duplicate entry | Accepted |

"Not an object" means a string, a list, a number, a boolean or `null`. A
nested stack's record that is reached through its parent's destroy is checked
the same way.

The sections below say what each check protects. The reasoning and the
behaviour for each shape are in
[Destroy internals](cli-destroy-internals.md#damaged-state-records). What
every other command does with the same record is in
[State Management](state-management.md).

### A malformed `resources` map refuses the destroy

The `resources` map is the list of what a destroy deletes. A map that is not
an object names nothing cdkd can delete. The run could then only remove the
record and report success while every resource was still running. A stack
always has a resource map, so a record without one is refused too.

The refusal prints the `cdkd state orphan` command as a template for you to
fill in. When the stack name or region is not a plain identifier, it prints no
target and points you at `cdkd state list --json` to read the exact name. See
[State Management](state-management-malformed-records.md#resources-is-not-an-object).

Two situations change what the refusal stops:

- **A nested stack's record is damaged.** The parent's destroy finishes its
  other deletes, ends with errors, and keeps its own state. Repair the nested
  stack's record and run the destroy again.
- **`--all`.** The refusal ends the run. The stacks cdkd had not reached yet
  are untouched.

### An unreadable resource record refuses the destroy

One entry of the map is `null`, a string, a list, or an object with no
`resourceType`. cdkd cannot tell how to delete it, so it refuses and names the
entries.

This refusal offers no `cdkd state orphan` template. Every other entry is
readable, and dropping the whole record would give up more than the one
damaged entry requires. Repair the entry instead.

An entry that names its type but has no usable `physicalId` is not refused.
cdkd skips that one resource; see
[A state record cdkd cannot address](cli-destroy-skipped.md#a-state-record-cdkd-cannot-address).
What other commands do is in
[State Management](state-management-malformed-records.md#one-resources-entry-cannot-be-read).

### An unreadable `properties` map refuses the destroy

An entry's `properties` decide what its delete does: whether an RDS instance
takes a final snapshot, whether an ECR repository is emptied first, which
resources the `--remove-protection` prompt counts. cdkd also works out the
order of the deletes from them.

If cdkd read damaged properties as empty, a delete would take the wrong path
after earlier resources were already gone. So a `properties` map that is
missing or not an object is refused.

An entry that its own `DeletionPolicy` retains is refused as well. cdkd does
not delete it, but its references to other resources still decide their order.

### A malformed `outputs` map refuses the destroy

The destroy reads `outputs` to decide whether it must check that no other
stack still imports from this one. A damaged map would make cdkd either invent
exports or skip the check. Skipping it would delete a record that other stacks
still read from.

A record with no `outputs` field is accepted, because cdkd writes such records
on purpose.

### A malformed `orphans` list refuses the destroy

`orphans` lists the `DeletionPolicy: Retain` resources that an earlier failed
deploy left in AWS. The destroy prints them before it deletes anything. That
listing is your only notice that cdkd stops tracking them, and a damaged list
would hide them.

The list is refused when it is not a list, when it holds an entry cdkd cannot
use, or when two entries share a `logicalId`. cdkd checks it when it first
reads the record and again once the stack is locked. A record with no
`orphans` field is accepted.

What other commands do is in State Management:
[when the field is not a list](state-management-malformed-records.md#orphans-is-not-a-list)
and
[when one entry cannot be read](state-management-malformed-records.md#one-orphans-entry-cannot-be-read).

## Destroying without a working CDK app

`cdkd destroy` can still delete a stack when the CDK app does not synthesize,
as long as you name the stack by its exact physical name. `--all`, display
paths and wildcards need the app.

```bash
cdkd destroy MyStage-Api          # exact physical name: works without the app
cdkd state destroy MyStage-Api    # never synthesizes
```

The reason is that display paths such as `MyStage/Api` exist only in the
synthesized app. A state record carries physical names only. So what works
depends on whether synthesis succeeded:

| Situation | `--all` and wildcards | An exact physical name |
| --- | --- | --- |
| The app synthesizes and has stacks | Work | Works |
| The app synthesizes but has no stacks | Refused | Found in state |
| Synthesis failed, or no app is configured | Refused | Found in state |
| A CDK Stage failed to load | Refused | Refused |

When synthesis failed, the synthesis error prints as the `Caused by:` line of
the refusal. The last row matches the AWS CDK CLI.

`--all` and wildcards never fall back to every stack in the state bucket,
because the bucket can hold the stacks of every app that shares it.

`cdkd state destroy '<stack>'` never synthesizes, so it works in every row. It
matches physical names only. The error for a Stage that failed to load names
that command; see
[the failed-Stage note](cli-deploy-safety-assembly-checks.md#a-pre-synthesized-assembly-is-trusted-input).

## Related

- [Destroy flags & guards](cli-destroy.md) — the command, its options and what can stop it
- [Destroy: skipped resources](cli-destroy-skipped.md) — a resource the destroy could not confirm it deleted
- [State Management](state-management.md) — state records, locks, and force-unlock
- [`cdkd force-unlock`](cli-force-unlock.md) — clearing a lock a forced quit left behind
