# Local execution

`cdkd local *` runs AWS workloads on the developer's machine via Docker
— no AWS deploy, no `template.yaml` to maintain, no `cdk synth | sam ...`
round-trip. Reuses cdkd's synthesis / asset / construct-path plumbing
directly.

## Subcommands

| Subcommand | Emulates | Backed by |
| --- | --- | --- |
| `cdkd local invoke <target>` | One-shot Lambda invoke | AWS Lambda Runtime Interface Emulator (RIE) container |
| `cdkd local start-api` | Long-running API Gateway (REST v1 / HTTP API / Function URL) | RIE container pool + `node:http` listener (one server per discovered API) |
| `cdkd local run-task <target>` | ECS `RunTask` for one task | docker network + ECS metadata sidecar (`amazon/amazon-ecs-local-container-endpoints`) |

## Requirements

All `cdkd local *` commands require Docker on the developer's machine.
The first run pulls the relevant base image (~600MB for the
language-specific Lambda images, ~50MB for `provided.*`, plus the ECS
metadata sidecar for `run-task`). Subsequent runs reuse the cached
image; pass `--no-pull` to skip the `docker pull` round-trip
altogether (per-command `--no-pull` semantics may differ — see each
section below).

## Common flags

Shared across all three subcommands:

- `-a, --app <cmd-or-dir>` — CDK app command or pre-synthesized
  `cdk.out` directory. Defaults to synth-every-time; pass `-a cdk.out`
  to iterate faster.
- `--env-vars <file>` — SAM-compatible JSON override:
  `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. `null` clears a
  key.
- `--no-pull` — Skip `docker pull` (per-command semantics differ;
  consult each section).
- `--from-state` — Resolve intrinsic-valued properties against cdkd's
  deployed S3 state. Off by default; the target stack must have been
  deployed via `cdkd deploy` first.
- `--stack-region <region>` — Disambiguate when the same stack name
  has cdkd state in multiple regions (only with `--from-state`).
- `--container-host <ip>` — Bind IP for published ports (default
  `127.0.0.1`). Must be a numeric IP; Docker rejects hostnames in
  `-p <ip>:<port>:<port>`.

## `local invoke` (run Lambda functions locally)

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

**Container Lambdas (PR 5 of #224)** — `lambda.DockerImageFunction(...)` /
`Code.ImageUri` is supported in addition to ZIP Lambdas. cdkd reads the
function's local `Dockerfile` from `cdk.out` (via the asset manifest
keyed off the `:<hash>` suffix on `Code.ImageUri`) and runs `docker build`
locally, then `docker run` against the resulting image. When no asset
matches (typically: invoking a stack deployed elsewhere), cdkd falls back
to `docker pull` from ECR — **same-account / same-region only** in v1.
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
| `--env-vars <file>` | — | JSON env-var overrides, SAM-compatible shape: `{"LogicalId":{"KEY":"VALUE"}}` plus an optional top-level `"Parameters"` block applied to every invoke. `null` clears a key. |
| `--no-pull` | off | Skip `docker pull`. Semantics differ by code path: **ZIP Lambdas** — skip pulling the public Lambda base image. **Container Lambdas, local-build path** — no-op (docker build's default does not refresh the FROM cache). **Container Lambdas, ECR-pull fallback** — skip `docker pull` AND error if the image is not in the local cache (re-run without `--no-pull` or pre-pull manually). |
| `--no-build` | off | Skip `docker build` on the **Container Lambdas, local-build path** (`Code.ImageUri`). Requires the deterministic `cdkd-local-invoke-<hash>` tag to already be in the local docker registry from a prior `cdkd local invoke` (or manual `docker build`); errors clearly when missing. **No-op for ZIP Lambdas** (no docker build runs there) AND for the **Container Lambdas, ECR-pull fallback** (use `--no-pull` to control that path). Compatible with `--no-pull`. |
| `--debug-port <port>` | off | Set `NODE_OPTIONS=--inspect-brk=0.0.0.0:<port>` and publish the port; attach a Node debugger to step through the handler. |
| `--container-host <host>` | `127.0.0.1` | Host to bind the RIE port to. |
| `--assume-role [arn]` | off | STS-assume the deployed function's execution role and forward the resulting temp credentials to the container, so the handler runs under the deployed role's narrow permissions instead of the developer's typically-admin shell credentials. Three forms: (1) `--assume-role <arn>` assumes the explicit ARN (precedence wins); (2) `--assume-role` (bare) auto-resolves the function's `Properties.Role` from cdkd state (requires `--from-state`); (3) `--no-assume-role` explicitly opts out (forces dev creds even with `--from-state`). Off by default — when omitted, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION` are passed through unchanged (SAM-compatible default). STS failures degrade to a warn + dev-creds fallback. |
| `-a, --app <cmd-or-dir>` | — | CDK app command or pre-synthesized `cdk.out` directory. Default: synth every time (Q2 recommendation C). Pass `-a cdk.out` to skip synthesis when iterating. |
| `--output <dir>` | `cdk.out` | Output directory for synthesis. |
| `--from-state` | off | Read cdkd's S3 state for the target stack and substitute `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join` placeholders + AWS pseudo parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` / `${AWS::URLSuffix}`) in env vars with the deployed physical IDs / attributes. Off by default — keeps PR 1's literal-only / warn-and-drop behavior. See [State-driven env recovery (`--from-state`)](#state-driven-env-recovery---from-state) below. |
| `--state-bucket <bucket>` | auto | S3 bucket containing cdkd state. Falls back to `CDKD_STATE_BUCKET` env or `cdk.json context.cdkd.stateBucket`, then the default `cdkd-state-{accountId}`. Only used with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Only used with `--from-state`. |
| `--stack-region <region>` | auto | Region of the cdkd state record to read. Required when the same stack name has state in multiple regions. Only used with `--from-state`. |

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

**Out of scope (v1)** — hard-errors with a clear pointer at the
offending entry:

- Literal-ARN layer entries (`arn:aws:lambda:...`) — these are external
  / pre-existing layers including cross-account / cross-region. No
  asset on disk to mount; deferred to a follow-up PR.
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
both miss, cdkd falls back to **ECR pull** — same-account / same-region
only; cross-account / cross-region pulls hard-error with a pointer at
the deferred follow-up PR. `ImageConfig.Command` becomes the docker run
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
base images don't mount a sized tmpfs themselves, so the pre-#440
behavior is preserved). Templates over the AWS 10240 MiB (10 GiB)
ceiling hard-error at resolve time with an actionable message rather
than hanging on a `docker run` that AWS would have refused anyway.
Intrinsic-valued `Size` entries (the `{Ref: 'SomeParam'}` shape) drop
silently to no-`--tmpfs` since local invoke cannot resolve them
without the Parameters context the deploy engine has.

