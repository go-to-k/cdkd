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
- **`start-service` / `start-alb` / `start-cloudfront` / `start-agentcore`** - thin consumers of cdk-local factories or `runEcsServiceEmulator`, threading cdkd's `--from-state` factory through `extraStateProviders`. It reaches ECS service targets but NOT a `TargetType: lambda` target group, so `start-alb` WARNS via `warnUnresolvedLambdaTargetEnv` while `start-cloudfront` REFUSES the flag — refusal is right only where NO consumer on that path reads a host state source (go-to-k/cdkd#2602). That decorator is a NAMED export, since inline it was deletable at its only call site.
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
  cdk-local's `StackInfo` declares neither field, so a site holding only that
  record looks the stack up in cdkd's `stacks`.
- A missing bound FAILS OPEN (falls back to the base, right only top-level), a
  wrong one FAILS CLOSED (refuses everything) — neither looks like a
  containment hole to a test that only checks refusals. Fence the WIRING: per
  call site, a case asserting the bound it passes, red under a probe.

## Region case folding (#1836)

**The folds are NOT interchangeable — do not simplify them into one.**

- The state-record match is EXACT-first, case-insensitive second, against the UNFOLDED `rawStackRegion` captured BEFORE the fold; without it the exact arm is DEAD. Keys handed to `getState` and the exports index keep the RECORD's spelling, since nothing folds `cdkd deploy --region`.
- **Every caller of `buildCrossStackResolver` must pass a state record's spelling**; the folded env chain is a fallback only when no record loaded, with `||` on the flag link so `--region ''` cannot become an empty key.
- **`consumerRegion` stays RAW at the boundary, because its consumers want different spellings.** The exports-index key and rebuild filter take RAW (a spelling no record carries PUTs an EMPTY index); the index-miss scan and `resolveGetStackOutput` fold BOTH sides; `resolveStateBucketWithDefault` must be FOLDED, the legacy bucket name being lowercase-only.
- `opts.region` folds at all three S3-client construction sites, ABSENT and blank staying absent so the SDK chain resolves the profile's region.
- The bootstrap-marker read probes the CANONICAL key first, then the RAW spelling, and `readBootstrapMarkerBody` (`src/assets/asset-storage.ts`) returns `{ body, resolvedKey }`, so a caller deletes the key actually READ and cannot orphan the marker.

## The cdk-local boundary runs THROUGH this directory

Half of `src/local/**` is cdkd's implementation and half a re-export surface over cdk-local, so a fix can land in a copy that no longer runs. `scripts/check-local-reachability.ts` classifies each module and fails on disagreement.

- Two annotations carry the verdict at the declaration, enforced BOTH ways (a missing one fails; one on a reachable symbol fails as stale): **`@no-live-caller`**, whose reason must name the live implementation, and **`@test-only-export`**.
- **Error CLASS identity crosses the package boundary.** Once a shim re-exports, its throws use cdk-local's classes while a still-local consumer or test holds cdkd's, so `instanceof` / `toThrow` silently fail. Fix by DELETING the local `class` and re-exporting cdk-local's; where the bases differ, the shim becomes a BOUNDARY WRAPPER re-throwing cdkd's error.
- `createLocalCommand()` calls `setEmbedConfig(CDKD_EMBED_CONFIG)` once at build time, so every shim reading `getEmbedConfig()` renders cdkd branding rather than cdk-local's.
- Never shimmed: the `ecs-*` engine, the invoke path, the websocket and REST v1 servers, the state-provider plumbing, the CLI files.
