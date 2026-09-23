---
description: cdkd assets layer (publishing, cdkd-owned asset storage, redirect)
paths:
  - 'src/assets/**'
---

# Assets layer

- **file-asset-publisher.ts** / **docker-asset-publisher.ts** — S3 ZIP upload;
  ECR image build and push.
- **Three manifest-supplied paths are containment-checked
  ([#3489](https://github.com/go-to-k/cdkd/issues/3489)); the rest of the
  manifest is NOT, and that is a known gap
  ([#3497](https://github.com/go-to-k/cdkd/issues/3497)).** Checked:
  `source.path` through `resolveFileAssetSourcePath` and `source.directory`
  through `resolveDockerContextDirectory` — each THE one spelling its two call
  sites share, since a second hand-written copy is how a guard on one twin
  becomes a guard on neither — plus the `<stackName>.assets.json` filename in
  `loadManifest`. **Those two RESOLVE against the manifest's
  directory but are CONTAINED within `StackInfo.assetOutdir`**: a Stage's
  assets sit in the app root, so `source.path` is `../asset.<hash>` by design
  and containing against the manifest directory refused every Stage asset.
  **Both resolvers take an OPTIONS BAG — the file one its trailing values,
  the Docker one EVERY parameter**
  (`FileAssetResolveOptions` / `DockerContextResolveOptions`), and
  `assetOutdir` is REQUIRED there and on `FileAssetPublisher.publish` /
  `DockerAssetPublisher.build`. Required catches a DROP; the bag catches a
  TRANSPOSITION, which required does not — the values are all `string`, so
  `(…, assetOutdir, assetId)` used to compile and print
  `cdkd will cdkd-asset-<hash>`
  ([#3537](https://github.com/go-to-k/cdkd/issues/3537)).
  **`resolveDockerContextDirectory` takes EVERY parameter in the bag**, because
  it had a second transposable pair and that one was not cosmetic:
  `manifestDir` is the assembly-derived base and `directory` the
  attacker-chosen value, so a swap changed which directory was resolved and
  which contained ([#3544](https://github.com/go-to-k/cdkd/issues/3544)).
  `resolveFileAssetSourcePath` keeps its leading positionals because its second
  parameter is a `FileAsset` and the swap does not typecheck — the invariant is
  "no transposable adjacent same-typed pair", not "both twins look alike".
  **That invariant is stated for the RESOLVER BOUNDARY — the functions that
  turn a manifest-supplied string into a real path — and it holds there**:
  `resolveAssetCodeDirectory` in `src/local/lambda-resolver.ts` carried the
  same pair on the same decision, for a value that gets bind-mounted, and took
  the whole call into an `AssetCodeResolveOptions` bag
  ([#3549](https://github.com/go-to-k/cdkd/issues/3549)).
  **It does NOT hold one layer down, and saying it did was wrong twice.**
  `src/utils/assembly-path.ts` still has three:
  `assemblyPathEscape(base, bound, candidate)` — where `(base, bound)` IS the
  resolve-from / contain-within pair, and its own doc says the two "differ for
  a Stage" — plus `resolveAssemblyPath(dir, candidate)` and
  `absoluteAssemblyPathEscape(bound, absolutePath)`. Those are the shared
  primitives the resolvers call, with ~20 call sites between them, so
  converting them is its own change rather than a rider on a resolver's. Do
  not restate the invariant as whole-program until they are done.
  The surviving `??` fallbacks IN THIS LAYER — two in `buildDockerImage`, one
  in `AssetPublisher` — all NARROW onto the manifest directory and never open
  past it. `src/local/` holds two more that feed the same resolvers
  (`invoke-agentcore-watch-loop.ts`, `lambda-resolver.ts`); they narrow too, so
  THAT claim holds whole-program and only its COUNT is limited to the files
  this page governs — the opposite direction from the invariant above, whose
  claim is whole-program while its enforcement is not.
  **The containment arm is the RELATIVE one only** (issue
  [#3532](https://github.com/go-to-k/cdkd/issues/3532)): an ABSOLUTE value is
  honoured and WARNED about when it leaves `assetOutdir`, because
  `cdk synth --no-staging` emits each asset's absolute source directory and
  upstream `cdk-assets` honours it with no containment at all.
  `resolveAssemblyPath` cannot answer for an absolute value — `path.join`
  ignores a leading separator, so it folded one INTO the outdir and reported
  `contained: true` over a path that exists nowhere — so the arm calls
  `absoluteAssemblyPathEscape`. **The local twin's line that a relative refusal
  "buys nothing against an adversary" is TRUE there and FALSE here, and copying
  it was the defect**: `resolveAssetCodeDirectory` already honoured absolute
  paths before [#3494](https://github.com/go-to-k/cdkd/issues/3494), while here
  the fold plus the lexical and symlink refusals meant NO spelling reached a
  file outside the assembly. Honouring one opens that; the warning is the whole
  signal for an absolute value, and every copy of this claim — code comment,
  `docs/cli-deploy-safety.md`, changelog — says so. The nested-stack
  `aws:asset:path` walk keeps REFUSING an absolute value: a different question,
  since CDK always writes a nested template into the outdir.
  A value NAMING THE OUTDIR ITSELF, by any spelling, is accepted with its own
  warning rather than silently — the whole assembly becomes the asset, and the
  local twin's silence does not carry over because this layer's sink is an
  upload. Both resolvers ask `namesTheSameDirectory`, never `===`
  ([layout-utils.md](layout-utils.md) says why).
  The warning itself is ONE function, `absolute-asset-path-warning.ts`, and its
  SINK clause is caller-supplied — the resolvers are shared by callers that
  upload, that build an image, and that only read, so a baked-in clause
  narrates something half of them do not do. `resolveFileAssetSourcePath` runs at the TOP of
  `publish`, above the `objectExists` short-circuit: below it, an
  already-present object skipped the check entirely and the HeadObject itself
  went to a manifest-named bucket. **WARNED but never refused**
  ([#3497](https://github.com/go-to-k/cdkd/issues/3497),
  `manifest-passthrough-warnings.ts`): every BuildKit passthrough
  (`dockerFile`, `dockerBuildContexts`, `dockerBuildSecrets`,
  `cacheFrom` / `cacheTo`, `dockerOutputs`) whose host path leaves the
  assembly, `source.executable` before it runs, and the DESTINATION half —
  `redirectFileAsset` rewrites only default-bootstrap-shaped destinations, so a
  manifest-chosen bucket name survives verbatim. **Do not harden any of these
  into a refusal or an opt-in flag**: that is the maintainer decision recorded
  on the issue, not an unfinished state. It is CDK-CLI parity territory, the
  attack presupposes someone who already controls the assembly and therefore
  the account, and a default-deny plus flag reduces who HOLDS the capability
  without protecting who USES it. What was cdkd's to fix was the silence.
  Every path judgement there goes through `assemblyPathEscape`
  ([layout-utils.md](layout-utils.md)), which picks the absolute or relative
  arm; a warn-only caller must not re-derive that branch.
- **asset-storage.ts** — cdkd-owned asset storage (issue
  [#1002](https://github.com/go-to-k/cdkd/issues/1002)). Custom bucket / repo
  names are validated BEFORE any AWS call and carried in the marker; differing
  names on re-bootstrap raise `ASSET_STORAGE_NAME_CONFLICT`.
  `ensureAssetStorage` creates the bucket, an IMMUTABLE-tag ECR repo and the
  per-region marker (`cdkd-bootstrap/{region}.json`) LAST; a bucket owned
  elsewhere is refused and every probe passes `ExpectedBucketOwner`.
  `AssetModeResolver` reads that marker at deploy time: absent means legacy
  mode, present means `cdkd-assets` mode with existence verification and a HARD
  ERROR on missing or malformed, never a silent fallback. `autoCreate` is deploy-only, never under `--dry-run`, and
  confirm-gated; `useCdkBootstrapAssets` pins legacy. Teardown deletes the
  marker LAST, takes names FROM it, and refuses on a reference scan.
- **asset-redirect.ts** — `buildAssetRedirectMap` maps only
  default-bootstrap-shaped destinations for the DEPLOY account and region;
  custom names and cross-region ones stay verbatim.
  `findUnrewrittenAssetReferences` audits after resolution: a surviving
  CDK-bootstrap reference FAILS the resource before provisioning.
  `redirectFileAsset` / `redirectDockerAsset` consume the SAME table as
  `rewriteTemplateAssetReferences`, so they cannot diverge; `synth` / `export`
  are unrewritten by design. **On `import` the rewrite must NOT reach
  `state.properties`** (issue
  [#1652](https://github.com/go-to-k/cdkd/issues/1652)): both walks
  `structuredClone` the template BEFORE the in-place rewrite and feed that
  snapshot to `buildStackState`, so state records the CDK-bootstrap values AWS
  holds, so the next deploy emits the corrective UPDATE.
- **docker-build.ts** — the shared `docker build`, reused by the ECR publish and
  `src/local/ecs-task-runner.ts`. It streams
  rather than buffering, sets `BUILDX_NO_DEFAULT_ATTESTATIONS=1`, and keeps
  build-arg order stable, which is load-bearing for the layer cache. EVERY argv
  it renders goes through
  [docker-argv-redaction.md](docker-argv-redaction.md), since `--build-arg`
  carries user `buildArgs`; the neither-mode error prints FIELD NAMES, not
  `JSON.stringify(source)`.
