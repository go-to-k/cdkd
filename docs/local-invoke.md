---
title: cdkd local invoke
description: "Run a single Lambda function from your CDK app in a local Docker container via the AWS Lambda Runtime Interface Emulator — no AWS deploy."
---

# cdkd local invoke

`cdkd local invoke <target>` runs one Lambda function from a CDK app on your
machine, inside a Docker container that bundles the AWS Lambda Runtime
Interface Emulator (RIE). It plays the role `sam local invoke` does, but reads
your CDK app directly — no `template.yaml`, no `cdk synth | sam ...`
round-trip. Reach for it to exercise a handler against a real event payload
before you deploy anything.

```bash
cdkd local invoke MyStack/MyApi/Handler                       # default {} event
cdkd local invoke MyStack/MyApi/Handler -e event.json         # event from a file
echo '{"k":1}' | cdkd local invoke MyHandler --event-stdin    # single-stack app, event on stdin
cdkd local invoke MyStack/MyApi/Handler --from-state          # resolve env intrinsics from cdkd state
cdkd local invoke MyStack/MyApi/Handler --from-state --assume-role   # run under the deployed role
cdkd local invoke MyStack/Handler -e event.json | tail -1 | jq .body # the payload is the LAST stdout line
```

Docker is required. The first run pulls the Lambda base image; later runs
reuse the cached one.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `<target>` | — | CDK display path or stack-qualified logical ID of the Lambda to invoke. Required. See [Target resolution](#target-resolution). |
| `-e`, `--event <file>` | `{}` | JSON event payload file. |
| `--event-stdin` | off | Read the event JSON from stdin. Mutually exclusive with `--event`. |
| `--env-vars <file>` | — | JSON env-var overrides, SAM-compatible shape. See [Local Execution](local-emulation.md#common-flags) and [Resolution priority](#resolution-priority). |
| `--no-pull` | off | Skip `docker pull`. Semantics differ per code path — see [`--no-pull` and `--no-build` by code path](#no-pull-and-no-build-by-code-path). |
| `--no-build` | off | Skip `docker build` on the container-image local-build path. See [`--no-pull` and `--no-build` by code path](#no-pull-and-no-build-by-code-path). |
| `--debug-port <port>` | off | Set `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` and publish the port, so a Node debugger can attach and step through the handler. Must be an integer in 1-65535. |
| `--container-host <host>` | `127.0.0.1` | Host IP to bind the RIE port to. See [Local Execution](local-emulation.md#common-flags). |
| `--assume-role [arn]` | off | Run the handler under the deployed function's execution role instead of your shell credentials. See [`--assume-role`: run under the deployed execution role](#assume-role-run-under-the-deployed-execution-role). |
| `--layer-role-arn <arn>` | — | Role to `sts:AssumeRole` before `lambda:GetLayerVersion` on literal-ARN layer entries. See [Literal layer ARNs](#literal-layer-arns). |
| `--ecr-role-arn <arn>` | — | Role to assume before authenticating to ECR on the container-image pull path. See [Container-image Lambdas](#container-image-lambdas). |
| `--from-state` | off | Substitute env-var intrinsics from cdkd's S3 state. See [`--from-state`: recover env vars from cdkd state](#from-state-recover-env-vars-from-cdkd-state). |
| `--from-cfn-stack [cfn-stack-name]` | off | Substitute env-var intrinsics from a deployed CloudFormation stack. Mutually exclusive with `--from-state`. See [`--from-cfn-stack`: recover env vars from CloudFormation](#from-cfn-stack-recover-env-vars-from-cloudformation). |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json`, then `cdkd-state-{accountId}` | S3 bucket holding cdkd state. Used only with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Used only with `--from-state`. |
| `--stack-region <region>` | auto | Region of the state record to read, and the CFn client region for `--from-cfn-stack`. See [Local Execution](local-emulation.md#common-flags). |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud-assembly directory. Pass `-a cdk.out` to skip synthesis while iterating. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value...>` | — | Set CDK context values. Repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for cdkd's own AWS API calls (state reads, STS, ECR). Distinct from `--assume-role`, which targets the handler's credentials. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging (on stderr). |

The region used for AWS API calls and for pseudo-parameter substitution is taken
from `AWS_REGION`, then `AWS_DEFAULT_REGION`, then the synthesized stack's own
`env.region`. A deprecated `--region` flag still overrides all three; prefer the
environment variable or your AWS profile.

### `--no-pull` and `--no-build` by code path

| Code path | `--no-pull` | `--no-build` |
| --- | --- | --- |
| ZIP Lambda | Skip pulling the public Lambda base image. | No-op — no `docker build` runs. |
| Container image, local build | No-op — `docker build` does not refresh the `FROM` cache by default. | Reuse the deterministic `cdkd-local-invoke-<hash>` tag from a prior run. Errors with an actionable message when that tag is not in the local registry. |
| Container image, ECR pull | Skip `docker pull`, and error when the image is not already in the local cache. | No-op — use `--no-pull` to control this path. |

The two flags are compatible with each other.

## Target resolution

The positional `<target>` accepts two forms:

- **CDK display path** — `MyStack/MyApi/Handler`. An L2 path resolves to the
  synthesized L1 child (`MyStack/MyApi/Handler/Resource`), the same prefix rule
  `cdkd orphan` uses.
- **Stack-qualified logical ID** — `MyStack:MyApiHandler1234ABCD`. The colon is
  unambiguous, because logical IDs can contain neither `/` nor `:`.

Single-stack apps may omit the stack prefix entirely: `cdkd local invoke
MyHandler` is valid when the app contains exactly one stack, mirroring `cdkd
deploy` / `cdkd destroy` auto-detection.

When the target matches nothing, the error lists every Lambda in the resolved
stack, so you can copy a valid one out of it.

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

The language-specific images are roughly 600MB; the OS-only `provided.*` images
roughly 50MB.

Java, .NET and `provided.*` are **asset-backed only**: inline `Code.ZipFile` is
rejected with a pointer at `lambda.Code.fromAsset(...)`, because each of those
`Handler` shapes names a compiled artifact — `package.Class::method` for Java's
JVM class, `Assembly::Namespace.Class::Method` for .NET's CLR assembly, an
arbitrary `bootstrap` binary for `provided.*`.

The deprecated `go1.x` runtime is rejected with a migration pointer at
`provided.al2023`.

### Architecture pinning

A ZIP Lambda's `Architectures: [x86_64]` (the default) or `[arm64]` is pinned to
`--platform linux/amd64` or `linux/arm64` on the container's `docker run`, the
same way the container-image path pins it on both build and run. On an
arch-mismatched host, Docker emulates the function's declared architecture, so a
`provided.*` `bootstrap` compiled for the other architecture runs rather than
failing with `fork/exec /var/runtime/bootstrap: exec format error` /
`Runtime.InvalidEntrypoint`.

The same pinning applies to [`cdkd local start-api`](local-start-api.md)'s
warm-container pool.

### Container-image Lambdas

`lambda.DockerImageFunction(...)` / `Code.ImageUri` functions are supported
alongside ZIP Lambdas. cdkd resolves the image in this order:

1. **Asset-manifest hit.** cdkd extracts the asset hash from the `:<hash>` tail
   of the image URI and looks it up in the stack's asset manifest
   (`cdk.out/<stack>.assets.json`, `dockerImages[<hash>]`), then runs `docker
   build` against the recorded build context.
2. **Single-asset fallback.** When the lookup misses but the manifest holds
   exactly one Docker asset, that asset is used — this covers digest-pinned
   URIs.
3. **ECR pull.** When both miss (typically: invoking a stack deployed
   elsewhere), cdkd falls back to `docker pull` from ECR.

The ECR-pull path supports cross-account and cross-region registries. cdkd
detects cross-account from `sts:GetCallerIdentity`, builds the ECR client for
the URI's own region, and — when `--ecr-role-arn <arn>` is passed — issues
`sts:AssumeRole` to pick up permissions in the target account before
`ecr:GetAuthorizationToken` and the pull. Without `--ecr-role-arn`, cdkd uses
your own credentials directly, which works when the target repository's resource
policy grants you; otherwise AWS returns `AccessDenied` and cdkd hints at the
flag. Same-account, same-region pulls need no role.

`ImageConfig` is honored on the `docker run`:

| Template field | Effect |
| --- | --- |
| `ImageConfig.Command` | Becomes the container `CMD`. |
| `ImageConfig.EntryPoint` | Becomes `--entrypoint <first>` plus the rest as positional args. |
| `ImageConfig.WorkingDirectory` | Becomes `--workdir`. |

When `EntryPoint` is unset — the common case — the image's own entrypoint stays
in charge. For AWS Lambda base images that is `/lambda-entrypoint.sh`, which
routes to RIE on port 8080.

## Environment variables

The function's template `Properties.Environment.Variables` entries are handled
by kind:

| Entry kind | Without a state source | With `--from-state` / `--from-cfn-stack` |
| --- | --- | --- |
| Literal (string / number / boolean) | Passed through as-is. | Passed through as-is. |
| Intrinsic (`Ref`, `Fn::GetAtt`, `Fn::Sub`, `Fn::Join`, `Fn::ImportValue`) | Warned by name and **dropped**, rather than silently substituting garbage. | Substituted with the deployed value where the source can supply one; warned and dropped otherwise. |
| AWS pseudo parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` / `${AWS::URLSuffix}`) | Warned and dropped. | Resolved from `sts:GetCallerIdentity` plus the resolved region. |

You can always override any entry — intrinsic or not — with `--env-vars`.

These standard Lambda runtime variables are always set, so the handler's
`context.*` fields look real: `AWS_LAMBDA_FUNCTION_NAME`,
`AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, `AWS_LAMBDA_FUNCTION_TIMEOUT`,
`AWS_LAMBDA_FUNCTION_VERSION`, `AWS_LAMBDA_LOG_GROUP_NAME`,
`AWS_LAMBDA_LOG_STREAM_NAME`.

### Resolution priority

Highest wins:

1. The `--env-vars` file's function-specific entry (`{LogicalId: {KEY: VALUE}}`,
   or the same block keyed by CDK display path).
2. The `--env-vars` file's global `Parameters` block.
3. The `--from-state` / `--from-cfn-stack` substituted intrinsic, when a state
   source is set and the substitution succeeded.
4. The template's literal value.

## `--from-state`: recover env vars from cdkd state

When the target stack has been deployed with `cdkd deploy`, cdkd already knows
the physical IDs and attributes its intrinsic-valued env vars point at.
`--from-state` opts in to reading cdkd's S3 state and substituting those values
before the env block reaches the container.

```bash
# Single-region stack: --from-state alone is enough
cdkd deploy MyStack
cdkd local invoke MyStack/MyApi/Handler --from-state

# Multi-region: disambiguate the state record
cdkd local invoke MyStack/MyApi/Handler --from-state --stack-region us-west-2

# Combine with --env-vars to override a single key (the override wins)
cdkd local invoke MyStack/MyApi/Handler --from-state \
  --env-vars '{"Parameters":{"DEBUG":"1"}}'
```

### Supported intrinsics

| Intrinsic | Resolved from |
| --- | --- |
| `Ref: <LogicalId>` | The state record's `resources[id].physicalId`. |
| `Fn::GetAtt: [<LogicalId>, <attr>]` | The state record's `resources[id].attributes[attr]`, JSON-stringified when the cached value is an object or array. |
| `Fn::Sub` | Both the single-string and two-arg forms. `${LogicalId}` / `${LogicalId.attr}` / `${AWS::*}` placeholders are substituted in place; the two-arg form's bindings map may itself carry intrinsics, resolved recursively. |
| `Fn::Join` | Every element is resolved recursively, then joined. |
| `Ref: AWS::AccountId` / `Region` / `Partition` / `URLSuffix` | One `sts:GetCallerIdentity` plus the resolved region. |
| `Fn::ImportValue` | The producer stack's state record, in a second pass. Same account and same region only. |
| `Fn::GetStackOutput` | The named stack's outputs in the same state bucket. Same account and same region only. |

The last two open an extra client, so cdkd builds that resolver only when the
function's environment actually references one of them.

Pseudo-parameter resolution runs only when the env map actually contains an
intrinsic — a literal-only map skips the STS hop entirely. The region used for
`partition` / `urlSuffix` follows `--region` > `AWS_REGION` >
`AWS_DEFAULT_REGION` > the synth-derived stack region. An STS failure warns and
leaves the `${AWS::*}` placeholders dropped; non-`AWS::*` substitution still
runs.

### Failure handling

Resolution is per-key best-effort. When a substitution cannot be produced —
state missing for the referenced resource, the attribute not captured at deploy
time, an unsupported intrinsic inside `Fn::Sub` — that key is warned and
dropped, and the invoke proceeds.

State-load failures are equally non-fatal: a missing state record, multi-region
ambiguity without `--stack-region`, or a bucket-resolution error warns and falls
back to the no-state behaviour rather than aborting the invoke.

## `--from-cfn-stack`: recover env vars from CloudFormation

`--from-state` only works for stacks deployed by `cdkd deploy`, because that is
the only thing that writes cdkd's S3 state. For CDK apps deployed through the
upstream CDK CLI (`cdk deploy` → CloudFormation), use `--from-cfn-stack`: cdkd
calls `cloudformation:ListStackResources` against the named stack to build
the same per-logical-ID physical-ID map, then runs the same substitution engine
over it.

```bash
# Bare flag — uses the cdkd stack name as the CFn stack name
cdk deploy MyStack
cdkd local invoke MyStack/MyApi/Handler --from-cfn-stack

# Explicit CFn stack name — when the deployed name differs from the CDK
# display name (e.g. CDK's `stackName` prop was overridden)
cdkd local invoke MyStack/MyApi/Handler --from-cfn-stack MyExplicitCfnStackName

# Cross-region CFn stack — --stack-region drives the CFn client region
cdkd local invoke MyStack/MyApi/Handler --from-cfn-stack --stack-region eu-west-1
```

### What resolves

| Intrinsic | Resolved from |
| --- | --- |
| `Ref: <LogicalId>` | `cloudformation:ListStackResources`, paginated, once per stack. |
| `Fn::ImportValue: <ExportName>` | `cloudformation:ListExports`, paginated and memoized for one substitution pass. |
| `Fn::GetAtt` in a **consumer Lambda's own** env vars | The deployed function's configuration (`lambda:GetFunctionConfiguration`). |
| `Fn::GetAtt` on a same-stack ECR repository's `Arn` / `RepositoryUri`, in a container image URI | Synthesized from the recovered physical name plus the pseudo parameters. |
| `Fn::GetAtt` anywhere else (e.g. an ECS container env) | Nothing — warned and dropped. Override the entry with `--env-vars` if the value is critical. |
| `Fn::GetStackOutput` | Nothing — rejected with a warn. |

`ListStackResources` returns only `(LogicalResourceId, PhysicalResourceId,
ResourceType)` triplets, with no per-attribute values. But
CloudFormation already resolved every intrinsic at deploy time, so a consumer
Lambda's `Environment.Variables` already holds the concrete value: cdkd reads it
back from the deployed function config, which covers `Fn::GetAtt` / `Fn::Sub` /
`Fn::ImportValue` / cross-stack `Ref` in Lambda env vars uniformly, with no
per-service describe calls.

`Fn::GetStackOutput` is a cdkd-specific intrinsic with no CloudFormation
equivalent — CFn's cross-stack vocabulary is `Fn::ImportValue` against an
explicit `Outputs.<name>.Export` block. Use `Fn::ImportValue`, or `--from-state`
instead.

### Region handling

The CFn client is region-bound at construction using the precedence
`--stack-region` > `--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > the
synth-derived stack region. There is deliberately no separate
`--cfn-stack-region` flag; `--stack-region` does double duty.

When none of those signals is set, the command **throws** with a remediation
message rather than falling back to a literal region the way `--from-state`
does. The CloudFormation client queries one specific region, and silently
choosing `us-east-1` would query the wrong environment.

### Multi-stack routing

[`cdkd local start-api`](local-start-api.md) and [`cdkd local
start-service`](local-start-service.md) can route several stacks in one
invocation. Bare `--from-cfn-stack` works there, because each routed stack uses
its own cdkd stack name as the CFn stack name. An **explicit
`--from-cfn-stack <name>` is rejected** when more than one stack is routed: the
one name would apply to every routed stack and silently mismap `Ref` lookups
whose logical IDs happen to collide between siblings. Use the bare form for
multi-stack apps, or run one cdkd invocation per stack.

### CloudFormation failure handling

`ListStackResources` failures — stack not found, access denied, throttling —
degrade to a per-key warn and drop, the same as `--from-state`. `ListExports`
failures affect only `Fn::ImportValue`; same-stack `Ref` substitutions still
succeed, because they need only the resource listing.

## `--assume-role`: run under the deployed execution role

By default the container inherits your shell's `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` unchanged, which is
SAM-compatible but means the handler usually runs with far wider permissions
than it has when deployed. `--assume-role` STS-assumes the function's execution
role and forwards the resulting temporary credentials instead, so an
IAM-permission bug shows up locally.

| Form | Behaviour |
| --- | --- |
| `--assume-role <arn>` | Assumes the explicit ARN. Takes precedence over anything resolved from state. |
| `--assume-role` (bare) | Reads the function's `Properties.Role` from cdkd state, resolves `Fn::GetAtt: [<RoleId>, 'Arn']` shapes against the sibling IAM Role's recorded `Arn` attribute, and assumes that. Requires `--from-state`. |
| flag omitted | Your shell credentials are forwarded unchanged. |

With `--from-state` set but no `--assume-role`, cdkd logs the deployed role ARN
once, so you can re-run with the flag.

An STS failure — insufficient permissions, trust-policy mismatch — degrades to a
warn plus a fallback to your shell credentials. This is a developer-loop tool,
not a security boundary.

## Asset resolution

**ZIP Lambdas.** cdkd reads the CDK-blessed `Metadata['aws:asset:path']` hint on
each Lambda's CFn resource — the same source SAM uses — to find the local
unzipped asset directory under `cdk.out`, and bind-mounts it at `/var/task`
read-only. Inline `Code.ZipFile` functions are materialized to a tmpdir using
the file path implied by the function's `Handler` property (`index.handler` →
`tmpdir/index.js`).

**Container-image Lambdas.** See [Container-image
Lambdas](#container-image-lambdas) above.

## Lambda layers

Layers are resolved into a single read-only bind mount at `/opt` inside the
container. cdkd does not inspect the contents — the layer's internal layout
(`/opt/python/...`, `/opt/nodejs/...`, `/opt/lib/...`) is yours to get right.

With one layer, that layer's asset directory is bind-mounted directly, with no
copy. With several, each layer's contents are copied into a fresh tmpdir **in
template order**, so later layers overwrite earlier files, and the merged tmpdir
is bind-mounted and removed on cleanup. The merge mirrors what AWS Lambda does
at runtime — it extracts every layer ZIP into `/opt` in template order, so the
**last layer wins on a file collision**. cdkd cannot use several `-v ...:/opt:ro`
entries instead, because Docker rejects duplicate bind mounts at one target with
`Error response from daemon: Duplicate mount point: /opt`.

### Same-stack layer references

A `Properties.Layers` entry of the form `{Ref: '<LayerLogicalId>'}` or
`{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}` must point at an
`AWS::Lambda::LayerVersion` in the same stack. Its
`Metadata['aws:asset:path']` is read the same way Lambda code is located, and
the asset is already unzipped under `cdk.out/asset.<hash>/`, ready to mount.

### Literal layer ARNs

A `Layers` entry that is the string
`arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>` is resolved
by downloading that layer version's ZIP and unzipping it into a host tmpdir,
which then joins the same `/opt` merge — so "last layer wins" holds across both
kinds. This covers AWS-published public layers (Lambda Powertools, the Datadog
extension) and cross-account or cross-region shared layers.

Pass `--layer-role-arn <arn>` to `sts:AssumeRole` before
`lambda:GetLayerVersion` when your own credentials cannot read the layer,
typically a cross-account one. AWS-published public layers are readable from
every account and need no role.

**Only a commercial-partition layer ARN downloads.** An `aws-cn`, `aws-us-gov`
or ISO-partition ARN passes cdkd's parse and then fails at the AWS call, because
the download rebuilds the ARN with a hardcoded `aws` partition before calling
`lambda:GetLayerVersion`.

The parse itself accepts all eight partitions — commercial, `aws-cn`,
`aws-us-gov`, `aws-iso`, `aws-iso-b`, `aws-iso-e`, `aws-iso-f`, `aws-eusc` —
because the partition is derived from the ARN's region rather than matched
against a fixed list. The two segments must agree: `arn:aws-cn:lambda:us-east-1:...`
is refused, naming the disagreement, because `us-east-1` does not belong to
`aws-cn`. A region cdkd's partition table does not recognise resolves to the
commercial partition, so a brand-new commercial region keeps working with
`arn:aws:`.

### Rejected layer entries

These hard-error, with the message pointing at the offending entry:

- An entry that is neither a same-stack reference nor a well-formed
  layer-version ARN — a malformed ARN, a function ARN, an unversioned layer
  ARN, or a partition that disagrees with the region.
- A same-stack reference that does not point at an `AWS::Lambda::LayerVersion`
  (a typo'd logical ID).
- A same-stack reference to a `LayerVersion` whose `Metadata['aws:asset:path']`
  is missing.

Container-image Lambdas (`Code.ImageUri`) silently ignore `Layers`, matching AWS:
container images bake their layers at build time, and AWS rejects `Layers` on a
container Lambda at deploy time.

## Ephemeral storage

When the template declares `Properties.EphemeralStorage.Size` — the typical CDK
shape being `new lambda.Function(this, 'X', { ephemeralStorageSize:
cdk.Size.gibibytes(2) })` — cdkd adds `--tmpfs /tmp:rw,size=<N>m` to the `docker
run`, so the container's `/tmp` is a memory-backed filesystem capped at the
templated value in MiB (`cdk.Size.gibibytes(2)` serializes to `2048`). Handlers
that exceed the deployed cap fail locally with `ENOSPC` the way they would on
AWS, and handlers that check free space via `statvfs` / `df` see the configured
cap instead of the host's overlay filesystem.

| Template state | Result |
| --- | --- |
| `EphemeralStorage.Size` set, ≤ 10240 MiB | `--tmpfs /tmp:rw,size=<N>m`. Applies to both ZIP and container-image Lambdas. |
| `EphemeralStorage` absent | No `--tmpfs`; `/tmp` is whatever the base image provides. AWS Lambda base images do not mount a sized tmpfs themselves. |
| Size above the AWS 10240 MiB (10 GiB) ceiling | Hard error at resolve time, with an actionable message, rather than a `docker run` AWS would have refused anyway. |
| Intrinsic-valued `Size` (the `{Ref: 'SomeParam'}` shape) | Silently no `--tmpfs` — local invoke has no Parameters context to resolve it with. |

Container-image Lambdas get an `[info]` line at startup, so the `/tmp` override
on top of whatever the Dockerfile placed there is not a surprise. The same cap
applies to each cold-started container in [`cdkd local
start-api`](local-start-api.md)'s warm pool.

## Reaching a server on the host

The container can reach a server bound on the host loopback — an
`AWS_ENDPOINT_URL_*` local endpoint such as a DynamoDB or S3 mock, or a tunneled
VPC resource — via the `host.docker.internal` hostname.

- **Docker Desktop (macOS / Windows)** resolves it natively.
- **Linux native dockerd** gets the `--add-host
  host.docker.internal:host-gateway` mapping injected automatically (Docker
  20.10+).
- On an older or unavailable daemon the mapping is silently skipped — never an
  error.

The same applies to [`cdkd local run-task`](local-run-task.md) container runs,
and to [`cdkd local start-service`](local-start-service.md) and [`cdkd local
start-alb`](local-start-alb.md).

## Output streams

**Everything cdkd's own logger prints goes to stderr.** `cdkd local invoke` and
[`cdkd local invoke-agentcore`](local-invoke-agentcore.md) reserve stdout
unconditionally, so every cdkd status line — `Synthesizing CDK app...`,
`Target: ...`, `Starting container ...`, layer-resolution notices, `--verbose`
debug output — is written to stderr, the way `sam local invoke` does it. A
terminal shows the same thing it always did, and `2>&1` restores a single-stream
view.

**Stdout is not payload-only, so pipe through `tail -1`.** Two things reach
stdout besides the response, neither routed by cdkd's logger:

| Source | What lands on stdout |
| --- | --- |
| The container's own stdout | The runtime emulator puts `START` / `END` / `REPORT` and every handler log line there — `console.error` included — so any handler that prints lands ahead of the response. |
| The container-image build path | For a container-image Lambda, `Building container image (platform=...)` and `Skipping docker build ...` print on stdout rather than stderr. |

`docker pull` progress does not: while a command holds the stdout reservation,
the child process's fd 1 is redirected to fd 2.

```bash
# The response payload is always the LAST line on stdout.
cdkd local invoke MyStack/Handler --event event.json | tail -1 | jq .body
cdkd local invoke-agentcore MyStack/Agent 2> progress.log | tail -1
```

A ZIP Lambda whose handler prints nothing hits neither source, so `cdkd local
invoke MyStack/Handler | jq` does work there — it is just not a guarantee that
holds for every target.

[`cdkd local start-api`](local-start-api.md), [`cdkd local
run-task`](local-run-task.md) and [`cdkd local
start-service`](local-start-service.md) are unaffected: their stdout is a human
surface (route table, prefixed container logs), not a payload.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | RIE answered — whether the handler returned a success payload **or** an error payload. This mirrors AWS, where a thrown handler still produces a 200 carrying an error structure. |
| `1` | A cdkd-side error before or after the handler ran: Docker not installed, image pull or build failed, target not found, an invalid flag value, RIE unreachable within the readiness window, or the container exiting before it responded. |
| `130` | `^C` (SIGINT). The container is stopped and removed, and any merged-layer or inline-code tmpdir is cleaned up, before the process exits. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Limitations

- The deprecated `go1.x` runtime is not emulated. Build Go handlers for
  `provided.al2023`, which is supported.
- Cross-stack `Fn::ImportValue` and `Fn::GetStackOutput` resolve only within one
  account and one region. A producer stack in another account or region is
  warned and dropped.
- `Fn::Select`, `Fn::Split`, `Fn::If` and other intrinsics outside the
  [supported list](#supported-intrinsics) are warned and dropped rather than
  resolved.
- SQS and S3 event-source emulation is not provided. Pass the event body with
  `--event` instead.
- VPC placement is not simulated. A handler that depends on VPC-private
  connectivity needs a tunnel; see [Reaching a server on the
  host](#reaching-a-server-on-the-host).
- Custom Resources (`Custom::*`) cannot be invoked as such — they are called by
  the deploy framework, not by users. cdkd errors with a pointer at the
  underlying `ServiceToken` Lambda, which you can invoke directly.

## Related

- [Local Execution](local-emulation.md) — every `cdkd local` subcommand, the Docker requirement, and the flags they share
- [`cdkd local start-api`](local-start-api.md) — the long-running API Gateway emulator over the same RIE containers
- [`cdkd local invoke-agentcore`](local-invoke-agentcore.md) — the same one-shot shape for a Bedrock AgentCore Runtime
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
