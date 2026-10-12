---
title: Schema versions and upgrades
description: "How cdkd handles state records written by older and newer versions, what each schema version added, and what the provisionedBy, exportNames and skippedOutputs fields do."
---

# Schema versions and upgrades

Every state record carries a schema `version`, and the current one is `11`.
A newer cdkd reads every older version, so upgrading cdkd needs no migration
step. An older cdkd cannot read a record that a newer one has written.

```bash
# includes the schema version read from the bucket
cdkd state info

# the "version" one record was last saved with
cdkd state show MyStack --json
```

This page is part of [State Store](state-management.md).

## Upgrading cdkd

A newer cdkd upgrades an older record in memory when it loads the record. The
next time cdkd writes the record, it saves the record in the current version.
There is no migration command and nothing to run.

## Mixing cdkd versions on one stack

An older cdkd refuses a record written in a version it does not know, and
exits:

```text
Unsupported state schema version 11 for stack MyStack. This cdkd binary supports versions 1, 2, 3, 4, 5, 6, 7, 8, 9, 10. Upgrade cdkd to a version that supports schema 11.
```

cdkd writes the current version on every record it saves. So once a newer
cdkd has written a stack's record, every older cdkd fails on that stack.
Upgrade every machine and CI job that deploys a stack at the same time.

## What each version added

| Version | What it added |
| --- | --- |
| 1 | The original layout, with no region in the key; still readable |
| 2 | The region in the key |
| 3 | `observedProperties`, the drift baseline |
| 4 | `imports` |
| 5 | `deletionPolicy`, `updateReplacePolicy` |
| 6 | The nested-stack parent fields |
| 7 | `provisionedBy` |
| 8 | `outputReads` |
| 9 | `exportNames` |
| 10 | `observedBaselineRefused` |
| 11 | `NoEcho` values stored as `***` |

[What a state record contains](state-management.md#what-a-state-record-contains)
says what each field means. The contributor page
[State schema internals](state-schema-internals.md#schema-version-history) has
the full history of each version.

## The first deploy after an upgrade

The first deploy of a stack after an upgrade can do a little extra work,
depending on how old the record is.

**From before version 3.** The deploy records `observedProperties` for the
existing resources in the background. `cdkd drift` needs that field as its
baseline. Pass `--no-capture-observed-state` to skip the capture. To record
the field without a deploy, run `cdkd state refresh-observed MyStack`.

**From before version 5.** The deploy reports an `UPDATE` for every resource
whose template carries a `DeletionPolicy` or an `UpdateReplacePolicy`. The
deploy only writes the attribute into the record. It makes no AWS call for
these updates.

**From before version 11.** The deploy replaces `NoEcho` values in the record
with `***`.
[Secrets in state](state-management-secrets.md#upgrading-from-a-record-written-before-version-11)
describes what to rotate afterwards.

## `provisionedBy`: which route owns a resource

cdkd creates a resource through one of two routes: its own SDK provider for
the type, or the Cloud Control API as a fallback.
[Provisioning Layers](provisioning-layers.md) explains the two. Each resource
entry records the route that created it in `provisionedBy`, as `sdk` or
`cc-api`. A custom resource is recorded as `sdk`.

`cdkd state show` prints the field for each resource as `ProvisionedBy: sdk`
or `ProvisionedBy: cc-api`.

Two commands read it. `cdkd destroy` uses it to choose how to delete the
resource, and `cdkd drift` uses it to choose how to read the resource.

A recorded `cc-api` keeps the resource on Cloud Control for later deploys.
This holds even after cdkd gains an SDK provider for the type, because
switching routes could change the physical ID.

### Edge cases

**A record with no `provisionedBy`.** A record written before version 7 has no
such field, and `cdkd state show` prints
`ProvisionedBy: (sdk, legacy default)` for it. The
resource is not tied to a route, so cdkd chooses the route again on the next
deploy.

**A resource that returns to the SDK provider.** A few types move from Cloud
Control back to the SDK provider without being asked. cdkd allows this only
for a type whose SDK provider addresses the resource by the same physical ID,
so the move replaces nothing. `cdkd diff` marks such a resource
`[returning to SDK provider]`. Pass `--pin-cc-api <logicalId>` to decline the
move for that deploy.

**A type Cloud Control cannot manage correctly.** Such a type moves to the SDK
provider whether or not you pass `--pin-cc-api`.

The contributor page
[State schema internals](state-schema-internals.md#version-7-adds-provisionedby-v7-writers)
lists the types and the conditions.

## `exportNames`: which outputs are exports

`outputs` holds plain output names and export names side by side.
`exportNames` lists the keys that are exports, and only those keys can satisfy
an `Fn::ImportValue` in another stack.

| `exportNames` | Meaning |
| --- | --- |
| A list of names | Only these keys can be imported |
| `[]` | The stack exports nothing |
| Absent | A record from before version 9 |

In a record from before version 9, every output key can be imported until the
stack is next deployed. That deploy writes the field, even when the template
did not change.

### Two stacks export the same name

The stack deployed most recently wins, and cdkd warns. CloudFormation refuses
the second stack in this situation, so rename one of the exports.

## An output the deploy could not resolve

When a deploy cannot resolve an output, it skips that output. It stores no
value for the output and adds the output's name to the record's
`skippedOutputs` list. One cause is a secret reference that names a JSON key
the secret does not contain.

The list exists for `cdkd diff`. Diff does not resolve secrets, so it cannot
tell that the output would fail again. Without the list, every diff of the
unchanged stack would preview an `ADD` for the output, and `cdkd diff --fail`
would keep failing.

With the list, diff shows no row for the output until one of two things
happens: the template inputs that the output reads change, or a resource the
output refers to is itself changing in that diff.

How the output comes back depends on where you fix it:

- **In the template.** The row returns in `cdkd diff`, and the next deploy
  publishes the output.
- **Outside the template**, for example by adding the missing key to the
  secret. Diff cannot see this fix. The next deploy resolves the output and
  removes its name from the list.

## Related

- [State Store](state-management.md): where state lives and what a
  record contains
- [Provisioning Layers](provisioning-layers.md): the SDK and Cloud Control
  routes
- [Use Another Stack's Outputs](cross-stack-references.md): how exports and
  imports work between stacks
