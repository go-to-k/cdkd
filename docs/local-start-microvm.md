---
title: cdkd local start-microvm
description: "Run AWS Lambda MicroVMs from a MicrovmImage in your CDK app as local Docker containers, with the lifecycle hooks, port routing and suspend / resume."
---

# cdkd local start-microvm

`cdkd local start-microvm [target]` runs AWS Lambda MicroVMs from an
`AWS::Lambda::MicrovmImage` in your CDK app until you press {kbd:ctrl+c}. It
builds the image's `Dockerfile` once, starts `--count` containers, drives each
one's lifecycle hooks in the order the cloud does, and serves each MicroVM on
its own local URL.

```bash
# one MicroVM on a free port
cdkd local start-microvm MyStack/Image

# three MicroVMs on 8000, 8001 and 8002
cdkd local start-microvm MyStack/Image --count 3 --port 8000

# the runHookPayload the /run hook receives
cdkd local start-microvm MyStack/Image --run-hook-payload tenant-a

# make container port 5005 routable
cdkd local start-microvm MyStack/Image --proxy-port 5005

# run under an execution role
cdkd local start-microvm MyStack/Image --assume-role arn:aws:iam::123456789012:role/MicrovmExec
```

Docker is required. [Local Execution](local-emulation.md) lists the
requirements.

## Run a MicroVM image

The image's code is an `s3assets.Asset` of a directory holding a `Dockerfile`
and the app:

```ts
import * as path from 'node:path';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { CfnMicrovmImage } from 'aws-cdk-lib/aws-lambda';

const code = new s3assets.Asset(this, 'Code', {
  path: path.join(__dirname, '../app'),
});

new CfnMicrovmImage(this, 'Image', {
  name: 'my-image',
  codeArtifact: { uri: code.s3ObjectUrl },
  cpuConfigurations: [{ architecture: 'ARM_64' }],
  environmentVariables: [{ key: 'GREETING', value: 'hello' }],
  hooks: {
    port: 9001,
    microvmImageHooks: { ready: 'ENABLED' },
    microvmHooks: { run: 'ENABLED', terminate: 'ENABLED' },
  },
  // ...the image's other required properties
});
```

```bash
cdkd local start-microvm MyStack/Image --port 8000
curl http://127.0.0.1:8000/hello
```

Once the hooks have answered, cdkd prints one line per MicroVM:

```text
MicroVM mvm-<uuid> listening on http://127.0.0.1:8000  (control: http://127.0.0.1:8000/_cdkl/microvm)
```

Nothing is deployed. The code comes from the asset staged in `cdk.out`.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | picker | The `MicrovmImage` to run. |
| `--count <n>` | `1` | Number of independent MicroVMs, each with its own URL. |
| `--run-hook-payload <string>` | — | The `runHookPayload` each `/run` hook receives (at most 16 KB). |
| `--run-hook-payload-file <path>` | — | Read the payload from a file. |
| `--port <n>` | `0` (auto) | Port of the first MicroVM; MicroVM *i* listens on `<n>` + *i*. |
| `--host <ip>` | `127.0.0.1` | Address the MicroVM URLs listen on. |
| `--platform <platform>` | the image's architecture | `linux/amd64` or `linux/arm64`, for the build and the containers. |
| `--proxy-port <port>` | — | Another container port `X-aws-proxy-port` may route to. Repeatable. |
| `--auto-resume` | off | Resume a suspended MicroVM on its next request instead of answering `503`. |
| `--no-build-cache` | off | Build with `docker build --no-cache`. |
| `--env-vars <file>` | — | JSON environment overrides, keyed by the image's logical ID or construct path. |
| `--timeout <ms>` | `60000` | Deadline of a hook with no `TimeoutInSeconds` of its own. |
| `--assume-role <arn>` | off | Run the containers under this role. |
| `--from-state` | off | Resolve the image's environment from cdkd's S3 state. |
| `--from-cfn-stack [name]` | off | Resolve it from a deployed CloudFormation stack. |

`--run-hook-payload` and `--run-hook-payload-file` are mutually exclusive. The
command also accepts the common flags listed in
[Local Execution](local-emulation.md), except `--container-host`.

