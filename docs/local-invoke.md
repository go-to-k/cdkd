---
title: cdkd local invoke
description: "Run one Lambda function from your CDK app in a local Docker container, with an event you supply, without deploying."
---

# cdkd local invoke

`cdkd local invoke <target>` runs one Lambda function from your CDK app on
your machine and prints what the handler returned. It does the job of
`sam local invoke`, reading the CDK app directly. Use it to try a handler
against a real event before you deploy.

## Invoke a function

Given this function in `MyStack`:

```ts
import * as lambda from 'aws-cdk-lib/aws-lambda';

new lambda.Function(this, 'Handler', {
  runtime: lambda.Runtime.NODEJS_22_X,
  handler: 'index.handler',
  code: lambda.Code.fromInline(
    'exports.handler = async (event) => ({ ok: true, id: event.id });',
  ),
});
```

write an event and invoke the function by its construct path:

```bash
echo '{"id": 42}' > event.json
cdkd local invoke MyStack/Handler --event event.json
```

Progress and the handler's own log lines go to stderr. The handler's return
value is the last line on stdout:

```text
{"ok":true,"id":42}
```

More invocations:

```bash
cdkd local invoke MyStack/Handler                             # event defaults to {}
echo '{"id": 42}' | cdkd local invoke Handler --event-stdin   # event on stdin; single-stack app
cdkd local invoke MyStack/Handler --from-state                # use the deployed stack's values
cdkd local invoke MyStack/Handler --from-state --assume-role  # run under the deployed role
cdkd local invoke MyStack/Handler -e event.json | tail -1 | jq .id   # take the payload
cdkd local invoke MyStack/Handler -a cdk.out                  # skip synthesis while iterating
```

