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
- `asset-storage.ts` (issue #1002 PR 1) owns cdkd-owned asset storage: naming (`cdkd-assets-{acct}-{region}` bucket / `cdkd-container-assets-{acct}-{region}` ECR repo), the per-region bootstrap marker (`s3://{stateBucket}/cdkd-bootstrap/{region}.json`, written LAST by `ensureAssetStorage` from `cdkd bootstrap`; `--no-assets` opts out; squatting defense via `ExpectedBucketOwner` + owned-elsewhere hard errors), and the deploy-time `AssetModeResolver` (marker absent → legacy mode byte-identical + one info line about the `cdk gc` hazard; present → `cdkd-assets` mode with bucket/repo existence verification, hard error on missing — never silent fallback). Detection-only until PR 2 wires publish redirection + template rewrite. Design: `docs/design/1002-cdkd-asset-storage.md`.
