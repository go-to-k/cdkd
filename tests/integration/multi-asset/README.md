# Multi-Asset Example

Stresses cdkd's **asset-publishing layer** when MANY assets of TWO kinds
publish **concurrently in one `cdkd deploy`**. Where
[`docker-image-asset`](../docker-image-asset/) exercises the ECR build+push
path alone and [`s3-asset-deploy`](../s3-asset-deploy/) exercises the S3 zip
path alone, this fixture forces `FileAssetPublisher` + `DockerAssetPublisher`
to run together (ECR + S3 in one run) and exercises asset-ref intrinsics.

## Stack

`CdkdMultiAssetExample` (no VPC) publishes **1 ECR image + 4 S3 objects** in
one deploy:

- **`DockerHandler`** — a `lambda.DockerImageFunction` built from a local
  `docker/` Dockerfile (`public.ecr.aws/lambda/nodejs:20` base). The build
  `platform` AND the Lambda `architecture` are BOTH pinned to **ARM_64**
  (matching) to avoid the cross-arch `Runtime.InvalidEntrypoint:
  ProcessSpawnFailed` trap on Apple-Silicon hosts (a default
  `DockerImageFunction` emits no `source.platform`, so cdkd builds for the host
  arch and pushes an arm64 image to an x86_64 Lambda). Goes through
  `DockerAssetPublisher` -> ECR build+push.
- **`AlphaHandler` / `BetaHandler` / `GammaHandler`** — three `lambda.Function`s
  (Python 3.12), each `Code.fromAsset('<distinct local dir>')`
  (`lambda-alpha/` / `lambda-beta/` / `lambda-gamma/`). Each directory is a
  genuine multi-file tree (handler + `pkg/` sub-package) with **distinct
  content** (distinct asset hash -> distinct S3 object), so each is a separate
  `FileAssetPublisher` upload. The alpha Lambda additionally consumes the
  generic asset (below) via env.
- **`ConfigAsset`** — a generic `s3_assets.Asset` (`asset-data/`, NOT Lambda
  code) — a **4th** `FileAssetPublisher` S3 upload. Its resolved
  `s3BucketName` / `s3ObjectKey` are threaded into the alpha Lambda as
  `CONFIG_BUCKET` / `CONFIG_KEY` env vars and read back at runtime via the SDK.

## How each Lambda's distinct marker proves correct wiring

Each Lambda returns its OWN marker baked into its OWN asset:

| Lambda          | Asset kind            | Marker                            |
| --------------- | --------------------- | --------------------------------- |
| `DockerHandler` | Docker image (ECR)    | `cdkd-multi-asset-marker-docker`  |
| `AlphaHandler`  | zip dir `lambda-alpha`| `cdkd-multi-asset-marker-alpha`   |
| `BetaHandler`   | zip dir `lambda-beta` | `cdkd-multi-asset-marker-beta`    |
| `GammaHandler`  | zip dir `lambda-gamma`| `cdkd-multi-asset-marker-gamma`   |

The integ invokes all four and asserts each returns its EXPECTED marker. A
**cross-wired asset** — e.g. the beta ZIP uploaded but cdkd pointed the alpha
Lambda's `Code.S3Bucket`/`S3Key` at it — would make alpha return the WRONG
marker and FAIL. So the markers prove not just that all assets uploaded, but
that each Lambda was wired to the RIGHT one.

## Features tested in cdkd

1. **Concurrent multi-asset publish** — 1 Docker/ECR image + 4 S3 objects in a
   single deploy (`FileAssetPublisher` + `DockerAssetPublisher` interleaved).
2. **Docker image asset (ECR build+push)** — the Docker Lambda is
   `PackageType=Image` with OUR pushed image present in ECR by content-tag
   (parsed from `Code.ImageUri`), and the image runs (invoke -> docker marker).
3. **File/ZIP asset publishing + correct Code ref wiring** — each zip Lambda's
   `CodeSize` is above the inline threshold (ran from an uploaded ZIP, not
   inline) and each returns its DISTINCT marker (correct asset wired).
4. **Generic `s3_assets.Asset` upload + intrinsic wiring** — the 4th S3 upload
   is read back by the alpha Lambda (`configBytes > 0`), proving the upload
   reached AWS and the `CONFIG_BUCKET`/`CONFIG_KEY` intrinsic resolved.
5. **Clean destroy** — all 4 Lambdas + roles deleted, OUR pushed ECR image (by
   tag) gone, state file gone. The shared bootstrap container-assets ECR repo +
   the bootstrap asset bucket OBJECTS persist by design (CDK bootstrap infra
   cdkd never deletes), so the verify script does NOT fail on them.

## Docker guard

`verify.sh` requires a running Docker daemon to build + push the image asset.
On a Docker-less box it SKIPs cleanly (`docker info` fails -> prints SKIP +
exits 0), so it is robust on a Docker-less box but runs in a Docker env.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```

(Use `/run-integ multi-asset`.)
