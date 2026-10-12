---
title: Stop on Destructive Changes
description: "Stop before a change that would replace, delete or orphan an existing resource: cdkd diff --fail-on=destructive fails a CI check, and cdkd deploy --require-approval=destructive asks first."
---

# Stop on Destructive Changes

Most changes to a CDK app are safe to deploy without a second look. The ones
that are not are the changes that lose an existing resource: a property change
that forces a replacement, a refactor that renames a construct's logical ID, a
resource dropped from the template. cdkd can stop on exactly those changes and
let everything else through:

```bash
# CI check: exit 1 if a change would lose a resource
cdkd diff --all --fail-on=destructive

# deploy, but ask first if a change would lose one
cdkd deploy MyStack --require-approval=destructive
```

Both use the same rule for what counts as destructive, so a change the diff
flags is the change the deploy asks about.

## What counts as destructive

A change is destructive when it replaces, deletes or orphans a resource that
already exists. Additions and in-place updates are not.

| Impact | When |
| --- | --- |
| `will be replaced` | A create-only property changes, or the resource's `Type` changes. |
| `may be replaced` | A create-only property reads a value only the deploy can resolve. |
| `will be destroyed` | The resource leaves the template. |
| `will be orphaned` | The resource leaves the template with `DeletionPolicy: Retain` or `RetainExceptOnCreate`. |

Both commands list each destructive change by stack, resource type, construct
path and logical ID:

```text
MyStack: AWS::S3::Bucket MyBucket MyBucketF68F3FF0 will be replaced
MyStack: AWS::DynamoDB::Table MyTable MyTable794EDED1 will be orphaned
```

Nested stacks are always checked. `AWS::CDK::Metadata` is never reported.

## Fail a CI check: `cdkd diff --fail-on=destructive`

Run the diff as a pull-request check. It prints the full diff, lists the
destructive changes, and exits `1` if there is at least one:

```console
$ cdkd diff --all --fail-on=destructive
...
❌  Found 2 destructive change(s) (--fail-on=destructive):
  MyStack: AWS::S3::Bucket MyBucket MyBucketF68F3FF0 will be replaced
  MyStack: AWS::DynamoDB::Table MyTable MyTable794EDED1 will be orphaned
```

When `cdkd deploy` would refuse to start, the diff exits `3` instead and
lists the refusal, not the destructive changes, so treat any non-zero exit as
a failed check. Exit `1` also means the command itself failed, for example on
an authentication error; a failed command prints an error instead of the
report.
[`cdkd diff`](cli-diff.md#exit-codes) lists every exit code.

Use `--fail-on=any-change` instead to fail on every difference.

## Ask before deploying: `cdkd deploy --require-approval=destructive`

With this level, `cdkd deploy` stops before a stack with a destructive change,
lists the changes, and asks:

```text
Destructive changes:
  MyStack: AWS::DynamoDB::Table MyTable MyTable794EDED1 will be orphaned

Stack MyStack: 0 to create, 1 to update, 1 to delete.
Stack includes destructive updates and "--require-approval" is set to 'destructive'.
Do you wish to deploy these changes? (y/n)
```

Answering no fails that stack's deploy with nothing changed. A nested stack
asks when its parent reaches it; declining fails the nested stack, and the
parent rolls back. A stack with no destructive change deploys without a
question.

To make it the default for an app, set it in `cdk.json`, where the AWS CDK CLI
reads it too. The flag wins over the file:

```json
{
  "app": "npx ts-node bin/app.ts",
  "requireApproval": "destructive"
}
```

> [!IMPORTANT]
> Without a terminal, as in CI, the deploy fails instead of asking. Pass
> `--yes` to approve every question, or gate the pipeline on
> `cdkd diff --fail-on=destructive` before the deploy step.

A `--recreate-via-*` target counts as a replacement, so it asks too.
`--dry-run` never asks. The AWS CDK CLI's `broadening` level is not available,
because cdkd does not compute a security diff; in `cdk.json` it is ignored
with a warning.

## Related

- [`cdkd diff`](cli-diff.md#fail-on): every `--fail-on` value
- [cdkd deploy: strictness and approval flags](cli-deploy-safety-ci-flags.md#require-approval-deploy):
  `--require-approval` with nested stacks and parallel deploys
- [cdkd deploy: replacements and name collisions](cli-deploy-safety-replacement.md):
  what a replacement does to a named resource
- [Orphan Instead of Destroy](orphan-vs-destroy.md): what an orphaned resource is
