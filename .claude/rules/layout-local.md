---
description: cdkd local-emulation layout (src/local, the cdk-local boundary)
paths:
  - 'src/local/**'
---

# src/local

Index: [code-layout.md](code-layout.md).

- **`invoke`** - lambda / env / state resolvers, runtime image, docker runner and builder, RIE client. Both `ResolvedLambda` variants carry `architecture`, so the ZIP run pins `--platform` like the IMAGE path; `ecr-puller.ts` SUPPORTS cross-account and cross-region, building the client for the image URI's own region; `copyLayerTreeLastWins` is the ONE layer-merge copy it shares with `start-api`.
- **`start-api`** - route discovery / matching / event building, the warm `container-pool.ts`, `http-server.ts`, authorizers, CORS, stage, watcher, reload, and the REST v1 non-proxy trio. `route-matcher.ts` precedence is full, then greedy `{proxy+}`, then `$default`, with a literal-segment tie-break. `sigv4-verify.ts` checks the signature only, and warn-and-pass is the DEFAULT (`--strict-sigv4` opts out).
- **`run-task`** - task and secrets resolvers, `ecs-network.ts`, `ecs-task-runner.ts`; the network module's exports survive ONLY because the runner consumes them.
- **`start-service` / `start-alb` / `start-cloudfront` / `start-agentcore`** - thin consumers of cdk-local factories or `runEcsServiceEmulator`, threading cdkd's `--from-state` factory through `extraStateProviders`. It reaches ECS service targets but NOT a `TargetType: lambda` target group, so `start-alb` WARNS via `warnUnresolvedLambdaTargetEnv` while `start-cloudfront` REFUSES the flag — refusal is right only where NO consumer on that path reads a host state source (go-to-k/cdkd#2602). That decorator is a NAMED export: inline, it was deletable. cdkd adds no Docker-context check to either ECS command: the engine contains every image it builds, with display-safe refusals (go-to-k/cdkd#3652).
- **Intrinsic helpers** - `intrinsic-lambda-arn.ts` returns a discriminated union so each call site wraps the unsupported case in its own error class. `intrinsic-image.ts` is NOT a bare re-export: `derivePseudoParametersFromRegion` applies `canonicalizeRegion` first, since cdk-local has its own table.
- **`LocalStateProvider`** - cdkd's `s3-local-state-provider.ts` (`--from-state`, over the shared `local-state-loader.ts`) and cdk-local's CFn provider (`--from-cfn-stack`). `local-state-source.ts` enforces mutual exclusion and is a thin shim: cdk-local owns the CFn implementation, cdkd injects its S3 factory via `extraStateProviders`, and that factory carries the UNFOLDED `--stack-region` as `rawStackRegion`.

## An asset path has TWO directories, and they are not the same one

go-to-k/cdkd#3489. Every site here that turns an asset manifest's `source.path`
/ `source.directory` into a real path RESOLVES it against the MANIFEST's own
directory and CONTAINS it within `StackInfo.assetOutdir`. For a stack inside a
`cdk.Stage` the manifest is in `cdk.out/assembly-<Stage>/` while its assets are
staged in the app root, so upstream writes `../asset.<hash>` by design — bind to
the manifest's directory and every Stage asset is refused as "hand-modified".

- **NEITHER directory is `--output`.** Under `-a <pre-synthesized dir>` the
  synthesizer never reads it. Bound: `StackInfo.assetOutdir` or
  `Synthesizer.synthesize`'s `assemblyDir` (both user-supplied, the invariant
  `containWithin` requires). Base: `dirname(stack.assetManifestPath)`.
  cdk-local's `StackInfo` carries both, set by its own `AssemblyReader`.
- A missing bound FAILS OPEN (falls back to the base, right only top-level), a
  wrong one FAILS CLOSED (refuses everything) — neither looks like a
  containment hole to a test that only checks refusals. Fence the WIRING: per
  call site, a case asserting the bound it passes, red under a probe.
