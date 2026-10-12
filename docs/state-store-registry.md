---
title: Stack registry
description: "The marker in the state bucket that ties a stack name to one state prefix, which commands read it, what they refuse, and the permissions it needs."
---

# Stack registry

The stack registry records which state prefix a stack belongs to. For each
top-level stack and region, the state bucket holds one small marker object:

```text
s3://cdkd-state-<accountId>/_cdkd-registry/<region>/<stack>.json
```

The marker names one `--state-prefix`. A command that would delete resources
reads it first, and refuses when it names a different prefix from the one the
command is running under. A nested stack is covered by the marker of its
top-level stack.

The registry is one of the two checks that keep
[one stack name to one deployment](state-store.md#one-stack-name-per-account-and-region).
It sees only one bucket. The
[name check](state-store-name-check.md) covers deployments in other buckets.

## Which commands read the marker

| Command | When it reads the marker |
| --- | --- |
| `cdkd deploy`, first deploy under a prefix | Always. It claims the marker before its first provider call. |
| `cdkd deploy`, later deploys | Only when the plan may destroy something. |
| `cdkd destroy`, `cdkd state destroy` | Always, before any prompt or delete. |
| `cdkd rollback` | Always, before the plan and the prompt. |
| `cdkd import` | Claims the marker once its record is saved. |

A later deploy "may destroy something" when its plan deletes a resource,
replaces one, may replace one, or adds or updates a nested stack. The read
happens before the `--require-approval` prompt. A plan that only creates
resources, updates them in place, or removes a retained resource makes no
registry request.

### A replacement found late

Sometimes a deploy learns that a resource needs replacing only when it reads
the resource back, after the plan was approved. cdkd checks the registry at
that point.

If the check refuses, cdkd keeps that resource, prints a warning, and carries
on with the rest of the deploy. The deploy then exits `2`, or `0` under
`--allow-unaddressed`.

### Rollbacks inside a deploy

Two more deletes ask the same question first:

- the automatic rollback of a failed deploy, before it deletes a resource
  that deploy created,
- a successful deploy, before it deletes a resource that an earlier failed
  deploy left in the rollback journal.

When another prefix holds the stack, or the check cannot run, cdkd keeps the
resource and warns. The resource stays in the journal, and a successful
deploy exits `2`.

## What a refusal means

A marker that names another prefix is compared with what that prefix actually
holds for the stack:

| The other prefix holds | Result |
| --- | --- |
| A record that can own a resource | The command refuses. The message names the prefix and the remedies. |
| Only a lock | A deploy is in progress there. The command refuses and names `cdkd force-unlock` for a lock a crashed run left. |
| An empty record | Not refused. The command prints a note with the `cdkd state orphan` command that removes it. |
| Nothing | The marker is stale. This prefix claims it. |

A record "can own a resource" when it lists resources, lists resources a
rollback left in AWS, or has a rollback journal that names a resource. A
failed first deploy that created nothing leaves an empty record, which blocks
nothing.

Once you know which record you are keeping, drop the other one. The refusal
prints the command:

```bash
cdkd state orphan MyStack --stack-region us-east-1 --state-prefix team-a
```

`cdkd state orphan` removes only the record and releases the marker. It never
deletes a resource.
[Lock and state errors](troubleshooting-locks-state.md#refusing-to-deploy-stack-x-it-is-already-recorded-under-another-state-prefix)
lists the remedies for each command.

## When the marker is removed

A marker lasts as long as its prefix can own the stack's resources. Every
command that removes a stack's record removes the marker after it:

- `cdkd destroy` and `cdkd state destroy`,
- `cdkd state orphan` of a whole stack,
- `cdkd export`, because CloudFormation now owns the stack,
- `cdkd rollback` of a first deploy, which removes the record,
- a first deploy that fails and leaves no record and no rollback journal.

`cdkd state migrate` copies the markers with the records.

After `cdkd state orphan`, a redeploy under the same prefix is still refused
for the resources it would take back. That refusal comes from the
[name check](state-store-name-check.md#after-cdkd-state-orphan), not from the
marker.

## Permissions

The registry needs three actions on the marker objects:

| Action | Resource |
| --- | --- |
| `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` | `arn:aws:s3:::<bucket>/_cdkd-registry/*` |

A policy that grants access to the whole bucket already covers them. A policy
that limits an identity to its own prefix, such as
`arn:aws:s3:::<bucket>/team-a/*`, must add the resource above.

When S3 denies access to the marker, the command warns and falls back to
listing the bucket's top-level prefixes. The same happens on an S3-compatible
endpoint that does not implement conditional writes. That fallback needs `s3:ListBucket`
on the whole bucket. If the listing is denied too, the command warns and
continues.

Any other failed read refuses the command and names the object it could not
read. That covers a server error, and a record or marker that does not parse.

## What the registry costs

A command that reads the marker reads one small object, once per run. A first
deploy adds one conditional write. An ordinary redeploy makes no registry
request at all.

A stack recorded before the registry existed has no marker. The first command
that needs the answer lists the bucket's top-level prefixes once, then claims
the marker. Every later command is one read.

A dry run reads the registry and never writes it.

## What the registry does not see

- **A record in another bucket.** The
  [name check](state-store-name-check.md) still refuses a create that would
  take over the other deployment's resource. Two records that already exist
  stay until you remove one.
- **A pair formed before the registry existed, under a prefix that contains
  a `/`** (such as `team/a`), when no marker exists yet.
- **A deploy by an older cdkd**, which neither claims nor reads markers.

[The internals page](state-store-internals.md#the-stack-registry) has the
full rules, including the order of the writes.

## Related

- [Manage Stacks Without the App](state-store.md#one-stack-name-per-account-and-region): why
  a stack name is one deployment
- [Name check before a create](state-store-name-check.md): the first check
- [State backup and bucket security](state-management-backup-and-security.md#iam-actions-cdkd-needs-on-the-bucket):
  the bucket policy
- [`cdkd state`](cli-state.md): `orphan`, `destroy` and `migrate`
