---
title: Local Execution
description: "Run the Lambda functions, APIs, ECS tasks and services, load balancers, CloudFront distributions and AgentCore runtimes in your CDK app on your own machine with cdkd local."
---

# Local Execution

`cdkd local` runs the workloads in your CDK app on your own machine, in Docker
containers. The commands read the same cloud assembly that `cdkd deploy` reads,
so you deploy nothing and maintain no `template.yaml`. You can test a handler
edit a few seconds after saving it.

With Docker running, from the directory that holds your `cdk.json`:

```bash
# run one Lambda once
cdkd local invoke MyStack/Handler --event event.json

# serve the app's APIs on localhost
cdkd local start-api --port 3000

# use the deployed stack's table names, ARNs, ...
cdkd local invoke MyStack/Handler --from-state
```

## Which command do I want

Pick the command by the resource you want to run.

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

`start-alb` starts the ECS services and Lambda functions behind the load
balancer itself, so you do not run `start-service` next to it.

## Requirements

Docker must be running, because every command runs your code in a container:

- A Lambda function runs in the AWS Lambda Runtime Interface Emulator (RIE)
  image for its runtime.
- An ECS container runs from its own image, next to the ECS metadata sidecar
  that AWS publishes.
- An AgentCore agent runs in the agent's image.

`local start-cloudfront` is the one command that can run without Docker. It
serves a distribution made of S3 origins and CloudFront Functions inside the
cdkd process. It needs Docker once the distribution has a Lambda Function URL
origin or a Lambda@Edge association.

The first run pulls the images it needs, so it is slower than later runs. A
language-specific Lambda base image is roughly 600 MB and a `provided.*` image
roughly 50 MB. Later runs reuse the cached image. `--no-pull` skips the
`docker pull` check, and each command page says which images that covers.

## Naming the target

Every command takes the resource to run as its argument, called the target.
You can write it in three ways:

```bash
# CDK display path
cdkd local invoke MyStack/MyApi/Handler

# stack name, a colon, the logical ID
cdkd local invoke MyStack:MyApiHandler1234ABCD

# bare name
cdkd local invoke Handler
```

- The CDK display path is the construct path. A prefix is enough, so you do
  not type the trailing `/Resource`.
- The stack-qualified logical ID works in any app.
- The bare name works only when the app has exactly one stack.

A stack inside a CDK `Stage` is addressed by its full display path, for example
`MyStage/MyStack/MyApi/Handler`.

`invoke` and `run-task` require a target. On the other commands it is
optional. Without one, `start-api` serves every API it finds, and
`start-service`, `start-alb`, `start-cloudfront` and the two AgentCore
commands open a picker when you run them in an interactive terminal.

## Where values come from

A local command runs before anything is deployed, so some environment values
do not exist yet. Take a function with two variables:

```ts
new lambda.Function(this, 'Handler', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda'),
  environment: {
    LOG_LEVEL: 'debug',           // a literal string
    TABLE_NAME: table.tableName,  // a reference to a table that has no name yet
  },
});
```

`LOG_LEVEL` reaches the container as written. `TABLE_NAME` is a `Ref` to the
table in the synthesized template, and only a deployment gives the table a
name. With no extra flag, cdkd leaves `TABLE_NAME` out of the container and
prints a warning that names it.

Every `cdkd local` command treats environment values this way. Each value is
handled according to its kind:

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

To give a reference such as `TABLE_NAME` a value, choose one of these:

| What you want | Do this |
| --- | --- |
| The values of a stack deployed with `cdkd deploy` | `--from-state` |
| The values of a stack deployed with the AWS CDK CLI | `--from-cfn-stack` |
| One variable pointed at something local | `--env-vars overrides.json` |

```bash
# TABLE_NAME is the deployed table's name
cdkd local invoke MyStack/Handler --from-state

# TABLE_NAME is whatever the file says
cdkd local invoke MyStack/Handler --env-vars overrides.json
```

A `{{resolve:...}}` value is a CloudFormation dynamic reference to a Secrets
Manager secret or an SSM parameter. cdkd looks it up with your credentials
before the container starts, and no flag is needed for that.

[Value resolution in local execution](local-emulation-value-resolution.md) has
the `--env-vars` file format, what each state flag can and cannot resolve, and
the rules for dynamic references.

## Credentials inside the container

By default the container gets your own AWS credentials, so the AWS calls your
code makes reach real AWS as you. Your credentials usually allow more than the
deployed role does, which means a missing IAM permission goes unnoticed. To see
IAM errors locally, run the code under the deployed role:

| Command | Flag |
| --- | --- |
| `local invoke` | `--assume-role [arn]` |
| `local start-api` | `--assume-role <arn>`, `--assume-role <LogicalId>=<arn>`, `--assume-role-auto` |
| `local run-task` | `--assume-task-role [arn]` |
| `local start-service`, `local start-alb` | `--assume-role [arn]` (`--assume-task-role` also works) |
| `local start-cloudfront` | `--assume-role [arn]`, for Lambda origins |
| `local invoke-agentcore`, `local start-agentcore` | `--assume-role [arn]` |

