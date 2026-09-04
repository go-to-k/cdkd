---
title: Local Execution
description: "Run AWS workloads on your machine with cdkd local via Docker — invoke Lambda functions, serve API Gateway and ALB, run ECS tasks and services, and serve CloudFront and Bedrock AgentCore, with no AWS deploy."
---

# Local Execution

`cdkd local *` runs the AWS workloads in your CDK app on your own machine. There
is no deploy, no `template.yaml` to maintain, and no `cdk synth | sam ...`
round-trip — the commands read the same cloud assembly `cdkd deploy` does, so a
handler edit is testable in seconds.

```bash
cdkd local invoke MyStack/Handler --event event.json   # one-shot Lambda invoke
cdkd local start-api                                   # serve every discovered API on localhost
cdkd local run-task MyStack/Service/TaskDef            # run one ECS task definition
cdkd local start-service MyStack/Service --watch       # long-running ECS service, hot-reloaded
cdkd local start-api -a cdk.out                        # skip synthesis, reuse a built assembly
cdkd local invoke MyStack/Handler --from-state         # resolve intrinsics from deployed state
```

## Subcommands

| Command | Emulates | Shape |
| --- | --- | --- |
| [`cdkd local invoke`](local-invoke.md) | One Lambda invocation | One-shot |
| [`cdkd local start-api`](local-start-api.md) | API Gateway REST v1, HTTP API, WebSocket API and Function URL routes | Server, one per discovered API |
| [`cdkd local run-task`](local-run-task.md) | ECS `RunTask` for one task definition | One-shot |
| [`cdkd local start-service`](local-start-service.md) | ECS `Service`, `DesiredCount` replicas with restart-on-exit | Server |
| [`cdkd local start-alb`](local-start-alb.md) | Application Load Balancer in front of ECS or Lambda targets | Server, one per listener port |
| [`cdkd local start-cloudfront`](local-start-cloudfront.md) | CloudFront distribution: CloudFront Functions, Lambda@Edge, S3 and Lambda Function URL origins | Server |
| [`cdkd local invoke-agentcore`](local-invoke-agentcore.md) | One Bedrock AgentCore Runtime invocation | One-shot |
| [`cdkd local start-agentcore`](local-start-agentcore.md) | Bedrock AgentCore Runtime served against a warm container | Server |

The servers run until `^C`, which tears down every container, sidecar and
docker network they created.

## Requirements

Docker is required for everything that runs a workload container: the Lambda
Runtime Interface Emulator (RIE) behind `local invoke` and `local start-api`,
the task containers and the ECS metadata sidecar behind `local run-task` /
`local start-service` / `local start-alb`, and the agent container behind the
two AgentCore commands.

`local start-cloudfront` is the one command that can run without Docker. A
distribution whose origins are all S3 and whose only edge logic is CloudFront
Functions serves entirely in-process — the functions run in a sandboxed VM and
the S3 content is read from the `BucketDeployment` source in the cloud assembly.
Docker is required as soon as the distribution has a Lambda Function URL origin
or a Lambda@Edge association, because those run in RIE containers.

The first run pulls the images it needs: roughly 600 MB for a language-specific
Lambda base image, 50 MB for `provided.*`, plus the ECS metadata sidecar for the
task commands. Later runs reuse the cached image. `--no-pull` skips the `docker
pull` round-trip entirely; its exact scope differs per command, so check the
command's own page.

## Common flags

Every `cdkd local` subcommand accepts these.

| Flag | Default | Description |
| --- | --- | --- |
| `-a`, `--app <cmd-or-dir>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory. Pass `-a cdk.out` to skip synthesis. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value...>` | — | CDK context values. Repeatable. |
| `--no-pull` | off | Skip `docker pull` and use the cached image. Per-command scope differs. |
| `--from-state` | off | Resolve intrinsic-valued properties against cdkd's deployed S3 state. Mutually exclusive with `--from-cfn-stack`. |
| `--from-cfn-stack [name]` | — | Resolve them against a deployed CloudFormation stack instead, for apps deployed with the AWS CDK CLI. Bare form uses the cdkd stack name. |
| `--stack-region <region>` | — | Which region's record to read, and the CloudFormation client region under `--from-cfn-stack`. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state read by `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

Two more are accepted by every subcommand **except `local start-cloudfront`**:

| Flag | Default | Description |
| --- | --- | --- |
| `--env-vars <file>` | — | JSON environment-variable overrides, SAM-compatible. |
| `--container-host <ip>` | `127.0.0.1` | Bind IP for published container ports. Must be a numeric IP — Docker rejects hostnames in `-p <ip>:<port>:<port>`. |

Everything else is per-command; each page's own options table is the complete
list for that command.

### `--env-vars`: overriding environment variables

The file is SAM-compatible: a top-level object keyed by resource, plus an
optional `Parameters` object for values that apply everywhere.

```json
{
  "MyHandler1234ABCD": { "TABLE_NAME": "local-table", "DEBUG": "1" },
  "MyStack/MyHandler": { "ENDPOINT": "http://host.docker.internal:4566" },
  "Parameters": { "LOG_LEVEL": "debug" }
}
```

A `null` value clears the key rather than setting it to the string `"null"`.

For Lambda targets — `local invoke` and `local start-api` — the resource key may
be either the logical ID or the **CDK display path** (`MyStack/MyHandler`), the
same form the `<target>` argument accepts; it is matched against the resource's
`aws:cdk:path` metadata. The two forms coexist in one file, and when both name
the same key the later JSON entry wins, matching SAM's apply-in-order semantics.

### `--from-state` and `--from-cfn-stack`: resolving deployed values

Both are off by default, and they are mutually exclusive. Without either, an
intrinsic-valued property — a `Ref` to a table name, an `Fn::GetAtt` on a queue
URL — has no value to resolve to, because nothing has been deployed.

| Flag | Reads | Use when |
| --- | --- | --- |
| `--from-state` | cdkd's S3 state for the stack | The stack was deployed with `cdkd deploy`. |
| `--from-cfn-stack [name]` | A deployed CloudFormation stack's resources | The stack was deployed with the AWS CDK CLI. |

`--from-cfn-stack` resolves `Ref` and `Fn::ImportValue` from the deployed
physical IDs and exports. `Fn::GetAtt` is not universally recoverable, because a
stack's resource listing carries no per-attribute values; where cdkd cannot
recover one it warns and drops the value rather than substituting a wrong one.
What each command can recover differs, so check its own page.

### `--stack-region`: choosing between records

Only meaningful alongside `--from-state` or `--from-cfn-stack`. Pass it when the
same stack name has state in more than one region.

Region **case is not significant**: the value is matched against the state
record's own spelling case-insensitively, so `--stack-region US-EAST-1` reads the
`us-east-1` record instead of silently falling back to no state at all. A record
spelled exactly the way you typed the flag always wins, so if both a `us-east-1`
and a `US-EAST-1` record exist, each flag spelling reads its own. That collision
is reported at warn level, naming the record read and which of the two rules
chose it.

## Reaching a server on the host

Containers cannot reach `localhost` on your machine — inside the container,
`localhost` is the container. Use `host.docker.internal` for a service running
on the host, which is what an override like
`"ENDPOINT": "http://host.docker.internal:4566"` is for.

## Related

- [CLI Reference](cli-reference.md) — every cdkd command, the output-stream
  contract, and the full exit-code table
- [Getting Started](getting-started.md) — installing cdkd and deploying a first
  stack
- [State Management](state-management.md) — what `--from-state` reads
