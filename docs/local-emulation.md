---
title: Local Execution
description: "Run the Lambda functions, APIs, ECS tasks and services, load balancers, CloudFront distributions and AgentCore runtimes in your CDK app on your own machine with cdkd local."
---

# Local Execution

`cdkd local` runs the workloads in your CDK app on your own machine. The
commands read the same cloud assembly `cdkd deploy` does, so there is no
deploy and no `template.yaml` to maintain. A handler edit is testable in
seconds.

```bash
cdkd local invoke MyStack/Handler --event event.json   # run one Lambda once
cdkd local start-api --port 3000                       # serve the app's APIs on localhost
cdkd local invoke MyStack/Handler --from-state         # use the deployed stack's table names, ARNs, ...
```

## Which command do I want

| In your CDK app | Command | Runs |
| --- | --- | --- |
| A Lambda function | [`cdkd local invoke`](local-invoke.md) | Once, then exits |
| API Gateway (REST, HTTP, WebSocket) or a Function URL | [`cdkd local start-api`](local-start-api.md) | Until {kbd:ctrl+c} |
| An ECS task definition | [`cdkd local run-task`](local-run-task.md) | Until the task exits |
| An ECS service | [`cdkd local start-service`](local-start-service.md) | Until {kbd:ctrl+c} |
| An Application Load Balancer | [`cdkd local start-alb`](local-start-alb.md) | Until {kbd:ctrl+c} |
| A CloudFront distribution | [`cdkd local start-cloudfront`](local-start-cloudfront.md) | Until {kbd:ctrl+c} |
| A Bedrock AgentCore Runtime, one request | [`cdkd local invoke-agentcore`](local-invoke-agentcore.md) | Once, then exits |
| A Bedrock AgentCore Runtime, many requests | [`cdkd local start-agentcore`](local-start-agentcore.md) | Until {kbd:ctrl+c} |

`start-alb` boots the ECS services and Lambda functions behind the load
balancer itself, so you do not run `start-service` next to it.

## Requirements

Docker must be running. Every command runs your code in a container: Lambda
functions in the AWS Lambda Runtime Interface Emulator (RIE) image, ECS
containers from their own images next to the AWS-published ECS metadata
sidecar, and AgentCore agents in the agent's image.

`local start-cloudfront` is the one exception. A distribution made of S3
origins and CloudFront Functions is served in-process and needs no Docker. It
needs Docker once the distribution has a Lambda Function URL origin or a
Lambda@Edge association.

The first run pulls the images it needs: roughly 600 MB for a language-specific
Lambda base image and 50 MB for `provided.*`. Later runs reuse the cached
image, and `--no-pull` skips the `docker pull` check. What `--no-pull` covers
differs per command, so each page states it.

## Naming the target

Every command takes the resource to run as a positional target.

| Form | Example | Notes |
| --- | --- | --- |
| CDK display path | `MyStack/MyApi/Handler` | The construct path. A prefix is enough, so you do not type the trailing `/Resource`. |
| Stack-qualified logical ID | `MyStack:MyApiHandler1234ABCD` | Works in any app. |
| Bare name | `Handler` | Only when the app has exactly one stack. |

A stack inside a CDK `Stage` is addressed by its full display path:
`MyStage/MyStack/MyApi/Handler`.

On `start-api`, `start-service`, `start-alb`, `start-cloudfront` and the two
AgentCore commands the target is optional. `start-api` serves every API it
finds. The others open a picker when you omit it in an interactive terminal.

## Where values come from

Nothing has been deployed when you run a local command, so a value such as
`table.tableName` has no real name yet. In the synthesized template it is a
`Ref`, not a string. Each environment value is handled by what it is:

```text diagram=local-value-resolution
                Value in the synthesized template
        ┌───────────────────────┼──────────────────────────┐
        ▼                       ▼                          ▼
     Literal        Intrinsic (Ref, Fn::GetAtt, ...)   {{resolve:...}}
  passed through    --from-state: cdkd S3 state        looked up with your
    unchanged       --from-cfn-stack: CloudFormation   credentials; a failed
                    neither: dropped with a warning    lookup stops the command
        └───────────────────────┼──────────────────────────┘
                                ▼
                        --env-vars file
        replaces any of the three; an overridden key is never looked up
                                │
                                ▼
                      Container environment
```

