---
title: cdkd local invoke
description: "Run one Lambda function from your CDK app in a local Docker container, with an event you supply, without deploying."
---

# cdkd local invoke

`cdkd local invoke <target>` runs one Lambda function from your CDK app on
your machine and prints what the handler returned. It does the job of
`sam local invoke`, and it reads the CDK app directly. Use it to try a handler
against a real event before you deploy.

## Invoke a function

Suppose `MyStack` has this function:

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

With Docker running, write an event to a file and invoke the function by its
construct path:

```bash
echo '{"id": 42}' > event.json
cdkd local invoke MyStack/Handler --event event.json
```

cdkd prints its progress and the handler's own log lines on stderr. The
handler's return value is the last line on stdout:

```text
{"ok":true,"id":42}
```

More invocations:

```bash
# event defaults to {}
cdkd local invoke MyStack/Handler

# event on stdin; single-stack app
echo '{"id": 42}' | cdkd local invoke Handler --event-stdin

# use the deployed stack's values
cdkd local invoke MyStack/Handler --from-state

# run under the deployed role
cdkd local invoke MyStack/Handler --from-state --assume-role

# take the payload
cdkd local invoke MyStack/Handler -e event.json | tail -1 | jq .id

# skip synthesis while iterating
cdkd local invoke MyStack/Handler -a cdk.out
```

