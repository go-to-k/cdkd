---
title: Develop Locally with AWS Emulator
description: "Deploy a CDK app into AWS Emulator with cdkd, then run its functions and APIs locally under the official Lambda images, without real AWS credentials and without redeploying on each code edit."
---

# Develop Locally with AWS Emulator

[AWS Emulator](https://github.com/aws/aws-emulator) runs the AWS APIs on your
own machine. cdkd deploys your CDK app into it, and `cdkd local` runs that
app's functions and APIs against what you deployed. One flag,
`--aws-emulator`, sets up every command, so the whole loop runs without real
AWS credentials, shell variables or a redeploy per code edit.

Think of `--aws-emulator` as the switch for the target environment. With it,
the deploy, the state that `--from-state` reads and the calls your code makes
at run time all move to the emulator together. Without it, all three stay on
real AWS.

This page walks through that loop, what each tool contributes, and the
practical details of running the two together. The flag reference is in
[Local Execution](local-emulation.md#aws-emulator).

## The loop

::: steps
1. Start the emulator

   It listens on `https://127.0.0.1:9297` by default and writes its keys,
   certificate and `config` to `~/.aws/emulator/9297/`. See
   [Run the emulator](#run-the-emulator) for Docker and Linux.

   ```bash
   aws-emulator
   ```

2. Deploy your stack

   Resources and file assets go to the emulator. There is no separate
   bootstrap step: on an emulator with no cdkd state bucket, `cdkd deploy`
   creates the state bucket, then the asset storage for each stack's region,
   without a prompt and with an info line for each. `cdkd import` creates the
   state bucket the same way. A restarted emulator starts empty, so the next
   deploy bootstraps it again. An explicit `cdkd bootstrap --aws-emulator`
   still works, but you do not need it; see
   [Bootstrap in AWS Emulator](cli-bootstrap.md#bootstrap-in-aws-emulator).

   ```bash
   cdkd deploy MyStack --aws-emulator
   ```

3. Run your code locally against what you deployed

   `--from-state` reads the deployed names (table, bucket, queue) from cdkd's
   state in the emulator and passes them to the container as environment
   variables. The handler's own AWS calls also go to the emulator.

   ```bash
   cdkd local invoke MyStack/Handler --from-state --aws-emulator --event event.json
   cdkd local start-api --from-state --aws-emulator --watch --port 3000
   ```

4. Edit, and run again

   `cdkd local` reads your app's current code each time it runs, and
   `start-api --watch` reloads on a save. You redeploy only when the
   infrastructure changes.

5. Clean up

   Stopping the emulator also discards everything in it, because it keeps
   its resources in memory.

   ```bash
   cdkd destroy MyStack --aws-emulator
   ```
:::

Put `--aws-emulator` after the command's target. The URL is optional, so a
word right after the flag is read as the URL: `--aws-emulator MyStack/Handler`
is refused, because `MyStack/Handler` is not an `http(s)` URL. The error says
to put the flag after the target, or to write `--aws-emulator=<url>`.

### `CDKD_AWS_EMULATOR`

To avoid typing the flag, set `CDKD_AWS_EMULATOR=1`, or the emulator's URL.
Every cdkd command then behaves as if `--aws-emulator` were given:

```bash
export CDKD_AWS_EMULATOR=1
cdkd deploy MyStack
cdkd local invoke MyStack/Handler --from-state
```

> [!WARNING]
> `CDKD_AWS_EMULATOR` applies to every command, not just `cdkd local`. In a
> shell that exports it, `cdkd deploy` deploys into the emulator too. Set it
> per command (`CDKD_AWS_EMULATOR=1 cdkd local ...`), or unset it before you
> deploy to a real account.

## Emulator alone, or with cdkd

AWS Emulator runs deployed Lambda functions and serves deployed REST APIs on
its own. It executes the code with runtimes embedded in the emulator, not the
official AWS Lambda images, and needs no Docker. That makes "deploy, then send
the emulator requests" a complete loop, and cdkd's deploy is the fast way into
it.

`cdkd local` runs the same functions differently:

| | AWS Emulator alone | `cdkd local --aws-emulator` |
| --- | --- | --- |
| Runtime | Embedded in the emulator binary, not the declared language version | The official AWS Lambda image for the declared runtime |
| Native dependencies and layers | Not the Lambda environment | As in Lambda |
| Container-image functions, ECS, ALB, CloudFront, AgentCore | Not run: the emulator has no container runtime | Run locally |
| A code edit | Needs a redeploy | Picked up on the next run, or on save with `--watch` |
| Debugger | — | `--debug-port` on `local invoke`, `--debug-port-base` on `start-api` (Node.js) |
| Function logs | — | In your terminal |

The two do not compete: both talk to the same emulated DynamoDB, S3, SQS and
the rest. Use the emulator's own execution for a quick end-to-end request, and
`cdkd local` when the handler has to behave as it will on Lambda, or when you
are iterating on it.

### Compared with the AWS CDK CLI

The AWS CDK CLI deploys into AWS Emulator too, but it needs the shell set up
first, as the emulator's
[SDK guide](https://docs.aws.amazon.com/emulator/latest/userguide/point-sdk-to-emulator.html)
describes: `AWS_ENDPOINT_URL`, `AWS_CONFIG_FILE` and
`AWS_SHARED_CREDENTIALS_FILE` pointing at the run's files, `NODE_EXTRA_CA_CERTS`
for the certificate, and your real credentials unset. Forget one in a new
terminal, and the deploy goes to real AWS or is rejected.

cdkd needs none of it. `--aws-emulator` reads the run directory for the port
in the URL, trusts its `ca.pem`, signs with its keys and sets its region, for
that one command. Against the emulator, cdkd also polls Cloud Control every
100 ms instead of using the backoff tuned for real AWS, because the emulator
finishes operations quickly.

## A stack deployed with `cdk deploy`

If you deploy into the emulator with the AWS CDK CLI, `cdkd local` reads the
deployed names from the emulator's CloudFormation instead of cdkd's state:

```bash
cdkd local invoke MyStack/Handler --from-cfn-stack --aws-emulator
cdkd local start-api --from-cfn-stack --aws-emulator --port 3000
```

So you can keep `cdk deploy` for deploying and still use `cdkd local` to run
the code.

## Where a value comes from, and where a call goes

Two flags decide what a local run does, and they answer different questions.
Take a table, a function that receives the table's name, and one line of the
handler:

```ts
const table = new dynamodb.Table(this, 'MyTable', {
  partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
});
const handler = new lambda.Function(this, 'Handler', {
  // ...
  environment: { TABLE_NAME: table.tableName }, // synthesizes to { Ref: MyTable }
});
table.grantWriteData(handler);
```

```ts
await ddb.send(new PutItemCommand({ TableName: process.env.TABLE_NAME, Item: item }));
```

1. **Where does `TABLE_NAME` come from?** In the template it is
   `{ Ref: MyTable }`, not a name. `--from-state` replaces it with the table
   name recorded when you deployed the stack. Without it, cdkd cannot know the
   name.
2. **Where does the PutItem request go?** `--aws-emulator` sends it to the
   emulator. Without the flag it goes to real AWS.

| | Without `--from-state` | With `--from-state` |
| --- | --- | --- |
| Without `--aws-emulator` | `TABLE_NAME` is dropped with a warning naming it; PutItem goes to real AWS with no table name and fails. | `TABLE_NAME` is the real table's name (from `cdkd deploy MyStack`); PutItem writes to it in real AWS. |
| With `--aws-emulator` | `TABLE_NAME` is dropped, and one hint names `--from-state`, `--from-cfn-stack` and `--env-vars`; PutItem goes to the emulator with no table name and fails. | `TABLE_NAME` is the emulator's table name (from `cdkd deploy MyStack --aws-emulator`); PutItem writes to it in the emulator. |

`--from-cfn-stack` fills the same table from the CloudFormation stack instead
of cdkd's state. A value you give `TABLE_NAME` in `--env-vars` wins in every
cell. With a `"real-aws"` exception for DynamoDB (see
[Mixed mode](#mixed-mode)), the bottom-right cell uses the real table's name
and writes to real AWS, while every other service stays on the emulator.

The same table, with the per-command details, is in
[Where a value comes from, and where a call goes](local-emulation.md#where-a-value-comes-from-and-where-a-call-goes).

## Real credentials stay out by default

Under `--aws-emulator`, with no `"real-aws"` exception, the emulator's
identity is the only one cdkd uses:

- Every AWS call cdkd makes goes to the emulator, signed with the emulator's
  keys.
- `--profile`, `--role-arn`, `CDKD_ROLE_ARN`, `AWS_PROFILE`, the
  `AWS_ACCESS_KEY_ID` triple and any `AWS_ENDPOINT_URL*` in your shell are
  ignored. A `cdkd local` command keeps its `--role-arn` / `CDKD_ROLE_ARN`
  hop, which the emulator's STS answers.
- cdkd's own process environment names the emulator's endpoint and run files,
  so a client that missed the override has no real credentials to fall back
  to.
- Containers started by `cdkd local` get the emulator's keys and nothing else.
  A handler that misses the endpoint fails with a credential error rather than
  reaching your account.

cdkd prints one line naming what it ignored, never the values:

```text
--aws-emulator: ignoring --profile, AWS_PROFILE, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; every AWS call uses the emulator's keys.
```

You can therefore keep your usual profile exported while you work against the
emulator. The one exception is [mixed mode](#mixed-mode), which you turn on
by marking a service `"real-aws"`.

## Mixed mode

Sometimes a service has to stay on real AWS while everything else runs in the
emulator: Bedrock for an AI agent, since the emulator cannot run real models,
or a real secret your handler reads while its writes stay local. Keep
`--aws-emulator`, which sends every service to the emulator, and mark each
exception in the `--env-vars` file by setting its `AWS_ENDPOINT_URL_<SERVICE>`
to `"real-aws"`:

```json
{
  "Parameters": {
    "AWS_ENDPOINT_URL_SECRETS_MANAGER": "real-aws",
    "AWS_ENDPOINT_URL_BEDROCK_RUNTIME": "real-aws"
  }
}
```

```bash
cdkd local invoke MyStack/Handler --from-state --env-vars env.json --aws-emulator
```

`Parameters` applies to every workload; a section named by a function's
logical ID or CDK path (or an ECS container name) applies to that workload
only. A service you do not mark stays on the emulator, so a forgotten entry
fails closed: the call reaches the emulator, never your real account.

Once a workload has an exception, its container holds your real identity.
Every other call goes through a sidecar that signs it
again with the emulator's keys, so no real-key signature reaches the emulator.

### Deploy to both sides first

With an exception and `--from-state`, the names come from two copies of the
stack: the excepted services' resources from the real copy, everything else
from the emulator's. Deploy the same stack, with the same stack name and CDK
context, to both sides:

```bash
cdkd deploy MyStack --aws-emulator    # the emulator copy
cdkd deploy MyStack                   # the real copy, for the excepted services
```

With `--from-cfn-stack`, deploy the real copy with `cdk deploy`. When a copy
is missing, a warning says so:

| Missing copy | What happens |
| --- | --- |
| The emulator's | The warning names the resources whose names could not be resolved. |
| The real one | The warning names the excepted services; their resources keep the emulator's names. |

When the real copy is missing, calls to an excepted service reach real AWS
with the emulator's names. Deploy the real copy too, or set those names with
`--env-vars`.

### One env.json, with and without the flag

A `"real-aws"` value does nothing without `--aws-emulator`: without the flag
everything already goes to real AWS. So you can keep one `env.json` and add or
drop the flag.

| `AWS_ENDPOINT_URL*` value in `--env-vars` | What happens |
| --- | --- |
| `"real-aws"` on `AWS_ENDPOINT_URL_<SERVICE>` | Under the flag, that service goes to real AWS. Without it, a no-op. |
| A literal URL on `AWS_ENDPOINT_URL_<SERVICE>` | Passed as it is and never signed again; with an exception, your real identity signs it. |
| `"real-aws"` on the bare `AWS_ENDPOINT_URL` | Refused under the flag: to send everything to real AWS, drop `--aws-emulator`. |
| `"aws-emulator"` | Refused, with how to rewrite it as `"real-aws"` exceptions. |
| A name the SDKs never read (`AWS_ENDPOINT_URL_SECRETSMANAGER`) | Refused, naming the SDK spelling (`AWS_ENDPOINT_URL_SECRETS_MANAGER`). |

### cdkd's own calls follow the exceptions

What cdkd fetches for a workload before it starts follows that workload's
exceptions too:

| cdkd's call | Goes to real AWS when the workload excepts |
| --- | --- |
| `{{resolve:secretsmanager:...}}` | `SECRETS_MANAGER` |
| `{{resolve:ssm:...}}`, `{{resolve:ssm-secure:...}}` | `SSM` |
| ECS task `Secrets` on `local run-task` | The service in the secret's ARN |
| The ECR login and pull of a deployed image | `ECR` |
| An AgentCore `fromS3` code bundle | `S3` |
| A literal layer ARN | `LAMBDA` |

So an image that exists only in real ECR runs with `ECR` excepted for that
workload, while the image's own calls stay on the emulator.

The full rules, including credentials, signing and limits, are in
[AWS Emulator mixed mode](local-emulation.md#aws-emulator-mixed-mode).

## Run the emulator

### macOS and Windows: Docker

AWS Emulator is published as a Linux package, so on macOS and Windows you run
it in a container. There is no prebuilt image: build one from the Dockerfile
in the emulator's
[Getting started with Docker](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html)
guide. Its entry point binds `0.0.0.0` inside the container. Publish the port
on `127.0.0.1` only, and mount the run directory, so cdkd finds the keys and
certificate at the usual path. On macOS:

```bash
PORT=9297
mkdir -p ~/.aws/emulator
docker run --rm --memory=2g --memory-swap=2g -p 127.0.0.1:$PORT:$PORT \
  -e HOME="$HOME" -v "$HOME/.aws/emulator:$HOME/.aws/emulator" \
  aws-emulator -p $PORT
```

Use `-p 127.0.0.1:9297:9297`, not `-p 9297:9297`: the short form opens the
emulator to your whole network. On Windows, use the PowerShell command from
the same guide, which mounts `$env:USERPROFILE\.aws\emulator`.

### Linux

A native install listens on `127.0.0.1` by default, which serves cdkd's own
calls. A `cdkd local` container reaches the emulator through a forwarder that
connects to the host from the Docker network, and a process listens on one
address only, so it cannot serve both your machine and the containers.

To use `cdkd local` on Linux, run the emulator in Docker instead (the image
built in [macOS and Windows: Docker](#macos-and-windows-docker)), and
publish the port on `127.0.0.1` and on the Docker bridge gateway:

```bash
mkdir -p ~/.aws/emulator
docker run --rm --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:9297:9297 -p 172.17.0.1:9297:9297 \
  -e HOME="$HOME" -v "$HOME/.aws/emulator:$HOME/.aws/emulator" \
  aws-emulator -p 9297
```

`172.17.0.1` is Docker's default bridge gateway; when cdkd cannot reach the
emulator, its error names the address it detected. Do not bind the emulator
to `0.0.0.0` on the host itself: that opens it to your network.

## Practical details

| Topic | What to know |
| --- | --- |
| TLS | cdkd and every container trust the run's `ca.pem`, so certificate verification stays on. There is no `-k` or verify-off switch. |
| S3 addressing | Keep the URL on `127.0.0.1`. cdkd rewrites `localhost` to it, and inside containers the URL stays loopback, so S3 stays path-style. |
| `--auth off` | When the emulator runs without authentication, there is no `emulator_credentials` file. cdkd notices, and containers get fixed placeholder keys. |
| Several emulators | Run each on its own port and pass its URL: `--aws-emulator https://127.0.0.1:9300`. The port selects `~/.aws/emulator/<port>/`. |
| Region | `--region`, `AWS_REGION` or `AWS_DEFAULT_REGION` when set, else the region in the run's `config` (`us-east-1`). Each emulator serves one region. |
| SQS queue URLs | The emulator's queue URLs are rewritten so SQS calls stay local; see the note below. |
| Docker image assets | Refused before anything is built. The emulator's ECR returns repository URIs on the real `amazonaws.com` registry, so a push would leave your machine. File assets publish normally. |
| Other emulators | `--aws-emulator` is specific to AWS Emulator. For LocalStack and the like, `cdkd local` forwards your `AWS_ENDPOINT_URL*` variables and `--ca-bundle`; see [Local AWS endpoints](local-emulation.md#local-aws-endpoints). |

The emulator answers with real-shaped queue URLs, and the AWS SDK for
JavaScript v3 sends SQS requests to the queue URL's host. A sidecar rewrites
those URLs in the emulator's answers: with an `https` emulator URL whose run
wrote `ca.pem`, and always in mixed mode. On the host network no sidecar
runs. A queue URL that reaches the handler as an environment variable
(`--from-state`, `--from-cfn-stack`, `--env-vars`) is not rewritten: pass
`useQueueUrlAsEndpoint: false` to that `SQSClient`.

In a Docker container, mind the port: it must be the same on both sides of
Docker's `-p` and in the emulator's own `-p`, because the emulator writes its
port into the run files. Do not use the emulator's `-p 0` in a container.

### Calling a deployed API Gateway API

A stack output such as
`https://<api-id>.execute-api.<region>.amazonaws.com/prod/` names the real
AWS host, so a request to it leaves your machine. The emulator serves the
API on its own endpoint and picks the API by the `Host` header. Send the
request to `127.0.0.1` and put the API's host name in `Host`:

```bash
curl --cacert ~/.aws/emulator/9297/ca.pem \
  -H 'Host: <api-id>.execute-api.<region>.amazonaws.com' \
  https://127.0.0.1:9297/prod/<path>
```

Do not use `--connect-to` or `--resolve` to send the real host name to
`127.0.0.1`. The emulator's certificate covers only `localhost` and
`127.0.0.1`, so TLS verification fails. A browser cannot set `Host`, so a
web page cannot call the API this way. To serve the API to a browser, run
it with
[`cdkd local start-api --aws-emulator`](local-start-api.md) instead.

## Custom resources run on your machine

The emulator's own Lambda runtimes miss parts of the standard library, which
breaks the provider functions of common constructs such as
`autoDeleteObjects: true` and `s3deploy.BucketDeployment`. So under
`--aws-emulator`, `cdkd deploy`, `cdkd destroy`, `cdkd state destroy` and
`cdkd rollback` run the function a custom resource's `ServiceToken` points at
in the official AWS Lambda runtime image, in Docker, the way
`cdkd local invoke` does. The function still exists in the emulator; only the
custom resource event runs on your machine.

| Topic | What to know |
| --- | --- |
| Requirement | Docker. Without it, cdkd prints one warning and sends the event to the emulator as before. |
| Code | Read from the synthesized cloud assembly, together with the handler, runtime and layers. A command that does not synthesize (`cdkd state destroy`, `cdkd rollback`, or a destroy without the app) cannot find it and sends the event to the emulator, with a warning. |
| Configuration | Environment variables, timeout and memory are the deployed function's. A destroy or rollback after the app changed runs the code of the app as it is now with the configuration that was deployed. |
| Runtime image | Used from the local Docker cache, else pulled once per run. When it cannot be pulled, cdkd prints one warning and sends the event to the emulator. |
| Identity | The container gets the emulator's keys, endpoint and CA only, like a `cdkd local` container. |
| Response | CDK's Node.js handlers send the response to port 443 whatever the URL says, so with an emulator on `127.0.0.1` the container gets a response URL signed for port 443 and forwards that port to the emulator. An emulator on another host keeps the URL as signed. |
| Provider framework | A `cr.Provider`'s handlers run locally too. The framework function calls your `onEventHandler` and `isCompleteHandler` through `lambda:Invoke`, and with `isCompleteHandler` it starts a Step Functions waiter. Each container cdkd starts gets a local endpoint as its Lambda and Step Functions endpoint (`AWS_ENDPOINT_URL_LAMBDA`, `AWS_ENDPOINT_URL_SFN`). A synchronous invoke of a function that the calling function's environment names with `Fn::GetAtt` or `Ref` in the same stack runs that function locally, with the rules above. The waiter state machine runs locally when it has the shape CDK synthesizes (Lambda `Task` states with `Retry` and `Catch`), each task in the runtime image. Every other call goes to the emulator: other functions, asynchronous or version-qualified invokes, other state machines, and every other Lambda or Step Functions API. |
| Local endpoint | Listens on `127.0.0.1` only (on Linux also on the Docker bridge gateway, which is where containers reach the host). A request must carry the container's token in its URL and be signed with the emulator's keys. A call it does not run locally is signed again with the emulator's keys and sent to the emulator, never anywhere else. |
| Opt out | `--no-local-custom-resources` sends every event to the emulator's own runtime. |

## Troubleshooting

### `no AWS Emulator answers its health check`

Before anything else, cdkd checks the emulator's `/__admin/health` endpoint.
When nothing answers, the command stops with:

```text
--aws-emulator https://127.0.0.1:9297: no AWS Emulator answers its health check at https://127.0.0.1:9297/__admin/health (...). Check that it is running on port 9297 (`aws-emulator -p 9297`, or its Docker image published with `-p 127.0.0.1:9297:9297`), that the URL's port matches, and that it listens on an address this machine reaches (`-b`).
```

Check, in order:

- The emulator is running, and its startup line shows the port you passed.
- The port in `--aws-emulator` (or `CDKD_AWS_EMULATOR`) is the emulator's
  port. Without a URL, cdkd uses `9297`.
- In Docker, the port is published on `127.0.0.1`, and the run directory is
  mounted so `~/.aws/emulator/<port>/` exists on your machine.

### `containers cannot reach port ... on the host`

cdkd itself reached the emulator, but a `cdkd local` container could not. On
Linux this is the bind issue in [Linux](#linux): publish the port on the
Docker bridge gateway as well. On Docker Desktop, publish it on the host's
`127.0.0.1`.

### A REST API's resources fail to deploy

cdkd creates `AWS::ApiGateway::RestApi` through its own SDK provider, which
works on AWS Emulator. A REST API whose record was created through Cloud
Control in the emulator holds the identifier the emulator's Cloud Control
returned, which is not the API id, so its resources and methods fail. Destroy
that stack and deploy it again once.

Changed in v0.343.0: cdkd creates REST APIs through the SDK provider. A REST
API deployed into the emulator by an earlier release went through Cloud
Control.

### A large single upload fails

AWS Emulator (as of 1.0.322) refuses a single `PutObject` of 16 MiB or more: the request fails
with HTTP 413 or a reset connection. cdkd uploads a file asset larger than
5 MiB as a multipart upload, so asset publishing is not affected. A tool or
handler that sends one large `PutObject` is; use a multipart upload, such as
the SDKs' managed uploaders.

### A Python function fails with `No module named '_signal'`

A Python function that the emulator runs itself, in its embedded runtime, can
fail with `No module named '_signal'`. This is a limit of the emulator's
runtime, reported in the
[AWS Emulator issue tracker](https://github.com/aws/aws-emulator/issues).

A custom resource's provider function is not affected: cdkd runs it in the
official Lambda runtime image (see
[Custom resources run on your machine](#custom-resources-run-on-your-machine)),
so `s3deploy.BucketDeployment` (`Custom::CDKBucketDeployment`) deploys. When
you see this error from a custom resource, cdkd printed a warning naming why it
sent the event to the emulator:

- Docker is not running: start it.
- You passed `--no-local-custom-resources`: drop it.
- The command did not read the app, or the function is not in it (the
  `ServiceToken` is not a `Fn::GetAtt` of a function in the same template).
  For `cdkd state destroy` or a destroy without the app, run
  `cdkd destroy --aws-emulator` from the app's directory instead. `cdkd rollback`
  never reads the app; its custom resource events stay in the emulator.

Run a function of your own through `cdkd local invoke`, which uses the same
image, instead of invoking it in the emulator.

### A Node.js function fails with `Cannot find module 'https'`

The emulator's embedded Node.js runtime does not provide every Node built-in
module. `https` is one of those missing, on `nodejs20.x`, `nodejs22.x` and
`nodejs24.x` alike, and a function that loads one fails with
`Runtime.ImportModuleError: Error: Cannot find module 'https'`. This is a
limit of the emulator's runtime, reported in the
[AWS Emulator issue tracker](https://github.com/aws/aws-emulator/issues).

CDK's Node.js custom resources send their response over `https`, but cdkd runs
their provider functions in the official Lambda runtime image (see
[Custom resources run on your machine](#custom-resources-run-on-your-machine)),
so `new s3.Bucket(..., { autoDeleteObjects: true })`
(`Custom::S3AutoDeleteObjects`) deploys and empties its bucket on destroy. When
you see this error from a custom resource, the causes and remedies are the
three in
[A Python function fails with `No module named '_signal'`](#a-python-function-fails-with-no-module-named-signal).
Run a function of your own through `cdkd local invoke` instead of invoking it
in the emulator.

### A Docker image asset is refused

```text
--aws-emulator: Docker image asset ... cannot be published to AWS Emulator
```

A stack with a Docker image asset cannot be deployed into the emulator. Keep
container-image functions and ECS tasks in a stack you do not deploy there:
`cdkd local` builds their images on your machine, and runs them without a
deploy.

## Related

- [Local Execution](local-emulation.md): every `cdkd local` command, and the
  `--aws-emulator` reference.
- [`cdkd local invoke`](local-invoke.md) and
  [`cdkd local start-api`](local-start-api.md).
- [Credentials and --role-arn](cli-reference-credentials.md).
- AWS Emulator user guide:
  [Pointing your AWS SDK at AWS Emulator](https://docs.aws.amazon.com/emulator/latest/userguide/point-sdk-to-emulator.html),
  [Command reference](https://docs.aws.amazon.com/emulator/latest/userguide/cli-reference.html).
