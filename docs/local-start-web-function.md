---
title: cdkd local start-web-function
description: "Serve an AWS Lambda Web Function from your CDK app on a local port: one revision's code bundle runs in a container with its own HTTP server."
---

# cdkd local start-web-function

`cdkd local start-web-function [target]` serves an AWS Lambda Web Function
from your CDK app on a local port until you press {kbd:ctrl+c}. It picks one
revision of the function, runs that revision's code bundle in a container, and
publishes the port the bundle's HTTP server listens on.

```bash
# serve the revision the endpoint routes the most traffic to
cdkd local start-web-function MyStack/Endpoint --port 8080

# serve one revision, whatever the weights say
cdkd local start-web-function MyStack/WebFn --revision RevV2

# pick a web function from a list
cdkd local start-web-function

# deployed values in the environment, run as the execution role
cdkd local start-web-function MyStack/Endpoint --from-state --assume-role
```

Docker is required. [Local Execution](local-emulation.md) lists the
requirements.

## Serve a web function

Given a web function with one revision built from the directory `web/`:

```ts
import * as path from 'node:path';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import {
  CfnWebFunction,
  CfnWebFunctionEndpoint,
  CfnWebFunctionRevision,
} from 'aws-cdk-lib/aws-lambda';

const code = new s3assets.Asset(this, 'Code', {
  path: path.join(__dirname, '../web'),
});
const role = new iam.Role(this, 'Role', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});
const fn = new CfnWebFunction(this, 'WebFn', { functionName: 'my-web-fn' });
const rev = new CfnWebFunctionRevision(this, 'RevV1', {
  functionName: fn.ref,
  buildConfig: {
    codeConfig: {
      s3Object: { bucket: code.s3BucketName, key: code.s3ObjectKey },
    },
    runtimeConfig: { runtime: 'nodejs24.x' },
  },
  serviceConfig: {
    executionRoleArn: role.roleArn,
    environmentVariables: { GREETING: 'hello' },
  },
});
new CfnWebFunctionEndpoint(this, 'Endpoint', {
  functionName: fn.ref,
  endpointName: 'main',
  revisionWeights: [{ revisionId: rev.attrRevisionId, weight: 100 }],
});
```

serve it and call it from another terminal:

```bash
cdkd local start-web-function MyStack/Endpoint --port 8080
curl http://127.0.0.1:8080/hello
```

cdkd synthesizes the app, starts the container, waits until the server answers
HTTP, and prints the address:

```text
Server listening on http://127.0.0.1:8080  (my-web-fn (Lambda web function))
```

Nothing is deployed. The code comes from the asset staged in `cdk.out`.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | picker | The `WebFunction`, `WebFunctionEndpoint` or `WebFunctionRevision` to serve. |
| `--revision <logicalId>` | — | Serve this revision instead of the one the endpoint weights pick. |
| `--port <n>` | `0` (auto) | Local port to serve on. |
| `--host <ip>` | `127.0.0.1` | Address the port is published on. |
| `--platform <platform>` | the runtime's architecture | `linux/amd64` or `linux/arm64`. |
| `--env-vars <file>` | — | JSON environment overrides, keyed by the revision's logical ID. |
| `--no-pull` | off | Skip `docker pull` of the runtime base image. |
| `--timeout <ms>` | `60000` | How long the server has to answer HTTP. |
| `--assume-role [arn]` | off | Run the container under an execution role. |
| `--no-assume-role` | — | Explicitly keep your own credentials. |
| `--from-state` | off | Resolve the revision's environment from cdkd's S3 state. |
| `--from-cfn-stack [name]` | off | Resolve it from a deployed CloudFormation stack. |

The command also accepts the common flags listed in
[Local Execution](local-emulation.md), except `--container-host`: here
`--host` sets the address the one published port binds to.

## Target resolution and revision selection

The target is written as a CDK display path (`MyStack/Endpoint`) or a
stack-qualified logical ID (`MyStack:Endpoint`); an app with one stack may
omit the stack. With no target in an interactive terminal, cdkd lists the
web functions in the app and you choose one.

Whatever you target, one revision is served, chosen in this order:

| Order | Revision served |
| --- | --- |
| 1 | The revision named by `--revision`, which must belong to the target's function |
| 2 | The target itself, when it is a `WebFunctionRevision` |
| 3 | The highest-weight revision of the targeted `WebFunctionEndpoint` |
| 4 | The function's only revision |
| 5 | For a function with two or more revisions, the highest-weight revision of its only endpoint |

