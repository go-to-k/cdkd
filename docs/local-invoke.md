---
title: local invoke
description: "Run a single Lambda function from your CDK app in a local Docker container via the AWS Lambda Runtime Interface Emulator — no AWS deploy."
---

# `local invoke` (run Lambda functions locally)

`cdkd local invoke <target>` runs a Lambda function from a CDK app on
the developer's machine, inside a Docker container that bundles the
AWS Lambda Runtime Interface Emulator (RIE). Modeled on
`sam local invoke` but reusing cdkd's synthesis / asset / construct-path
plumbing.

**Requires Docker.** The first invocation pulls the Lambda base image
(`public.ecr.aws/lambda/nodejs:<version>`,
`public.ecr.aws/lambda/python:<version>`,
`public.ecr.aws/lambda/ruby:<version>`,
`public.ecr.aws/lambda/java:<version>`,
`public.ecr.aws/lambda/dotnet:<version>`, or
`public.ecr.aws/lambda/provided:<al2|al2023>` — ~600MB for the
language-specific images, ~50MB for the OS-only `provided.*`);
subsequent invocations reuse the cached image. Pass `--no-pull` to
skip the `docker pull` round-trip altogether. Supported runtimes:
`nodejs18.x` / `nodejs20.x` / `nodejs22.x` / `nodejs24.x` /
`python3.11` / `python3.12` / `python3.13` / `python3.14` /
`ruby3.2` / `ruby3.3` / `java8.al2` / `java11` / `java17` / `java21` /
`dotnet6` / `dotnet8` / `provided.al2` / `provided.al2023`. The
deprecated `go1.x` runtime is rejected with a migration pointer to
`provided.al2023`. Java, .NET, and `provided.*` are **asset-backed
only** — inline `Code.ZipFile` is rejected with a routing message
("use `lambda.Code.fromAsset(...)`") because the Handler shape names
a compiled artifact (`package.Class::method` for Java's JVM class;
`Assembly::Namespace.Class::Method` for .NET's CLR assembly; an
arbitrary `bootstrap` binary for `provided.*`).

A ZIP Lambda's `Architectures: [x86_64]` (default) / `[arm64]` is pinned to
`--platform linux/amd64` / `linux/arm64` on the container's `docker run`
(matching the container-image path). On an arch-mismatched host Docker
emulates the function's declared arch, so a `provided.*` `bootstrap`
compiled for the other architecture runs instead of failing with
`fork/exec /var/runtime/bootstrap: exec format error` /
`Runtime.InvalidEntrypoint`. The same pinning applies to `cdkd local
start-api`'s warm-container pool.

**Container Lambdas** — `lambda.DockerImageFunction(...)` /
`Code.ImageUri` is supported in addition to ZIP Lambdas. cdkd reads the
function's local `Dockerfile` from `cdk.out` (via the asset manifest
keyed off the `:<hash>` suffix on `Code.ImageUri`) and runs `docker build`
locally, then `docker run` against the resulting image. When no asset
matches (typically: invoking a stack deployed elsewhere), cdkd falls back
to `docker pull` from ECR. **Cross-account / cross-region pull is
supported**: cdkd auto-detects cross-account from `sts:GetCallerIdentity`,
builds the ECR client for the URI's region, and (when
`--ecr-role-arn <arn>` is passed) issues `sts:AssumeRole` to pick up
permissions in the target account. Without `--ecr-role-arn`, cdkd
falls through to the caller's credentials — works when the target ECR
repository's resource policy grants the caller directly (AWS surfaces
`AccessDenied` if missing, with a hint at the flag).
`Architectures: [x86_64]` (default) and `[arm64]` are honored via
`--platform linux/amd64` / `linux/arm64` on both the build and the run.

### Target resolution

The positional `<target>` accepts two forms:

- **CDK display path** — `MyStack/MyApi/Handler`. Matches the same
  prefix-rule cdkd uses for `cdkd orphan`: an L2 path resolves to the
  synthesized L1 child (`MyStack/MyApi/Handler/Resource`).
