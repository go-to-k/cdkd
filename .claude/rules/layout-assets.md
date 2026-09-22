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
  **`assetOutdir` is REQUIRED on both resolvers AND on
  `FileAssetPublisher.publish` / `DockerAssetPublisher.build`**, so a dropped
  argument is a compile error rather than a silent narrowing back onto the
  manifest directory; exactly one `??` survives, in `buildDockerImage`, whose
  options bag may legitimately lack it, and it narrows, never opens.
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
  The warning itself is ONE function, `absolute-asset-path-warning.ts`, and its
  SINK clause is caller-supplied — the resolvers are shared by callers that
  upload, that build an image, and that only read, so a baked-in clause
  narrates something half of them do not do. `resolveFileAssetSourcePath` runs at the TOP of
  `publish`, above the `objectExists` short-circuit: below it, an
  already-present object skipped the check entirely and the HeadObject itself
  went to a manifest-named bucket. Unchecked and tracked in #3497: every
  BuildKit passthrough (`dockerFile`, `dockerBuildContexts`,
  `dockerBuildSecrets`, `cacheFrom` / `cacheTo`, `dockerOutputs`),
  `source.executable`, and the DESTINATION half — `redirectFileAsset` rewrites
  only default-bootstrap-shaped destinations, so a manifest-chosen bucket name
  survives verbatim.
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
