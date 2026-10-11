---
title: Orphan vs Destroy
description: "cdkd destroy deletes a stack's AWS resources and its state record; cdkd orphan removes only the state record, for one resource or a whole stack, and leaves the AWS resources running."
---

# Orphan vs Destroy

Both commands make cdkd stop managing something. **Destroy** deletes the AWS
resources and then the state record. **Orphan** removes only the state record
(or one resource's entry in it), so the AWS resources keep running and cdkd
no longer tracks them. `cdkd orphan` mirrors `cdk orphan` in the AWS CDK CLI.

```text diagram=guide-orphan-vs-destroy
                 A deployed stack
          AWS resources + cdkd state record
                │                  │
             destroy             orphan
                ▼                  ▼
       AWS resources: deleted    AWS resources: untouched
       State record: deleted     State record or entry: removed
                                 cdkd no longer tracks them
```

## Which command to run

Each operation has a form that synthesizes your CDK app and a form that reads
only the state bucket. The second works from any machine, by the stack's
physical name.

| You want to | With the CDK app | Without it |
| --- | --- | --- |
| Delete a stack and its resources | `cdkd destroy MyStack` | `cdkd state destroy MyStack` |
| Stop managing one resource, keep it in AWS | `cdkd orphan 'MyStack/MyBucket'` | `cdkd state orphan MyStack --resource MyBucket` |
| Stop managing a whole stack, keep it in AWS | Not available | `cdkd state orphan MyStack` |

## Orphan one resource

```bash
cdkd orphan 'MyStack/MyBucket' --dry-run   # print what would be rewritten
cdkd orphan 'MyStack/MyBucket'
```

The argument is a construct path that starts with the stack's display path.
For a stack inside a CDK `Stage` that includes the stage:
`cdkd orphan 'MyStage/Api/MyBucket'`.

Other resources in the stack may reference the one you orphan through `Ref`,
`Fn::GetAtt`, `Fn::Sub` or a dependency. cdkd rewrites those references in
the state record, so the next deploy does not try to create the orphaned
resource again.

`cdkd state orphan MyStack --resource <logicalId>` does the same from the
state record, by logical id. It is the form that reaches a resource whose
construct has already left the template, such as a delete that `cdkd deploy`
skipped.

## Orphan a whole stack

```bash
cdkd state orphan MyStack
```

This removes the stack's entire state record. Every resource stays in AWS.

> [!WARNING]
> On a stack you still deploy, this drops the record of every resource in it.
> The next `cdkd deploy` then re-creates each resource or collides with the
> existing one. To release some resources from a live stack, use `--resource`.

## Related

- [`cdkd state`](cli-state.md): flags, prompts and exit codes of the two
  state-driven commands
- [Destroy flags & guards](cli-destroy.md): what `cdkd destroy` deletes and
  what it refuses to
- [State Store](state-store.md): why the state-driven forms need no CDK app
