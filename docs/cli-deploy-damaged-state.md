---
title: "Deploy: a damaged state record"
description: "Why cdkd deploy refuses a hand-edited or truncated state record with STATE_RESOURCES_MALFORMED, which parts of the record it checks, and how to recover."
---

# Deploy: a damaged state record

`cdkd deploy` refuses to run against a state record whose structure is broken.
The refusal carries the code `STATE_RESOURCES_MALFORMED` and exits `1`.
Nothing is provisioned, and no state is written for that stack.

A record gets into this condition when it was edited by hand or truncated. It
then holds the wrong kind of value where cdkd expects a map or a list, for
example a string where the map of resources belongs.

## How to recover

::: steps
1. Inspect the record

   ```bash
   cdkd state show MyStack --stack-region us-east-1 --json
   ```

2. Preview the rest of the stack

   [`cdkd diff`](cli-diff.md) does not refuse. It reads each damaged part as
   empty, warns, and still prints a preview. On the stack you named it exits
   `3`, because the deploy would refuse.

   ```bash
   cdkd diff MyStack
   ```

3. Repair or remove the record, then deploy again
:::

## Which parts of the record are checked

A state record is a JSON document. The table lists the parts a deploy checks
and what it refuses in each.

| Part of the record | Refused when it is | Accepted |
| --- | --- | --- |
| `resources` map | Not an object, or absent | An empty `{}` |
| One record in `resources` | Not an object, or an object with no `resourceType` | |
| A resource's `properties` map | Not an object, or absent | An empty `{}` |
| `outputs` map | Not an object | An absent field |
| `orphans` list | Not a list, or a list holding a record cdkd cannot read | An absent field |

The `orphans` list records the `DeletionPolicy: Retain` resources that a
rollback left standing, so that the next deploy can adopt them back.

## Why cdkd refuses and does not repair

Reading a damaged part as empty would be worse than refusing. A `resources`
value that is not a map, for example, lists no resources. cdkd would conclude
that nothing is deployed, and the deploy would try to create a stack that is
already standing.
[Deploy internals](cli-deploy-internals.md#why-a-damaged-record-is-refused-and-not-repaired)
walks through each part.

## Details for each part

### `resources`, one resource record, and `properties`

- `--dry-run` refuses too, because its plan comes from the same comparison.
- The refusal names the resource records it could not read. It lists up to
  five, and then gives a count.
- When `--recreate-via-cc-api` or `--recreate-via-sdk-provider` names a
  resource, cdkd runs the same check on that resource before it takes the
  stack lock.

### `outputs`

The refusal also covers the record of a nested stack. The parent stack stores
the nested stack's outputs as its own `Outputs.<Key>` attributes.

### `orphans`

A record in the `orphans` list is unreadable in any of these cases:

- it is not an object;
- it has no string `logicalId`, or it shares its `logicalId` with another
  record;
- it has no readable `state`. A readable `state` has a non-empty string
  `physicalId`, and `properties` and `attributes` maps that are objects.

## How other commands treat the same damage

Other commands read the same record and react differently.
[Malformed state records](state-management-malformed-records.md) describes
each command, part by part:

- [`resources`](state-management-malformed-records.md#resources-is-not-an-object)
- [`properties`](state-management-malformed-records.md#a-resource-s-properties-is-not-an-object)
- [`outputs`](state-management-malformed-records.md#outputs-is-not-an-object)
- [`orphans`](state-management-malformed-records.md#orphans-is-not-a-list)
- [one `orphans` record](state-management-malformed-records.md#one-orphans-entry-cannot-be-read)

## Related

- [`cdkd state`](cli-state.md): inspecting and editing the state record
- [`cdkd diff`](cli-diff.md): the preview that still runs against a damaged record
- [State Management](state-management.md): the state record's layout
- [Deploy: waits & concurrency](cli-deploy.md): every deploy flag
