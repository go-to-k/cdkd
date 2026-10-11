---
title: "cdkd diff: stack outputs"
description: "How cdkd diff reports changes to stack outputs and exports, why the Outputs section is sometimes missing, and the AWS calls it makes to resolve them."
---

# cdkd diff: stack outputs

`cdkd diff` compares the stack's outputs as well as its resources. It works
out the value each output in your template would have and compares it with
the outputs the last deploy stored in state. A stack whose outputs changed is
reported even when none of its resources did.

```bash
cdkd diff ProducerStack
```

```text
Stack ProducerStack:

  Outputs:
    [+] ExportsOutputFnGetAttBucketArn
          new: "arn:aws:s3:::my-bucket"
    [+] ProducerStack:ExportsOutputFnGetAttBucketArn [export]
          new: "arn:aws:s3:::my-bucket"

0 to create, 0 to update, 0 to delete
2 output(s) to add, 0 to change, 0 to remove
```

## Reading the Outputs section

The example above is the most common outputs-only change. Another stack
started to use a value from this one. CDK responded by adding an exported
output to this stack, and left its resources alone. The next deploy publishes
the export.

- Each output is listed by its logical name, with `[+]`, `[~]` or `[-]`.
- An output that has an `Export.Name` gets a second line marked `[export]`.
  That line shows the export name, which is the string another stack's
  `Fn::ImportValue` looks up.
- Outputs have a totals line of their own. They never add to the create,
  update and delete counts for resources.

With `--fail`, a change to outputs alone makes the diff exit `1`.

## When the Outputs section is missing

The diff shows the Outputs section only when it can work out every output's
value. It resolves the values against current state, with the same code
`cdkd deploy` uses. When one output cannot be resolved, the whole section is
left out.

The usual reason is an output that refers to a resource this deploy has yet
to create, so its value does not exist. If some other output also differs,
the diff prints a warning that says the section was omitted.

There are cases where the diff shows the outputs that did resolve and leaves
out only the rest. The exact rules are in
[cdkd diff internals](cli-diff-internals.md#outputs-previewed-instead-of-omitted).

### An output the last deploy could not resolve

A deploy can finish while skipping an output it could not resolve, with or
without a warning. cdkd remembers which outputs it skipped. Without that
memory, every later diff would show the output as an addition, because state
has no value for it. With it, the diff stays quiet about the output.

Once you repair the output, the diff shows it normally again. Repairing means
fixing its `Value`, its `Export.Name`, or a parameter, condition or mapping it
reads.

### Commands that make a broken output reappear

These commands rewrite state and drop the list of skipped outputs:

- `cdkd import`
- `cdkd drift --accept` and `cdkd drift --revert`
- `cdkd rollback`
- `cdkd scrub`
- `cdkd orphan`
- `cdkd state refresh-observed`

After one of them, an output that is still broken can show as an addition
again. `cdkd diff --fail` then exits `1` on a stack that has not changed. The
next deploy records the skipped output again and the diff goes quiet.

## AWS calls that resolving Outputs makes

Diff reads state and the template, and for most stacks that is all. Some
output values can only be worked out by asking AWS, so the diff makes these
read-only calls:

| The output uses | Call |
| --- | --- |
| `Fn::ImportValue` | CloudFormation `ListExports` |
| `Fn::GetStackOutput` | CloudFormation `DescribeStacks` |
| `Fn::GetStackOutput` with a `RoleArn` | `sts:AssumeRole` into the other account |
| `Fn::GetAZs` | EC2 `DescribeAvailabilityZones` |
| `{{resolve:ssm:...}}` | SSM `GetParameter` |

Three details:

- The two CloudFormation calls are a fallback for a value that is not in cdkd
  state. `--no-cfn-fallback` turns them off.
- The SSM call is made with `WithDecryption: false`, so it never returns a
  decrypted secret.
- The `RoleArn` must be written as a literal string in the template.

## Related

- [`cdkd diff`](cli-diff.md): the text output, the exit codes and the options
- [cdkd diff: JSON output](cli-diff-json.md): the `outputChanges` array
- [cdkd diff: secrets and NoEcho values](cli-diff-secrets.md): when an output's value or name is hidden
- [Cross-Stack References](cross-stack-references.md): how `Fn::ImportValue` and `Fn::GetStackOutput` resolve
- [cdkd diff internals](cli-diff-internals.md): the rules for skipped and partially resolved outputs