## Code and build

`CodeArtifact.Uri` must be the `s3://` URI of a CDK asset of this app, an
`s3assets.Asset` of a directory passing `asset.s3ObjectUrl`. cdkd finds the
staged directory, or `.zip`, in `cdk.out` by its object key and never
downloads deployed code. The bundle needs a `Dockerfile` at its root.

The image is built with your local Docker engine for the image's
`CpuConfigurations` architecture (`ARM_64` is `linux/arm64`, `X86_64` is
`linux/amd64`; `--platform` overrides it). The container starts the app with
the image's own `ENTRYPOINT` / `CMD`.

> [!NOTE]
> Lambda's container base `public.ecr.aws/lambda/microvms:al2023-minimal` is
> published for arm64 only and has no language runtime. On an amd64 host,
> build from a multi-arch base image or pass `--platform`.

## Lifecycle hooks

Hooks are the `POST`s to `/aws/lambda-microvms/runtime/v1/<hook>` on
`Hooks.Port`. For each MicroVM, in order:

| Step | What happens |
| --- | --- |
| 1 | The container starts. |
| 2 | `/ready` is polled. `503`, or a refused connection while the app starts, is retried until `ReadyTimeoutInSeconds`; any other status than `200` / `503` fails, and a request held open without an answer fails at the deadline, with no retry. |
| 3 | `/validate` is polled the same way. |
| 4 | `/run` is posted once with `{"microvmId":"mvm-<uuid>","runHookPayload":"..."}` and must answer `200` within `RunTimeoutInSeconds`. |
| 5 | The MicroVM's local URL opens. |

Without a `/ready` hook, the app must answer any HTTP request on `Hooks.Port`
(or 8080 when the image has no hooks) within `--timeout`. A hook that is not
`ENABLED` is skipped, and an enabled hook without a literal `Hooks.Port`
fails before anything is built. A hook without its own `TimeoutInSeconds`
gets `--timeout`, except `/terminate`, which gets 10 seconds.

A failure removes the containers and prints the container's last output.

## Port routing

Each MicroVM's URL forwards a request to one container port, chosen in this
order:

| Order | Container port |
| --- | --- |
| 1 | The port in the `X-aws-proxy-port` header |
| 2 | For a WebSocket, the port in a `lambda-microvms.port.N` subprotocol |
| 3 | 8080 |

Before the app sees the request, every `X-aws-proxy-*` header and the MicroVM
subprotocols (`lambda-microvms`, `lambda-microvms.authentication.*`,
`lambda-microvms.port.*`) are removed. When a WebSocket client offered only
MicroVM subprotocols, the `101` response selects `lambda-microvms` if the
client offered that base protocol, and no protocol if it offered only, say,
`lambda-microvms.port.9000`.

Reachable ports are 8080, `Hooks.Port`, every port the image `EXPOSE`s, and
every `--proxy-port`. Errors match the cloud endpoint's:

| Status | When |
| --- | --- |
| `400` | The port value is not 1-65535. |
| `403` | The port is not one of the reachable ports. |
| `502` | The app does not answer on the port. |

`Hooks.Port` is reachable through `X-aws-proxy-port` locally. Whether the
cloud endpoint routes to the hooks port is not verified, so do not rely on it.

## The control endpoint

Each MicroVM's URL reserves `/_cdkl/microvm`:

| Request | Effect |
| --- | --- |
| `GET /_cdkl/microvm` | Returns `{"microvmId", "state", "ports"}`. |
| `POST /_cdkl/microvm/suspend` | Calls `/suspend`, then pauses the container. |
| `POST /_cdkl/microvm/resume` | Unpauses the container, then calls `/resume`; traffic flows once it answers `200`. |
| `POST /_cdkl/microvm/terminate` | Calls `/terminate` and removes the container. Terminating the last MicroVM ends the command with exit `0`. |

An action the current state does not allow answers `409`, and a hook failure
`502`. While a MicroVM is suspending, suspended or resuming, its requests get
`503`. A failed `/resume` leaves it suspended; a failed `/terminate` is
reported and the container is removed anyway.

