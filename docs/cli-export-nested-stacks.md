---
title: "cdkd export: nested stacks"
description: "How cdkd export migrates a tree of nested stacks: the order, the CloudFormation stack names, the Parameters each child receives, and recovery when one stack fails."
---

# cdkd export: nested stacks

[`cdkd export`](cli-export.md) exports a stack together with every nested
stack under it. You name the root stack, and cdkd handles the tree:

```bash
cdkd export MyApp --dry-run   # per-stack plan for the whole tree
cdkd export MyApp
```

cdkd exports the tree one stack at a time, starting with the stacks that have
no nested stacks of their own. Each cdkd stack in the tree becomes its own
CloudFormation stack. Each parent then adopts its children as nested stacks,
so the tree has the same shape in CloudFormation afterwards.

The export works this way because CloudFormation offers no single changeset
for a tree: it rejects `IncludeNestedStacks` on an IMPORT changeset.

cdkd asks for one tree-wide confirmation before it exports the first stack.

## Child stack names

cdkd names a nested stack `<parent>~<childLogicalId>`. CloudFormation does not
allow `~` in a stack name, so the export names the CloudFormation stack
`<parent>-<childLogicalId>`.

To choose a different name for one child, pass `--cfn-child-stack-name` with
the cdkd name and the CloudFormation name. The flag can be repeated:

```bash
cdkd export MyApp --cfn-child-stack-name 'MyApp~Database=my-app-db'
```

## Child Parameters

A parent's template passes Parameters to each nested stack. After the export a
child is imported with its own changeset, so cdkd works out each Parameter's
value and submits it with that changeset.

What the child receives depends on the value the parent passes. cdkd resolves
a `Ref` or `Fn::GetAtt` from the parent's Parameters and from cdkd state.

| The parent passes | The child's changeset receives |
| --- | --- |
| A literal string, number or boolean | The value. |
| A `Ref` to a parent Parameter, or `Fn::GetAtt` on a parent resource | The resolved value. |
| A parent's SSM-typed Parameter | The value stored in SSM. |
| A value cdkd cannot resolve | Nothing. cdkd warns. |
| A value that resolves to or embeds `***` | Nothing. The export refuses. |

### A value cdkd cannot resolve

cdkd prints a warning and passes no value for that Parameter. The child
template's `Default` then has to cover it. Check the `--dry-run` plan for
these warnings before you export.

### A value that is masked

cdkd stores `***` in state in place of a secret, and `***` is not the value
the child needs. The export refuses with
`EXPORT_MASKED_CHILD_PARAMETER`.
[When a recorded value is `***`](cli-export-blocks.md#a-nested-stack-s-parameter)
has the remedy.

### A parent's SSM-typed Parameter

An SSM-typed Parameter has a type such as
`AWS::SSM::Parameter::Value<String>`. Its value is the name of an SSM
parameter, and CloudFormation looks the stored value up. The child needs that
stored value, so cdkd reads it with `ssm:GetParameter`, without decryption.

`cdkd export` therefore needs the `ssm:GetParameter` permission on each SSM
parameter that a child's Parameters mention.

The export refuses if the read fails, or if the SSM parameter is not a
`String` or `StringList`. It refuses before it locks any nested stack or
submits any changeset. `--dry-run` prints a warning instead.

## When one stack of the tree fails

Each stack that was imported before the failure has a CloudFormation stack.
cdkd keeps its state for the failed stack and for every stack that was not
imported yet. The error names the stacks that moved and the ones that remain.

Running `cdkd export` again does not resume. The command refuses a tree while
any of its CloudFormation stacks exists, and every stack imported before the
failure has one. You finish the migration by hand, following the steps the
error prints:

- Run `cdkd state orphan <stack> --stack-region <region>` for each stack that
  finished. Run it for the failed stack too, once you have completed the steps
  the error names for that stack.
- If the failed stack has a phase 2, run the inline-policy deletes the error
  lists before that phase.
  [cdkd export: custom resources and IAM policies](cli-export-two-phase.md)
  explains phase 2.
- Migrate the stacks that were not imported yet with a CloudFormation IMPORT
  by hand. Adopt nested children as AWS's "Nest an existing stack" procedure
  describes.

### When the first stack fails

If the import of the first stack fails, nothing was imported, and you can
start over:

1. Run the `aws cloudformation list-stack-resources` command that cdkd prints,
   and confirm that the CloudFormation stack the failed import left holds no
   resources.
2. Delete that CloudFormation stack.
3. Run `cdkd export` again.

## Related

- [`cdkd export`](cli-export.md): the command, the run order and the options
- [cdkd export: what blocks an export](cli-export-blocks.md): including a nested stack whose state record is missing
- [cdkd export: the template CloudFormation receives](cli-export-template.md): Parameters of the root stack
- [cdkd export internals](cli-export-internals.md#nested-stack-changesets): the changeset sequence cdkd submits per stack, for contributors
