---
title: "cdkd state: malformed records"
description: "What the cdkd state subcommands print, and what they refuse, when a state record cannot be read, has an unexpected shape, or holds a stale value."
---

# cdkd state: malformed records

A state record is a JSON file in S3. A hand edit or a truncated write can
leave it in a shape cdkd does not expect. The [`cdkd state`](cli-state.md)
subcommands then follow one rule:

- The read-only subcommands (`list`, `resources`, `show`) show what they can
  and say on stderr what they could not show.
- The subcommands that would have to rely on the record's contents to write
  refuse it and change nothing.

This page lists what you see in each case. To look at the stored values
exactly as they are, run:

```bash
cdkd state show MyStack --json
```

## Rows `state list --long` could not read

`cdkd state list --long` reads every stack's record and lock. When one of
those reads fails, the listing continues. The affected row says what is
missing, a warning on stderr counts such rows, and the command still exits
`0`.

Two reads can fail, and each failure leaves the other value in place:

- **The record.** The row shows `Resources: unknown (...)`, and the lock is
  still reported. With `--long --json`, `resourceCount` is `null`, and
  `stateReadError` and `stateReadErrorKind` are set.
- **The lock.** The row shows `Lock: unknown (...)`, and the resource count is
  still reported. With `--long --json`, `locked` is `null` and `lockReadError`
  is set.

The text in parentheses gives the reason. Run `cdkd state show` on that stack
to see the underlying error.

### `stateReadErrorKind`

A script can use `stateReadErrorKind` to decide whether a retry is worthwhile:

| `stateReadErrorKind` | Meaning | Retry? |
| --- | --- | --- |
| `read-failed` | The record could not be read. | Possibly; the failure may be transient. |
| `resources-malformed` | The record was read, but its `resources` is not a JSON object. | No. Fix the record. |

Treat a value you do not recognise as a failure. More kinds may be added.

## Names that are quoted or cut

cdkd prints a stack name or region as it is when the value is a plain
identifier. Every real stack name and region is one, so you normally never see
anything else.

A hand-edited record or S3 key can hold other characters. A value with a
space, a bracket, a quote or a non-ASCII character is printed inside double
quotes. Without the quotes, such a value could be read as a different stack's
row. A very long value is cut and ends with
`[cut: N more characters withheld, tail sha256:<32 hex>]`.

The quotes mark where the value starts and ends for a person reading the
output. They are not shell quoting, so do not paste a quoted value into a
command.

Use `--json` when a script needs the exact stored values. `--json` output is
never quoted or cut this way. Control characters in it are written as `\uXXXX`
escapes, so the values parse back unchanged. That holds for the `--json` mode
of every `cdkd state` subcommand.

## What the human views do to a malformed record

The text output of `cdkd state resources` and `cdkd state show` treats every
value in the record as untrusted text. A stored value therefore cannot change
what the output appears to say:

- Control characters are removed from names, types, ids and dependency lists.
  A value cannot forge an extra output line or run a terminal escape sequence.
- A value of the wrong type is still printed. A number prints as that number
  and an object prints as JSON. A value that cannot be serialized prints as
  `(unserializable)`.
- A lock whose expiry cannot be read prints `expires at an unknown time`.

### Records that are refused outright

`state resources` and `state show` refuse a record that is broken at its root.
The message names the problem. This happens when:

- `state.json` is not valid JSON,
- its body is not a JSON object, or
- its schema version is one this cdkd does not read.

