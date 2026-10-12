---
title: After a failed or interrupted deploy
description: "What state a stack is in after a cdkd deploy fails or is interrupted, and how to revert it, resume it or adopt what it left behind."
---

# After a failed or interrupted deploy

By default cdkd rolls a failed deploy back, which reverts what the deploy
completed. The stack is left partly deployed in three cases: you passed
`--no-rollback`, you pressed {kbd:ctrl+c}, or the rollback itself died.

In those cases cdkd keeps two things in the state bucket. One is the state it
saved for every resource that completed. The other is the rollback journal, a
file that lists the operations the deploy completed, which `cdkd rollback`
uses to undo them. From there you have three ways on, shown below.
[Roll Back a Failed Deploy](rollback.md) describes the mechanism.

On this page:

- [Reverting a failed `--no-rollback` / interrupted deploy: `cdkd rollback`](#reverting-a-failed-no-rollback-interrupted-deploy-cdkd-rollback)
- [Detecting Orphaned Resources](#detecting-orphaned-resources)
- [Recovering from Orphaned Resources](#recovering-from-orphaned-resources)

```text diagram=troubleshooting-after-failed-deploy
                  ┌────────────────────────────┐
                  │ Deploy fails or is stopped │
                  └──────┬──────────────┬──────┘
                         ▼              ▼
  ┌─────────────────────────┐  ┌──────────────────────────────────┐
  │ Automatic rollback      │  │ --no-rollback, Ctrl+C, or a      │
  │ (default)               │  │ rollback that died               │
  │ Reverts what the deploy │  │ Partial state and a journal are  │
  │ completed               │  │ kept                             │
  └─────────────────────────┘  └────┬───────────┬───────────┬─────┘
                                    ▼           ▼           ▼
                        ┌─────────────┐ ┌───────────────┐ ┌──────────────┐
                        │ cdkd deploy │ │ cdkd rollback │ │ cdkd destroy │
                        │ Fix forward │ │ Revert        │ │ Clean up     │
                        └─────────────┘ └───────────────┘ └──────────────┘
```

A failed deploy can also leave an orphaned resource, which is one that exists
in AWS but is in no cdkd state file. cdkd saves state after every completed
resource, so orphans are rare. They have three sources:

- a create that was in flight when the process was killed,
- a resource that a rollback kept because of its `Retain` policy,
- a server error that left it unclear whether a create happened, covered
  under [Possible duplicates after a server error](troubleshooting-duplicates.md).

## Reverting a failed `--no-rollback` / interrupted deploy: `cdkd rollback`

```bash
# revert to the pre-deploy state
cdkd rollback MyStack

# skip the confirmation (--force also works)
cdkd rollback MyStack --yes

# also revert the resource that failed mid-deploy
cdkd rollback MyStack --revert-failed

# leave one resource alone (repeatable)
cdkd rollback MyStack --orphan MyQueue
cdkd rollback MyStack --stack-region us-west-2
```

`cdkd rollback` undoes the operations listed in the rollback journal. It
works from the journal alone, so it does not synthesize and needs no CDK app.
It asks for confirmation and refuses to ask when stdin is not interactive, so
in CI pass `--yes` or `--force`.

### When the rollback does not finish cleanly

- **`Nothing to roll back`.** There is no journal. Either a later deploy
  succeeded, or the process was killed before it wrote one. Run `cdkd deploy`
  to resume, or `cdkd destroy` to clean up.
- **Exit `2`, and the journal is kept.** One or more operations failed. Re-run
  `cdkd rollback`. Resources that were already reverted are skipped.
- **Exit `2`, and an operation was skipped with a warning.** That operation
  cannot be reverted, because the resource's physical id changed or the
  delete cannot be undone. Read the `ROLLBACK_RESOURCE_SKIPPED` event with
  `cdkd events MyStack`.
- **Exit `2`, and a resource is left that cdkd no longer tracks.** A reverted
  operation left a copy that `UpdateReplacePolicy: Retain` kept, or a resource
  whose delete failed. The operation's `ROLLBACK_RESOURCE_SUCCEEDED` event
  carries the id and a `reason`.

### A resource whose properties come from a secret

When a property uses `{{resolve:secretsmanager:...}}`, or a
`{{resolve:ssm:...}}` that points at a SecureString, cdkd stores the
reference in state and leaves the secret's value out. Reverting such a
resource resolves the reference again during the rollback. If the secret was
deleted, or your credentials can no longer read it, that revert fails with
exit `2` and the journal is kept. Restore access and re-run, or skip the
resource with `--orphan`.

Storing the reference removes secret values on a best-effort basis and
guarantees nothing. Treat a secret that was ever stored in plaintext as
compromised, and rotate it.

See [`cdkd rollback`](cli-rollback.md) for every flag and the known
limitations.

## Detecting Orphaned Resources

List what cdkd tracks, then compare it with AWS:

```bash
# which stacks have state
cdkd state list

# LogicalID, Type, PhysicalID
cdkd state resources MyStack

# machine-readable
cdkd state resources MyStack --json

# the full record, including properties
cdkd state show MyStack
```

```bash
aws cloudcontrol list-resources --type-name AWS::S3::Bucket
aws cloudcontrol list-resources --type-name AWS::Lambda::Function
```

Pass `--stack-region <region>` when the same stack name has state in more than
one region.

## Recovering from Orphaned Resources

In the usual case state was saved, and running `cdkd deploy` again is enough.
The existing resources are in state, so cdkd updates them or leaves them
alone.

If a resource exists in AWS without a state record, adopt it with
`cdkd import`. Do not delete `state.json`, and do not edit it by hand.

::: steps
1. See what cdkd tracks

   ```bash
   cdkd state resources MyStack
   ```

2. Preview the adoption

   ```bash
   cdkd import MyStack --dry-run   # writes no state
   ```

3. Adopt

   ```bash
   cdkd import MyStack

   # anything reported "not found"
   cdkd import MyStack --resource MyBucket=mystack-mybucket
   ```
:::

Copy a resource's exact name from AWS and do not construct it yourself. A
name cdkd generates is `<StackName>-<LogicalId>` only when that fits the
type's length limit. Otherwise cdkd truncates the name and appends `-` plus 8
hex characters.

A `--resource` import adds to the existing state. It needs no `--force` as
long as the resource is not in state yet.

To start over instead, delete the resources through cdkd:

```bash
cdkd state destroy MyStack --yes   # deletes the AWS resources AND the state
cdkd deploy MyStack
```

### A rollback left a `Retain` resource behind

When a deploy rolls back, a resource with `DeletionPolicy: Retain` stays in
AWS and its state record is dropped. CloudFormation does the same. With cdkd,
the next deploy then fails with an already-exists error. The names cdkd
generates have no random part, so the next deploy asks for exactly the name
the retained resource still holds. Re-running does not clear the error.

When the colliding name is one cdkd generated, the failure is followed by a
message that ends with the adoption command on its own line:

```text
ApiGatewayAccountCloudWatchRole: the name AWS reports as taken (mystack-apigatewayaccountcl-19184149) is one cdkd DERIVED from the logical id, and that derivation has no random component — so this is most likely a resource an earlier cdkd run left behind.
Adopt with: cdkd import MyStack --resource 'ApiGatewayAccountCloudWatchRole=mystack-apigatewayaccountcl-19184149'
```

The same message covers a second situation. A create can fail in a way that
does not say whether AWS made the resource, and cdkd's retry then finds the
name taken by the resource its own first attempt made. The message then opens
with `... is most likely held by a resource THIS create made`. That resource
is in no state file, so no rollback and no `cdkd destroy` removes it.

> [!IMPORTANT]
> Confirm the resource is yours before adopting it. A generated name is
> predictable. For a globally unique name it can belong to another account,
> and the same stack in another region generates the same name. Importing
> that leaves two stacks sharing one resource.

If you do not want to keep the resource, delete it in AWS after confirming it
holds nothing you need, then re-deploy.

#### When the message prints no import command

In three cases cdkd tells you to delete the resource and prints no import
command:

- the type cannot be imported,
- the resource is in a nested stack,
- the name contains characters that would change what the printed command
  means.

A name that holds whitespace or shell characters is printed as a quoted
placeholder (`'<stack>'`, `'<logicalId=physicalId>'`). Replace it with your
own quoted value.

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
