---
title: Malformed state records
description: "What each cdkd command does when a state record has been damaged by a hand edit or a truncated upload, and how to repair the record."
---

# Malformed state records

A state record is malformed when one of its parts has the wrong JSON shape,
for example `"resources": null`. cdkd does not write such records. They come
from a hand edit or a truncated upload. A command that would change or delete
something refuses a malformed record, and a command that only displays the
record carries on with a warning.

```bash
# the record exactly as stored
cdkd state show MyStack --stack-region us-east-1 --json
```

This page is part of [State Store](state-management.md).

## What cdkd does with a damaged record

Commands fall into two groups:

- **Commands that write or delete refuse.** The error code is
  `STATE_RESOURCES_MALFORMED`, and the message names the damaged part of the
  record.
- **Commands that only display repair the record in memory and warn.** The
  stored record is not changed.

The refusal protects your resources. If cdkd read a damaged `resources` map as
empty, the record would say that the stack has no resources. A deploy would
then try to create every resource again, and a destroy would delete nothing
and remove the record.

The sections below give the exact answer for each kind of damage. The
reasoning behind each row is on the contributor page
[State schema internals](state-schema-internals.md#schema-reference).

## Repair a damaged record

You have three ways out. The refusal message prints the commands that apply,
with the `--profile`, `--state-bucket` and `--state-prefix` you passed, so a
pasted command reaches the same bucket.

### Fix the record and put it back

This is the only option that keeps every resource managed by cdkd. Print the
stored record, correct the damaged part, and upload the corrected file:

```bash
cdkd state show MyStack --stack-region us-east-1 --json
```

If an earlier version of the record was healthy, restore that version.
[State backup and bucket security](state-management-backup-and-security.md#restore-an-earlier-version-of-a-record)
shows both the restore and the upload.

### Drop the whole record

Every live resource stays in AWS, and cdkd no longer tracks any of them. This
needs no CDK app.

```bash
cdkd state orphan MyStack --stack-region us-east-1
```

### Drop only the damaged resource

This applies when a single resource entry is damaged. The live resource stays
in AWS, and the rest of the record is repaired and kept.

```bash
# by construct path; the CDK app must still declare the resource
cdkd orphan MyStack/TheDamagedResource

# by logical ID; needs no CDK app
cdkd state orphan MyStack --stack-region us-east-1 --resource TheDamagedResource
```

## `resources` is not an object

`resources` should be a JSON object that maps each logical ID to a resource
entry. This section applies when it holds a string, a list, a number, a
boolean or `null`, or when it is absent. An empty `{}` is healthy.

| Command | What it does |
| --- | --- |
| `cdkd deploy`, including `--dry-run` | Refuses when it loads the record; exit `1` |
| `cdkd destroy`, `cdkd state destroy` | Refuses before the prompt and the lock; exit `1` |
| `cdkd orphan`, `cdkd import`, `cdkd rollback` | Refuse; exit `1` |
| `cdkd export` | Refuses the named stack and every nested child record; exit `1`, under `--dry-run` too |
| `cdkd scrub` | Refuses on a real run, exit `2`; audits and reports under `--dry-run` |
| `cdkd diff` | Repairs in memory and warns; reports the deploy's refusal under `Blocking`; exit `3` |
| `cdkd state show` | Repairs in memory and warns; `--json` still prints the stored value |
| `cdkd state resources` | Repairs in memory and warns; `--json` prints `[]` |
| `cdkd local *` with `--from-state` | Repairs in memory and warns |

Under `cdkd local *`, a reference to one of this record's resources resolves
to nothing.

## `outputs` is not an object

This section applies when `outputs` holds something other than a JSON object.
An absent `outputs` and an empty `{}` are both healthy.

cdkd judges `resources` and `outputs` separately, and the refusal names the
one that is damaged.

| Command | What it does |
| --- | --- |
| `cdkd deploy` | Refuses when it loads the record; exit `1` |
| `cdkd destroy`, `cdkd state destroy` | Refuses before the prompt; exit `1` |
| `cdkd orphan`, `cdkd import` | Refuse; exit `1` |
| `cdkd scrub` | Refuses on a real run, exit `2`; audits and reports under `--dry-run` |
| `cdkd diff` | Repairs in memory and warns; reports the deploy's refusal under `Blocking`; exit `3` |
| `cdkd state show`, `cdkd state resources` | Repair in memory and warn; `--json` still prints the stored value |
| `cdkd local *` with `--from-state` | Repairs in memory and warns; continues with no outputs from that record |

A destroy refuses because `outputs` decides whether other stacks still import
from this one.

### When another stack depends on the damaged record

- **A nested stack's child record is damaged.** The parent's deploy and its
  destroy both refuse, with exit `1`.
- **Another stack reads the record with `Fn::GetStackOutput`.** The reference
  is refused, and the reading stack's deploy fails.
- **cdkd rebuilds the exports index**, the file that lists every stack's
  exported values. It publishes nothing from the damaged record, warns, and
  indexes every other stack.

## One `resources` entry cannot be read

Here `resources` is an object, but one of its entries is damaged. The entry is
`null`, a string, a list, or an object with no string `resourceType`.

An entry that names its type but has no `physicalId` counts as readable here.
The command that reaches that entry reports what the missing ID costs.

| Command | What it does |
| --- | --- |
| `cdkd deploy`, including `--dry-run` | Refuses when it loads the record, naming the entries; exit `1` |
| `cdkd destroy`, `cdkd state destroy` | Refuses before the prompt and the lock, naming the entries |
| `cdkd import` | Refuses a selective import that would keep the entry |
| `cdkd orphan` | Refuses for an entry it would keep, under `--dry-run` too |
| `cdkd scrub` | Refuses on a real run, exit `2`; under `--dry-run` drops the entries and reports them |
| `cdkd state refresh-observed`, `cdkd drift --accept`, `cdkd drift --revert` | Refuse before the lock, naming the entries |
| `cdkd diff`, plain `cdkd drift` | Drop the entries, warn, and report the rest; `cdkd diff` also exits `3` |
| `cdkd local *` with `--from-state` | Drops the entries in memory and warns |

Two commands can remove the damage:

- `cdkd orphan` drops a damaged entry when that entry is the one you are
  orphaning.
- `cdkd import` repairs a damaged entry when you import that entry again with
  `--resource <id>=<physicalId> --force`.

## A resource's `properties` is not an object

This section applies when one resource's `properties` is not a JSON object, or
is absent. An empty `{}` is healthy.

cdkd refuses because of what a comparison with the template would conclude.
With `properties` unreadable, every property the template declares looks
missing from the resource. For a create-only property such as a bucket name,
a missing value means the resource would be replaced.

| Command | What it does |
| --- | --- |
| `cdkd deploy`, including `--dry-run` | Refuses when it loads the record, before any provider call, naming the resources; exit `1` |
| `cdkd destroy`, `cdkd state destroy` | Refuses before the prompt and the lock; exit `1` |
| `cdkd orphan` | Refuses when it would keep the resource; exit `1` |
| `cdkd export` | Refuses the named stack and every nested child record; exit `1`, under `--dry-run` too |
| `cdkd diff` | Repairs those maps to empty in memory and warns; exit `3` |

`cdkd orphan` never refuses for the resource you are orphaning, which is how
[dropping only the damaged resource](#drop-only-the-damaged-resource) works.

The same refusal covers a resource's `attributes` when it is `null` or not an
object and the command would keep the resource. An absent `attributes` is
healthy.

## `orphans` is not a list

`orphans` lists resources that a rollback left in AWS and removed from
`resources`, so that a later deploy can adopt them again. This section applies
when the field holds a string, a number, an object or `null`. An absent field
and an empty `[]` are both healthy.

| Command | What it does |
| --- | --- |
| `cdkd deploy` | Refuses when it loads the record, before any resource operation; exit `1` |
| `cdkd destroy`, `cdkd state destroy` | Refuses at its first read and again under the lock |
| `cdkd rollback` | Refuses before any replay |
| `cdkd import` | Refuses |
| `cdkd orphan` | Refuses, under `--dry-run` too |
| `cdkd scrub` | Refuses on a real run, exit `2`; audits and reports under `--dry-run` |
| `cdkd diff` | Repairs in memory and warns; exit `3` |

`cdkd diff --json` lists `orphans` in its `unreadableContainers` field.

## One `orphans` entry cannot be read

Here `orphans` is a list, but one of its entries is unusable. An entry is
usable only when all of these hold:

- it is an object with a string `logicalId`;
- its `state` is a readable resource entry with a non-empty `physicalId`;
- no other entry has the same `logicalId`.

| Command | What it does |
| --- | --- |
| `cdkd deploy` | Refuses when it loads the record |
| `cdkd destroy`, `cdkd state destroy` | Refuses at both reads |
| `cdkd rollback` | Refuses before any replay |
| `cdkd import` | Refuses |
| `cdkd orphan` | Refuses, under `--dry-run` too |
| `cdkd scrub` | Refuses on a real run, exit `2`; under `--dry-run` drops the entry and reports it |
| `cdkd diff` | Drops the entry and previews the rest; exit `3` |

`cdkd diff --json` lists the dropped entry in its `unreadableOrphans` field.

Repair the entry by hand; do not delete the record. No command removes a
single `orphans` entry, and the entry is the only evidence that a failed
deploy left its resource live in AWS.

When two entries share a `logicalId`, keep one of them. cdkd then no longer
tracks the resource the other entry described.

## Related

- [State backup and bucket security](state-management-backup-and-security.md):
  restore an earlier version of a record
- [Orphan Instead of Destroy](orphan-vs-destroy.md): what dropping a record does and
  does not delete
- [State Store](state-management.md): what a healthy record contains
