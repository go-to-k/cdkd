---
title: Orphan vs Destroy
description: "cdkd destroy deletes a stack's AWS resources and its state record; cdkd orphan removes only the state record, for one resource or a whole stack, and leaves the AWS resources running."
---

# Orphan vs Destroy

Both commands make cdkd stop managing something, and they differ in what
happens to the AWS resources:

- **Destroy** deletes the AWS resources, and then removes them from state,
  cdkd's record of what it deployed.
- **Orphan** removes a resource or a whole stack from state only. The AWS
  resources keep running, and cdkd no longer tracks them.

Destroy is how you tear a stack down. Orphan is for a resource you want to
keep but no longer want cdkd to manage, such as a bucket whose data must
outlive the stack. `cdkd orphan` mirrors `cdk orphan` in the AWS CDK CLI.

```text diagram=guide-orphan-vs-destroy
                 A deployed stack
             AWS resources + cdkd state
                │                  │
             destroy             orphan
                ▼                  ▼
       AWS resources: deleted    AWS resources: untouched
       State: deleted            State, or one entry in it: removed
                                 cdkd no longer tracks them
```

## Which command to run

Each operation has two forms. One synthesizes your CDK app, so you run it
from the app's directory. The other reads only the state bucket, so it works
from any machine, and you name the stack as it is named in AWS.

| You want to | With the CDK app | Without it |
| --- | --- | --- |
| Delete a stack and its resources | `cdkd destroy MyStack` | `cdkd state destroy MyStack` |
| Stop managing one resource | `cdkd orphan 'MyStack/MyBucket'` | `cdkd state orphan MyStack --resource MyBucket` |
| Stop managing a whole stack | Not available | `cdkd state orphan MyStack` |

## Orphan one resource

Name the resource by its construct path, which is the stack's path in the
CDK app followed by the construct's ID. Preview the change first:

```bash
cdkd orphan 'MyStack/MyBucket' --dry-run   # print what would be rewritten
cdkd orphan 'MyStack/MyBucket'
```

For a stack inside a CDK `Stage`, the path includes the stage:
`cdkd orphan 'MyStage/Api/MyBucket'`.

Other resources in the stack may refer to the resource you orphan, through
`Ref`, `Fn::GetAtt`, `Fn::Sub` or a dependency. cdkd rewrites those
references in state, so that the next deploy does not try to create the
orphaned resource again.

### When the resource is no longer in your CDK code

`cdkd orphan` finds the resource through the synthesized app, so it cannot
reach a resource whose construct you have already removed. Use the form that
works from state, and name the resource by its logical ID:

```bash
cdkd state orphan MyStack --resource MyBucketF68F3FF0
```

One case where you need this is a resource that `cdkd deploy` was meant to
delete but skipped.

## Orphan a whole stack

```bash
cdkd state orphan MyStack
```

This removes the stack from state entirely. Every resource stays in AWS.

> [!WARNING]
> On a stack you still deploy, this drops the record of every resource in it.
> The next `cdkd deploy` then re-creates each resource or collides with the
> existing one. To release some resources from a live stack, use `--resource`.

## Related

- [`cdkd state`](cli-state.md): flags, prompts and exit codes of the two
  commands that work from state
- [cdkd destroy](cli-destroy.md): what `cdkd destroy` deletes and
  what it refuses to
- [State Store](state-store.md): why the commands that work from state need
  no CDK app