When none applies, for example a function with two revisions and no single
endpoint, the command stops and lists the revisions to pass to `--revision`.
The startup line names which rule chose the revision.

## The runtime contract

The revision's code runs in the AWS Lambda base image for its runtime, with
the bundle mounted read-only at `/var/task`. Your code is the server: there is
no handler and no Runtime Interface Emulator.

| Variable | Value in the container |
| --- | --- |
| `AWS_LAMBDA_HTTP_ENDPOINT` | `0.0.0.0:8080`. Listen on this address; the local port is published to it. |
| `AWS_LAMBDA_NODEJS_ENTRYPOINT` | The entry file, relative to the bundle root. Default `index.js`. |
| `AWS_LAMBDA_FUNCTION_NAME` | The function's name. |
| `AWS_LAMBDA_LOG_GROUP_NAME` | The revision's log group, or `/aws/lambda/<function name>`. |
| `AWS_LAMBDA_FUNCTION_TIMEOUT` | The revision's `ServiceConfig` timeout, when it sets one. |

The revision's `ServiceConfig.EnvironmentVariables` are set as well, plus your
AWS credentials. A value your revision sets for `AWS_LAMBDA_HTTP_ENDPOINT` is
replaced, with a warning.

Supported runtimes:

| Runtime | Base image | Default platform |
| --- | --- | --- |
| `nodejs24.x` | `public.ecr.aws/lambda/nodejs:24` | `linux/arm64` |

The code must come from a CDK asset in this app, a directory or a `.zip`
file, so that its bundle is staged in `cdk.out`. cdkd does not download
deployed code.

The container's output is streamed to your terminal. When the server exits
while serving, the command stops with an error quoting the container's last
output.

## What is not emulated

cdkd warns at startup about each of these that your app uses. The endpoint
rows apply only when an endpoint was resolved: the target is one, or rule 5
above picked the function's only endpoint.

| Feature | Locally |
| --- | --- |
| Weighted routing across revisions | Every request goes to the one revision served. |
| An endpoint `AuthType` other than `ApplicationManaged` | Not enforced; every request reaches the server. |
| An `EndpointType` other than `HomeRegion` | One endpoint on one local port. |
| `ServiceConfig.EgressNetworkConnectorArn` | Not emulated; the container uses Docker's default network. |
| `ServiceConfig.EnvironmentVariables` written as an intrinsic | None of its variables reach the container; use `--env-vars`. |

## State sources and the execution role

`--from-state` reads cdkd's S3 state for the stack and replaces the `Ref`,
`Fn::GetAtt`, `Fn::Sub`, `Fn::ImportValue` and `Fn::GetStackOutput`
references in the revision's environment with the deployed values.
`--from-cfn-stack`, for a stack deployed with the AWS CDK CLI, resolves only
`Ref` and `Fn::ImportValue` there: an `Fn::GetAtt` is not resolved. The two
flags are mutually exclusive.
[What each flag can resolve](local-emulation-value-resolution.md#what-each-flag-can-resolve)
compares them.

By default the container gets your own credentials. `--assume-role` runs it
under a role instead:

- `--assume-role <arn>` assumes that role.
- A bare `--assume-role` uses the revision's
  `ServiceConfig.ExecutionRoleArn`. A literal ARN is used as written. The
  `Fn::GetAtt` CDK synthesizes for a role in the app is resolved against the
  deployed state, so pass `--from-state` or `--from-cfn-stack` with it.
- `--no-assume-role` keeps your own credentials and silences the hint that
  suggests `--assume-role` when deployed state is loaded.

```bash
cdkd local start-web-function MyStack/Endpoint --from-state --assume-role
```

> [!NOTE]
> Under `--role-arn`, the container and what cdkd resolves for it use your own
> identity, not the role. See
> [Credentials and --role-arn](cli-reference-credentials.md#role-arn-with-cdkd-local).

## Stopping

{kbd:ctrl+c} or `SIGTERM` removes the container and exits.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Stopped by `SIGTERM`. |
| `1` | An error. |
| `130` | Stopped by {kbd:ctrl+c}, or the picker was cancelled. |

An error here is a target that does not exist, a synthesis failure, an
unsupported runtime, code that is not a staged asset, an entry file missing
from the bundle, a server that did not answer within `--timeout`, or a server
that exited while serving.

The [CLI Reference](cli-reference.md) has the exit-code table for every
command.

## Related

- [`cdkd local start-api`](local-start-api.md): serve API Gateway APIs and
  Function URLs backed by ordinary Lambda functions
- [`cdkd local invoke`](local-invoke.md): run a Lambda function once
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
