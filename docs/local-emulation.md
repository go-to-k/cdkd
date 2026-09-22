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
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json`, then `cdkd-state-{accountId}` | S3 bucket holding the state read by `--from-state`. The default means `--from-state` works with no configuration on a bootstrapped account. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

`--from-state` and its two bucket flags are accepted everywhere but do nothing on
`local start-cloudfront`, which reads deployed values only through
`--from-cfn-stack`. On `local start-alb` they are partial: they resolve the
backing ECS services but not a Lambda target group's environment, which the
command warns about at boot — see
[its page](local-start-alb.md#lambda-target-groups-and-the-state-source). Two
more flags are not accepted on `local start-cloudfront` at all:

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

What the top-level key names depends on what the command runs:

| Command | Key |
| --- | --- |
| `local invoke`, `local start-api` | The Lambda's logical ID, or its **CDK display path** (`MyStack/MyHandler`) — the same form the `<target>` argument accepts, matched against the resource's `aws:cdk:path` metadata. |
| `local run-task`, `local start-service`, `local start-alb` | The **container name**, i.e. `ContainerDefinitions[].Name`. |
| `local invoke-agentcore`, `local start-agentcore` | The runtime's logical ID or CDK display path. |

For Lambda targets the two forms coexist in one file, and when both name the
same key the later JSON entry wins, matching SAM's apply-in-order semantics.

### `--from-state` and `--from-cfn-stack`: resolving deployed values

Both are off by default, and they are mutually exclusive. Without either, an
intrinsic-valued property — a `Ref` to a table name, an `Fn::GetAtt` on a queue
URL — has no value to resolve to, because nothing has been deployed.

| Flag | Reads | Use when |
| --- | --- | --- |
| `--from-state` | cdkd's S3 state for the stack | The stack was deployed with `cdkd deploy`. `local start-cloudfront` REFUSES it — see [its page](local-start-cloudfront.md#state-sources) — and `local start-alb` does not apply it to a Lambda target group. |
| `--from-cfn-stack [name]` | A deployed CloudFormation stack's resources | The stack was deployed with the AWS CDK CLI, or the command is `local start-cloudfront`. |

`--from-cfn-stack` resolves `Ref` and `Fn::ImportValue` from the deployed
physical IDs and exports. `Fn::GetAtt` is not universally recoverable, because a
stack's resource listing carries no per-attribute values; where cdkd cannot
recover one it warns and drops the value rather than substituting a wrong one.
What each command can recover differs, so check its own page.

#### When a state record's `outputs` map is malformed

A state record is used as typed data without a field-by-field shape check, so a
hand-edited or truncated one can hold a string, a list, a number, a boolean or
`null` where the `outputs` map belongs — and enumerating a string yields one
entry per **character**. `--from-state` used to hand a six-character value to
the local run as six outputs. A `Fn::GetStackOutput` against such a record
behaved differently by shape, because the reader tested `!got.state.outputs`
before `outputName in got.state.outputs`. A **falsy** bag — `null`, `0`, `false`
or `''` — short-circuited on the first test and returned an ordinary miss, so
the reference simply went unresolved with nothing said about the record. A
truthy non-object — a non-empty string, a non-zero number or `true` — reached
the `in`, which throws on all three, and surfaced as an opaque state-read error
naming nothing either. A **list** answered the membership test, so an output
named like an index resolved a fabricated element.

`cdkd local` reads such a bag as **empty** and warns, naming the stack and
region. It does not refuse: these commands write no state record, so there is
nothing to damage further, and a local invoke over one damaged record is still
worth running. What the warning buys is the distinction an empty map cannot
make on its own — "this record could not be read" versus "this stack publishes
no outputs". Repair the record (or run [`cdkd state
show`](cli-state.md) with `--json` to see what is stored) before trusting a
substitution that came back absent.

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

## What cdkd trusts in the assembly

These commands read the cloud assembly, and `-a <dir>` reads one that was built
elsewhere. Some of the paths it supplies are refused when they resolve outside
the assembly directory, and some are not, so the list is worth reading rather
than assuming.

Refused:

- a Lambda's `Handler`, for an inline `Code.ZipFile` — cdkd materializes it as
  a file before running it, so an escaping module path would have written the
  assembly's own bytes to a path of its choosing;
- a Docker asset's `source.directory` under `cdkd local run-task`;
- a code asset's `source.path` under `cdkd local invoke-agentcore`, and the
  `source.directory` its `--watch` soft reload reads;
- a Lambda's `Metadata['aws:asset:path']` under `cdkd local invoke` and
  `cdkd local start-api` — both the function's own code directory and a
  same-stack layer's. This one is refused on **two** counts, worded apart so
  you can tell which fired: a path that leaves the app's output directory, and
  a path that is **absolute**. An absolute value used to be honoured on
  purpose, and it reached the same place `../..` does without needing a `..` at
  all, so refusing only one of the two would have closed almost nothing. The
  result is bind-mounted read-only at `/var/task` (a layer's at `/opt`) inside
  a container running handler code the same assembly supplies, and
  `cdkd local invoke` forwards your credentials into it — so the mount is what
  would carry that code from a session it already has to the raw contents of
  your home directory.

A stack inside a `cdk.Stage` is unaffected by any of those: its assets are
staged into the app's output directory, so `../asset.<hash>` is the shape CDK
writes and it loads normally. The same rule and the same wording apply on the
deploy path; see [Deploy safety](cli-deploy-safety.md).

Not refused today:

- every Docker build context that goes through the bundled `cdk-local` engine,
  which joins the path itself: a container-image Lambda under
  `cdkd local invoke` and `cdkd local start-api`, and the image build of
  `cdkd local invoke-agentcore`'s container arm (so that command contains the
  `source.directory` its watcher classifies against, but not the one it
  builds).

Until those land, a hand-modified assembly can still put a directory of its
choosing in front of code it also supplies. Treat an assembly you did not
synthesize yourself as untrusted input.

## Related

- [CLI Reference](cli-reference.md) — every cdkd command, the output-stream
  contract, and the full exit-code table
- [Deploy safety](cli-deploy-safety.md) — what cdkd refuses to read out of a
  cloud assembly, and why
- [Getting Started](getting-started.md) — installing cdkd and deploying a first
  stack
- [State Management](state-management.md) — what `--from-state` reads