- **Stack-qualified logical ID** — `MyStack:MyApiHandler1234ABCD`. The
  colon is unambiguous because logical IDs cannot contain `/` or `:`.

Single-stack apps may omit the stack prefix entirely:
`cdkd local invoke MyHandler` is valid when the app contains exactly
one stack (mirrors `cdkd deploy` / `cdkd destroy` auto-detect).

When the target does not match anything, the error lists every Lambda
in the resolved stack so the user can copy/paste a valid one.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `-e, --event <file>` | `{}` | JSON event payload file. |
| `--event-stdin` | off | Read event JSON from stdin (mutually exclusive with `--event`). |
| `--env-vars <file>` | — | JSON env-var overrides, SAM-compatible shape: `{"LogicalId":{"KEY":"VALUE"}}` plus an optional top-level `"Parameters"` block applied to every invoke. `null` clears a key. The function-specific key may also be a **CDK display path** (`MyStack/MyHandler` — same form `cdkd local invoke <target>` accepts). Both forms coexist; later JSON entry wins on conflict (SAM apply-in-order). |
| `--no-pull` | off | Skip `docker pull`. Semantics differ by code path: **ZIP Lambdas** — skip pulling the public Lambda base image. **Container Lambdas, local-build path** — no-op (docker build's default does not refresh the FROM cache). **Container Lambdas, ECR-pull fallback** — skip `docker pull` AND error if the image is not in the local cache (re-run without `--no-pull` or pre-pull manually). |
| `--no-build` | off | Skip `docker build` on the **Container Lambdas, local-build path** (`Code.ImageUri`). Requires the deterministic `cdkd-local-invoke-<hash>` tag to already be in the local docker registry from a prior `cdkd local invoke` (or manual `docker build`); errors clearly when missing. **No-op for ZIP Lambdas** (no docker build runs there) AND for the **Container Lambdas, ECR-pull fallback** (use `--no-pull` to control that path). Compatible with `--no-pull`. |
| `--ecr-role-arn <arn>` | — | Role ARN to assume before authenticating against ECR on the **Container Lambdas, ECR-pull fallback** path. Issues `sts:AssumeRole` via the default credential chain and uses the resulting temp creds for `ecr:GetAuthorizationToken` + `docker pull`. Required for cross-account pulls when the caller's identity does not already have direct cross-account access. Same-account / same-region pulls do not need this flag; cross-account without the flag falls back to the caller's credentials (succeeds when an IAM resource policy on the ECR repo grants the caller directly, else AWS surfaces `AccessDenied`). No-op when `--no-pull` is set. |
| `--layer-role-arn <arn>` | — | Role to `sts:AssumeRole` before calling `lambda:GetLayerVersion` on every literal-ARN entry in `Properties.Layers`. Use only when the developer's own credentials cannot read the layer — typically a cross-account layer. AWS-published public layers (e.g. Lambda Powertools) are readable from every account and need no role. No-op for stacks whose layers are all same-stack `AWS::Lambda::LayerVersion` references. |
| `--debug-port <port>` | off | Set `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` and publish the port; attach a Node debugger to step through the handler. |
| `--container-host <host>` | `127.0.0.1` | Host to bind the RIE port to. |
| `--assume-role [arn]` | off | STS-assume the deployed function's execution role and forward the resulting temp credentials to the container, so the handler runs under the deployed role's narrow permissions instead of the developer's typically-admin shell credentials. Three forms: (1) `--assume-role <arn>` assumes the explicit ARN (precedence wins); (2) `--assume-role` (bare) auto-resolves the function's `Properties.Role` from cdkd state (requires `--from-state`); (3) `--no-assume-role` explicitly opts out (forces dev creds even with `--from-state`). Off by default — when omitted, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` are passed through unchanged (SAM-compatible default). STS failures degrade to a warn + dev-creds fallback. |
| `-a, --app <cmd-or-dir>` | — | CDK app command or pre-synthesized `cdk.out` directory. Default: synth every time (Q2 recommendation C). Pass `-a cdk.out` to skip synthesis when iterating. |
| `--output <dir>` | `cdk.out` | Output directory for synthesis. |
| `--from-state` | off | Read cdkd's S3 state for the target stack and substitute `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join` placeholders + AWS pseudo parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` / `${AWS::URLSuffix}`) in env vars with the deployed physical IDs / attributes. Off by default — keeps PR 1's literal-only / warn-and-drop behavior. See [State-driven env recovery (`--from-state`)](#state-driven-env-recovery-from-state) below. |
| `--from-cfn-stack [cfn-stack-name]` | off | Read a deployed CloudFormation stack via `DescribeStackResources` and substitute `Ref` / `Fn::ImportValue` placeholders in env vars with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). Bare form uses the cdkd stack name; pass an explicit value when the CFn stack name differs. **Mutually exclusive with `--from-state`** — pick one source. `Fn::GetAtt` in a consumer Lambda's own env vars is recovered from the deployed function config (`lambda:GetFunctionConfiguration`, via `cdk-local@0.10.0`); `Fn::GetAtt` at other sites still warn-and-drops, except a same-stack ECR repository's `Arn` / `RepositoryUri` in a container image URI (synthesized from the recovered physical name + pseudo parameters). See [CloudFormation-driven env recovery (`--from-cfn-stack`)](#cloudformation-driven-env-recovery-from-cfn-stack) below. |
| `--state-bucket <bucket>` | auto | S3 bucket containing cdkd state. Falls back to `CDKD_STATE_BUCKET` env or `cdk.json context.cdkd.stateBucket`, then the default `cdkd-state-{accountId}`. Only used with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Only used with `--from-state`. |
| `--stack-region <region>` | auto | Region of the state record to read. Required for `--from-state` when the same stack name has state in multiple regions. Also drives the CFn client region for `--from-cfn-stack` (cdkd does not have a separate `--cfn-stack-region` flag). |

### Environment variables

Template `Properties.Environment.Variables` entries:

- **Literal values** (string / number / boolean) are passed through as-is.
- **Intrinsic-valued entries** (`Ref` / `Fn::GetAtt` / `Fn::Sub` /
  `Fn::Join`, plus the `${AWS::AccountId}` / `${AWS::Region}` /
  `${AWS::Partition}` / `${AWS::URLSuffix}` pseudo parameters) need state
  (and a single `sts:GetCallerIdentity` for `${AWS::AccountId}`) to
  resolve. Without `--from-state` v1 emits a warning naming the variable
  and **drops** it (rather than silently substituting garbage); pass
  `--from-state` (see below) to recover deployed values from cdkd's S3
  state, or override intrinsics via `--env-vars`.

Standard Lambda runtime env vars are always set: `AWS_LAMBDA_FUNCTION_NAME`,
`AWS_LAMBDA_FUNCTION_MEMORY_SIZE`, `AWS_LAMBDA_FUNCTION_TIMEOUT`,
`AWS_LAMBDA_FUNCTION_VERSION`, `AWS_LAMBDA_LOG_GROUP_NAME`,
`AWS_LAMBDA_LOG_STREAM_NAME`. The handler's `context.*` fields look real.

### State-driven env recovery (`--from-state`)

When the target stack has been deployed with `cdkd deploy`, the function's
intrinsic-valued env vars (`Ref` / `Fn::GetAtt` / `Fn::Sub`) reference
resources whose physical IDs only exist in AWS. PR 1's behavior is to
drop those entries with a warn — correct when there's no source of
truth, but unhelpful when cdkd already knows them. `--from-state` opts
in to reading cdkd's S3 state and substituting the deployed values
before the env block reaches the container.

**Resolution priority** (highest priority wins):

1. `--env-vars` file function-specific entry (`{LogicalId: {KEY: VALUE}}`).
2. `--env-vars` file global `Parameters` block.
3. `--from-state` substituted intrinsic (when the flag is set AND the
   template entry was a supported intrinsic AND substitution succeeded).
4. Template literal value.

**Supported intrinsics**: `Ref` (→ `state.resources[id].physicalId`),
`Fn::GetAtt` (→ `state.resources[id].attributes[attr]`, JSON-stringified
when the cached value is an object/array), `Fn::Sub` (single-string and
two-arg forms; `${LogicalId}` / `${LogicalId.attr}` / `${AWS::*}`
placeholders are substituted in place — the two-arg form's bindings map
can also carry intrinsic values, recursively resolved), `Fn::Join`
(every element recursively resolved, then joined), and `Ref: AWS::*`
pseudo parameters (`AccountId` / `Region` / `Partition` / `URLSuffix`)
resolved against STS `GetCallerIdentity` + the configured region.

**Failure mode**: per-key best-effort. When a substitution can't be
produced (state missing for the referenced resource, attribute not
captured at deploy time, unsupported intrinsic in `Fn::Sub`), the key
is reported via warn and dropped — same UX as PR 1. State-load
failures (no state record, multi-region ambiguity without
`--stack-region`, bucket-resolution error) degrade to warn-and-fall-back
rather than aborting the whole invoke.

**Auto-assume execution role**: when `--from-state` is paired with bare
`--assume-role` (no ARN argument), cdkd reads the function's
`Properties.Role` from cdkd state, resolves `Fn::GetAtt: [<RoleId>, 'Arn']`
shapes against the sibling IAM Role resource's recorded `Arn` attribute,
and STS-assumes that role automatically — no manual ARN lookup required.
When `--from-state` is set WITHOUT `--assume-role`, the legacy hint path
fires instead: cdkd logs the deployed role ARN once so users can re-run
with `--assume-role`. Pass `--no-assume-role` to explicitly opt out even
with `--from-state`; pass `--assume-role <arn>` to override the resolved
ARN with an explicit one. STS failures (insufficient permissions /
trust-policy mismatch) degrade to a warn + dev-creds fallback — this is
a developer-loop tool, not a security boundary.

**Pseudo parameters**: when the function's template env contains any
intrinsic value, `cdkd local invoke --from-state` issues a single
`sts:GetCallerIdentity` (for `${AWS::AccountId}`) and derives
`partition` / `urlSuffix` from the resolved region (`--region` >
`AWS_REGION` > `AWS_DEFAULT_REGION` > the synth-derived stack region).
STS failures degrade to warn — substitution still runs for non-`AWS::*`
refs; affected `${AWS::*}` placeholders fall back to warn + drop.
Literal-only env maps skip the STS hop.

**Out of scope** (deferred): cross-stack `Fn::ImportValue` /
`Fn::GetStackOutput`, other intrinsics (`Fn::Select`, `Fn::Split`,
`Fn::If`, etc.). Anything beyond the listed supported intrinsics is
treated as unresolved (warn + drop).

```bash
# Single-region stack: --from-state alone is enough
cdkd deploy MyStack
cdkd local invoke MyStack/MyApi/Handler --from-state

# Multi-region: disambiguate the state record
cdkd local invoke MyStack/MyApi/Handler --from-state --stack-region us-west-2

# Combine with --env-vars to override a single key (override wins)
cdkd local invoke MyStack/MyApi/Handler --from-state \
  --env-vars '{"Parameters":{"DEBUG":"1"}}'
```

### CloudFormation-driven env recovery (`--from-cfn-stack`)

`--from-state` only works when the target stack was deployed via `cdkd
deploy` — cdkd reads its own S3 state and that state only exists for
cdkd-deployed stacks. For CDK apps deployed via the upstream CDK CLI
(`cdk deploy` → CloudFormation), use `--from-cfn-stack` instead: cdkd
calls `cloudformation:DescribeStackResources` against the named CFn
stack to populate the same per-logical-id physical-id map that
`--from-state` would have built from cdkd state, then runs the existing
substitution engine against it.

```bash
# Bare flag — uses the cdkd stack name as the CFn stack name
# (typical for CDK apps where they match).
cdk deploy MyStack
cdkd local invoke MyStack/MyApi/Handler --from-cfn-stack

# Explicit CFn stack name — use when the deployed CFn stack name
# differs from the cdkd / CDK display name (e.g. when CDK's `stackName`
# prop was overridden).
cdkd local invoke MyStack/MyApi/Handler --from-cfn-stack MyExplicitCfnStackName

# Cross-region CFn stack — --stack-region drives the CFn client region.
cdkd local invoke MyStack/MyApi/Handler --from-cfn-stack --stack-region eu-west-1
```

**What's resolved**: `Ref: <LogicalId>` against
`DescribeStackResources` (one CFn API call per stack) and
`Fn::ImportValue: <ExportName>` against `cloudformation:ListExports`
(paginated, memoized for one substitution pass).

**`Fn::GetAtt` is recovered for a consumer Lambda's OWN env vars; other
sites warn-and-drop.** CFn's `DescribeStackResources` does NOT return
per-attribute values — it only exposes `(LogicalResourceId,
PhysicalResourceId, ResourceType)` triplets. But CloudFormation already
resolved every intrinsic at deploy time, so a consumer Lambda's
`Environment.Variables` already carries the concrete value. As of
`cdk-local@0.10.0` (which cdkd consumes through the `--from-cfn-stack`
shim), env keys whose template value is an `Fn::GetAtt` the static
substituter could not resolve are filled at runtime by reading the
deployed function's config (`lambda:GetFunctionConfiguration`) — this
covers `Fn::GetAtt` / `Fn::Sub` / `Fn::ImportValue` / cross-stack `Ref`
in Lambda env vars uniformly, without provider-specific describe calls.
`Fn::GetAtt` at NON-Lambda-env sites (e.g. ECS container env) is still
warn-and-dropped; override the affected entry via `--env-vars` if the
value is critical.

**`Fn::GetStackOutput` is rejected** with a clear warn naming the cdkd-
vs-CFn gap: it's a cdkd-specific intrinsic with no CloudFormation
equivalent (CFn cross-stack vocabulary is `Fn::ImportValue` against an
explicit `Outputs.<name>.Export` block). Use `Fn::ImportValue` or pass
`--from-state` instead.

**Mutually exclusive with `--from-state`** — the CLI rejects the
combination at parse time. The two flags target different state
sources (cdkd's S3 state vs CloudFormation); asking for both is
ambiguous about which wins.

**Region handling**: the CFn client is region-bound at construction
time using the precedence `--stack-region` > `--region` > `AWS_REGION`
> `AWS_DEFAULT_REGION` > the synth-derived stack region. There is
intentionally no separate `--cfn-stack-region` flag — `--stack-region`
does double duty. When NONE of these signals is set the CLI **throws**
with a remediation message (distinct from `--from-state`'s silent
`us-east-1` fallback; CFn `DescribeStackResources` queries a specific
region and silently picking `us-east-1` would query the wrong stack
environment).

**Multi-stack guard**: `local start-api` / `local start-service` route
multiple stacks in one invocation. Bare `--from-cfn-stack` works there
because each routed stack uses its own cdkd stack name as the CFn
stack name. **Explicit `--from-cfn-stack <name>` is rejected** when
more than one stack is routed (the explicit name would apply to every
routed stack and silently mismap `Ref` lookups whose logical IDs
happen to collide between siblings). Use bare `--from-cfn-stack` for
multi-stack apps, or run one cdkd invocation per stack.

**Failure modes**: `DescribeStackResources` failures (stack not found,
access denied, throttling) degrade to a per-key warn + drop, same UX as
the `--from-state` warn-and-fall-back path. `ListExports` failures only
affect `Fn::ImportValue` resolution; same-stack `Ref` substitutions
still succeed because they only need the `DescribeStackResources`
result.

### Asset resolution

**ZIP Lambdas**: cdkd uses the CDK-blessed `Metadata['aws:asset:path']`
hint on each Lambda's CFn resource (the same source SAM uses) to find
the local unzipped asset directory under `cdk.out`, and bind-mounts it
at `/var/task` read-only. `Code.ZipFile` (inline) functions are
materialized to a tmpdir using the file path implied by the function's
`Handler` property (`index.handler` → `tmpdir/index.js`).

### Lambda Layers

Same-stack `AWS::Lambda::LayerVersion` references in
`Properties.Layers` are resolved automatically and bind-mounted at
`/opt` (read-only) inside the container. The flow:

1. `cdkd local invoke` walks `Properties.Layers` left-to-right.
2. Each entry must be `{Ref: '<LayerLogicalId>'}` or
   `{Fn::GetAtt: ['<LayerLogicalId>', 'Ref']}` pointing at an
   `AWS::Lambda::LayerVersion` resource in the same stack. The layer's
   `Metadata['aws:asset:path']` is read the same way Lambda code is
   located — the layer asset is unzipped under `cdk.out/asset.<hash>/`
   ready to bind-mount.
3. cdkd produces a single bind mount at `/opt`:
   - **Single layer**: the layer's asset dir is bind-mounted directly
     (no copy).
   - **Multiple layers**: each layer's contents are copied into a
     freshly-allocated tmpdir IN ORDER (later layers overwrite earlier
     files via `cpSync({force: true})`); the merged tmpdir is then
     bind-mounted at `/opt` and removed in the cleanup path.
   - The merge mirrors AWS Lambda's actual runtime behavior: AWS
     extracts every layer ZIP into `/opt` in template order so later
     layers shadow earlier files (**"last layer wins on file
     collision"**). cdkd cannot rely on multiple `-v ...:/opt:ro`
     entries — Docker rejects duplicate bind mounts at the same target
     path with `Error response from daemon: Duplicate mount point: /opt`.
4. The layer's directory layout (`/opt/python/...`,
   `/opt/nodejs/...`, `/opt/lib/...`, etc.) is the user's
   responsibility — cdkd does NOT inspect the contents.

**Literal-ARN layer entries**: a `Layers` entry
that is the string
`arn:<partition>:lambda:<region>:<account>:layer:<name>:<version>` is
resolved by downloading that layer version's ZIP and unzipping it into a
host tmpdir, which then joins the same `/opt` merge as same-stack layers
— so "last layer wins" holds across both kinds. This covers
AWS-published public layers (Lambda Powertools, the Datadog extension)
and cross-account / cross-region shared layers. Pass
`--layer-role-arn <arn>` to `sts:AssumeRole` before
`lambda:GetLayerVersion` when the developer's own credentials cannot
read the layer — typically a cross-account one; AWS-published public
layers are readable from every account and need no role.

The ARN's **partition is derived from its region** rather than matched
against a hardcoded list, so the ARN in any of the eight partitions —
commercial, `aws-cn`, `aws-us-gov`, `aws-iso`, `aws-iso-b`, `aws-iso-e`,
`aws-iso-f`, `aws-eusc` — now PARSES; previously only three did, and
the other five were refused outright at resolution. The two segments must
also AGREE: `arn:aws-cn:lambda:us-east-1:...` is refused, naming the
disagreement, because `us-east-1` does not belong to `aws-cn`. A region
cdkd's partition table does not recognise resolves to the commercial
partition, so a brand-new commercial region keeps working with `arn:aws:`.

> **Parsing is not the whole path, and the rest is still commercial-only.**
> The download itself runs through cdk-local, which rebuilds the ARN with a
> hardcoded `aws` partition before calling `lambda:GetLayerVersion`
> (`node_modules/cdk-local/dist/local-studio-BBtUAVNy.js:15214` —
> `` `arn:aws:lambda:${layer.region}:${layer.accountId}:layer:${layer.name}` ``).
> So a layer ARN in any of the seven non-commercial partitions gets past
> cdkd's parse and then fails at the AWS call instead. `aws-cn` and
> `aws-us-gov` already parsed before this change and gain nothing from it;
> for the five that did not (`aws-iso`, `aws-iso-b`, `aws-iso-e`,
> `aws-iso-f`, `aws-eusc`) what changed is WHICH failure you get — an
> AWS-side error naming the real blocker, rather than cdkd refusing to read
> the ARN at all. End-to-end support for those partitions needs an
> upstream cdk-local fix.

**Out of scope (v1)** — hard-errors with a clear pointer at the
offending entry:

- Layer entries that are neither a same-stack reference nor a
  well-formed layer-version ARN (a malformed ARN, a function ARN, an
  unversioned layer ARN, or a partition that disagrees with the region).
- Same-stack refs that don't point at an `AWS::Lambda::LayerVersion`
  (typo'd logical ID).
- Same-stack refs to a `LayerVersion` whose `Metadata['aws:asset:path']`
  is missing.

**Container Lambdas** (`Code.ImageUri`): the `Layers` property is
silently ignored — matches AWS behavior, since container images bake
their layers at build time and AWS rejects `Layers` on container
Lambdas at deploy time.

**Container Lambdas** (`Code.ImageUri`): cdkd extracts the asset hash
from the `:<hash>` tail of the image URI (CDK synthesizes the URI as a
`Fn::Sub` whose body ends in the asset hash) and looks the matching
entry up in the stack's asset manifest (`cdk.out/<stack>.assets.json`,
`dockerImages[<hash>]`). When the lookup hits, `cdkd local invoke` calls
`docker build` against the recorded build context. When the lookup
misses AND the manifest contains exactly one Docker asset, that single
asset is used (single-asset fallback — covers digest-pinned URIs). When
both miss, cdkd falls back to **ECR pull** with cross-account /
cross-region support: cdkd builds the ECR client for the URI's region
and (when `--ecr-role-arn <arn>` is passed) issues `sts:AssumeRole` to
gain credentials in the target account before authenticating to ECR
and pulling. Without `--ecr-role-arn`, cdkd uses the caller's
credentials directly (works when the ECR repo's resource policy grants
the caller, else AWS surfaces `AccessDenied` with a hint at the flag).
`ImageConfig.Command` becomes the docker run
CMD; `ImageConfig.EntryPoint` (when set) becomes `--entrypoint <first>`
plus the rest as positional args; `ImageConfig.WorkingDirectory` becomes
`--workdir`. When `EntryPoint` is unset (the common case), the image's
default entrypoint stays in charge — for AWS Lambda base images that's
`/lambda-entrypoint.sh`, which routes to RIE on port 8080.

### Ephemeral storage (`/tmp` cap)

When a Lambda's template declares `Properties.EphemeralStorage.Size`
(typical CDK shape:
`new lambda.Function(this, 'X', { ephemeralStorageSize: cdk.Size.gibibytes(2) })`),
`cdkd local invoke` adds `--tmpfs /tmp:rw,size=<N>m` to the `docker run`
command so the container's `/tmp` is a memory-backed filesystem capped
at the templated value (`N` MiB; `cdk.Size.gibibytes(2)` serializes to
`2048`). Handlers that exceed the deployed cap fail locally with
`ENOSPC` the way they would on AWS, and handlers that detect free space
via `statvfs` / `df` see the configured cap rather than the host's
overlay-fs.

Applies to both ZIP and IMAGE (container) Lambdas — `--tmpfs` overlays
mount-time inside any container regardless of base image. Container
Lambdas get an `[info]` log line at startup so users notice the
`/tmp` override on top of whatever their Dockerfile placed there.

When `EphemeralStorage` is absent, no `--tmpfs` is emitted and the
container's `/tmp` is whatever the base image provides (AWS Lambda
base images don't mount a sized tmpfs themselves, so the existing
behavior is preserved). Templates over the AWS 10240 MiB (10 GiB)
ceiling hard-error at resolve time with an actionable message rather
than hanging on a `docker run` that AWS would have refused anyway.
Intrinsic-valued `Size` entries (the `{Ref: 'SomeParam'}` shape) drop
silently to no-`--tmpfs` since local invoke cannot resolve them
without the Parameters context the deploy engine has.

The same cap applies to `cdkd local start-api`'s warm container pool
— each cold-started container for a Lambda with `EphemeralStorage`
gets the same sized `/tmp`.

### Reaching a server on the host (`host.docker.internal`)

The Lambda container can reach a server bound on the host loopback — an
`AWS_ENDPOINT_URL_*` local endpoint (e.g. a local DynamoDB / S3 mock), or a
tunneled VPC resource — via the `host.docker.internal` hostname. Docker
Desktop (macOS / Windows) resolves it natively; on Linux native dockerd cdkd
injects the `--add-host host.docker.internal:host-gateway` mapping
automatically (Docker 20.10+). On an older / unavailable daemon the mapping is
silently skipped (never an error). The same applies to `cdkd local run-task`
container runs, and — inherited from cdk-local's ECS service emulator engine —
to `cdkd local start-service` / `cdkd local start-alb`.

### `local invoke` / `local invoke-agentcore` output streams

**Everything cdkd's own logger prints goes to stderr.** Both commands reserve
stdout unconditionally, so every cdkd status line -- `Synthesizing CDK
app...`, `Target: ...`, `Starting container ...`, layer resolution notices,
and cdkd's `--verbose` debug output -- goes to **stderr**, the way
`sam local invoke` has always done it. The lines are moved, not suppressed:
a terminal shows what it always did, and `2>&1` restores the old
single-stream view.

**But stdout is not yet payload-only, so pipe through `tail -1`.** Two
things still reach it, neither routed by cdkd's logger:

1. **The container's own stdout**, piped through by `streamLogs`. The Lambda
   runtime emulator puts `START` / `END` / `REPORT` *and* every handler log
   line on the container's stdout -- `console.error` included, which is
   measured rather than assumed -- so any handler that prints lands ahead of
   the response.
2. **cdk-local's own logger.** The container-image build path is reused from
   cdk-local, which has a separate logger with no reservation concept, so
   `Building container image (platform=...)` and `Skipping docker build ...`
   print on stdout for a container-image Lambda.

A third used to be listed here and is now closed: `docker pull` progress
reached stdout because `runDockerForeground` passes `stdio: 'inherit'`, and
`cdkd` runs it unconditionally for an ECR image, so it needed no flag at all.
While a command holds the reservation that child's fd 1 is now redirected to
fd 2. The remaining gap is `streamLogs` alone.

```bash
# Safe today: the response payload is always the LAST line on stdout.
cdkd local invoke MyStack/Handler --event event.json | tail -1 | jq .body
cdkd local invoke-agentcore MyStack/Agent 2> progress.log | tail -1
```

A ZIP-code Lambda whose handler prints nothing hits neither, so
`cdkd local invoke MyStack/Handler | jq` does work there -- it is just not a
guarantee cdkd can make yet for every target.

`local start-api`, `local run-task` and `local start-service` are unaffected --
their stdout is a human surface (route table, prefixed container logs), not a
payload.

### `local invoke` exit codes

- `0` — RIE answered, regardless of whether the handler returned a
  success payload OR an error payload. Lambda-style: a thrown handler
  produces a 200 with an error structure on AWS, and we mirror that.
- `1` — cdkd-side errors before/after the handler ran: Docker not
  installed, image pull failed, target not found, RIE port unreachable
  after the readiness window, container exited before responding.

### v1 scope (out of scope, deferred)

| Out of scope | Deferred to |
| --- | --- |
| Java / Go / Ruby / .NET runtimes | Future PRs |
| Cross-account / cross-region / pre-existing-ARN Lambda Layers | Shipped — same-stack `AWS::Lambda::LayerVersion` refs and literal layer-version ARNs are both resolved, the latter by downloading the layer version; see the "Lambda Layers" section above |
| Cross-stack `Fn::ImportValue` / `Fn::GetStackOutput` in `--from-state` | Future PR |
| `Fn::Select` / `Fn::Split` / `Fn::If` etc. in `--from-state` | Future PR (warn + drop today) |
| SQS / S3 event source emulation | Future PR |
| VPC simulation | Never (local can't replicate VPC) |
| Custom Resources (`Custom::*`) | Never — these are invoked by the deploy framework, not by users. cdkd surfaces a clear error pointing at the underlying ServiceToken Lambda. |