The same cap applies to `cdkd local start-api`'s warm container pool
— each cold-started container for a Lambda with `EphemeralStorage`
gets the same sized `/tmp`.

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
| Cross-account / cross-region / pre-existing-ARN Lambda Layers | Future PR (same-stack `AWS::Lambda::LayerVersion` refs are supported in v1; literal ARNs hard-error — see "Lambda Layers" section above) |
| Cross-account / cross-region ECR pull for container Lambdas | Future PR (same-account / same-region only in v1) |
| Cross-stack `Fn::ImportValue` / `Fn::GetStackOutput` in `--from-state` | Future PR |
| `Fn::Select` / `Fn::Split` / `Fn::If` etc. in `--from-state` | Future PR (warn + drop today) |
| SQS / S3 event source emulation | Future PR |
| VPC simulation | Never (local can't replicate VPC) |
| Custom Resources (`Custom::*`) | Never — these are invoked by the deploy framework, not by users. cdkd surfaces a clear error pointing at the underlying ServiceToken Lambda. |

## `local start-api` (long-running local API server)

`cdkd local start-api` stands up a long-running HTTP server that maps
synthesized API Gateway routes (REST v1, HTTP API, Function URL) to
local Lambda invocations against the AWS Lambda Runtime Interface
Emulator. Modeled on `sam local start-api` but reusing cdkd's
synthesis, asset, and route-discovery plumbing — no `template.yaml`
round-trip.

**Requires Docker.** As with `cdkd local invoke`, the first run pulls
the Lambda base image (~600MB once per machine). Pass `--no-pull` on
subsequent runs to skip the layer check.

```bash
cdkd local start-api                              # auto-allocate one port PER discovered API
cdkd local start-api --port 3000                  # first API → 3000, second API → 3001, ...
cdkd local start-api MyAdminApi                   # logical id (single-stack apps)
cdkd local start-api MyStack/MyAdminApi           # OR: CDK Construct path (prefix-matched)
cdkd local start-api --warm                       # pre-start one container per Lambda
```

### One server per API (v0.81+)

Every discovered API surface (`AWS::ApiGatewayV2::Api`,
`AWS::ApiGateway::RestApi`, `AWS::Lambda::Url`) gets its own HTTP
server on its own port. cdkd prints one `Server listening on
http://<host>:<port>  (<API> (<kind>))` line per server at startup,
and one route table per server underneath.

This is a deliberate departure from `sam local start-api`'s
single-server-per-template model: realistic CDK apps usually define
multiple APIs (admin + public, internal + external) with different
authorizer setups, different CORS configs, and overlapping paths.
Lumping them into one server forced an awkward "first-match-wins"
semantic that didn't mirror AWS Lambda's actual routing. Pre-v0.81
versions did this — see [issue #260](https://github.com/go-to-k/cdkd/issues/260)
for the background.

Port assignment:

| `--port` value | Per-API port allocation |
| --- | --- |
| `0` (default) | Every server auto-allocates its own port. |
| `3000` | First API → `3000`, second API → `3001`, third → `3002`, ... |

Pass an optional positional `<target>` to launch exactly one server
for the named API. The same target syntax `cdkd local invoke` /
`cdkd local run-task` use applies here — the whole `cdkd local *`
family addresses resources consistently:

1. **Bare logical id** — `MyHttpApi`. **Single-stack apps only**;
   in multi-stack apps cdkd rejects this form with the same
   disambiguation hint `local invoke` / `local run-task` produce.
   The id is the HTTP API / REST API logical id, or (for Function
   URLs) the backing Lambda's logical id.
2. **Stack-qualified logical id** — `MyStack:MyHttpApi`. Works in
   any app size; required when the same bare id exists in two stacks.
3. **CDK Construct path / display path** — `MyStack/MyHttpApi/Resource`.
   Exact match against the resource's `aws:cdk:path` metadata.
4. **CDK Construct path prefix** — `MyStack/MyHttpApi`. Matches when
   the input is a strict ancestor of the resource's `aws:cdk:path`
   (same prefix rule `cdkd orphan` uses): CDK's
   `new apigw2.HttpApi(stack, 'MyHttpApi')` synthesizes the L1 child
   at `MyStack/MyHttpApi/Resource`, so `cdkd local start-api MyStack/MyHttpApi`
   resolves cleanly without having to type the synthesized
   `/Resource` suffix.

For Function URLs, the path forms reference the **backing Lambda's**
`aws:cdk:path`, not the auto-generated URL resource — so
`cdkd local start-api MyStack/MyHandler` matches the Function URL
declared by `new lambda.Function(this, 'MyHandler').addFunctionUrl()`.

Routes from templates without `aws:cdk:path` metadata (hand-rolled
`cfn.Resource` defs, or older CDK that didn't emit the metadata)
still match by bare logical id (form 1) and by stack-qualified logical
id (form 2) — only the path forms (3, 4) need the metadata.

**Deprecated `--api <id>` alias.** Earlier versions used a `--api`
flag for the same purpose. The flag is still accepted in this release
(emitting a deprecation warn on use) and accepts the same four forms;
it will be removed in a future major release. Migrate scripts /
CI to the positional form. Passing both positional and `--api`
at once produces an error — they're mutually exclusive.

### Discovered routes

| Source | CFn types |
| --- | --- |
| HTTP API | `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Integration` |
| REST v1 | `AWS::ApiGateway::RestApi`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Stage` |
| Function URL | `AWS::Lambda::Url` |

Per-route classification (boot never aborts on per-integration
unsupportedness):

| Class | Trigger | Behavior |
| --- | --- | --- |
| Normal | AWS_PROXY integration with a resolvable Lambda Arn | Dispatched to the Lambda via the container pool. |
| Synthetic CORS preflight | REST v1 `HttpMethod: OPTIONS` + `Integration.Type: MOCK` + `IntegrationResponses[].ResponseParameters` carries literal `method.response.header.*` pairs (the shape CDK's `defaultCorsPreflightOptions` synthesizes) | Captured at boot. The HTTP server returns the captured status + headers directly on OPTIONS without invoking any Lambda. |
| Deferred-error unsupported | Non-AWS_PROXY REST v1 integrations (`MOCK` not matching the CORS preflight subset, `AWS`, `HTTP`, `HTTP_PROXY`); HTTP API v2 service integrations (`IntegrationSubtype` set); WebSocket APIs (`ProtocolType: WEBSOCKET`); Function URLs with `AuthType !== 'NONE'` or `InvokeMode === 'RESPONSE_STREAM'`; routes whose Lambda Arn intrinsic cannot be resolved against the same template (cross-stack / imported references) | Boot continues. The route appears in the route table tagged `[501 Not Implemented]` and a `[warn]` line per route is printed up front. When the route is hit at request time, the HTTP server returns HTTP 501 with `{"message": "Not Implemented", "reason": "<the discovery reason>"}` in the JSON body, without invoking any Lambda. |
| Hard error | Template-structural problems the discovery layer cannot generate a meaningful route from: missing `Integration` on a Method, non-Ref `RestApiId` / `ApiId`, malformed Route `Target`, ParentId chain failures, missing `PathPart`, unresolvable `TargetFunctionArn` on a Function URL | Boot aborts via `RouteDiscoveryError` with every offending route listed in a single message. |

The deferred-error class lets you run the supported subset of an API
locally even when the CDK app contains MOCK integrations, WebSocket
routes, or other unimplemented shapes — only the unsupported routes
themselves return 501; everything else dispatches as normal.

### Routing precedence

3 tiers per AWS docs: full match → greedy `{proxy+}` → `$default`.
Within "full match" tier, more literal segments win as a best-effort
tie-break (AWS does not formally specify multi-route precedence within
the same tier; cdkd uses literal-segment count as a heuristic).

### Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--port <port>` | auto-allocate | First API server's port (subsequent APIs get `port+1`, `port+2`, ...). Pass `0` (default) to auto-allocate each. The actual port assignment is printed at startup. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--api <id>` | unset | **Deprecated** — use the positional `<target>` argument instead. Same accepted forms (bare logical id, stack-qualified, Construct path, ancestor prefix). Emits a deprecation warn on use. Mutually exclusive with the positional `<target>` — passing both produces an error. Will be removed in a future major release. |
| `--stack <name>` | single-stack auto-detect | Required when the app has multiple stacks. |
| `--warm` | off | Pre-start one container per discovered Lambda at server boot. Trades RAM for first-request latency. |
| `--per-lambda-concurrency <n>` | `2` | Pool size cap per Lambda. Max 4 in v1; above-cap values are clamped with a warn. |
| `--no-pull` | off | Skip `docker pull`. |
| `--container-host <host>` | `127.0.0.1` | IP the host uses to bind/probe the RIE port. Must be a numeric IP — `docker run -p <ip>:<port>:8080` rejects hostnames like `host.docker.internal`. |
| `--debug-port-base <port>` | unset | Allocate a contiguous `--inspect-brk` port range across Lambdas (one per Lambda). |
| `--env-vars <file>` | unset | SAM-shape JSON: `{"LogicalId":{"KEY":"VALUE"}, "Parameters":{...}}`. Same format as `cdkd local invoke`. |
| `--assume-role <arn-or-pair>` | unset | Repeatable. Bare `<arn>` = global default; `<LogicalId>=<arn>` = per-Lambda override. Per-Lambda > global > unset (developer creds passed through). |
| `--watch` | off | Hot reload: re-synth + re-discover routes when `cdk.out/` or any routed Lambda's asset directory changes. 500ms debounce. Synth failures keep the previous version serving (warn-and-continue, never crashes the server). |
| `--stage <name>` | first attached | Select an API Gateway Stage by `StageName`. Drives `event.stageVariables` (REST v1 + HTTP API v2). When the override doesn't match any Stage on a given API, that API's routes get `stageVariables: null` and the CLI emits a warn line up front. |
| `--from-state` | off | Read cdkd S3 state for every routed stack and substitute `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join` placeholders + AWS pseudo parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` / `${AWS::URLSuffix}`) in Lambda env vars with the deployed physical IDs / attributes. Off by default — keeps the pre-PR literal-only / warn-and-drop behavior. Mirrors `cdkd local invoke --from-state` and `cdkd local run-task --from-state`. Re-runs against fresh state on every hot-reload firing (`--watch`). State load failures degrade per-stack to warn-and-fall-back so a missing or unreadable state file never aborts the server. |
| `--state-bucket <bucket>` | auto | S3 bucket containing cdkd state. Falls back to `CDKD_STATE_BUCKET` env or `cdk.json context.cdkd.stateBucket`, then the default `cdkd-state-{accountId}`. Only used with `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Only used with `--from-state`. |
| `--stack-region <region>` | auto | Region of the cdkd state record to read. Required when the same stack name has state in multiple regions. Only used with `--from-state`. |

### Hot reload (`--watch`)

When `--watch` is set, cdkd installs a [chokidar](https://github.com/paulmillr/chokidar)-backed
file watcher over `cdk.out/` plus every routed Lambda's asset
directory. A change in any watched path triggers a debounced (500ms
window) reload:

1. Re-run `cdk synth` (skipped when `-a <dir>` was passed at server
   boot — the directory is treated as already-synthesized).
2. Re-run route discovery, stage resolution, and CORS-config
   extraction.
3. Build per-Lambda specs + a fresh container pool.
4. Atomically swap the server state. Routes added / removed / changed
   take effect on the next request.
5. Dispose the previous pool in the background — in-flight requests
   complete against the old containers; new requests hit the new
   pool.

Synth failures during reload do NOT crash the server. The previous
version keeps serving and the CLI emits a `[warn]` line naming the
failure. Reloads serialize, so a burst of file changes coalesces to
one synth.

### CORS preflight

cdkd's HTTP server intercepts OPTIONS preflight requests for HTTP API
v2 routes whose `AWS::ApiGatewayV2::Api` has a `CorsConfiguration`:

- Match `Origin` against `AllowOrigins` (literal entries or `*`).
- Match `Access-Control-Request-Method` against `AllowMethods`.
- Match each `Access-Control-Request-Headers` entry against
  `AllowHeaders` (case-insensitive).
- Respond `204 No Content` with the canonical `Access-Control-Allow-*`
  headers, plus `Access-Control-Max-Age` / `Access-Control-Expose-Headers`
  / `Access-Control-Allow-Credentials` when configured.
- Always set `Vary: Origin` so downstream caches (browser / CDN) do
  not share the response across origins (load-bearing whenever
  `Access-Control-Allow-Origin` was derived from the request — the
  wildcard echo, literal-origin echo, and `AllowCredentials` echo
  paths all qualify).

When `AllowCredentials: true` AND the origin matched via `*`, the
response echoes the request's literal `Origin` (browser fetch spec
disallows `*` + credentials).

`Access-Control-Request-Headers` lists are validated strictly: a
malformed entry (e.g. `"Content-Type,,Authorization"` — a trailing /
embedded empty entry) rejects the preflight rather than silently
skipping the empty entry. This matches AWS's stricter HTTP API
behavior on preflight headers.

When the user has registered an explicit OPTIONS method on a path
(an `AWS::ApiGatewayV2::Route` whose `RouteKey` is `OPTIONS /...`)
**on the same API as the matched route**, preflight interception is
skipped — the user's Lambda owns the OPTIONS surface. The same-API
filter is load-bearing in multi-API stacks: an explicit OPTIONS
route on Stack B's REST v1 API at the same path no longer suppresses
preflight on Stack A's HTTP API v2.

REST v1 (`AWS::ApiGateway::*`) CORS via Mock OPTIONS methods IS
intercepted when the synthesized template matches CDK's
`defaultCorsPreflightOptions` shape: `HttpMethod: 'OPTIONS'` +
`Integration.Type: 'MOCK'` + `IntegrationResponses[].ResponseParameters`
carrying literal `method.response.header.Access-Control-Allow-*` pairs.
The headers are extracted at boot (AWS's `"'value'"` single-quote
wrappers are stripped) and the HTTP server returns the captured
status and headers directly on OPTIONS requests — no Lambda
invocation, no VTL evaluation. The default status code is 204
(matches the CDK default);
intrinsic-valued (`Fn::Sub` / `Ref` etc.) `ResponseParameters` are
dropped silently because cdkd cannot evaluate VTL locally, and if the
drop leaves zero header literals the route falls back to the deferred-
error 501 class.

Other REST v1 MOCK shapes (non-OPTIONS methods, MOCK without literal
header parameters, MOCK with VTL `RequestTemplates` that produce custom
bodies) remain in the deferred-error 501 class — emulating arbitrary
VTL mapping templates is out of scope.

### Stage variables

`event.stageVariables` is populated from the selected Stage's
`Variables` (REST v1) / `StageVariables` (HTTP API v2) map.

- **Default**: the first Stage attached to each API in template
  order.
- **`--stage <name>`**: select a Stage by `StageName`. Applied per-API
  — a `--stage prod` override against an app with three APIs picks
  the matching Stage on each. APIs without a matching Stage get
  `stageVariables: null` and surface a warn line at startup. The
  resolved stage name is threaded into `event.requestContext.stage`
  for **both** REST v1 and HTTP API v2 routes. AWS supports named
  stages on HTTP API v2 (`CreateStage` accepts any name; `$default`
  is the auto-deploy default but not the only option), so a v2
  template that pins a named Stage gets that name surfaced through
  the integration event — matching what the deployed endpoint would
  emit. v2 APIs without a templated Stage continue to use
  `'$default'`.
- **Function URL** routes don't have a Stage — `stageVariables` stays
  `null` regardless of the flag.
- **Intrinsic-valued entries** (`Ref`, `Fn::GetAtt`, `Fn::Sub`) in
  the Stage's `Variables` map are dropped with a warn (mirrors
  PR 1's env-var policy — the local server has no deploy state to
  resolve them against).

### Container lifecycle

- One pool per Lambda. Each container's RIE port is bound to its own
  free host port (`pickFreePort`); the user-facing HTTP server stays on
  the single `--port`.
- `acquire()` returns the first idle container in the pool; lazy-grows
  up to `--per-lambda-concurrency` under a per-Lambda mutex. Above the
  cap, requests queue.
- `release()` returns the container to the pool and starts a 60s idle
  timer. Idle GC fires after 60s of inactivity per pool.
- Containers are named `cdkd-local-<logicalId>-<pid>-<rand>` so an
  external sweep can mop up orphans (`docker ps --filter
  name=cdkd-local-`).

### Lambda Layers in `local start-api`

`cdkd local start-api` resolves same-stack `AWS::Lambda::LayerVersion`
references the same way `cdkd local invoke` does — see the **Lambda
Layers** section under `local invoke` above for the full rules
(supported reference shapes, last-layer-wins on file collision, the
single merged `/opt` bind mount, hard-error cases). The merge happens
once per Lambda at server boot (not per request); the merged tmpdir
is removed by the graceful shutdown path. Single-layer Lambdas skip
the copy and bind-mount the layer's asset dir directly.

### Graceful shutdown

`SIGINT` / `SIGTERM` / `uncaughtException` / `unhandledRejection` all
run the same dispose path: drain in-flight requests, tear down every
container (tolerating per-container removal failures — logged at warn,
loop continues). The verify-time `docker ps --filter` sweep is the
defense-in-depth backstop.

Double-`^C` bypasses dispose and exits immediately so the user can
escape a hung Docker daemon. The skipped containers are reported with
the `docker ps` cleanup command in the warning.

### `local start-api` exit codes

- `0` — server started cleanly and shut down on SIGTERM.
- `1` — startup failure (Docker missing, port bind failed, route
  discovery rejected) OR uncaught exception during the run.
- `130` — exited via SIGINT.

### `local start-api` authorizers

cdkd supports four authorizer kinds in front of any discovered route:

- **Lambda TOKEN** (REST v1) — `AWS::ApiGateway::Authorizer.Type: 'TOKEN'`.
  The header named in `IdentitySource` (default
  `method.request.header.Authorization`) is forwarded to the authorizer
  Lambda as `event.authorizationToken`. The Lambda's response must carry
  a `policyDocument` with at least one `{ Effect: 'Allow', Resource:
  <methodArn> }` statement; cdkd matches `Resource` against the
  request's methodArn (literal or `*`/`?` wildcard) on every request —
  cached verdicts get re-evaluated against the new methodArn so a
  narrow-Resource Allow doesn't leak across routes. Allow → context
  flat under `event.requestContext.authorizer`. Policy-deny → HTTP 403,
  missing identity header → HTTP 401 without invoking the Lambda.
- **Lambda REQUEST** — REST v1 (`Type: 'REQUEST'`) and HTTP v2
  (`AuthorizerType: 'REQUEST'`). The full request snapshot (headers,
  query string, path parameters) is passed to the authorizer Lambda.
  HTTP v2 also accepts the simple `{ isAuthorized, context }` response
  shape in addition to the IAM-policy shape. REST v1 missing-identity →
  HTTP 401 without invoking the Lambda; HTTP v2 falls through.
- **Cognito User Pool** (REST v1) — `Type: 'COGNITO_USER_POOLS'`. The
  Bearer token from `Authorization: Bearer <token>` is verified locally
  against the user pool's published JWKS. Allow → claims under
  `event.requestContext.authorizer.claims`. Deny → HTTP 403.
- **JWT** (HTTP v2) — `AuthorizerType: 'JWT'`. Same JWKS-based
  verification, with `aud` / `client_id` matched against the
  `JwtConfiguration.Audience` allowlist. Allow → claims under
  `event.requestContext.authorizer.jwt.claims`. Deny → HTTP 401.

Authorizer results are cached per `(authorizer, identity)` for the TTL
declared by the authorizer (REST v1: `AuthorizerResultTtlInSeconds`,
default 300s, max 3600s; HTTP v2: 0 by default = no cache; JWT: cached
for `min(remaining-exp, 300s)`).

**JWKS-fetch failure → pass-through.** When the JWKS endpoint is
unreachable at startup, cdkd warns and falls back to a pass-through
mode where every Bearer token is accepted as if valid (including
malformed / non-JWT garbage — a real JWT still gets its claims
surfaced into `event.requestContext.authorizer`, a malformed token
gets a synthetic `unknown` principal and an empty claims map):

```text
[warn] [cognito-jwt] JWKS unreachable at https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xyz/.well-known/jwks.json: ...
        JWT validation will allow all tokens — local dev fallback. Configure
        network access to the JWKS URL to enable real signature verification.
```

The failure entry has a short TTL (~60s) so a transient blip doesn't
lock pass-through for the full 1hr success TTL — the next minute's
request retries the JWKS fetch. The pass-through warn line itself
fires at most once per JWKS URL per server lifecycle (the warn-set
is constructed once at server startup, not per request).

This is a deliberate dev-tool tradeoff: surprising deny is worse than
warn+allow when the developer is iterating on a function and the JWKS
URL is blocked by a corporate proxy. **Do NOT rely on this in any
shared environment** — the dev's machine accepts every token, including
forged ones.

Unsupported authorizer kinds (REST v1 `AWS_IAM`, mTLS, and any non-
TOKEN/REQUEST/COGNITO_USER_POOLS Type / non-REQUEST/JWT AuthorizerType)
hard-error at discovery with the offending route's location named.

### `local start-api` VPC-config Lambdas

Lambdas with `Properties.VpcConfig` set still run locally — cdkd does
NOT block these — but the local container does NOT get attached to the
deployed VPC's subnets. Calls from the handler to private RDS /
ElastiCache / VPC-only endpoints will fail. cdkd surfaces a one-line
warn at startup naming each affected Lambda:

```text
[warn] Lambda MyVpcLambda has VpcConfig — local container will reach external
        services via the host's network, NOT through the deployed VPC's
        NAT/private subnets. Calls to private RDS/ElastiCache will fail.
```

AWS SDK calls from the container still use the developer's shell
credentials (or `--assume-role`-issued temp creds) and reach the public
AWS endpoints; nothing about that path changes.

### `local start-api` v1 scope (out of scope, deferred)

| Out of scope | Deferred to |
| --- | --- |
| REST v1 IAM authorizer (`AuthorizationType: 'AWS_IAM'`) | Future PR |
| mTLS authorizers | Future PR |
| REST v1 CORS via Mock OPTIONS integration | Out of scope (use the deployed API) |
| Custom integration mapping templates | Never (not testable locally) |
| WebSocket APIs | Never (different protocol) |
| Throttling / quotas / usage plans / API keys | Never |
| Per-Lambda concurrency above 4 | Future PR if a real workload needs it |

## `local run-task` (run an ECS task definition locally)

`cdkd local run-task <Stack/TaskDefinitionPath>` is the ECS counterpart
of `cdkd local invoke`. It takes an `AWS::ECS::TaskDefinition` defined
in a CDK app and starts every container on the developer's Docker host
— no AWS deploy needed.

Implementation Phase 1: synchronous run of one task, stream every
container's stdout/stderr with a `[<name>]` prefix, propagate the
essential container's exit code. Phase 2 (`cdkd local start-service` —
ECS Service + ALB-emulated path/host-based routing) and Phase 3
(Service Connect / Cloud Map degraded mode) are tracked separately.

**Requires Docker.** The first run pulls the AWS-published
`amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar (a
small Go binary maintained by awslabs) plus each container's image.

### `local run-task` target resolution

Same target-syntax rules as `cdkd local invoke`:

- CDK display path (`MyStack/MyService/TaskDef`) — preferred
- Stack-qualified logical id (`MyStack:MyServiceTaskDefXYZ1234`)
- Single-stack apps may omit the stack prefix (`MyTaskDef`)

Path matching is prefix-based: an L2 path like `MyStack/MyService/TaskDef`
resolves to the synthesized L1 child (`MyStack/MyService/TaskDef/Resource`).

### `local run-task` options

| Flag | Default | Behavior |
| --- | --- | --- |
| `--cluster <name>` | `cdkd-local` | Surfaced as `ECS_CONTAINER_METADATA_URI_V4`'s `Cluster` field and used as the docker network prefix (`<name>-task-<rand>`). |
| `--env-vars <file>` | unset | SAM-shape JSON overlay. Top-level keys are container names; `Parameters` is a global overlay. Same shape as `cdkd local invoke --env-vars`. |
| `--container-host <ip>` | `127.0.0.1` | Bind IP for `PortMappings` published ports. Must be a numeric IP — Docker rejects hostnames in `-p <ip>:<port>:<port>`. |
| `--assume-task-role [<arn>]` | unset (host creds pass through) | Bare flag uses the task definition's `TaskRoleArn`. Resolves a flat-string ARN directly; for `{Ref: <Role>}` / `{Fn::GetAtt: [<Role>, 'Arn']}` against a same-stack `AWS::IAM::Role`, cdkd substitutes the caller's account id (via STS `GetCallerIdentity`) into `arn:aws:iam::<account>:role/<RoleLogicalId>`. Pass an explicit ARN to override. Either way, `sts:AssumeRole` runs once at startup; the resulting creds are exposed via the local metadata sidecar at `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. |
| `--from-state` | off | Load cdkd S3 state for the target stack and substitute deployed values into (a) `Fn::Sub` / `Fn::GetAtt` ECR image URIs that reference a same-stack `AWS::ECR::Repository`, AND (b) intrinsic-valued `ContainerDefinitions[].Environment[].Value` + `Secrets[].ValueFrom` entries (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`). Without this flag, env / secret intrinsics are dropped with a per-key warning (matching `cdkd local invoke --from-state` semantics). See "ECR image resolution" and "Env / Secrets substitution" below. Off by default. The stack must have been deployed via `cdkd deploy` first. |
| `--stack-region <region>` | unset | Region of the cdkd state record to read (used with `--from-state` when the same stack name has state in multiple regions). |
| `--no-pull` | off | Skip `docker pull` for every container image and the metadata sidecar. |
| `--platform <platform>` | inferred from `RuntimePlatform.CpuArchitecture` | `linux/amd64` or `linux/arm64`. Threaded into every container's `docker run --platform`. |
| `--keep-running` | off | Don't `docker rm -f` user containers on task exit (network + sidecar are still torn down). Use when you want to `docker exec` into a stopped container for post-mortems. |
| `--detach` | off | Start the containers and return without streaming logs or auto-tearing them down. Useful in CI smoke tests; caller manages container lifecycle. |

Plus the standard shared options: `-a/--app`, `-c/--context`, `--profile`,
`--role-arn`, `--region`, `--verbose`, `--output`.

### Networking model

For every task invocation cdkd:

1. Creates a fresh docker network `cdkd-local-task-<random>` (or
   `--cluster <name>-task-<random>`) with subnet `169.254.170.0/24`.
2. Starts the AWS-published
   `amazon/amazon-ecs-local-container-endpoints:latest-amd64` sidecar
   on the network at the well-known IP `169.254.170.2`.
3. Starts every user container on the same network with
   `--network-alias <container-name>` so siblings resolve each other by
   their CFn `ContainerDefinitions[].Name`.
4. Injects per-container env vars: `ECS_CONTAINER_METADATA_URI_V4=http://169.254.170.2/v4/<container-name>`
   and (when `--assume-task-role` is set) `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=/role/<task-role-arn>`.

`awsvpc` network mode is mapped to `bridge` locally with a warn line —
docker cannot emulate ENI-per-task. AWS SDK calls from inside the
container still reach public AWS endpoints via the developer network.

### ECR image resolution

`ContainerDefinitions[].Image` is parsed in three tiers:

1. **Public images** — `public.ecr.aws/...`, `docker.io/...`, `nginx:latest`, etc. → plain `docker pull` (subject to `--no-pull`).
2. **Direct ECR URIs** — `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>` (flat string, no intrinsics) → `pullEcrImage` (STS check + ECR auth + `docker pull`). Same-account / same-region only; cross-account / cross-region hard-errors with a `--role-arn` / `AWS_REGION` workaround pointer.
3. **CDK-asset images** (`ContainerImage.fromAsset` / `DockerImageAsset`) → `cdk.out/<stack>.assets.json` lookup → `docker build` via the shared `src/assets/docker-build.ts` helper, tagged `cdkd-local-run-task-<asset-hash>`.

For `Fn::Sub` / `Fn::GetAtt` shapes pointing at AWS pseudo parameters or a same-stack ECR repository (the typical `ContainerImage.fromEcrRepository(repo)` synthesis), two additional resolution tiers fire **before** the URI is fed to tier 2:

- **Tier 1 — AWS pseudo-parameter substitution (no state needed)**: `${AWS::AccountId}` → STS `GetCallerIdentity` (lazy, cached for the run); `${AWS::Region}` → `--region` / `AWS_REGION` / `AWS_DEFAULT_REGION`; `${AWS::Partition}` → derived from region (`cn-*` → `aws-cn`, `us-gov-*` → `aws-us-gov`, else `aws`); `${AWS::URLSuffix}` → matches partition. Substituted URI then routes through tier 2.
- **Tier 2 — same-stack ECR Repository reference (state needed)**: when the `Fn::Sub` body contains `${<LogicalId>}` against an `AWS::ECR::Repository`, or when the template uses `Fn::GetAtt: [<Repo>, 'RepositoryUri']`, cdkd needs the deployed physical repo name. Pass `--from-state` (the stack must have been deployed via `cdkd deploy`); cdkd loads state, substitutes the physical name, then routes through tier 2. Without `--from-state` the error message points back at this flag as the resolution path.

### Env / Secrets substitution (`--from-state`)

`ContainerDefinitions[].Environment[].Value` and `Secrets[].ValueFrom`
entries are commonly intrinsic-valued in real-world CDK ECS apps —
`table.tableName` synthesizes as `Ref`, `table.tableArn` as
`Fn::GetAtt`, `ecs.Secret.fromSecretsManager(secret)` as `Ref` against
the secret (returns the deployed ARN), `ecs.Secret.fromSsmParameter(p)`
as `Fn::Join` over pseudo parameters + a `Ref` to the parameter, etc.
Without `--from-state` these intrinsics are silently dropped (matching
`cdkd local invoke` v1 semantics) and the developer sees an empty env
var or a missing secret.

`cdkd local run-task --from-state` substitutes every intrinsic-valued
entry against cdkd's deployed S3 state plus AWS pseudo parameters:

| Intrinsic | Source |
| --- | --- |
| `Ref: <LogicalId>` | `state.resources[<LogicalId>].physicalId` |
| `Fn::GetAtt: [<LogicalId>, <Attr>]` | `state.resources[<LogicalId>].attributes[<Attr>]` |
| `Fn::Sub: '...${X}...${AWS::Region}...'` | recursive substitution against state + pseudo parameters |
| `Fn::Join: [<delim>, [<elements>]]` | recursive substitution of every element, then `Array.join` |
| `Ref: AWS::AccountId` / `AWS::Region` / `AWS::Partition` / `AWS::URLSuffix` | STS `GetCallerIdentity` (lazy, cached) + the resolved region + region-derived partition / URL suffix |

Per-key best-effort: when a substitution can't be produced (state
missing for a referenced logical ID, attribute not captured at deploy
time, unsupported intrinsic), the env / secret entry is dropped and a
per-key warning surfaces on the task's warnings line — the run-task
invocation never aborts. State-load failures (no record, multi-region
ambiguity without `--stack-region`, bucket resolution error) also
degrade to warn-and-fall-back rather than hard-fail.

Resolved `Secrets[].ValueFrom` strings then flow into the standard
SecretsManager / SSM resolver below.

### Secrets / SSM parameter resolution

`ContainerDefinitions[].Secrets[].ValueFrom` entries are resolved once at
startup via the AWS SDK (after any `--from-state` intrinsic substitution
above). Three accepted shapes:

| `valueFrom` | API |
| --- | --- |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>` | `SecretsManagerClient.GetSecretValue` |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<json-key>::` | `GetSecretValue`, then JSON.parse + extract `json-key` |
| `arn:aws:ssm:<region>:<account>:parameter/<name>` | `SSMClient.GetParameter({ WithDecryption: true })` |

Resolution failures (NotFound / AccessDenied / network error / invalid
ARN) hard-fail with the offending container + secret name. The user
fixes their AWS creds / IAM policy and re-runs. (Mirrors the
`cdkd local invoke --from-state` philosophy: explicit failure beats
silently-empty.)

### Container start ordering — `DependsOn`

| Condition | What cdkd waits for |
| --- | --- |
| `START` | Dependency's `docker run` has returned. |
| `COMPLETE` | Dependency's container has exited (any code). |
| `SUCCESS` | Dependency's container has exited with exit code 0. |
| `HEALTHY` | Dependency's `HEALTHCHECK` reports `healthy` (polled every 1s, capped at 5 min). |

Cyclic dependencies → hard-error at discovery with the offending cycle
named. Topological sort decides the start order; siblings with no
dependsOn relation start in template order.

### Volumes

| `Volumes[]` shape | Local realization |
| --- | --- |
| `Host: { SourcePath: '/some/path' }` | `docker run -v /some/path:<containerPath>` bind mount (caller's responsibility that the host path exists; a missing path emits a warn) |
| `Host` (no `SourcePath`) | Docker anonymous volume — empty per-task scratch |
| `DockerVolumeConfiguration: { Scope: 'task' \| 'shared', Driver, DriverOpts }` | `docker volume create --driver <driver> --opt ...` per task; per-task scope is torn down at exit |
| `EFSVolumeConfiguration` | **Hard-error**. Bind-mount a local directory at the same `containerPath` instead. |
| `FSxWindowsFileServerVolumeConfiguration` | **Hard-error**. |

### Lifecycle + teardown

1. The first `essential: true` container (defaults to `containers[0]`
   when no container declares `essential: false`) drives the task.
2. When the essential container exits, cdkd `docker stop`s every other
   container with a 10s grace then `docker rm -f`.
3. The metadata sidecar is `docker rm -f`'d and the docker network is
   removed.
4. cdkd exits with the essential container's exit code.

`^C` triggers the same teardown. Double-`^C` exits 130 immediately
(skipping container cleanup — same pattern as `cdkd local start-api`).

`--detach` skips steps 1, 2, and 4. The sidecar and user containers
stay running for the caller to manage. cdkd prints the network name on
exit so you can `docker ps --filter network=<name>` to inspect.

`--keep-running` skips step 2 only. The network + sidecar are still
torn down. Use to `docker exec` into a stopped container post-mortem.

### `local run-task` exit codes

- `0` — essential container exited 0.
- N (non-zero) — essential container exited N (cdkd propagates the code).
- Various cdkd-side error codes (Docker missing, target not found,
  network creation failed, secret resolution failed, ...) follow the
  global handler's defaults (typically 1).

### `local run-task` Phase 1 scope (out of scope, deferred)

| Out of scope | Why |
| --- | --- |
| `AWS::ECS::Service` / `DesiredCount` / `LaunchType` | Phase 2 (`cdkd local start-service`) |
| ALB / NLB target group registration / listener rules | Phase 2 — needs an HTTP proxy emulator |
| Service Connect / Cloud Map | Phase 3 — `docker network` alias gives 80% of the value |
| Auto Scaling / Deployment Strategy | Not meaningful locally |
| Fargate vs EC2 launch-type differences (PID namespace, `awsvpc`-only, ephemeral storage cap) | Local Docker can't enforce these |
| EFS / FSx volumes | Need real AWS NFS / SMB; hard-error with a routing hint |
| ECS Exec | Use `docker exec` directly |
| CloudWatch Logs auto-shipping (`logConfiguration.LogDriver: 'awslogs'`) | stdout/stderr already streamed; skip the driver |
| X-Ray sidecar's AWS-API mocking | Run the daemon explicitly if you need it |
| AWS App Mesh / Envoy fidelity | Not meaningful locally |
| awsvpc / ENI complete fidelity | Map to docker bridge with a warn |