| What you want | Do this |
| --- | --- |
| Run without reading a deployed stack | Nothing. Literals pass through; intrinsic values are dropped, each with a warning naming the key. |
| Use the values of a stack deployed with `cdkd deploy` | `--from-state` |
| Use the values of a stack deployed with the AWS CDK CLI | `--from-cfn-stack` |
| Point one variable at something local | `--env-vars overrides.json` |

When several sources supply the same key, the highest of these wins:

1. The resource's own entry in the `--env-vars` file.
2. The `Parameters` entry in the `--env-vars` file.
3. The value resolved from `--from-state` or `--from-cfn-stack`.
4. The literal in the template.

### `--env-vars`: overriding environment variables

The file has the shape `sam local` uses: a top-level object keyed by resource,
plus an optional `Parameters` object for values that apply to every resource.

```json
{
  "MyHandler1234ABCD": { "TABLE_NAME": "local-table", "DEBUG": "1" },
  "MyStack/MyHandler": { "ENDPOINT": "http://host.docker.internal:4566" },
  "Parameters": { "LOG_LEVEL": "debug" }
}
```

A `null` value removes the key from the container environment.

| Command | The top-level key is |
| --- | --- |
| `local invoke`, `local start-api` | The Lambda's logical ID, or its CDK display path (`MyStack/MyHandler`) |
| `local run-task`, `local start-service`, `local start-alb` | The container name, `ContainerDefinitions[].Name` |
| `local invoke-agentcore`, `local start-agentcore` | The runtime's logical ID, or its CDK display path |

For a Lambda both key forms can appear in one file. When both set the same
variable, the entry later in the file wins.

`local start-cloudfront` does not accept `--env-vars`.

### `--from-state` and `--from-cfn-stack`: resolving deployed values

Both are off by default and they cannot be combined.

| Flag | Reads | Use when |
| --- | --- | --- |
| `--from-state` | cdkd's S3 state for the stack | The stack was deployed with `cdkd deploy`. |
| `--from-cfn-stack [name]` | A deployed CloudFormation stack | The stack was deployed with the AWS CDK CLI. |

```bash
cdkd local invoke MyStack/Handler --from-state                          # deployed with cdkd
cdkd local invoke MyStack/Handler --from-cfn-stack                      # CloudFormation stack named MyStack
cdkd local invoke MyStack/Handler --from-cfn-stack MyExplicitStackName  # the deployed name differs
cdkd local invoke MyStack/Handler --from-state --stack-region us-west-2 # state exists in two regions
```

What each source can supply:

| Intrinsic | `--from-state` | `--from-cfn-stack` |
| --- | --- | --- |
| `Ref` to a resource | The recorded physical ID | The physical ID from `ListStackResources` |
| `Fn::GetAtt` | The attribute recorded at deploy time | Only where the command can read it back; otherwise dropped with a warning |
| `Fn::Sub`, `Fn::Join` | Resolved piece by piece | Resolved piece by piece, within the limits above |
| `AWS::AccountId`, `AWS::Region`, `AWS::Partition`, `AWS::URLSuffix` | STS `GetCallerIdentity` and the resolved region | Same |
| `Fn::ImportValue` | The producing stack's state, same account and region | `ListExports` |
| `Fn::GetStackOutput` | The named stack's outputs, same account | Not resolved |

`Fn::GetAtt` is the weak spot of `--from-cfn-stack`: a CloudFormation resource
listing carries no attribute values. cdkd never substitutes a guess. It warns
and drops the key, and you can supply the value with `--env-vars`. Each command
page says what it can recover.

Resolution is per key and never stops the run. A missing state record, an
attribute that was not recorded, an unsupported intrinsic or a failed
CloudFormation call drops the affected keys with a warning, and the command
continues.