- A Lambda's `Metadata['aws:asset:path']` is the one of these whose value is
  BIND-MOUNTED, and it answers ABSOLUTE and RELATIVE differently
  (go-to-k/cdkd#3494). RELATIVE escaping: REFUSED. ABSOLUTE: ACCEPTED, with a
  WARNING naming the path when it leaves `assetOutdir`. **Do not "restore" a
  refusal on the absolute arm** — `cdk synth --no-staging`
  (`aws:cdk:disable-asset-staging`) emits the asset's absolute SOURCE
  directory, normally outside the outdir, so refusing it rejects the output of
  a documented CDK CLI flag. The security cost is real and was weighed: cdkd
  cannot tell that value from a planted one, and the mount is read-only on a
  local command against an assembly the user named. `resolveAssetCodeDirectory`
  in `lambda-resolver.ts` is THE one spelling, shared with
  `local-start-api.ts`'s resolver through a `wrapError` callback so each keeps
  its own error class and command name. **It takes EVERY value in an
  `AssetCodeResolveOptions` bag**
  ([#3549](https://github.com/go-to-k/cdkd/issues/3549)): positionals left four
  `string`s in a row with two transposable pairs — `(manifestDir, assetPath)`
  decides which directory is resolved and which is contained for a value that
  is then BIND-MOUNTED, and `(assetOutdir, logicalId)` made the bound
  `path.resolve('<logicalId>')` under the cwd. Required-ness caught only a
  DROP. **What the bag buys**: an ordering mistake is now a compile error and a
  dropped member names itself; what is left is a deliberate mis-naming, which a
  reader can see. **What it does not**: the swap is UNORDERABLE, not
  inexpressible — a caller can still write
  `{ manifestDir: assetOutdir, assetOutdir: manifestDir }`, and
  `local-asset-code-path-containment.test.ts` is what catches that, by driving
  both call sites against a STAGE manifest where the two directories differ
  (measured: it reds three cases; a source scan of the call sites passed).
  `asset-code-resolve-options-shape.test.ts` pins only what no behavioural test
  sees — the arity, and that the interface sits IMMEDIATELY above its function.
  The absolute arm's verdict comes from
  `absoluteAssemblyPathEscape`, which lives beside `resolveAssemblyPath` so the
  containment rule is not re-spelled (`path.join` cannot answer for an absolute
  candidate — it folds one INTO the directory).

## Region case folding (#1836)

**The folds are NOT interchangeable — do not simplify them into one.**

- The state-record match is EXACT-first, case-insensitive second, against the UNFOLDED `rawStackRegion` captured BEFORE the fold; without it the exact arm is DEAD. Keys handed to `getState` and the exports index keep the RECORD's spelling, since nothing folds `cdkd deploy --region`.
- **Every caller of `buildCrossStackResolver` must pass a state record's spelling**; the folded env chain is a fallback only when no record loaded, with `||` on the flag link so `--region ''` cannot become an empty key.
- **`consumerRegion` stays RAW at the boundary, because its consumers want different spellings.** The exports-index key and rebuild filter take RAW (a spelling no record carries PUTs an EMPTY index); the index-miss scan and `resolveGetStackOutput` fold BOTH sides; `resolveStateBucketWithDefault` must be FOLDED, the legacy bucket name being lowercase-only.
- `opts.region` folds at all three S3-client construction sites, ABSENT and blank staying absent so the SDK chain resolves the profile's region.
- The bootstrap-marker read probes the CANONICAL key first, then the RAW spelling, and `readBootstrapMarkerBody` (`src/assets/asset-storage.ts`) returns `{ body, resolvedKey }`, so a caller deletes the key actually READ and cannot orphan the marker. `local run-task` folds `process.env` at entry (#3622), so it captures the raw env spelling FIRST and passes it as `rawEnvRegion`.

## The cdk-local boundary runs THROUGH this directory

Half of `src/local/**` is cdkd's implementation and half a re-export surface over cdk-local, so a fix can land in a copy that no longer runs. `scripts/check-local-reachability.ts` classifies each module and fails on disagreement.

- Two annotations carry the verdict at the declaration, enforced BOTH ways (a missing one fails; one on a reachable symbol fails as stale): **`@no-live-caller`**, whose reason must name the live implementation, and **`@test-only-export`**.
- **Error CLASS identity crosses the package boundary.** Once a shim re-exports, its throws use cdk-local's classes while a still-local consumer or test holds cdkd's, so `instanceof` / `toThrow` silently fail. Fix by DELETING the local `class` and re-exporting cdk-local's; where the bases differ, the shim becomes a BOUNDARY WRAPPER re-throwing cdkd's error.
- `createLocalCommand()` calls `setEmbedConfig(CDKD_EMBED_CONFIG)` once at build time, so every shim reading `getEmbedConfig()` renders cdkd branding rather than cdk-local's.
- Never shimmed: the `ecs-*` engine, the invoke path, the websocket and REST v1 servers, the state-provider plumbing, the CLI files.
