---
title: "cdkd diff: incomplete or malformed state"
description: "What cdkd diff does when a state record lacks an attribute a reference needs, and what it shows when the state record is damaged."
---

# cdkd diff: incomplete or malformed state

`cdkd diff` compares your app with the state record the last deploy wrote.
This page covers two cases where that record is not what the diff expects. In
the first, the record lacks one value and the diff fetches it from AWS. In the
second, the record is damaged and the diff shows what it can, with a warning.

## A state record missing an attribute

An attribute is a value AWS assigns to a resource, such as an ARN or an
endpoint address. cdkd stores attributes in state so that an `Fn::GetAtt` in
your template can be resolved without a call to AWS.

A record can lack an attribute that an `Fn::GetAtt` reads. This happens when:

- an older cdkd wrote the record before it stored that attribute;
- the resource was imported and no attributes were recorded;
- AWS had not assigned the value yet, such as the endpoint of an RDS instance
  deployed with `--no-wait`.

`cdkd deploy` handles this by reading the resource from AWS when a reference
needs the attribute. `cdkd diff` makes the same read. A property or output
that uses the attribute is then shown with the value AWS reports. If that
value changes a resource's property, the resource is shown as an update.

The read is limited:

- It happens only when a reference needs the attribute.
- It happens at most once per resource per run, in the stack's own region.
- The diff does not save what it reads to state.
- Custom resources and nested stacks are never read this way.

If the read fails, for example because a permission is missing, the diff does
not fail. The line is shown as it would be without the read.

> [!WARNING]
> An attribute that is itself a credential and that AWS returns unmasked, such
> as a Cognito user pool client's `ClientSecret`, is printed: in the rows, in
> `--json`, and in the `--verbose` log. This affects records an older cdkd
> wrote and records imported with `--migrate-from-cloudformation`.

## When the state record is malformed

A state record is malformed when it holds the wrong kind of value somewhere,
for example a string or a list where a map belongs. This happens to a record
that was edited by hand or cut short.

`cdkd diff` never writes state, so it does not refuse such a record. It treats
each damaged part as empty, prints a warning, and still shows a preview.
`cdkd deploy` refuses the same record, so the preview describes a deploy that
will not start until the record is repaired.

Look at the record as stored before you repair it:

```bash
cdkd state show MyStack --stack-region us-east-1 --json
```

### What you see

Beyond the warning, the diff reports the damage in four ways:

- A line after the totals names the entries it dropped. A whole damaged
  section is named `(resources map)` or `(orphans container)`.
- `--json` lists them in `unreadable`, `unreadableContainers` and
  `unreadableOrphans`; see
  [cdkd diff: JSON output](cli-diff-json.md#the-three-unreadable-fields).
- `--fail` counts them as a change.
- On the stack you named, the diff lists the damage under `Blocking` and exits
  `3`. A damaged `exportNames` list is the one exception: it only warns.

### How each kind of damage changes the preview

A damaged part is read as empty, so the preview is wrong for that part. The
parts of a state record are its `resources`, each resource's `properties`, its
`outputs`, its `exportNames`, and its `orphans`. The `orphans` list holds
resources a failed deploy left in AWS, which the next deploy can adopt.

| Damaged part | The preview shows |
| --- | --- |
| `resources` is not an object | Every declared resource as a create |
| One `resources` entry | That resource as a create, or no line |
| A resource's `properties` is not an object | Every property as an addition |
| `outputs` is not an object | Every output as an `ADD` |
| `orphans` is not a list | No adoption |
| One `orphans` record cannot be read | No adoption for that record |
| One `orphans` record has damaged contents | The adoption, with a warning |
| `exportNames` is not a list | No output marked as an export |

Some rows need more detail:

- A `resources` entry counts as damaged when it is not an object or has no
  resource type. The diff drops it. If your template still declares that
  resource, it is shown as a create. Otherwise it has no line.
- When a resource's `properties` is damaged, a property that cannot change in
  place is shown as a replacement. Do not act on these lines.
- When `outputs` is damaged, only the outputs that resolve are shown, and no
  `REMOVE` lines appear.
- An `orphans` record has damaged contents when its `properties` or
  `attributes` field is not an object. The diff keeps the record and previews
  it, and warns that the deploy refuses it.

### What is not damage

An empty `{}` or `[]` is healthy. So is a record with no `outputs` or
`orphans` field at all. A record with no `resources` map is a defect, and the
diff warns about it.

### Nested stacks

With `--recursive`, each nested stack has a state record of its own. A healthy
parent can therefore sit above a damaged nested stack, and the warning names
the stack it came from.

A damaged nested stack gets the warning without exit `3`. The reason is under
[Exit `3`](cli-diff.md#exit-3-the-deploy-would-refuse).

### More detail

What `cdkd deploy` does with each case is under
[Malformed state records](state-management-malformed-records.md). The
rules for each part of the record are in
[cdkd diff internals](cli-diff-internals.md#malformed-state-records).

## Related

- [`cdkd diff`](cli-diff.md): the text output, the exit codes and the options
- [cdkd diff: JSON output](cli-diff-json.md): the `unreadable` fields
- [`cdkd state`](cli-state.md): inspecting a state record
- [State Store](state-management.md): the state schema and how deploy treats a damaged record
