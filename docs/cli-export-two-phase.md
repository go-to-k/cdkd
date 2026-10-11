---
title: "cdkd export: Custom Resources and IAM policies"
description: "How cdkd export migrates the two kinds of resource CloudFormation cannot import, Custom Resources and AWS::IAM::Policy, in a second phase, and how to recover when that phase fails."
---

# cdkd export: Custom Resources and IAM policies

CloudFormation cannot import two kinds of resource that CDK stacks often
contain: Custom Resources and `AWS::IAM::Policy`. [`cdkd export`](cli-export.md)
migrates them in a second phase. Phase 1 imports everything else. Phase 2 then
submits the full template as an UPDATE changeset, and CloudFormation creates
these resources itself.

The two kinds differ in what you have to do:

| Resource | Needs a flag | What phase 2 costs |
| --- | --- | --- |
| Custom Resource | `--include-non-importable` | The backing Lambda is invoked with a `Create` event again. |
| `AWS::IAM::Policy` | no | The permission is missing until phase 2 completes. |

```bash
cdkd export MyStack --include-non-importable --dry-run   # preview both phases
cdkd export MyStack --include-non-importable
```

## Custom Resources and `--include-non-importable`

A Custom Resource is backed by a Lambda function that you or a CDK construct
wrote. In the template its type is `Custom::*` or
`AWS::CloudFormation::CustomResource`. The second is what
`new cdk.CustomResource(...)` synthesizes when no `resourceType` is passed.

Without `--include-non-importable`, cdkd refuses a stack that contains one.
Under `--dry-run` the refusal becomes a warning, so you still see the full
plan.

With the flag, phase 2 has CloudFormation create the Custom Resources. To do
so, CloudFormation invokes each backing Lambda's `onCreate` handler again,
although the resource already exists.

### What the handler must do

The handler has to cope with that second `Create` event:

1. It must be idempotent: it returns the same `PhysicalResourceId` and `Data`
   on every event type.
2. It must answer through the response URL: it sends its status payload with
   an HTTP `PUT` to `event.ResponseURL`.

> [!WARNING]
> cdkd's own deploy also accepts a handler that only returns a value.
> CloudFormation does not. A Custom Resource backed by such a Lambda hangs
> phase 2, and every later `cdk deploy`, until CloudFormation's one-hour
> Custom Resource timeout.

## `AWS::IAM::Policy` is deleted and re-created

An `AWS::IAM::Policy` is an inline policy attached to roles, users or groups.
CDK grants emit this type often: a Lambda execution role's inline policy, or
an ECS task execution role's ECR pull policy. CloudFormation has no way to
look up an existing inline policy, so it cannot import one.

cdkd handles this type without a flag:

1. Phase 1 leaves the policy out.
2. cdkd deletes the inline policy from its roles, users and groups.
3. Phase 2 has CloudFormation create it again from the template.

> [!WARNING]
> Between steps 2 and 3 the permission does not exist. A call that relies on
> it fails with `AccessDenied` until phase 2 completes.

The plan that cdkd prints before the confirmation lists each such policy, and
the roles, users and groups it will be removed from. To refuse such a stack
instead, pass `--no-recreate-import-unsupported`.

### The policy is checked against the template first

Step 2 and step 3 take their principals from different places. cdkd detaches
the policy from the principals recorded in cdkd state. CloudFormation attaches
it to the principals named in the template. If the two lists differ, a
principal could be detached and not attached again.

cdkd therefore compares the state record with the template before anything
changes. When they disagree, it stops the export with no AWS change, and the
error tells you what to run:

- **State records a principal the template does not name, or a policy name
  other than the template's `PolicyName`.** This is usually a template change
  that has not been deployed. Run `cdkd diff`, then `cdkd deploy`. If the
  value comes from a root Parameter, run the export again with the
  `--parameter` values the stack was deployed with.
- **State records no principal list, a value that is not a list of IAM names,
  or a physical id that is not the policy name.** Import the policy again
  with `cdkd import ... --force`, so that its record matches the template.
- **State records more than 100 principals.** Check the record and the
  template against AWS. Do not destroy the resource or remove it from the
  app: that removes the policy from every recorded principal.

### Principals cdkd cannot check

cdkd can check a template principal that is one of these:

- a literal name,
- a `Ref` to a role, user or group in the same template,
- a `Ref` to a template Parameter.

It cannot check any other value, such as `Fn::ImportValue`, and it cannot
check a missing `PolicyName`. The plan marks each one it could not check, and
the export proceeds.

> [!IMPORTANT]
> Under `--yes` nobody reads those marks. A principal that the template names
> only through an uncheckable value is detached and may not be re-attached.
> Read a `--dry-run` plan before exporting such a stack unattended.

### If deleting the policy fails

The export stops between phase 1 and phase 2. cdkd state and the
CloudFormation stack that phase 1 created are both kept.

The usual cause is a missing permission: `iam:DeleteRolePolicy`,
`iam:DeleteUserPolicy` or `iam:DeleteGroupPolicy`, depending on what the
policy is attached to.

Running `cdkd export` again does not resume the export, because the
CloudFormation stack now exists. The error gives the steps to finish by hand:

1. Delete the remaining inline policies.
2. Run the phase-2 UPDATE yourself.
3. Remove the state record with `cdkd state orphan`.

## If phase 2 fails

cdkd keeps its state record, and the CloudFormation stack from phase 1 stays.
The error prints the recovery:

1. An `aws cloudformation create-change-set --change-set-type UPDATE` command
   that finishes phase 2.
2. `cdkd state orphan`, which removes the state record once the update has
   succeeded.

## Related

- [`cdkd export`](cli-export.md): the command, the run order and the options
- [cdkd export: what blocks an export](cli-export-blocks.md): types that cannot be migrated at all
- [cdkd export: nested stacks](cli-export-nested-stacks.md): phase 2 inside a nested-stack tree
- [cdkd export internals](cli-export-internals.md): the pre-delete check in detail, for contributors
