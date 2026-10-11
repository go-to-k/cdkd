---
title: Value resolution in local execution
description: "How cdkd local fills in environment values that only exist after a deploy: the --env-vars file, --from-state, --from-cfn-stack, --stack-region and CloudFormation dynamic references."
---

# Value resolution in local execution

A `cdkd local` command passes literal environment values to the container
unchanged. A value that refers to another resource, such as
`table.tableName`, has no value until the stack is deployed, so cdkd drops it
with a warning unless you tell it where to find one. This page covers the
three ways to supply a value. [Local Execution](local-emulation.md#where-values-come-from)
introduces the idea with a diagram.

```bash
# values you write in a file
cdkd local invoke MyStack/Handler --env-vars overrides.json

# values of a stack deployed with cdkd
cdkd local invoke MyStack/Handler --from-state

# values of a stack deployed with the AWS CDK CLI
cdkd local invoke MyStack/Handler --from-cfn-stack
```

## Which source wins

Several sources can supply the same variable. cdkd uses the first one in this
list that has it:

1. The resource's own entry in the `--env-vars` file.
2. The `Parameters` entry in the `--env-vars` file.
3. The value resolved from `--from-state` or `--from-cfn-stack`.
4. The literal in the template.

## `--env-vars`: overriding environment variables

`--env-vars <file>` reads a JSON file of variables and uses them in place of
the template's values. The file has the shape `sam local` uses: a top-level
object keyed by resource, plus an optional `Parameters` object whose values
apply to every resource.

```json
{
  "MyHandler1234ABCD": { "TABLE_NAME": "local-table", "DEBUG": "1" },
  "MyStack/MyHandler": { "ENDPOINT": "http://host.docker.internal:4566" },
  "Parameters": { "LOG_LEVEL": "debug" }
}
```

A `null` value removes the variable from the container environment.

What you write as the top-level key depends on the command:

| Command | The top-level key is |
| --- | --- |
| `local invoke`, `local start-api` | The Lambda's logical ID, or its CDK display path (`MyStack/MyHandler`) |
| `local run-task`, `local start-service`, `local start-alb` | The container name, `ContainerDefinitions[].Name` |
| `local invoke-agentcore`, `local start-agentcore` | The runtime's logical ID, or its CDK display path |

For a Lambda, one file can use both key forms. When both set the same
variable, the entry that comes later in the file wins.

`local start-cloudfront` does not accept `--env-vars`.

## `--from-state` and `--from-cfn-stack`: resolving deployed values

These two flags read a deployed copy of the stack and use its real names and
ARNs for the references in your template. Choose the flag by how the stack was
deployed:

| Flag | Reads | Use when |
| --- | --- | --- |
| `--from-state` | cdkd's S3 state for the stack | The stack was deployed with `cdkd deploy`. |
| `--from-cfn-stack [name]` | A deployed CloudFormation stack | The stack was deployed with the AWS CDK CLI. |

```bash
# deployed with cdkd
cdkd local invoke MyStack/Handler --from-state

# CloudFormation stack named MyStack
cdkd local invoke MyStack/Handler --from-cfn-stack

# the deployed name differs
cdkd local invoke MyStack/Handler --from-cfn-stack MyExplicitStackName

# state exists in two regions
cdkd local invoke MyStack/Handler --from-state --stack-region us-west-2
```

Both flags are off by default, and you cannot combine them.

### What each flag can resolve

| Intrinsic | `--from-state` | `--from-cfn-stack` |
| --- | --- | --- |
| `Ref` to a resource | The recorded physical ID | The physical ID from `ListStackResources` |
| `Fn::GetAtt` | The attribute recorded at deploy time | Only where the command can read it back |
| `Fn::Sub`, `Fn::Join` | Resolved piece by piece | Resolved piece by piece |
| `AWS::AccountId`, `AWS::Region`, `AWS::Partition`, `AWS::URLSuffix` | STS `GetCallerIdentity` and the resolved region | Same |
| `Fn::ImportValue` | The producing stack's state, same account and region | `ListExports` |
| `Fn::GetStackOutput` | The named stack's outputs, same account | Not resolved |

`Fn::GetAtt` is where `--from-cfn-stack` falls short. A CloudFormation
resource listing carries physical IDs but no attribute values, so cdkd can
resolve an attribute only when the command has another way to read it back.
Each command page says which attributes it recovers. The same limit applies to
an `Fn::GetAtt` inside an `Fn::Sub` or `Fn::Join`.

### When a value cannot be resolved

cdkd resolves each variable on its own, and a failure never stops the run.
The affected variable is dropped, a warning names it, and the command
continues. cdkd never substitutes a guess. This happens for:

- a missing state record,
- an attribute that was not recorded,
- an intrinsic the flag does not support,
- a failed CloudFormation call.

To supply a dropped variable yourself, add it to an `--env-vars` file.

### Edge cases for the state flags

**An explicit stack name with several stacks.** `--from-cfn-stack <name>` is
rejected when the run spans more than one stack, because one name cannot apply
to all of them. Use the bare `--from-cfn-stack`, which uses each stack's own
name.

**No region for `--from-cfn-stack`.** The flag needs a region. The command
fails when there is no `--stack-region`, no `AWS_REGION` or
`AWS_DEFAULT_REGION`, and no region on the synthesized stack.

**Cross-stack references on `start-api`.** Under `--from-state`,
`local start-api` drops `Fn::ImportValue` and `Fn::GetStackOutput` values.

**A damaged state record.** cdkd reads as much of the record as it can. A
`resources` or `outputs` map that is not an object is treated as empty, and a
row that is not a resource record is skipped. Each case prints a warning
naming the stack. Run [`cdkd state show`](cli-state.md) with `--json` to see
what is stored.

### Commands that restrict the state flags

| Command | Restriction |
| --- | --- |
| [`local start-cloudfront`](local-start-cloudfront.md) | Refuses `--from-state`, `--state-bucket` and `--state-prefix`. Use `--from-cfn-stack`. |
| [`local start-alb`](local-start-alb.md) | `--from-state` resolves the ECS services but not a Lambda target group's environment. |

## `--stack-region`: choosing between records

Pass `--stack-region` when the same stack name has state in more than one
region, to say which record to read. Under `--from-cfn-stack` it also sets the
region of the CloudFormation client.

```bash
cdkd local invoke MyStack/Handler --from-state --stack-region us-west-2
```

The value is matched without regard to letter case, so
`--stack-region US-EAST-1` reads the `us-east-1` record. If records exist
under both spellings, each spelling reads its own record and a warning names
the record that was read.

## CloudFormation dynamic references (`{{resolve:...}}`)

A dynamic reference is a string such as
`{{resolve:secretsmanager:prod/db:SecretString:password}}`. CloudFormation
replaces it with the secret's value when it deploys the resource. cdkd does
the same before the container starts, so your code sees the value the
deployed resource would receive. No state flag is needed.

cdkd resolves three kinds: `{{resolve:secretsmanager:...}}`,
`{{resolve:ssm:...}}` and `{{resolve:ssm-secure:...}}`.

### Whose credentials and which region

The lookup is made with your own credentials, honouring `--profile`. It never
uses the `--role-arn` role, because the value ends up in the container.

A reference written as an ARN uses the region in the ARN. Any other reference
uses the region of the stack that owns it. cdkd takes that region from the
state record, then from `--stack-region`, then from the synthesized stack.

### When the lookup fails

The command stops before any container starts. The error names the reference,
the resource that uses it and the IAM permission the lookup needs.

To skip the lookup, set the variable in an `--env-vars` file. cdkd never
looks up a variable that the file overrides.

### Where the resolved value goes

cdkd passes the value to `docker run` through the environment of the
`docker run` process, using a `-e KEY` argument that carries no value. The
secret therefore does not appear on a command line, and no log line carries
it. [finch on macOS and Windows](local-emulation.md#finch-on-macos-and-windows)
is the exception.

### Edge cases for dynamic references

**A reference that arrives through another stack.** cdkd stores a stack output
that carries a secret as its `{{resolve:...}}` text. Under `--from-state`, an
`Fn::ImportValue` or `Fn::GetStackOutput` of that output therefore yields the
reference, and cdkd resolves it in the producing stack's region.

**A reference in an ECS command.** cdkd refuses an ECS `Command`, `EntryPoint`
or health-check command that contains a dynamic reference, because resolving
it would put the secret on the `docker run` command line. Move the value to
an `Environment` variable or a `Secrets` entry.

## Related

- [Local Execution](local-emulation.md): choosing a command and the flags
  every command shares
- [State Management](state-management.md): what `--from-state` reads
- [`cdkd state show`](cli-state.md): print the state record a command reads
