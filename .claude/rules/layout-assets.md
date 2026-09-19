---
description: cdkd assets layer (publishing, cdkd-owned asset storage, redirect)
paths:
  - 'src/assets/**'
---

# Assets layer

- **file-asset-publisher.ts** / **docker-asset-publisher.ts** — S3 ZIP upload;
  ECR image build and push.
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
