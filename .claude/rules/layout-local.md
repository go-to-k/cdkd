---
description: cdkd local-emulation layer layout (cdkd local invoke / start-api / run-task / start-service, Docker plumbing)
paths:
  - 'src/local/**'
---

# Key Files and Directories - src/local

Index of every area: [code-layout.md](code-layout.md).

## Core Directories

- **src/local/** - `cdkd local invoke` / `start-api` / `run-task` /
  `start-service` / `start-alb` / `start-cloudfront` / `invoke-agentcore` /
  `start-agentcore` building blocks (renamed from `src/local-invoke/`, PR
  #228).
  - **`start-cloudfront` + `start-agentcore` are THIN factory pass-throughs**
    (`src/cli/commands/local-start-cloudfront.ts` /
    `local-start-agentcore.ts`): each wraps a cdk-local
    `createLocalStart*Command` factory, re-hands the active embed config, and
    threads cdkd's `--from-state` factory through the factory's
    `extraStateProviders` seam (issue #766; the `start-cloudfront` factory
    gained the seam in cdk-local 0.128.0 / cdk-local#426). Both layer cdkd's
    `--from-state` / `--state-bucket` / `--state-prefix` on top of cdk-local's
    inherited `--from-cfn-stack` / `--stack-region`.
  - **ECS run-task family** (still cdkd-local): `ecs-task-resolver.ts` (synth
    template → `ResolvedEcsTask`), `ecs-secrets-resolver.ts`
    (`Secrets[].ValueFrom` → real values via SecretsManager / SSM),
    `ecs-network.ts` (per-task docker network + metadata-endpoints sidecar),
    `ecs-task-runner.ts` (orchestrator: image prep → DAG topo-sort → docker
    run loop → log stream → teardown).
  - **ECS start-service family** (#466 / #460): the original per-replica
    orchestrator + Cloud Map modules were MOVED to cdk-local's bundled
    `runEcsServiceEmulator` engine and deleted from cdkd's tree (Part B
    refactor, PR #731). The per-CLI-run shared docker network
    (`cdkd-local-svc-<rand>`, subnet `169.254.171.0/24`, sidecar at
    `169.254.171.2`) and the Cloud Map peer-discovery overlay are
    engine-owned. History in `docs/changelog-cdkd.md`.
  - **`cdkd local invoke` modules**: `lambda-resolver.ts` (target →
    discriminated `ResolvedLambda` (`kind: 'zip' | 'image'`); both variants
    carry `architecture` (issue #768) so the ZIP container run pins
    `--platform` like the IMAGE path), `env-resolver.ts` (template literals +
    SAM-shape `--env-vars`; intrinsic-valued entries warn-and-drop unless
    `--from-state` substituted them), `state-resolver.ts` (pure-functional
    substituter against `state.resources`: `Ref` / `Fn::GetAtt` / `Fn::Sub` /
    `Fn::Join` / `Fn::Select` / `Fn::Split`, plus async `Fn::ImportValue` /
    `Fn::GetStackOutput` via a cross-stack resolver, with per-key unresolved
    reasons — `docs/local-invoke.md`'s table still calls `Fn::Select` /
    `Fn::Split` a future PR, which is STALE: they ship), `runtime-image.ts` (`Runtime` →
    `public.ecr.aws/lambda/<lang>:<v>` + source extension), `docker-runner.ts`
    (thin `execFile`/`spawn` wrappers around docker pull/run/logs/rm + free-
    port allocator; optional `--name` for orphan-sweep),
    `docker-image-builder.ts` (local-build path for container Lambdas),
    `ecr-puller.ts` (ECR-pull fallback; same-account / same-region only,
    cross-acct/region hard-errors), `rie-client.ts` (HTTP POST to RIE +
    TCP-probe readiness wait).
  - **`cdkd local start-api` modules** (PR 8a): `route-discovery.ts` (REST v1
    + HTTP API + Function URL → `DiscoveredRoute[]`, local intrinsic
    resolver, no deploy-state dependency), `api-gateway-event.ts` (v1 + v2
    event builders + `applyAuthorizerOverlay`), `api-gateway-response.ts`,
    `route-matcher.ts` (3-tier precedence: full → greedy `{proxy+}` →
    `$default`, literal-segment tie-break), `container-pool.ts` (per-Lambda
    warm pool, mutex-protected lazy growth, 60s idle GC), `http-server.ts`
    (accept loop + authorizer pass + atomic `setServerState` hot-reload
    swap). PR 8b: `authorizer-resolver.ts` (authorizer detection +
    identity-source parsing; #447 added the `IamAuthorizer` union member for
    REST v1 `AWS_IAM`, #621 wired Function URL `AuthType: 'AWS_IAM'` onto the
    same SigV4 verifier, #470 accepts `Fn::GetAtt: [<UserPool>, 'Arn']` under
    `ProviderARNs[]` by synthesizing an unreachable placeholder ARN so
    `cognito-jwt.ts`'s JWKS pass-through fallback admits tokens without
    signature verification), `authorizer-cache.ts` (TTL-aware),
    `lambda-authorizer.ts` (**DELETED** in slice 12 — the logic survives in
    cdk-local), `cognito-jwt.ts` (JWKS fetch + RS256 verify + pass-through
    fallback), `sigv4-verify.ts` (#447 — SigV4 signature verification against
    local credentials; signature only, no IAM policy emulation; warn-and-pass
    on foreign identities per `feedback_match_aws_default_over_opinionated`).
    PR 8c: `cors-handler.ts`, `stage-resolver.ts` (populates
    `event.stageVariables`), `file-watcher.ts`, `reload-orchestrator.ts`
    (synth-failure-tolerant, chain-serialized).
  - `invoke-agentcore-watch-loop.ts` (#270): cdkd-owned
    `cdkd local invoke-agentcore --watch` reload loop — built on cdk-local's
    exported watch primitives plus copies of the not-exported
    `loadAgentCoreAssetContext` / `deriveOldAssetHash`; the per-firing
    classifier picks `docker cp`+restart soft-reload vs full image rebuild.
    cdk-local's own `runAgentCoreWatchLoop` could not be shimmed (it
    hard-couples to cdk-local's `Synthesizer` / options types).
  - Intrinsic helpers: `intrinsic-image.ts` (#286 Gap 2 — canonical CDK 2.x
    `Fn::Join` ECR image-URI resolver shared by `lambda-resolver.ts` and
    `ecs-task-resolver.ts`), `intrinsic-lambda-arn.ts` (#286 Gaps 3/4 —
    `resolveLambdaArnIntrinsic` accepts `Ref` / `Fn::GetAtt: [..., 'Arn']` /
    the REST v1 invoke-ARN `Fn::Join` wrapper / the `Fn::Sub` invoke-ARN
    wrapper (1-arg and 2-arg); returns a discriminated union so each call
    site wraps the unsupported case in its own error class),
    `intrinsic-utils.ts` (#471 — shared `pickRefLogicalId`, consumed by
    route/websocket discovery, authorizer-resolver, stage-resolver, so
    intrinsic-shape extensions land in one place), `authorizer-context.ts`
    (PR #515 item 9 — per-kind `$context.authorizer.*` shape builder;
    `http-server.ts`'s sibling `buildOverlay` still hand-branches because it
    wraps the result in the `AuthorizerEventOverlay` union).
  - #457 REST v1 non-proxy: `vtl-engine.ts` (minimal AWS VTL evaluator —
    `$input` / `$context` / `$util`, directives, JSONPath subset, no external
    dep), `integration-response-selector.ts` (`SelectionPattern` regex +
    `ResponseParameters` + Accept negotiation), `rest-v1-integrations.ts`
    (the four dispatchers + `substituteUriPlaceholders` +
    `applyRequestParameters`).
  - CLI commands: `src/cli/commands/local-invoke.ts` (creates the `cdkd
    local` parent + registers invoke / start-api / run-task / start-service),
    `local-start-api.ts`, `local-run-task.ts`, `local-start-service.ts`.
    `local-state-loader.ts` (PR #267) is the shared S3-state loader both
    `invoke --from-state` and `run-task --from-state` route through; it also
    exports `loadBootstrapContainerRepo` (issue #1025): a best-effort,
    never-failing read of the region's asset-storage bootstrap marker
    (`cdkd-bootstrap/{region}.json`) so `run-task --from-state` recognizes
    images in a custom-named container-asset repo (issue #1011) as cdk-asset
    images.
  - **Region CASE is folded across the loader (issue #1836), and its several
    folds are NOT interchangeable — do not "simplify" them into one.**
    - The state-record match is EXACT-first, case-insensitive second
      (`listStacks` dedupes on the exact `{stack}\0{region}` pair, so both
      spellings can coexist as two DISTINCT refs; a canonical-equal collision
      is reported at warn). The candidate compared is the user's UNFOLDED
      spelling, carried as `rawStackRegion` — captured at each handler entry
      BEFORE the fold, derived from the still-raw flag by the `--from-state`
      factory for the ENGINE commands, and read by NOTHING else except
      `loadBootstrapContainerRepo`'s raw marker probe. Without it the exact
      arm is DEAD and its warning lies (every path would fold first). The key
      handed to `getState` — and the exports-index key
      `buildCrossStackResolver` builds — keeps the RECORD's own spelling
      (nothing folds `cdkd deploy --region`; a folded key would 404).
    - **Every caller of `buildCrossStackResolver` must pass a state record's
      spelling** (`local-invoke.ts` / `local-invoke-agentcore.ts` pass
      `loaded.region`; `local-run-task.ts` threads it out of
      `buildEcsImageResolutionContext`, falling back to its folded env chain
      via `resolveEcsConsumerRegion` only when no record was loaded — with
      `||` on the flag link, so a blank `--region ''` cannot become an empty
      index key).
    - **`consumerRegion` has FOUR consumers that do NOT all want the same
      spelling** — it stays RAW at the boundary and each consumer folds for
      itself: (1) the `cdkd/_index/{region}/exports.json` key AND
      `ExportIndexStore`'s rebuild filter take RAW (a spelling no record
      carries rebuilds ZERO refs and PUTs an EMPTY index, permanently
      degrading every `Fn::ImportValue` to the O(N) scan; keyed by a record's
      spelling a key miss costs only a correct rebuild — also why that lookup
      is NOT read-only against the bucket); (2) the index-miss per-stack
      scan's same-region filter folds BOTH sides (`getState` key still the
      ref's own spelling); (3) via `SubstitutionContext.consumerRegion` it is
      cdk-local's DEFAULT producer region for an `Fn::GetStackOutput` with no
      explicit `Region`, so `resolveGetStackOutput` needs the same both-sides
      case RECOVERY the scan has (exact key first, then a `listStacks` walk
      for a canonical-equal record) — else an `US-EAST-1` consumer record
      referencing a `us-east-1` producer 404s and the env var is dropped with
      only a per-key warning; (4) `resolveStateBucketWithDefault` must be
      FOLDED — the legacy default bucket name `cdkd-state-{acct}-{region}` is
      lowercase-only, an upper-cased name is not virtual-hostable, S3 answers
      400 `InvalidBucketName` path-style, and the whole resolver returns
      `undefined`, warn-dropping EVERY cross-stack env entry on a
      legacy-bucket account. Both sibling loaders fold before their own
      `resolveStateBucketWithDefault` call, so all three agree.
    - `opts.region` folds separately at all three S3-client construction
      sites, with ABSENT — and a blank `--region ''` — staying absent so the
      SDK's own chain still resolves the profile's region. That fold is on
      the `AwsClients` constructor, NOT on the `S3StateBackend` options bag
      beside it (which carries only `profile` / `credentials`) — a test
      asserting the latter fences nothing.
    - The bootstrap-marker read probes the CANONICAL
      `cdkd-bootstrap/{region}.json` first, then the RAW spelling — the
      WRITE side (`cdkd bootstrap`, whose region is unfolded, issue #1820)
      can have written the upper-cased key. How reachable the raw key is was
      MEASURED for issue #2021 and is narrow: it needs BOTH `--asset-bucket`
      and `--container-repo` as valid lowercase names AND a pre-existing
      bucket, or a marker written by hand / by a cdkd predating the guards
      (a plain `AWS_REGION=US-EAST-1 cdkd bootstrap` cannot write it — the
      marker is written LAST and the bucket create fails first). Probe 2 is
      KEPT anyway: that state is real, losing it silently re-points a
      bootstrapped region at `cdk gc`-collectable storage (the #2021 failure
      itself); cost is one extra `GetObject` on a non-canonical region only,
      and both conditions are pinned by tests.
    - Issue #2021 moved the two-probe read into ONE shared helper,
      `readBootstrapMarkerBody(stateBackend, rawRegion)` in
      `src/assets/asset-storage.ts`, returning `{ body, resolvedKey }` — the
      key ACTUALLY read, so each caller's message, plan line and delete
      target can follow it. It deliberately does NOT catch:
      `loadBootstrapContainerRepo` stays best-effort, `gc.ts` /
      `bootstrap-destroy.ts` translate `NoSuchBucket` into their
      never-bootstrapped message and hard-error otherwise, and
      `bootstrap --destroy` deletes `resolvedKey` rather than the canonical
      key (deleting the canonical one when the body came from the raw one
      orphans the marker).
  - **`LocalStateProvider`** (issue #606, `src/local/local-state-provider.ts`):
    two implementations — cdkd's own `s3-local-state-provider.ts` (wraps
    `local-state-loader.ts`; the `--from-state` path) and cdk-local's CFn
    provider (reads a deployed CloudFormation stack for
    `--from-cfn-stack [<cfn-stack-name>]`, letting users run the `cdkd
    local` family against `cdk deploy`-ed apps without migrating). The
    dispatcher `src/cli/commands/local-state-source.ts`
    (`createLocalStateProvider(...)`) enforces mutual exclusion between the
    two flags and is a thin shim around the `cdk-local` npm package —
    cdk-local owns the `--from-cfn-stack` implementation + dispatch, cdkd
    injects its S3-backed `--from-state` factory via the
    `extraStateProviders` hook. That factory also folds the region CASE of
    `--region` AND `--stack-region` (#1836) — idempotent for the four
    commands that fold at handler entry, and the ONLY cdkd-owned stop for
    the ECS / CloudFront / AgentCore engine commands — and carries the
    UNFOLDED `--stack-region` through as `rawStackRegion`, the only thing
    that makes the loader's exact-spelling match reachable. cdkd carried an
    unreferenced FORK of the CFn provider until go-to-k/cdkd#2607 deleted
    it (issue go-to-k/cdkd#2527); the shipped symbol is cdk-local's,
    re-exported through `local-state-source.ts`. CFn-provider wire mapping:
    `Ref` → paginated `ListStackResources`. The deleted fork called
    `DescribeStackResources` instead, and correcting that name across the
    remaining surfaces is go-to-k/cdkd#2527's other half;
    `Fn::ImportValue` → `ListExports`; `Fn::GetAtt` warn-and-drop for most
    sites, but a consumer Lambda's OWN env-var `Fn::GetAtt` values are
    recovered from the deployed function's already-resolved config
    (`lambda:GetFunctionConfiguration`, cdk-local@0.10.0) — CFn resolved
    every intrinsic at deploy time; other `Fn::GetAtt` sites (ECS container
    env) still warn-and-drop. `Fn::GetStackOutput` is rejected with a
    pointer (cdkd-specific intrinsic). Region handling reuses
    `--stack-region`.
  - **Phase 3 shim swap (COMPLETE)**: an expanding set of `src/local/**`
    modules became thin re-export shims (`export { ... } from 'cdk-local'`);
    implementations and their unit tests moved to cdk-local. cdkd keeps its
    OWN `cdkd local` command tree, so `createLocalCommand()` calls
    `setEmbedConfig(CDKD_EMBED_CONFIG)` once at build time (cdk-local 0.20.0
    / cdk-local#85) — every shim reading `getEmbedConfig()` renders cdkd
    branding (`cliName: 'cdkd local'` / `resourceNamePrefix: 'cdkd-local'` /
    `awsBindMountPath: '/cdkd-aws'` / `envPrefix: 'CDKD'`). Slices, with the
    BREAKER FAMILIES each surfaced:
    - Slice 1 (0.8.0): `intrinsic-utils`, `intrinsic-lambda-arn`,
      `parameter-mapping`, `api-gateway-response`, `docker-inspect`. Slice 2
      (0.11.0): route cluster (`route-discovery`, `route-matcher`,
      `api-gateway-event`, `websocket-route-discovery`). Slice 3 (0.12.0):
      `authorizer-cache`, `cognito-jwt`. Slice 4 (0.14.0): `env-resolver`,
      `stage-resolver`. Slice 5 (0.15.0): `cloud-map-registry` — had to wait
      for cdk-local#79 to export `type RegistrationHandle` (a still-local
      sibling imported the type, so a bare shim could not typecheck).
    - Slice 6 (0.17.0): `runtime-image`, `websocket-event`,
      `websocket-mgmt-api`. Slice 7 (0.21.0): `docker-version`
      (`probeHostGatewaySupport`; cdk-local#483 / issue #784 added
      `resolveHostGatewayExtraHosts` — the memoized never-throwing
      `host.docker.internal:host-gateway` resolver `local invoke` /
      `run-task` adopt, merged by `ecs-task-runner.ts`'s
      `mergeHostGatewayAddHostFlags`; `start-service` / `start-alb` inherit
      it from the engine), `api-server-grouping`, `layer-arn-materializer`
      (cdkd's consumer tests keep their `vi.mock` — direct
      module-replacement still intercepts post-shim). Shims re-export only
      src-consumed symbols; test-only symbols stay off the package entry.
    - Slice 8 (0.22.0): `cors-handler`, `intrinsic-image` — clean SUPERSET
      inheritances (cdk-local adds `isFunctionUrlOacFronted` cdkd does not
      consume, and a same-stack-ECR `Fn::GetAtt` synthesis that fires only
      under `--from-cfn-stack`). **`intrinsic-image.ts` stopped being a BARE
      re-export in issue #1814**: `derivePseudoParametersFromRegion` is a
      thin BOUNDARY WRAPPER running the region through `canonicalizeRegion`
      (`src/utils/aws-partition.ts`) before delegating — cdk-local carries
      its OWN case-sensitive partition table, so the #1795 canonicalization
      structurally could not reach this fourth derivation and an upper-cased
      `--region CN-NORTH-1` still synthesized a wrong ECR host. The wrapper
      stays correct if cdk-local later canonicalizes (the fold is
      idempotent). It fixes CASE only — cdk-local's table also predates
      cdkd's #1764 rows, so `us-isof-` / `eu-isoe-` / `eusc-` regions
      resolve COMMERCIAL there even spelled canonically (table-COVERAGE
      divergence, issue #1821, pinned by a unit case).
    - Slice 9 (0.24.0): `state-resolver` (the `--from-state` /
      `--from-cfn-stack` substituter over `Ref` / `Fn::GetAtt` / `Fn::Sub` /
      `Fn::Join` / `Fn::Select` / `Fn::Split` plus async `Fn::ImportValue` /
      `Fn::GetStackOutput`, + `CrossStackResolver` / `SubstitutionContext`
      types). Clean superset; cdk-local genericized
      the USER-VISIBLE per-key unresolved-reason wording, and cdkd's two
      consumer-test reason-string assertions were flipped to the new
      wording.
    - Slice 10 (0.29.0): `websocket-body` — NOT a bare re-export but a thin
      spy-friendly LOCAL wrapper (`bufferToBody` delegating to the cdk-local
      impl): the still-local `websocket-server.ts` imports it as a namespace
      and a regression test installs `vi.spyOn` — a bare re-export binding
      is a non-configurable getter `vi.spyOn` cannot redefine.
    - Slice 11 (0.30.0): `cloud-map-resolver`,
      `integration-response-selector` — surfaced the **class-identity
      breaker family**: once a shim re-exports, its throws use cdk-local's
      BUNDLED error classes while still-local consumers/tests reference
      cdkd's local class — two class objects across the package boundary, so
      `instanceof` / `toThrow` silently fail. Resolved by class-identity
      reconciliation: cdk-local#109 also exports `EcsTaskResolutionError` +
      `VtlEvaluationError`, and cdkd's still-local `ecs-task-resolver.ts` /
      `vtl-engine.ts` DELETE their local `class` definitions and import +
      re-export from cdk-local — impl local, error CLASS sourced upstream,
      one identity for every throw site and assertion.
    - Slice 12 (0.32.0): `http-server`, `authorizer-resolver`,
      `sigv4-verify` become shims; `lambda-authorizer.ts` +
      `authorizer-context.ts` are DELETED (zero remaining cdkd consumers — a
      shim would be dead code). Surfaced the **fourth breaker family: a
      deliberate semantic divergence the host has not adopted** (memory
      `feedback_shim_blocked_by_unadopted_semantic_divergence`) — the #63
      SigV4 default (cdkd fail-closed vs cdk-local warn-and-pass); first
      resolved divergence-preserving via the `sigV4Strict` option +
      polarity-aware embedConfig messages (`sigV4StrictByDefault` /
      `sigV4OptFlag`), and cdkd cleanly gained the `oacFronted` Function-URL
      exception (CloudFront re-signs OAC-fronted origin requests, so
      warn-and-pass is correct there). **UPDATE 2026-05-31: REVERSED with
      user sign-off** — cdkd now follows cdk-local's warn-and-pass default;
      `CDKD_EMBED_CONFIG` flipped to `sigV4StrictByDefault: false` +
      `sigV4OptFlag: '--strict-sigv4'`, the option renamed
      `--allow-unverified-sigv4` → `--strict-sigv4` with inverted polarity
      (`sigV4Strict: options.strictSigv4 === true`). **BREAKING CHANGE** for
      users who relied on the prior fail-closed default.
    - Slice 13 (0.33.0): `docker-image-builder` — a BOUNDARY-WRAPPER shim:
      cdkd's `LocalInvokeBuildError` extends `CdkdError` while cdk-local's
      is `CdkLocalError`-based, so the slice-11 same-base reconciliation
      cannot apply; `buildContainerImage` is wrapped to catch cdk-local's
      error and re-throw cdkd's at the boundary (exit code / formatting
      preserved). `ecr-puller` + `ecs-task-runner` throw/catch their OWN
      `LocalInvokeBuildError` (self-contained, unaffected).
    - Slice 14 (0.34.0): `file-watcher` — a user-approved BEHAVIOR-CHANGING
      reconciliation, not a mechanical re-export: `start-api --watch` flips
      from watch-OUTPUT (watch `cdk.out/` + asset dirs) to cdk-local's
      watch-SOURCE model (watch the app source tree, exclude `cdk.out` /
      `node_modules` / `.git`, honor `cdk.json` `watch.include/exclude`,
      RE-SYNTH on a source edit). Small only because `reloadAllServers`
      ALREADY re-synths; cdkd deleted the watch-output plumbing. No
      self-fire loop: synth writes only to `cdk.out`, which the predicates
      exclude.
    - Each slice was verified end-to-end via the relevant Docker integ
      (`local-invoke-container`, `local-start-api`, `local-start-service`,
      `local-start-api-websocket`, `local-start-api-rest-v1-non-proxy`).
    - The stay-local-FOREVER set: the `ecs-*` engine, `rie-client`,
      `container-pool`, `lambda-resolver`, `ecr-puller`, `docker-runner`,
      `reload-orchestrator`, `httpv2-service-integration`,
      `websocket-server`, `rest-v1-integrations`, `vtl-engine` +
      `ecs-task-resolver` (impl local; error class from cdk-local per slice
      11), the `*-local-state-provider` plumbing, and the CLI command files
      that keep cdkd's own command tree. NOTE `route-discovery.ts`'s error
      strings still emit a `go-to-k/cdkd` docs URL via cdk-local until the
      self-containment cleanup parameterizes it via `embedConfig` (correct
      for cdkd meanwhile).
  - **`cdkd local start-alb`** (#86): thin shim consumer of the shared ECS
    service emulator engine — `src/local/elb-front-door-resolver.ts`
    re-exports `resolveAlbFrontDoor` / `isApplicationLoadBalancer` + the
    front-door types, `src/cli/commands/ecs-service-emulator.ts` re-exports
    `runEcsServiceEmulator` / `addCommonEcsServiceOptions` + engine types
    from `cdk-local/internal`, and `local-start-alb.ts` wires
    `runEcsServiceEmulator(targets, options, albStrategy(options),
    cdkdExtraStateProviders)`. ALB-specific flags (`--lb-port` / `--tls` /
    `--tls-cert` / `--tls-key` / `--no-verify-auth` / `--bearer-token`) come
    via cdk-local's `addAlbSpecificOptions(cmd)` (0.64.0 / cdk-local#203) so
    cdkd auto-inherits new ALB-only flags. **BREAKING 2026-05-31**: cdk-local
    0.64.0 flips the default HTTPS-listener local behavior from
    auto-TLS-terminate to **plain HTTP** (with `X-Forwarded-Proto: https`
    preserved); users wanting the prior behavior pass `--tls` or
    `--tls-cert` / `--tls-key`. The 4th-arg `extraStateProviders` is the
    exported `cdkdExtraStateProviders` from `local-state-source.ts` — the
    same factory the rest of the family registers — so the engine picks
    cdkd's S3 `--from-state` transparently per backing-service boot.
  - **`cdkd local start-service`** (Part B follow-up to PR #725): second
    consumer of the same engine — `local-start-service.ts` collapsed from a
    944-line orchestrator to a ~120-line shim mirroring `local-start-alb.ts`
    (`serviceStrategy` returns `boots` only, empty `lbPortOverrides`, no
    `frontDoor`). Start-service-specific flags come via
    `addStartServiceSpecificOptions(cmd)` (`--host-port` since 0.62.0;
    `--watch` since 0.69.0 / cdk-local#214 Phase 4). `--watch` on either
    command runs the engine's classifier per reload: interpreted-language
    source edits inside a CDK image asset take the bind-mount FAST PATH
    (`docker cp` + `docker restart`, well under a second), everything else
    falls through to the rebuild rolling primitive (shadow boot + atomic
    swap); the verdict + per-replica lines are engine-emitted and pass
    through unchanged. Fixture: `tests/integration/local-start-service-watch-fast/`.
  - The retained `src/local/ecs-network.ts` exports (`createTaskNetwork` /
    `destroyTaskNetwork` / `buildMetadataEnv` / `buildEndpointSubnet` /
    `METADATA_ENDPOINT_IMAGE` / `METADATA_ENDPOINT_IP`) are kept ONLY
    because `ecs-task-runner.ts` consumes them; once `run-task` migrates to
    a cdk-local engine they become deletable.

## The cdk-local boundary runs THROUGH this directory, not around it

Half of `src/local/**` is cdkd's own implementation and half is a re-export
surface over cdk-local, and the line has moved several times. Getting it wrong
has cost review rounds in BOTH directions — a fix landing in a copy that no
longer runs (issue #2203, where a live probe returned the whole secret
afterwards), and a "cdkd users are not affected" call that held only for
`local run-task` because `start-service` / `start-alb` reach cdk-local's
bundled copy instead. The boundary is therefore MECHANICAL:
`scripts/check-local-reachability.ts` (`vp run audit:local-reachability:check`)
classifies every module and fails when classification and source disagree.
Measured 2026-09-05 over all 56 files: 16 live (12 fully, 4 with dead
exports), 2 loaded-only (`vtl-engine.ts`, `reload-orchestrator.ts`), 1
unreferenced (`httpv2-service-integration.ts`), 36 re-export shims (28
consumed, 8 with no `src/` importer), 1 types-only. The second unreferenced
file, cdkd's fork of the CFn state provider, was deleted by
go-to-k/cdkd#2607 (issue go-to-k/cdkd#2527).

Two annotations carry the verdict at the declaration, and BOTH directions are
enforced — a missing one fails, and one on a symbol that IS reachable fails as
stale:

- **`@no-live-caller <reason>`** - a cdkd-authored body nothing in `src/`
  reaches. The reason must name where the live implementation is (usually
  cdk-local's copy behind `http-server.ts`'s `startApiServer`), or say there
  is none.
- **`@test-only-export <reason>`** - exported solely so unit tests can reset
  module-scoped state, in an otherwise-live module.

Annotating is the floor — deleting the orphaned fork (~4.0k lines of source +
~3.0k of tests, enumerated per file) is issue #2277, kept separate because
removing a subsystem is a different review from adding a critic. The figures
are net of go-to-k/cdkd#2607, which removed one of #2277's four whole-file
orphans (`cfn-local-state-provider.ts`, 438 source + 694 test lines).

`loaded-only` is the state that makes a module-level rule useless here:
`vtl-engine.ts` IS imported (by `rest-v1-integrations.ts`, which
`local-start-api.ts` imports for `warnSsrfRiskyUri`), so ESM evaluates it, yet
not one of its exports is ever reached. `rie-client.ts` is the mirror-image
caution: `invokeRie` and `waitForRieReady` ARE live, only the streaming half
is not — so "this file is dead" is as wrong as "this file is live".