Four limits to know:

- An explicit `--from-cfn-stack <name>` is rejected when the run spans more
  than one stack, because one name cannot apply to all of them. Use the bare
  form, which uses each stack's own name.
- `--from-cfn-stack` needs a region. With no `--stack-region`, no
  `AWS_REGION` / `AWS_DEFAULT_REGION` and no region on the synthesized stack,
  the command fails instead of guessing one.
- `local start-api` does not resolve cross-stack references
  (`Fn::ImportValue`, `Fn::GetStackOutput`) under `--from-state`. It drops
  them.
- A damaged state record is read as far as it can be. A `resources` or
  `outputs` map that is not an object is treated as empty, and a row that is
  not a resource record is skipped. Each case prints a warning naming the
  stack. Run [`cdkd state show`](cli-state.md) with `--json` to see what is
  stored.

Two commands restrict the state flags:

| Command | Restriction |
| --- | --- |
| [`local start-cloudfront`](local-start-cloudfront.md) | Refuses `--from-state`, `--state-bucket` and `--state-prefix`. Use `--from-cfn-stack`. |
| [`local start-alb`](local-start-alb.md) | `--from-state` resolves the ECS services but not a Lambda target group's environment. |

### `--stack-region`: choosing between records

Pass `--stack-region` when the same stack name has state in more than one
region. Under `--from-cfn-stack` it also sets the CloudFormation client's
region.

The value is matched case-insensitively, so `--stack-region US-EAST-1` reads
the `us-east-1` record. If records exist under both spellings, each spelling
reads its own and a warning names the record that was read.

### CloudFormation dynamic references (`{{resolve:...}}`)

An environment value containing `{{resolve:secretsmanager:...}}`,
`{{resolve:ssm:...}}` or `{{resolve:ssm-secure:...}}` is resolved before the
container starts, so your code sees the value the deployed resource would
receive. This needs no state flag.

| Question | Answer |
| --- | --- |
| Whose credentials make the call | Yours, honouring `--profile`. Never the `--role-arn` role, because the value lands in the container. |
| Which region | An ARN reference uses its own region. Any other uses the owning stack's region: the state record's, then `--stack-region`, then the synthesized region. |
| What if the lookup fails | The command stops before any container starts. The error names the reference, the consumer and the IAM permission needed. |
| How do I skip the lookup | Override the key with `--env-vars`. An overridden key is never looked up. |
| Does the value appear on a command line | No. It is passed as a value-less `-e KEY`, read from the environment of `docker run`. No log line carries it. |

A token can also arrive through a cross-stack reference: cdkd stores a
secret-bearing stack output as its `{{resolve:...}}` text, so under
`--from-state` an `Fn::ImportValue` or `Fn::GetStackOutput` of that output
yields the token, which is then resolved in the producing stack's region.

ECS `Command`, `EntryPoint` and health-check commands that contain a token are
refused, because resolving one would put the secret on the `docker run` command
line. Move it to an `Environment` variable or a `Secrets` entry.

## Credentials inside the container

By default the container gets your own AWS credentials, so calls your code
makes to AWS reach real AWS as you. That usually means wider permissions than
the deployed role has. To see IAM errors locally, run under the deployed role:

| Command | Flag |
| --- | --- |
| `local invoke` | `--assume-role [arn]` |
| `local start-api` | `--assume-role <arn>`, `--assume-role <LogicalId>=<arn>`, `--assume-role-auto` |
| `local run-task` | `--assume-task-role [arn]` |
| `local start-service`, `local start-alb` | `--assume-role [arn]` (`--assume-task-role` also works) |
| `local start-cloudfront` | `--assume-role [arn]`, for Lambda origins |
| `local invoke-agentcore`, `local start-agentcore` | `--assume-role [arn]` |

`--role-arn` is a different flag. It is the role cdkd assumes for its own AWS
calls. On `start-service`, `start-alb`, `start-cloudfront` and
`start-agentcore` it is not safe to pass `--role-arn` without `--profile`: the
role's credentials reach your containers, or fetch the secrets injected into
them. cdkd warns at startup when that applies, and each page's Options table
says what the role touches.