Docker is required. See [Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `<target>` | — | The Lambda to invoke. Required. See [Target resolution](#target-resolution). |
| `-e`, `--event <file>` | `{}` | JSON event payload file. |
| `--event-stdin` | off | Read the event JSON from stdin. Cannot be combined with `--event`. |
| `--debug-port <port>` | off | Start Node with `--inspect-brk` on this port and publish it. The handler waits for a debugger to attach. Integer in 1-65535. |
| `--assume-role [arn]` | off | Run the handler under the function's execution role. See [`--assume-role`](#assume-role-run-under-the-deployed-execution-role). |
| `--no-assume-role` | — | Keep your own credentials and silence the hint to use `--assume-role`. |
| `--no-pull` | off | Skip `docker pull`. See [the table below](#no-pull-and-no-build-by-code-path). |
| `--no-build` | off | Skip `docker build` for a container-image Lambda. |
| `--layer-role-arn <arn>` | — | Role to assume before downloading a layer named by ARN. See [Lambda layers](#lambda-layers). |
| `--ecr-role-arn <arn>` | — | Role to assume before pulling a container image from ECR. See [Container-image Lambdas](#container-image-lambdas). |

It also accepts every [common flag](local-emulation.md#common-flags), including
`--env-vars`, `--container-host`, `--from-state` and `--from-cfn-stack`.
`--container-host` is the IP the emulator's port binds to.

### `--no-pull` and `--no-build` by code path

| Code path | `--no-pull` | `--no-build` |
| --- | --- | --- |
| ZIP Lambda | Skips pulling the Lambda base image. | No effect. |
| Container image, built locally | No effect. | Reuses the `cdkd-local-invoke-<hash>` image from an earlier run. Errors when it is not in the local registry. |
| Container image, pulled from ECR | Skips the pull. Errors when the image is not cached. | No effect. |

The two flags can be combined.

## Target resolution

`<target>` is a CDK display path (`MyStack/MyApi/Handler`), a stack-qualified
logical ID (`MyStack:MyApiHandler1234ABCD`), or, in a single-stack app, a bare
name (`Handler`). [Naming the target](local-emulation.md#naming-the-target)
has the full rules.

When the target matches nothing, the error lists every Lambda in the stack so
you can copy a valid one.

A Custom Resource (`Custom::*`) cannot be invoked as such. The error points at
the Lambda behind its `ServiceToken`, which you can invoke directly.

## Runtimes and images

### Supported runtimes

| Family | Runtimes | Base image | Code source |
| --- | --- | --- | --- |
| Node.js | `nodejs18.x`, `nodejs20.x`, `nodejs22.x`, `nodejs24.x` | `public.ecr.aws/lambda/nodejs:<version>` | Asset or inline `Code.ZipFile` |
| Python | `python3.11`, `python3.12`, `python3.13`, `python3.14` | `public.ecr.aws/lambda/python:<version>` | Asset or inline `Code.ZipFile` |
| Ruby | `ruby3.2`, `ruby3.3` | `public.ecr.aws/lambda/ruby:<version>` | Asset or inline `Code.ZipFile` |
| Java | `java8.al2`, `java11`, `java17`, `java21` | `public.ecr.aws/lambda/java:<version>` | Asset only |
| .NET | `dotnet6`, `dotnet8` | `public.ecr.aws/lambda/dotnet:<version>` | Asset only |
| OS-only | `provided.al2`, `provided.al2023` | `public.ecr.aws/lambda/provided:<al2\|al2023>` | Asset only |

The language images are roughly 600 MB and the `provided.*` images roughly
50 MB.

Java, .NET and `provided.*` handlers name a compiled artifact, so inline
`Code.ZipFile` is rejected for them with a pointer at
`lambda.Code.fromAsset(...)`. The deprecated `go1.x` runtime is rejected with a
pointer at `provided.al2023`.

The function's asset directory is mounted read-only at `/var/task`. Inline code
is written to a temporary directory at the path its `Handler` implies
(`index.handler` becomes `index.js`).

### Architecture

The function's `Architectures` value (`x86_64` by default, or `arm64`) becomes
`--platform linux/amd64` or `linux/arm64` on the container. On a host of the
other architecture Docker emulates it, so a `provided.*` `bootstrap` built for
the declared architecture runs instead of failing with `exec format error`.

### Container-image Lambdas

`lambda.DockerImageFunction` and `Code.ImageUri` functions are supported. cdkd
finds the image in this order:

1. The Docker asset in the cloud assembly whose hash matches the image URI's
   tag. cdkd runs `docker build` on its build context.
2. The assembly's only Docker asset, when there is exactly one. This covers
   digest-pinned URIs.
3. A `docker pull` from ECR, when neither matches. This is the usual case for
   a stack deployed elsewhere.

The ECR pull works across regions without extra flags. Across accounts it uses
your own credentials, which works when the repository's policy grants you
access. Otherwise AWS returns `AccessDenied`; pass `--ecr-role-arn <arn>` to
assume a role in the target account first.

`ImageConfig` is applied to the container:

| Template field | Effect |
| --- | --- |
| `ImageConfig.Command` | Becomes the container `CMD`. |
| `ImageConfig.EntryPoint` | Becomes `--entrypoint <first>`, with the rest as arguments. |
| `ImageConfig.WorkingDirectory` | Becomes `--workdir`. |

With no `EntryPoint`, the image's own entrypoint runs. A container-image Lambda
ignores `Layers`, as it does on AWS.

## Environment variables

The function's `Environment.Variables` are resolved as
[Where values come from](local-emulation.md#where-values-come-from) describes:

| Entry | With no state flag | With `--from-state` or `--from-cfn-stack` |
| --- | --- | --- |
| Literal | Passed through. | Passed through. |
| Intrinsic (`Ref`, `Fn::GetAtt`, `Fn::Sub`, `Fn::Join`, `Fn::ImportValue`) | Dropped, with a warning naming the key. | Replaced by the deployed value, or dropped with a warning when the source cannot supply it. |
| Pseudo parameter (`${AWS::AccountId}`, `${AWS::Region}`, `${AWS::Partition}`, `${AWS::URLSuffix}`) | Dropped, with a warning. | Resolved from STS and the region. |
| `{{resolve:...}}` dynamic reference | Looked up with your credentials. A failed lookup fails the invoke. | Same. |

`--env-vars` overrides any of them.

These Lambda runtime variables are always set, so `context` looks real:
`AWS_LAMBDA_FUNCTION_NAME`, `AWS_LAMBDA_FUNCTION_MEMORY_SIZE`,
`AWS_LAMBDA_FUNCTION_TIMEOUT`, `AWS_LAMBDA_FUNCTION_VERSION`,
`AWS_LAMBDA_LOG_GROUP_NAME`, `AWS_LAMBDA_LOG_STREAM_NAME`.

### What `--from-cfn-stack` recovers

| Intrinsic | Result |
| --- | --- |
| `Ref` | Resolved from the stack's resource listing. |
| `Fn::ImportValue` | Resolved from the account's exports. |
| `Fn::GetAtt` in the invoked function's own variables | Read back from the deployed function's configuration. |
| `Fn::GetAtt` anywhere else | Dropped with a warning. Override it with `--env-vars`. |
| `Fn::GetStackOutput` | Dropped with a warning. Use `Fn::ImportValue`, or `--from-state`. |

CloudFormation resolved every intrinsic when it deployed the function, so the
deployed function's configuration already holds the final values. cdkd reads
them from there, which is why the invoked function's own `Fn::GetAtt` values
come back.

### Intrinsics that are not resolved

`Fn::Select`, `Fn::Split`, `Fn::If` and any other intrinsic outside the set
[Local Execution](local-emulation.md#from-state-and-from-cfn-stack-resolving-deployed-values)
lists are dropped with a warning under either flag.

Cross-stack references resolve within one AWS account. A `Fn::GetStackOutput`
carrying a `RoleArn` for another account is refused, and a `Fn::ImportValue`
whose producing stack is in another region is dropped with a warning.

## `--assume-role`: run under the deployed execution role

By default the container gets your shell's AWS credentials, which usually
allow far more than the deployed function's role does. `--assume-role` assumes
the function's execution role and passes those temporary credentials instead,
so a missing IAM permission shows up locally.

| Form | Behaviour |
| --- | --- |
| `--assume-role <arn>` | Assumes that role. It must be a well-formed role ARN (`arn:<partition>:iam::<account>:role/<name>`, at most 2048 characters). |
| `--assume-role` | Assumes the function's own role, read from cdkd state. Requires `--from-state`. |
| Flag omitted | Your credentials are used. With `--from-state`, cdkd logs the deployed role ARN once so you can re-run with the flag. |
| `--no-assume-role` | Your credentials are used and that log line is not printed. |

If the role cannot be assumed, or the ARN read from state is not a well-formed
role ARN, cdkd warns and falls back to your credentials. The flag is a
development aid and does not enforce anything.

## Lambda layers

Layers are mounted read-only at `/opt`. cdkd does not inspect a layer's
contents, so the layout inside it (`/opt/python`, `/opt/nodejs`, `/opt/lib`)
is yours to get right.

With several layers, their contents are merged in template order and the last
layer wins when two contain the same file, as on AWS.

| `Layers` entry | How it is resolved |
| --- | --- |
| `{ Ref: <LayerVersion> }` or `{ Fn::GetAtt: [<LayerVersion>, 'Ref'] }` in the same stack | The layer's asset directory in the cloud assembly. |
| A layer-version ARN string | Downloaded with `lambda:GetLayerVersion` and unzipped to a temporary directory. |

For an ARN your own credentials cannot read, typically a cross-account layer,
pass `--layer-role-arn <arn>`. AWS-published public layers such as Lambda
Powertools need no role.

A layer ARN is used in the partition it names, so `aws-cn`, `aws-us-gov`,
`aws-eusc` and the ISO partitions work. The partition must match the ARN's
region: `arn:aws-cn:lambda:us-east-1:...` is refused.

These entries are errors, and the message names the entry:

- A string that is not a layer-version ARN: a malformed ARN, a function ARN,
  an unversioned layer ARN, or a partition that disagrees with the region.
- A reference that does not point at an `AWS::Lambda::LayerVersion`.
- A reference to a `LayerVersion` with no asset path in the assembly.

## Ephemeral storage

When the function sets `ephemeralStorageSize`, the container's `/tmp` is a
memory-backed filesystem capped at that size. A handler that writes past the
cap fails with `ENOSPC` as it would on AWS, and one that checks free space
sees the cap.

| `EphemeralStorage.Size` | Result |
| --- | --- |
| Set, up to 10240 MiB | `/tmp` is capped at that size, for ZIP and container-image Lambdas. |
| Absent | `/tmp` is whatever the base image provides. |
| Above 10240 MiB | Error before the container starts. |
| An intrinsic such as `{ Ref: 'SomeParam' }` | No cap is applied. |

## Output streams

stdout is reserved for the handler's response. Everything else goes to stderr:
cdkd's own status lines, `docker pull` progress, and the container's output,
including `START` / `END` / `REPORT` and every line the handler logs.

```bash
cdkd local invoke MyStack/Handler --event event.json | jq .id          # ZIP Lambda: stdout is the payload
cdkd local invoke MyStack/ImageFn --event event.json | tail -1 | jq .  # container image: take the last line
cdkd local invoke MyStack/Handler --event event.json 2> invoke.log     # logs to a file
```

For a container-image Lambda, the lines `Building container image
(platform=...)` and `Skipping docker build ...` also print on stdout. Pipe
through `tail -1` to take the payload.

cdkd stops the container and waits up to 5 seconds for Docker to relay its
remaining output before printing the response, so the handler's log lines
always come first.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The emulator answered, whether the handler returned a result or an error payload. On AWS a thrown handler also produces a response carrying an error structure. |
| `1` | cdkd failed before or after the handler ran: Docker missing, image pull or build failed, target not found, an invalid flag value, or the container not answering. |
| `130` | {kbd:ctrl+c}. The container and temporary directories are removed first. |

To detect a handler error, inspect the payload. The full cross-command table is
in the [CLI Reference](cli-reference.md#exit-codes).

## Limitations

| Not emulated | What to do |
| --- | --- |
| The `go1.x` runtime | Build the handler for `provided.al2023`. |
| SQS, S3 and other event sources | Pass the event body with `--event`. |
| VPC placement | Tunnel to the resource and reach it through [`host.docker.internal`](local-emulation.md#reaching-a-server-on-the-host). |
| Invoking a Custom Resource by its `Custom::*` type | Invoke the Lambda behind its `ServiceToken`. |

## Related

- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [`cdkd local start-api`](local-start-api.md): serve the same functions
  behind their API Gateway routes
- [`cdkd local invoke-agentcore`](local-invoke-agentcore.md): the same
  one-shot shape for a Bedrock AgentCore Runtime
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