### The `403` guard

The control path answers only requests addressed to this URL, so a web page
open in your browser cannot drive it. Anything else gets `403`:

- `Host` must carry this URL's port and an allowed name. Under `--host
  0.0.0.0` or `::`, any IP literal or loopback name is allowed; under a
  loopback bind, the loopback names; under any other bind, only that host.
- `Origin`, when present, must be `http://<that Host>`, so `Origin: null` is
  refused.
- `Sec-Fetch-Site`, when present, must be `same-origin` or `none`.

Requests to the app itself are not checked.

## `--count` and `--auto-resume`

`--count <n>` runs `n` independent MicroVMs from one build, each with its own
`microvmId`, its own `/run` call and its own URL: the first on `--port`, the
next on `--port` + 1, and so on. With more than one, each container's output
is prefixed with its MicroVM ID.

`--auto-resume` is the idle policy's `autoResumeEnabled`. A request to a
suspended MicroVM is held instead of answered `503`, and every held request
shares ONE resume. A held request gets `502` when the resume fails.

## What is not emulated

cdkd warns once at startup about each of these; none of them fails the run.

| In the cloud | Locally |
| --- | --- |
| A MicroVM restored from the image snapshot | A fresh container: state the app sets up before `/ready` answers is not shared across MicroVMs. |
| VM isolation | Docker container isolation. |
| Suspend checkpoints memory | Suspend freezes the processes in place. |
| `/validate` on a fresh MicroVM from the snapshot | `/validate` on the same container as `/ready`. |
| `X-aws-proxy-auth` token check | Requests are accepted without it. |
| Idle policy and `maximumDurationInSeconds` | Not emulated. |
| `BaseImageArn` (the managed base OS) | Always warned; the build runs on your Docker engine. |
| `BaseImageVersion`, `EgressNetworkConnectors`, `AdditionalOsCapabilities`, `Resources`, `Logging` | Warned when set. |

## Environment and credentials

The image's `EnvironmentVariables` reach every container. `--env-vars`
overrides them. `--from-state` reads cdkd's S3 state for the stack and
replaces the `Ref`, `Fn::GetAtt`, `Fn::Sub`, `Fn::ImportValue` and
`Fn::GetStackOutput` references in them with the deployed values.
`--from-cfn-stack`, for a stack deployed with the AWS CDK CLI, resolves only
`Ref` and `Fn::ImportValue` there. The two flags are mutually exclusive.
[What each flag can resolve](local-emulation-value-resolution.md#what-each-flag-can-resolve)
compares them.

The containers get your own AWS credentials. The execution role is a
parameter of running a MicroVM, not part of the template, so `--assume-role`
takes the role's ARN explicitly; there is no form that reads it from state.

> [!NOTE]
> Under `--role-arn`, the containers and what cdkd resolves for them use your
> own identity, not the role. See
> [Credentials and --role-arn](cli-reference-credentials.md#role-arn-with-cdkd-local).

## Stopping

{kbd:ctrl+c} or `SIGTERM` calls `/terminate` on every running MicroVM, then
removes the containers. A second signal while the containers are being
removed is ignored, except while a container's `docker run` is still in
flight: then cdkd exits at once, with `130` for {kbd:ctrl+c} and `143` for
`SIGTERM`, and prints the `docker rm -f` command for the container it may
leave behind. A container that exits on its own ends the command with
an error quoting its last output.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Stopped by `SIGTERM`, or every MicroVM was terminated through the control endpoint. |
| `1` | An error. |
| `130` | Stopped by {kbd:ctrl+c}, or the picker was cancelled. |
| `143` | A second `SIGTERM` while a `docker run` was still in flight. |

An error here is a target that does not exist, a synthesis failure, code that
is not a staged asset, a build failure, a hook that failed or timed out, or a
container that exited while running.

The [CLI Reference](cli-reference.md) has the exit-code table for every
command.

## Related

- [`cdkd local start-web-function`](local-start-web-function.md): serve a
  Lambda Web Function locally
- [`cdkd local start-service`](local-start-service.md): run ECS services
  locally
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
