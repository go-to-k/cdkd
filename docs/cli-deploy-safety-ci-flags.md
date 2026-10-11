---
title: "cdkd deploy: strictness and approval flags"
description: "Four cdkd deploy flags for pipelines: --strict-getatt, --allow-unaddressed, --no-cfn-fallback and --require-approval."
---

# cdkd deploy: strictness and approval flags

These four flags change how strict `cdkd deploy` is about an outcome it would
otherwise let through, or let through with a warning. They matter most in a
pipeline, where nobody reads the warnings.

```bash
# fail on a guessed Fn::GetAtt value
cdkd deploy MyStack --strict-getatt

# exit 0 when a resource was left alive
cdkd deploy MyStack --allow-unaddressed

# resolve cross-stack references from cdkd state only
cdkd deploy MyStack --no-cfn-fallback

# ask before replacing or deleting anything
cdkd deploy --require-approval=destructive
```

| Flag | Without it | With it |
| --- | --- | --- |
| [`--strict-getatt`](#strict-getatt-deploy) | A guessed attribute value warns | The deploy fails |
| [`--allow-unaddressed`](#allow-unaddressed-deploy) | A resource left alive exits `2` | Exits `0` |
| [`--no-cfn-fallback`](#no-cfn-fallback-deploy-diff) | A missing reference is looked up in CloudFormation | The reference is not found |
| [`--require-approval`](#require-approval-deploy) | cdkd deploys without asking | cdkd asks first |

This page is part of
[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md).

## `--strict-getatt` (deploy)

`--strict-getatt` fails the deploy when cdkd would have to guess the value of
an `Fn::GetAtt`, and when it cannot resolve a stack Output. Use it in CI so a
guessed value never ships unnoticed.

```bash
cdkd deploy MyStack --strict-getatt
```

### What cdkd does without the flag

`Fn::GetAtt` asks for an attribute of a resource, such as a queue's ARN. cdkd
normally finds the attribute in the resource's state record or constructs it.
When it can do neither, it reads the resource from AWS once and uses the value
if the read supplies it.

If the attribute is still missing, cdkd substitutes the resource's physical
ID. That guess can be wrong, and what happens next depends on the attribute's
name:

| Attribute name | The guess | Result |
| --- | --- | --- |
| Ends in `Arn` | Is not `arn:`-shaped | The deploy fails |
| Ends in `Url` | Is not an http(s) URL | The deploy fails |
| Anything else | Any value | A warning; the deploy continues |

A failure names the resource and the attribute and carries an issue link. The
warning reads
`Unknown attribute X for resource type Y, returning physical ID`.

Other attribute names only warn because cdkd cannot tell a wrong value from a
right one by its shape. An alias or an endpoint looks like a plain name, so
failing there would break correct deploys.

A summary line counts the guesses, once per distinct place and per stack. A
nested stack counts its own.

```text
2 attribute resolution(s) fell back to the physical ID (potentially wrong values); re-run with --strict-getatt to fail on these
```

An Output that cdkd cannot resolve is warned about and skipped. cdkd stores no
value for it and exports nothing, and the deploy exits `0`.

### What the flag changes

With `--strict-getatt`, every substituted physical ID is an error, whatever
the attribute's name. That includes a substitute that happens to look like an
ARN for an attribute ending in `Arn`.

An Output that cannot be resolved also fails the deploy. Without the flag it
would break other stacks' `Fn::ImportValue` with "export not found" long after
this deploy exited `0`.

The Output failure comes after every resource operation has succeeded, so cdkd
saves state first. Created and updated resources are recorded, earlier outputs
are kept, and no rollback runs. A following `cdkd deploy` or `cdkd destroy`
sees everything.

Nested stacks inherit the flag from the parent deploy. Leave the flag off when
you know a substitute is right, for instance on a type whose physical ID is
the attribute's value.

### Attributes that are never guessed

Some attributes cdkd always reads from AWS, and it never substitutes the
physical ID for them:

- an EC2 instance's `PrivateIp`, `PublicIp`, `PrivateDnsName`, `PublicDnsName`
  and `AvailabilityZone`;
- a VPC's `DefaultSecurityGroup`;
- a CloudFront distribution's `DomainName`;
- a security group's `VpcId`.

When AWS has not assigned the value yet, as for an instance still `pending`
under `--no-wait`, or when the read fails, cdkd refuses to resolve the
reference. The message names the resource, the attribute, what cdkd observed
and the remedy. [`cdkd deploy`](cli-deploy.md) describes the effect under
`--no-wait`.

An RDS `DBProxy` or `DBProxyEndpoint` `VpcId` that is missing from the state
record is refused the same way.

The same rules apply inside `Fn::Sub`. A `${LogicalId.Attribute}` placeholder
that would fail as a resource property fails there too. A variable that does
not exist warns and keeps its `${...}` text.

## `--allow-unaddressed` (deploy)

A deploy in which no resource failed can still leave a resource alive in AWS
that cdkd was responsible for. That outcome exits `2`, as `cdkd destroy` does
for the same case. `--allow-unaddressed` makes it exit `0`.

```bash
# exit 2 if a resource was left alive
cdkd deploy MyStack

# exit 0 for the same run
cdkd deploy MyStack --allow-unaddressed
```

The flag changes only the exit code and the run-level error. The summary rows,
each resource's own warning and the banner are still printed, although the
banner's closing sentence differs. `cdkd events` still records the `skipped`
figure and a `RUN_FINISHED` record with `result: 'FAILED'`. So the log still
says a resource survived.

With the flag cdkd does not raise the `PartialFailureError` message. That
message carries the run-level advice and the number of stacks that were
cancelled, so in CI the per-resource warnings become your way to the cause.

### When to use it

Use it for a leftover resource you cannot act on yet. The common case is an
ACM certificate replacement where another stack, often a CloudFront
distribution, still uses the old certificate. The delete succeeds once
`DescribeCertificate.InUseBy` is empty. Until then the pipeline would be red
for a cause it cannot fix.

Prefer the flag to a shell test on the exit code. `cdkd deploy` also exits `2`
for `MacroExpansionError` and `ResourceUpdateNotSupportedError`, so
`cdkd deploy || [ $? -eq 2 ]` would hide those failures.

### Which resources count

The deploy summary reports three kinds of leftover:

| Summary row | What was left |
| --- | --- |
| `Skipped (not deleted): N` | A resource cdkd should have deleted and could not |
| `of which left an orphaned predecessor: N` | The old resource of a replacement |
| `Left an orphaned predecessor in a nested stack: N` | The same, inside a nested stack at any depth |

An **orphaned predecessor** is the old resource of a replacement that was not
deleted. Either the provider could not delete it, or
`UpdateReplacePolicy: Retain` kept it. State now points at the new resource,
so the next deploy does not retry. Delete the old resource by hand.

A resource inside a nested stack, at any depth, counts toward the exit code
exactly as one in the stack you deployed. The nested stack prints its own
warning and a `partial (…)` or `skipped (…)` row that names the resource. The
`Updated:` total counts only the deployed stack's own resources.

### A delete that was skipped

One cause of `Skipped (not deleted)` is a resource you removed from the
template whose delete cdkd could not issue. That happens when the physical ID
in the resource's state record is malformed, missing, empty, whitespace or not
a string. The row prints `skipped (state record has no physical id)`, and cdkd
makes no AWS call.

cdkd keeps the state record, so the next `cdkd deploy` retries the delete.
Inside a nested stack a plain re-deploy retries it even when the nested
template is unchanged, and every deploy exits `2` until the delete succeeds.

To give up on the delete, remove the resource by hand and drop its record with
the command the warning prints last:

```bash
cdkd state orphan MyStack --stack-region us-east-1 --resource MyQueue
```

> [!CAUTION]
> Never run `cdkd state orphan` on the deployed stack without `--resource`.
> That drops every resource's record, and the next deploy re-creates or
> collides with all of them.

#### Edge cases

- **A nested stack's own row.** The delete is not skipped for it unless its
  record names Cloud Control. When it is skipped, the command names the child
  stack's own record, `'<stack>~<logicalId>'`, with no `--resource`. Dropping
  that record untracks everything the child still holds, so delete those
  resources first. `cdkd state show '<stack>~<logicalId>' --show-nested` lists
  them.
- **The child stack's destroy was interrupted.** The warning says to re-run
  `cdkd deploy`, which resumes it.
- **The template changes a resource whose record has no usable physical ID.**
  The deploy fails on that resource before anything is sent
  (`STATE_RESOURCES_MALFORMED`) and rolls back unless `--no-rollback` is set.
  Repair the `physicalId` in `state.json` and re-run. cdkd does not touch a
  record the template leaves unchanged.

### A resource a failed CREATE left behind

The other cause of `Skipped (not deleted)` is a create that made its resource
in AWS and then failed. Such a resource has no state record. It is known only
to the rollback journal, a file in the state bucket that lists what a failed
deploy did.

A later successful deploy deletes the resource when it can. When the delete
fails, the deploy is interrupted, or a record cannot be read, cdkd keeps the
journal entry and the next successful deploy retries.

cdkd does not delete the resource when a state record may own it, or when cdkd
cannot prove the resource is the one it made. The deploy then warns with the
physical ID and drops the journal entry, so nothing retries. Delete the
resource by hand if it is not in use. See
[Failed CREATEs that made their resource](cli-rollback-failed-operations.md#failed-creates-that-made-their-resource).

## `--no-cfn-fallback` (deploy / diff)

By default, a cross-stack reference that cdkd's state does not hold is looked
up in CloudFormation. That lets a stack deployed by cdkd consume a stack
CloudFormation still manages. `--no-cfn-fallback` turns the lookup off, so the
reference resolves from cdkd state only.

```bash
cdkd deploy MyStack --no-cfn-fallback   # resolve from cdkd state only
cdkd diff MyStack --no-cfn-fallback     # preview with the same rule
```

Pass the flag to keep IAM permissions minimal, or to make a typo in an export
name fail instead of matching an unrelated CloudFormation export. Nested
stacks inherit the flag. `cdkd diff` honours it, so the preview and the deploy
resolve alike.

### How the fallback works

| Intrinsic | Where cdkd looks |
| --- | --- |
| `Fn::ImportValue` | CloudFormation `ListExports` in the consumer's region |
| `Fn::GetStackOutput` | CloudFormation `DescribeStacks` outputs in the target region, same account only |

- **cdkd state wins.** The fallback runs only after cdkd state has no match,
  so a name that exists in both resolves to the cdkd export.
- **Nothing protects the reference.** cdkd does not record it in state, so
  neither side is guarded at destroy time. Deleting the CloudFormation
  producer breaks the consumer's next deploy.
- **A failed lookup is not an error of its own.** Without
  `cloudformation:ListExports` or `cloudformation:DescribeStacks`, cdkd warns
  and reports the original not-found error.

[Cross-Stack References](cross-stack-references.md) covers the design.

## `--require-approval` (deploy)

`--require-approval` asks for confirmation before cdkd deploys a stack's
changes, like `cdk deploy --require-approval`. cdkd also reads the level from
`"requireApproval"` in `cdk.json`, and the flag wins over it.

| Level | cdkd asks when the stack has |
| --- | --- |
| `never` (default) | Nothing; cdkd deploys without asking |
| `any-change` | Any change, including one to Outputs only |
| `destructive` | A change that replaces, deletes or orphans an existing resource |

`destructive` uses the same classification as
[`cdkd diff --fail-on=destructive`](cli-diff.md), and counts a
`--recreate-via-*` target as a replacement. It lists the affected resources
before the question:

```console
$ cdkd deploy --require-approval=destructive
```

The output:

```text
...
Destructive changes:
  MyStack: AWS::DynamoDB::Table MyTable MyTable794EDED1 will be orphaned

Stack MyStack: 0 to create, 1 to update, 1 to delete.
Stack includes destructive updates and "--require-approval" is set to 'destructive'.
Do you wish to deploy these changes? (y/n)
```

If you answer no, that stack's deploy fails with nothing changed, and cdkd
exits `1`.

### Edge cases

- **`--dry-run`** never asks.
- **No terminal, as in CI.** The deploy fails instead of asking, unless you
  pass `--yes`.
- **A nested stack** asks for its own changes when the parent reaches it.
  Declining fails the nested stack, and the parent rolls back. The nested
  stack's `--resource-timeout` clock stops while its question is open.
- **Under `any-change`**, a parent whose only changes are nested-stack updates
  does not ask for them itself.
- **Stacks deployed in parallel** ask one at a time.
- **`broadening`**, the AWS CDK CLI's default, is not available, because cdkd
  does not compute a security diff. The flag refuses the value. A
  `"requireApproval": "broadening"` in `cdk.json` is ignored with a warning,
  so cdkd asks for no approval.

## Related

- [Stop on Destructive Changes](destructive-changes.md): `--require-approval`
  with `cdkd diff --fail-on=destructive`, as a guide
- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): what each
  refusal means, and the exit codes
- [`cdkd rollback`](cli-rollback.md): the rollback journal and failed creates
- [`cdkd diff`](cli-diff.md): `--fail-on=destructive` and `--no-cfn-fallback`
  in a preview
- [Cross-Stack References](cross-stack-references.md): the design behind the
  CloudFormation fallback