Docker is required. See [Local Execution](local-emulation.md#requirements).

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `<target>` | — | The Lambda to invoke. Required. See [Target resolution](#target-resolution). |
| `-e`, `--event <file>` | `{}` | JSON event payload file. |
| `--event-stdin` | off | Read the event JSON from stdin. Cannot be combined with `--event`. |
| `--debug-port <port>` | off | Wait for a Node debugger on this port. See [`--debug-port`](#debug-port). |
| `--assume-role [arn]` | off | Run the handler under the function's execution role. See [`--assume-role`](#assume-role-run-under-the-deployed-execution-role). |
| `--no-assume-role` | — | Keep your own credentials and silence the hint to use `--assume-role`. |
| `--no-pull` | off | Skip `docker pull`. See [`--no-pull` and `--no-build`](#no-pull-and-no-build-by-code-path). |
| `--no-build` | off | Skip `docker build` for a container-image Lambda. |
| `--layer-role-arn <arn>` | — | Role to assume before downloading a layer named by ARN. See [Lambda layers](#lambda-layers). |
| `--ecr-role-arn <arn>` | — | Role to assume before pulling a container image from ECR. See [Container-image Lambdas](#container-image-lambdas). |

The command also accepts every
[common flag](local-emulation.md#common-flags), including `--env-vars`,
`--container-host`, `--from-state` and `--from-cfn-stack`. On this command
`--container-host` is the IP that the Lambda emulator's port binds to.

### `--debug-port`

`--debug-port <port>` starts Node with `--inspect-brk` on that port and
publishes the port on your machine. The handler waits until a debugger
attaches. The port must be an integer from 1 to 65535.

```bash
cdkd local invoke MyStack/Handler --event event.json --debug-port 9229
```

### `--no-pull` and `--no-build` by code path

`--no-pull` and `--no-build` each skip one step, and which step exists
depends on how the function's code is packaged. You can combine the two
flags.

**A ZIP Lambda.** `--no-pull` skips pulling the Lambda base image.
`--no-build` has no effect.

**A container image built locally.** `--no-build` reuses the
`cdkd-local-invoke-<hash>` image that an earlier run built. It is an error
when that image is not in the local registry. `--no-pull` has no effect.

**A container image pulled from ECR.** `--no-pull` skips the pull. It is an
error when the image is not cached. `--no-build` has no effect.

## Target resolution

`<target>` names the Lambda to invoke. You can write it in three ways:

```bash
# CDK display path
cdkd local invoke MyStack/MyApi/Handler

# stack name, a colon, the logical ID
cdkd local invoke MyStack:MyApiHandler1234ABCD

# bare name, single-stack app only
cdkd local invoke Handler
```

[Naming the target](local-emulation.md#naming-the-target) has the full rules.

When the target matches nothing, the error lists every Lambda in the stack,
so you can copy a valid one.

### Edge case: a Custom Resource

A Custom Resource (`Custom::*`) is not a function, so you cannot invoke it by
its own name. The error points at the Lambda behind its `ServiceToken`. Invoke
that Lambda directly.

## Runtimes and images

cdkd runs a ZIP Lambda in the AWS base image for its runtime, with your code
mounted into it. A container-image Lambda runs in its own image.

### Supported runtimes

| Family | Runtimes | Base image | Code source |
| --- | --- | --- | --- |
| Node.js | `nodejs18.x`, `nodejs20.x`, `nodejs22.x`, `nodejs24.x` | `public.ecr.aws/lambda/nodejs:<version>` | Asset or inline `Code.ZipFile` |
| Python | `python3.11`, `python3.12`, `python3.13`, `python3.14` | `public.ecr.aws/lambda/python:<version>` | Asset or inline `Code.ZipFile` |
| Ruby | `ruby3.2`, `ruby3.3` | `public.ecr.aws/lambda/ruby:<version>` | Asset or inline `Code.ZipFile` |
| Java | `java8.al2`, `java11`, `java17`, `java21` | `public.ecr.aws/lambda/java:<version>` | Asset only |
| .NET | `dotnet6`, `dotnet8` | `public.ecr.aws/lambda/dotnet:<version>` | Asset only |
| OS-only | `provided.al2`, `provided.al2023` | `public.ecr.aws/lambda/provided:<al2\|al2023>` | Asset only |

The language images are roughly 600 MB each and the `provided.*` images
roughly 50 MB.

cdkd mounts the function's asset directory read-only at `/var/task`. It
writes inline code to a temporary directory, at the path the function's
`Handler` implies: `index.handler` becomes `index.js`.

Two kinds of function are rejected:

- **Inline code on Java, .NET or `provided.*`.** A handler in these runtimes
  names a compiled artifact, which inline `Code.ZipFile` cannot hold. The
  error points at `lambda.Code.fromAsset(...)`.
- **The deprecated `go1.x` runtime.** The error points at `provided.al2023`.

### Architecture

The container runs on the architecture the function declares. cdkd turns the
function's `Architectures` value, `x86_64` by default or `arm64`, into
`--platform linux/amd64` or `--platform linux/arm64`.

On a host of the other architecture, Docker emulates the declared one. A
`provided.*` `bootstrap` binary built for the declared architecture therefore
runs, where it would otherwise fail with `exec format error`.

### Container-image Lambdas

`lambda.DockerImageFunction` and `Code.ImageUri` functions are supported.
cdkd looks for the image in this order and uses the first match:

1. The Docker asset in the cloud assembly whose hash matches the tag of the
   image URI. cdkd runs `docker build` on that asset's build context.
2. The assembly's only Docker asset, when there is exactly one. This covers
   an image URI pinned by digest.
3. A `docker pull` from ECR. This is the usual case for a stack deployed
   from another machine.

An ECR pull from another region works without extra flags. A pull from
another account uses your own credentials, which works when the repository's
policy grants you access. When it does not, AWS returns `AccessDenied`. Pass
`--ecr-role-arn <arn>` to assume a role in the target account before the
pull.

cdkd applies the function's `ImageConfig` to the container:

| Template field | Effect |
| --- | --- |
| `ImageConfig.Command` | Becomes the container `CMD`. |
| `ImageConfig.EntryPoint` | Becomes `--entrypoint <first>`, with the rest as arguments. |
| `ImageConfig.WorkingDirectory` | Becomes `--workdir`. |

With no `EntryPoint`, the image's own entrypoint runs. A container-image
Lambda ignores `Layers`, as it does on AWS.

## Environment variables

With no extra flag, a variable whose value is a literal string reaches the
container, and a variable that refers to another resource is dropped with a
warning naming it. Pass `--from-state` or `--from-cfn-stack` to fill
references with the deployed stack's values.
[Where values come from](local-emulation.md#where-values-come-from) explains
the idea for every local command.

```bash
# literals only
cdkd local invoke MyStack/Handler

# stack deployed with cdkd deploy
cdkd local invoke MyStack/Handler --from-state

# stack deployed with the AWS CDK CLI
cdkd local invoke MyStack/Handler --from-cfn-stack

# values from a file
cdkd local invoke MyStack/Handler --env-vars overrides.json
```

Each entry of the function's `Environment.Variables` is handled by its kind:

| Entry | With no state flag | With `--from-state` or `--from-cfn-stack` |
| --- | --- | --- |
| Literal | Passed through | Passed through |
| Intrinsic (`Ref`, `Fn::GetAtt`, `Fn::Sub`, `Fn::Join`, `Fn::ImportValue`) | Dropped with a warning | The deployed value, or dropped with a warning |
| Pseudo parameter (`${AWS::AccountId}`, `${AWS::Region}`, `${AWS::Partition}`, `${AWS::URLSuffix}`) | Dropped with a warning | Resolved from STS and the region |
| `{{resolve:...}}` dynamic reference | Looked up with your credentials | Looked up with your credentials |

An intrinsic is dropped under a state flag when the source cannot supply its
value. A `{{resolve:...}}` lookup that fails stops the invoke before the
container starts. An entry in the `--env-vars` file overrides any of the four
kinds.

cdkd also sets the variables the Lambda runtime normally provides, so that
the handler's `context` object looks real: `AWS_LAMBDA_FUNCTION_NAME`,
`AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, `AWS_LAMBDA_FUNCTION_TIMEOUT`,
`AWS_LAMBDA_FUNCTION_VERSION`, `AWS_LAMBDA_LOG_GROUP_NAME` and
`AWS_LAMBDA_LOG_STREAM_NAME`.

### What `--from-cfn-stack` recovers

A CloudFormation stack listing gives cdkd physical IDs but no attribute
values, so `--from-cfn-stack` resolves less than `--from-state` does:

| Intrinsic | Result |
| --- | --- |
| `Ref` | Resolved from the stack's resource listing. |
| `Fn::ImportValue` | Resolved from the account's exports. |
| `Fn::GetAtt` in the invoked function's own variables | Read back from the deployed function's configuration. |
| `Fn::GetAtt` anywhere else | Dropped with a warning. Override it with `--env-vars`. |
| `Fn::GetStackOutput` | Dropped with a warning. Use `Fn::ImportValue`, or `--from-state`. |

The third row works because CloudFormation resolved every intrinsic when it
deployed the function. The deployed function's configuration already holds
the final values, and cdkd reads them from there.

### Intrinsics that are not resolved

**Other intrinsics.** `Fn::Select`, `Fn::Split`, `Fn::If` and any intrinsic
outside the set that
[Value resolution in local execution](local-emulation-value-resolution.md#what-each-flag-can-resolve)
lists are dropped with a warning under either flag.

**References to another account or region.** Cross-stack references resolve
within one AWS account. An `Fn::GetStackOutput` that carries a `RoleArn` for
another account is refused. An `Fn::ImportValue` whose producing stack is in
another region is dropped with a warning.

## `--assume-role`: run under the deployed execution role

By default the container gets your shell's AWS credentials, which usually
allow far more than the deployed function's role does. `--assume-role` makes
cdkd assume the function's execution role and pass those temporary
credentials to the container, so a missing IAM permission shows up locally.

```bash
# the function's own role, read from cdkd state
cdkd local invoke MyStack/Handler --from-state --assume-role
cdkd local invoke MyStack/Handler \
  --assume-role arn:aws:iam::123456789012:role/HandlerRole
```

- The bare `--assume-role` reads the function's role from cdkd state, so it
  requires `--from-state`.
- `--assume-role <arn>` assumes the role you name. The ARN must be a
  well-formed role ARN (`arn:<partition>:iam::<account>:role/<name>`, at most
  2048 characters).

When you omit the flag and pass `--from-state`, cdkd logs the deployed role's
ARN once, so that you can run again with the flag. `--no-assume-role` keeps
your credentials and suppresses that log line.

The flag is a development aid and does not enforce anything. If the role
cannot be assumed, or the ARN read from state is not a well-formed role ARN,
cdkd warns and runs the handler with your credentials.

## Lambda layers

cdkd mounts the function's layers read-only at `/opt`, as Lambda does. A layer
in the same stack comes from the cloud assembly, and a layer named by ARN is
downloaded. For a layer your own credentials cannot read, pass
`--layer-role-arn <arn>`. [Layers in cdkd local invoke](local-invoke-layers.md)
has the merge order, the role flag and the entries that are rejected.

## Ephemeral storage

When the function sets `ephemeralStorageSize`, cdkd makes the container's
`/tmp` a memory-backed filesystem capped at that size. A handler that writes
past the cap fails with `ENOSPC`, as it would on AWS, and a handler that
checks free space sees the cap. This applies to ZIP and container-image
Lambdas, for sizes up to 10240 MiB.

Three other cases:

- **No `EphemeralStorage.Size`.** `/tmp` is whatever the base image provides.
- **A size above 10240 MiB.** cdkd stops with an error before the container
  starts.
- **A size that is an intrinsic**, such as `{ Ref: 'SomeParam' }`. No cap is
  applied.

## Output streams

stdout carries the handler's response, so that you can pipe it. Everything
else goes to stderr: cdkd's own status lines, `docker pull` progress, and the
container's output, which includes `START`, `END`, `REPORT` and every line
the handler logs.

```bash
# ZIP Lambda: stdout is the payload
cdkd local invoke MyStack/Handler --event event.json | jq .id

# container image: take the last line
cdkd local invoke MyStack/ImageFn --event event.json | tail -1 | jq .

# logs to a file
cdkd local invoke MyStack/Handler --event event.json 2> invoke.log
```

The handler's log lines always come before the response. cdkd stops the
container and waits up to 5 seconds for Docker to relay the remaining output,
and only then prints the response.

### Edge case: build lines on stdout

For a container-image Lambda, the lines `Building container image
(platform=...)` and `Skipping docker build ...` also print on stdout. Pipe
through `tail -1` to take the payload.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The emulator answered, whether the handler returned a result or an error payload. |
| `1` | cdkd failed before or after the handler ran: Docker missing, image pull or build failed, target not found, an invalid flag value, or the container not answering. |
| `130` | {kbd:ctrl+c}. The container and temporary directories are removed first. |

A handler that throws still exits `0`, because on AWS a thrown handler also
produces a response, one that carries an error structure. To detect a handler
error, inspect the payload.

The full cross-command table is in
[Exit codes](cli-reference-exit-codes.md).

## Limitations

| Not emulated | What to do |
| --- | --- |
| The `go1.x` runtime | Build the handler for `provided.al2023`. |
| SQS, S3 and other event sources | Pass the event body with `--event`. |
| VPC placement | Tunnel to the resource and reach it through [`host.docker.internal`](local-emulation.md#reaching-a-server-on-the-host). |
| Invoking a Custom Resource by its `Custom::*` type | Invoke the Lambda behind its `ServiceToken`. |

## In this section

- [Layers in cdkd local invoke](local-invoke-layers.md): where each layer
  comes from, the order layers are merged in, and layers in another account
  or partition

## Related

- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [`cdkd local start-api`](local-start-api.md): serve the same functions
  behind their API Gateway routes
- [`cdkd local invoke-agentcore`](local-invoke-agentcore.md): the same
  one-shot shape for a Bedrock AgentCore Runtime
- [CLI Reference](cli-reference.md): every cdkd command