## Common flags

Every `cdkd local` command accepts these. Each command page lists only the
flags that are its own.

| Flag | Default | Description |
| --- | --- | --- |
| `-a`, `--app <cmd-or-dir>` | `cdk.json` / `CDKD_APP` | CDK app command, or a synthesized cloud assembly directory. `-a cdk.out` skips synthesis. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value...>` | — | CDK context value. Repeatable. |
| `--no-pull` | off | Skip `docker pull` and use the cached image. |
| `--from-state` | off | Resolve intrinsic values from cdkd's S3 state. |
| `--from-cfn-stack [name]` | off | Resolve them from a deployed CloudFormation stack. The bare form uses the stack's own name. |
| `--stack-region <region>` | — | Region of the state record, and of the CloudFormation client under `--from-cfn-stack`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json`, then `cdkd-state-{accountId}` | S3 bucket read by `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role cdkd assumes for its own AWS calls. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

Every command except `local start-cloudfront` also accepts:

| Flag | Default | Description |
| --- | --- | --- |
| `--env-vars <file>` | — | JSON environment-variable overrides. |
| `--container-host <ip>` | `127.0.0.1` | IP that published container ports bind to. Must be numeric; Docker rejects a hostname here. |

The region for AWS calls comes from `AWS_REGION`, then `AWS_DEFAULT_REGION`,
then the synthesized stack's own `env.region`. A deprecated `--region` flag,
hidden from `--help`, still overrides them and prints a removal warning. An
upper-cased region such as `US-EAST-1` is folded to lower case before any AWS
call.

## Reaching a server on the host

Inside a container, `localhost` is the container. To reach a server on your
machine, such as a local DynamoDB or a tunnel to a VPC resource, use the
hostname `host.docker.internal`:

```json
{ "Parameters": { "AWS_ENDPOINT_URL_DYNAMODB": "http://host.docker.internal:8000" } }
```

Docker Desktop resolves the name natively. On Linux, cdkd adds the
`host.docker.internal:host-gateway` mapping itself (Docker 20.10 or newer). On
a daemon that does not support it, the mapping is skipped without an error.

## Stopping a server

{kbd:ctrl+c} stops a long-running command and removes every container,
sidecar, Docker network and temporary file it created.

A second {kbd:ctrl+c} exits immediately without cleanup, for when Docker
itself hangs. Leftover containers can then be found and removed:

```bash
docker ps --filter name=cdkd-local-
docker rm -f <container-id>
```

On `start-api` and `run-task` with `--profile`, the forced exit also names a
temporary credentials file it did not remove. The file holds live credentials,
so delete it once the containers are gone.

## finch on macOS and Windows

When `CDK_DOCKER` names finch on macOS or Windows, containers run inside a
Lima VM, and finch copies each `-e KEY` value onto command lines that other
local processes can read. cdkd therefore refuses to pass a secret that way:

| Command | Refused |
| --- | --- |
| `local run-task`, `local start-service` | A task with a `Secrets` entry |
| `local start-alb` | A service with a `Secrets` entry, and a Lambda target with a decrypted SecureString |
| `local invoke-agentcore`, `local start-agentcore` | A decrypted SecureString in the runtime's environment |
| `local start-cloudfront` | A decrypted SecureString in a Lambda Function URL origin's environment |
| Any command | A resolved `{{resolve:...}}` value |

The error names the secrets. Use Docker, podman, nerdctl or finch on Linux
instead, or set `CDKD_ALLOW_SECRETS_ON_ARGV=1` to accept the exposure.

AWS credentials are treated differently so that finch stays usable:

- Credentials cdkd hands to a container are still forwarded, with a warning
  naming the variables. This matters most for `--assume-role` /
  `--assume-task-role` session credentials and credentials resolved from
  `--profile`, which are not otherwise in the environment.
- Credentials in cdkd's own environment reach finch's command line on every
  finch command, including pulls and builds. finch does that by itself and
  cdkd does not warn about it.

finch is recognised by the file name `CDK_DOCKER` resolves to (`finch` or
`finch.exe`, in any case). A wrapper script or symlink under another name is
not recognised. finch on Linux is not affected.

## What cdkd trusts in the assembly

A cloud assembly names directories to mount, build and serve, and `-a <dir>`
can point at an assembly built elsewhere. cdkd checks those paths against the
app's output directory before using them.

Running a local command against an assembly runs code from it: the handler
runs in a container, and a Docker asset's build command runs on your machine.
Treat an assembly you did not synthesize yourself as untrusted input.

### Refused

A path is refused when it resolves outside the app's output directory, through
`..` or a symbolic link.

| Path in the assembly | Applies to |
| --- | --- |
| A Lambda's relative `Metadata['aws:asset:path']`, for function code and same-stack layers | `invoke`, `start-api`, `start-alb`, `start-cloudfront` |
| The module path in a Lambda's `Handler`, for inline `Code.ZipFile` | Wherever inline code is run |
| A Docker asset's `source.directory` | Every command that builds an image, on each build and each `--watch` rebuild |
| The directory a `--watch` reload copies into a running container | `start-service`, `start-alb`, `invoke-agentcore`, `start-agentcore` |
| A code asset's `source.path` | `invoke-agentcore`, `start-agentcore` |
| A relative `BucketDeployment` source served as an S3 origin | `start-cloudfront` |
| A stack name that would place `<stack>.assets.json` outside the assembly | Wherever a command reads it |

Notes on those rows:

- An absolute `source.directory` or `source.path` is placed under the
  manifest's directory, so it cannot leave it.
- A refused `--watch` copy falls back to a full rebuild or is skipped. The
  directory is never copied.
- `--no-build` reuses a cached image and opens no directory.
- `start-cloudfront` also checks every file it serves, so a symbolic link
  inside an origin directory that points elsewhere is not served.

A stack inside a `cdk.Stage` is unaffected. Its assets are staged into the
app's output directory, so the `../asset.<hash>` CDK writes resolves inside it.
The exception is pointing `-a` at the Stage's own sub-assembly
(`-a cdk.out/assembly-MyStage`): the check is then bounded to that directory
and the Stage's assets are refused. Point `-a` at the app's `cdk.out` and
select the resource by its display path. The deploy path follows the same
rule; see [Deploy safety](cli-deploy-safety.md).

### Warned about, but accepted

| Path in the assembly | Why it is accepted |
| --- | --- |
| An absolute `Metadata['aws:asset:path']` outside the output directory | `cdk synth --no-staging` writes the asset's absolute source directory there. |
| A Docker asset's `source.executable` | It is the build command the manifest chose. cdkd runs it on your machine to produce the image. |
| An absolute `BucketDeployment` source outside the output directory | Also written by `cdk synth --no-staging`. Served only when it is a folder inside your project; see [`cdkd local start-cloudfront`](local-start-cloudfront.md#absolute-bucketdeployment-sources). |

> [!WARNING]
> If you did not synthesize with `--no-staging`, a warning that cdkd is about
> to mount a directory outside the output directory means the assembly chose
> that directory. Treat the assembly as untrusted.

cdkd announces a `source.executable` build before running it, naming the
command and how many arguments it takes. The arguments are shown only under
`--verbose`, because a build script's flags may include a password. Each
distinct command is announced once per run.

`start-service`, `start-alb`, `start-cloudfront` and `start-agentcore` also
warn about a BuildKit path outside the assembly (a build secret, an SSH key, a
build context, a cache or output directory) on every image they build.

## Related

- [CLI Reference](cli-reference.md): every cdkd command and the full exit-code
  table
- [Deploy safety](cli-deploy-safety.md): what cdkd refuses to read out of a
  cloud assembly on the deploy path
- [State Management](state-management.md): what `--from-state` reads
- [Getting Started](getting-started.md): installing cdkd and deploying a first
  stack
