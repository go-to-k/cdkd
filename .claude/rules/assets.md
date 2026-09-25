---
description: cdkd asset publishing layer (S3 ZIP upload, ECR build and push)
paths:
  - 'src/assets/**'
  - 'src/local/**'
---

# Asset publishing

Self-implemented; no external CDK asset library.

- `FileAssetPublisher` does S3 upload with ZIP packaging (`archiver`);
  `DockerAssetPublisher` does ECR build and push; `AssetPublisher` orchestrates
  both for the standalone `publish-assets` command.
- On `deploy`, `WorkGraph` manages asset nodes directly: file assets as
  `asset-publish` nodes, Docker assets as `asset-build -> asset-publish` chains.
- `AssetManifestLoader` reads asset manifests from `cdk.out`.

Per-module notes are in [layout-assets.md](layout-assets.md); the cross-region
refusal is in [asset-bucket-region.md](asset-bucket-region.md). Design:
`docs/design/1002-cdkd-asset-storage.md`.

## Things easy to get wrong

- **The deploy region is canonicalized at `AssetModeResolver.resolve`'s own
  boundary** (issue [#2021](https://github.com/go-to-k/cdkd/issues/2021)), so an
  env-agnostic stack deployed under `--region US-EAST-1` cannot miss the marker
  and downgrade silently to legacy, and `us-east-1` / `US-EAST-1` share
  one cache slot. The RAW spelling travels on to the MARKER READ alone,
  through the shared `readBootstrapMarkerBody` two-probe helper, because the
  WRITE side does not fold; that helper's JSDoc holds the reachability
  conditions.
- **`cdkd gc`** deletes unreferenced, old objects and images from ONE region's
  asset storage: names come from the marker, the reference scan is whole-bucket
  over state files, a lock or malformed state aborts it, `--older-than` defaults
  to 30d, and CDK bootstrap storage is never touched.
- **`--use-cdk-bootstrap-assets`** and `context.cdkd.useCdkBootstrapAssets` pin
  legacy per invocation and per app (`resolveUseCdkBootstrapAssets`).
- `loadPublishableAssetManifest` gates the redirect wiring so an ASSET-LESS
  stack stays byte-identical. Integ: `tests/integration/asset-migration/`.
