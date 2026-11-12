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

2. Bootstrap cdkd's storage in it

   This creates cdkd's state bucket and asset storage in the emulator.

   ```bash
   cdkd bootstrap --aws-emulator
   ```

3. Deploy your stack

   Resources and file assets go to the emulator.

   ```bash
   cdkd deploy MyStack --aws-emulator
   ```

4. Run your code locally against what you deployed

   `--from-state` reads the deployed names (table, bucket, queue) from cdkd's
   state in the emulator and passes them to the container as environment
   variables. The handler's own AWS calls also go to the emulator.

   ```bash
   cdkd local invoke MyStack/Handler --from-state --aws-emulator --event event.json
   cdkd local start-api --from-state --aws-emulator --watch --port 3000
   ```

5. Edit, and run again

   `cdkd local` reads your app's current code each time it runs, and
   `start-api --watch` reloads on a save. You redeploy only when the
   infrastructure changes.

6. Clean up

   Stopping the emulator also discards everything in it, because it keeps
   its resources in memory.

   ```bash
   cdkd destroy MyStack --aws-emulator
   ```
:::

Put `--aws-emulator` after the command's target. The URL is optional, so a
word right after the flag is read as the URL: `--aws-emulator MyStack/Handler`
swallows the target.

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

## Real credentials are never used

Under `--aws-emulator`, the emulator's identity is the only one cdkd uses:

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
emulator.

## Mixed mode

Sometimes only some services should be local: for example, DynamoDB writes in
the emulator while Bedrock or a real S3 bucket stays in AWS. Mixed mode routes
chosen services from a `cdkd local` container to the emulator and leaves the
rest on real AWS. You name the services in the `--env-vars` file by setting
`AWS_ENDPOINT_URL_<SERVICE>` to `"aws-emulator"`.

Unlike the rest of `--aws-emulator`, mixed mode calls your real account for every service
you do not list, so the container runs with your real credentials. List every
service whose writes must stay local.

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
| Docker image assets | Refused before anything is built. The emulator's ECR returns repository URIs on the real `amazonaws.com` registry, so a push would leave your machine. File assets publish normally. |
| Other emulators | `--aws-emulator` is specific to AWS Emulator. For LocalStack and the like, `cdkd local` forwards your `AWS_ENDPOINT_URL*` variables and `--ca-bundle`; see [Local AWS endpoints](local-emulation.md#local-aws-endpoints). |

In a Docker container, mind the port: it must be the same on both sides of
Docker's `-p` and in the emulator's own `-p`, because the emulator writes its
port into the run files. Do not use the emulator's `-p 0` in a container.

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