`--role-arn` is a different flag. It names the role cdkd assumes for its own
AWS calls.

> [!WARNING]
> On `start-service`, `start-alb`, `start-cloudfront` and `start-agentcore`,
> do not pass `--role-arn` without `--profile`. The role's credentials would
> reach your containers, or fetch the secrets injected into them. cdkd warns at
> startup when that applies, and each page's Options table says what the role
> touches.

## Common flags

Every `cdkd local` command accepts the flags below. Each command page lists
only the flags of its own.

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
| `--container-host <ip>` | `127.0.0.1` | IP that published container ports bind to. Must be numeric, because Docker rejects a hostname here. |

### Which region is used

The region for AWS calls comes from `AWS_REGION`, then `AWS_DEFAULT_REGION`,
then the synthesized stack's own `env.region`. An upper-cased region such as
`US-EAST-1` is changed to lower case before any AWS call.

A deprecated `--region` flag still overrides all three and prints a removal
warning. `--help` does not list it.

## Reaching a server on the host

Inside a container, `localhost` is the container itself. To reach a server on
your machine, such as a local DynamoDB or a tunnel to a VPC resource, use the
hostname `host.docker.internal`:

```json
{
  "Parameters": {
    "AWS_ENDPOINT_URL_DYNAMODB": "http://host.docker.internal:8000"
  }
}
```

Save that as `overrides.json` and pass it with `--env-vars overrides.json`.

Docker Desktop resolves the name natively. On Linux, cdkd adds the
`host.docker.internal:host-gateway` mapping itself, which needs Docker 20.10
or newer. On a daemon that does not support the mapping, cdkd skips it without
an error.

## Stopping a server

Press {kbd:ctrl+c} to stop a long-running command. cdkd then removes every
container, sidecar, Docker network and temporary file the command created.

If Docker itself hangs during that cleanup, press {kbd:ctrl+c} a second time.
cdkd exits immediately and skips the cleanup, so containers can be left
behind. Find and remove them yourself:

```bash
docker ps --filter name=cdkd-local-
docker rm -f <container-id>
```

On `start-api` and `run-task` with `--profile`, the forced exit also names a
temporary credentials file that it did not remove. The file holds live
credentials, so delete it once the containers are gone.

## finch on macOS and Windows

This section applies only when the `CDK_DOCKER` environment variable names
finch and you are on macOS or Windows. There, finch runs containers inside a
Lima VM and copies each environment value onto a command line that other
processes on your machine can read. cdkd therefore refuses to pass a secret
to finch:

| Command | Refused |
| --- | --- |
| `local run-task`, `local start-service` | A task with a `Secrets` entry |
| `local start-alb` | A service with a `Secrets` entry, and a Lambda target with a decrypted SecureString |
| `local invoke-agentcore`, `local start-agentcore` | A decrypted SecureString in the runtime's environment |
| `local start-cloudfront` | A decrypted SecureString in a Lambda Function URL origin's environment |
| Any command | A resolved `{{resolve:...}}` value |

The error names the secrets. You have two ways forward:

- Use Docker, podman or nerdctl, or run finch on Linux, which is not affected.
- Set `CDKD_ALLOW_SECRETS_ON_ARGV=1` to accept the exposure.

### AWS credentials under finch

cdkd still forwards AWS credentials to a container under finch, so that finch
stays usable, and it prints a warning naming the variables. The warning
matters most for two kinds of credentials that are otherwise absent from your
environment: the session credentials of `--assume-role` or
`--assume-task-role`, and credentials resolved from `--profile`.

Credentials that are already in cdkd's own environment reach finch's command
line on every finch command, including pulls and builds. finch does that by
itself, so cdkd prints no warning for it.

### How finch is recognised

cdkd recognises finch by the file name that `CDK_DOCKER` resolves to: `finch`
or `finch.exe`, in any letter case. A wrapper script or a symbolic link under
another name is not recognised.

## What cdkd trusts in the assembly

A local command runs code from the cloud assembly: the handler runs in a
container, and a Docker asset's build command runs on your machine. Treat an
assembly you did not synthesize yourself as untrusted input.
[Assembly paths in local execution](local-emulation-assembly-trust.md) lists
the paths cdkd refuses to use and the ones it accepts with a warning.

## In this section

- [Value resolution in local execution](local-emulation-value-resolution.md):
  the `--env-vars` file, what `--from-state` and `--from-cfn-stack` resolve,
  and `{{resolve:...}}` references
- [Assembly paths in local execution](local-emulation-assembly-trust.md):
  which directories named by a cloud assembly cdkd refuses to mount, build or
  serve

## Related

- [CLI Reference](cli-reference.md): every cdkd command
- [Deploy safety](cli-deploy-safety.md): what cdkd refuses to read out of a
  cloud assembly on the deploy path
- [State Store](state-management.md): what `--from-state` reads
- [Getting Started](getting-started.md): installing cdkd and deploying a first
  stack