`cdkd state list --long` does not refuse. It marks only that stack's row, as
described under
[Rows `state list --long` could not read](#rows-state-list-long-could-not-read).

### `--json` and the stored values

`cdkd state show --json` prints the stored values without any of this
filtering. `cdkd state resources --json` is different: it prints the resource
list cdkd derived from the record, so a malformed part of the record does not
appear in it.

## When `resources` is not an object

In a healthy record, `resources` is a JSON object that maps each logical id to
a resource. A damaged record can hold a string, a list, a number or a boolean
there instead. The read-only views then treat the stack as having no resources
and print a warning on stderr.

| Command | What it prints |
| --- | --- |
| `cdkd state resources`, plain and `--long` | Nothing, plus the warning. |
| `cdkd state resources --json` | `[]`, plus the warning. |
| `cdkd state show` | `Resources (0):` and no resource blocks, plus the warning. |
| `cdkd state show --json` | The stored value, unchanged. No warning. |
| `cdkd state list --long` | `Resources: unknown (...)` for that row. |

An absent or `null` `resources` is reported the same way, with one difference:
`cdkd state list --long` counts it as `0` and gives no reason.

> [!WARNING]
> `cdkd deploy` and `cdkd destroy` refuse such a record. If they read it as
> empty, a deploy would create every resource again, and a destroy would
> delete none of them and then remove the record. Repair the record or remove
> it. [State Store](state-management.md) lists what each command does.

### With `--show-nested`

`cdkd state show --show-nested` judges each record in the tree separately. A
healthy parent with a malformed nested stack prints the parent's resources and
reports the child with none. It prints one warning for each record it read
that way.

`--show-nested --json` prints the stored values unchanged, like plain
`--json`, but it also prints one warning per malformed record.

## When a value container is not an object

Four other parts of a record are JSON objects too: `outputs` and
`skippedOutputs` on the record, and `attributes` and `properties` on each
resource. The same rule applies to them. One that holds a string, a list, a
number or a boolean is read as empty. cdkd prints one warning per record, and
the warning names each part it read as empty.

| Command | What it prints |
| --- | --- |
| `cdkd state show` | The record without that block, plus the warning. |
| `cdkd state resources --long` | `Attributes: (none)`, plus the warning. |
| `cdkd state resources --json` | `"attributes": {}`, plus the warning. |
| `cdkd state resources`, plain | The usual three columns. No warning. |
| `cdkd state show --json` | The stored value, unchanged. No warning. |

In `cdkd state show`, "without that block" means the following. An emptied
`outputs` prints no `Outputs:` block, and an emptied `skippedOutputs` prints
no `Skipped outputs:` block. An emptied `attributes` prints
`Attributes: (none)`, and an emptied `properties` prints `Properties: (none)`.

Three details:

- Plain `cdkd state resources` prints no warning because it prints no
  attributes.
- With `--show-nested`, the warning names the stack whose record it was.
  `--show-nested --json` prints the stored value with no warning.
- An absent or `null` container is normal and is not reported.

## What the writing subcommands refuse

The subcommands that write do not guess at a malformed record:

- [`cdkd state refresh-observed`](cli-state-writing.md#malformed-records-are-refused)
  refuses before it takes the lock or reads anything from AWS.
- [`cdkd state orphan --resource`](cli-state-writing.md#when-resource-refuses)
  refuses and writes nothing.

`cdkd state orphan` without `--resource` deletes the whole record, so it is
the way to remove a record you cannot repair. The AWS resources stay.

## When a nested resource shows the wrong `provisionedBy`

This section is about a record that is well formed but holds a stale value.

`cdkd state show` prints a `ProvisionedBy` line for each resource. It names
the layer that created the resource: `sdk` or `cc-api` (the AWS Cloud Control
API). A resource in a nested stack can carry `cc-api` from an older cdkd
release. In that release, `--recreate-via-cc-api <LogicalId>` also matched a
nested stack's resource that had the same logical id.

The value stays in the record, and you cannot edit it:

- The recreate flags cannot target a resource in a nested stack.
- No `cdkd state` subcommand changes the label. The two layers store different
  physical ids for many types, so changing the label alone would hand the SDK
  provider an id it cannot use.

### Check whether the type moves back by itself

Some types return to the default layer without any action.
[cdkd deploy: safety](cli-deploy-safety.md) and
[State Store](state-management.md) list them.

### Otherwise, rename the construct

Rename the construct in the nested stack, which changes its logical id:

```ts
// Before: new sqs.Queue(this, 'Jobs');
new sqs.Queue(this, 'JobsV2');
```

The next deploy creates the new logical id through the default layer. It then
deletes the old resource through the layer that created it.

> [!CAUTION]
> This destroys and re-creates the resource, and the deploy does not ask
> first. A stateful resource comes back empty. With a `Snapshot` deletion
> policy, the RDS default, the old one is deleted after a final snapshot.

### Prepare these cases before you rename

The deploy creates the new resource before it deletes the old one. Four kinds
of old resource need preparation:

- **A non-empty S3 bucket without `autoDeleteObjects`.** Empty it first.
  Otherwise its delete fails, and the rollback deletes the new bucket again.
  With `--no-rollback`, both buckets are left.
- **A resource with deletion protection.** Deploy the property set to `false`
  on its own, before the rename. A deploy never lifts protection, and the
  renamed resource would be created protected, so the rollback could not
  delete it either.
- **A resource with a fixed physical name.** Give the new one a different
  name. Or deploy the removal first and add the construct back in a second
  deploy.
- **A resource with `DeletionPolicy: Retain`.** No preparation is needed, but
  the old resource stays in AWS afterwards and is only dropped from state.
  Delete it yourself. If it has a fixed physical name, delete it before the
  deploy that adds the construct back.

## Related

- [`cdkd state`](cli-state.md): the read-only subcommands this page describes
- [cdkd state: writing subcommands](cli-state-writing.md): `orphan`, `destroy`, `migrate` and `refresh-observed`
- [State Store](state-management.md): the record schema, and what `cdkd deploy` and `cdkd destroy` do with a malformed record
- [cdkd state internals](cli-state-internals.md): the full rendering rules, for contributors
