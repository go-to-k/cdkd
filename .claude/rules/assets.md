---
description: cdkd asset publishing layer (S3 file upload with ZIP packaging, ECR Docker image build & push)
paths:
  - 'src/assets/**'
  - 'src/local/**'
---

# Asset Publishing

- Self-implemented (no external CDK asset libraries)
- `FileAssetPublisher` handles S3 file upload with ZIP packaging (using `archiver`)
- `DockerAssetPublisher` handles ECR Docker image build & push
- `AssetPublisher` orchestrates using above publishers (standalone `publish-assets` command)
- For `deploy`, `WorkGraph` manages asset nodes directly: file assets as `asset-publish` nodes, Docker assets as `asset-build → asset-publish` node chains
- `AssetManifestLoader` loads asset manifests from cdk.out
- `asset-storage.ts` (issue #1002 PR 1) owns cdkd-owned asset storage: naming (`cdkd-assets-{acct}-{region}` bucket / `cdkd-container-assets-{acct}-{region}` ECR repo), the per-region bootstrap marker (`s3://{stateBucket}/cdkd-bootstrap/{region}.json`, written LAST by `ensureAssetStorage` from `cdkd bootstrap`; `--no-assets` opts out; squatting defense via `ExpectedBucketOwner` + owned-elsewhere hard errors), and the deploy-time `AssetModeResolver` (marker absent → legacy mode byte-identical + one info line about the `cdk gc` hazard; present → `cdkd-assets` mode with bucket/repo existence verification, hard error on missing — never silent fallback; `useCdkBootstrapAssets` opt pins legacy with no marker read + no notice, `suppressLegacyNotice` quiets non-publishing commands). Design: `docs/design/1002-cdkd-asset-storage.md`.
- `asset-redirect.ts` (issue #1002 PR 2) wires the `cdkd-assets` mode: `buildAssetRedirectMap` builds the §6 destination-driven mapping table from a stack's `*.assets.json` (scope rule §8 — only `cdk-[a-z0-9]+-(container-)?assets-{acct}-{region}` shapes for the deploy account+region redirect; user-chosen names / cross-region destinations stay verbatim; template-asset destinations included so nested `TemplateURL` rewrites harmlessly); `rewriteTemplateAssetReferences` is the §7 boundary-aware deep rewrite (plain strings + `Fn::Sub` template strings + folded pseudo-parameter-only `Fn::Join` runs — folds persist only when a source matched); `findUnrewrittenAssetReferences` backs the deploy engine's §7-step-3 post-resolution audit (`DeployEngineOptions.assetRedirect` — any resolved property still naming a mapped source fails the resource before provisioning); `redirectFileAsset` / `redirectDockerAsset` apply the SAME table at publish time (`AssetPublisher.addAssetsToGraph`'s `redirect` option; keys/tags untouched); `createAssetRedirectResolver` is the lazy STS+marker gate used by `diff` / `import`; `loadPublishableAssetManifest` gates everything so asset-less stacks stay byte-identical. Rewrite call sites: deploy.ts (top-level), `NestedStackProvider.readChildTemplate` (via `NestedStackProviderContext.assetRedirect`), diff-recursive's `buildDiffTree`, import.ts (top-level + recursive CFn-migration child walk). `synth` / `export` stay unrewritten by design (§7.1). `--use-cdk-bootstrap-assets` (deploy/diff/import/publish-assets) + `cdk.json context.cdkd.useCdkBootstrapAssets` pin legacy per invocation / per app (`resolveUseCdkBootstrapAssets`). Integ: `tests/integration/asset-migration/`.
