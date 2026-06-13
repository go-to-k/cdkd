# S3 Asset Deploy Example

Exercises cdkd's **asset-publishing layer** (`FileAssetPublisher`) end-to-end
during a real `cdkd deploy` — the S3 file/ZIP asset upload path that most
Lambda fixtures skip (they use inline code, or never assert the upload
itself).

## Stack

`CdkdS3AssetDeployExample` contains:

- **Lambda function** (`AssetHandler`, Python 3.12) whose code comes from a
  **local multi-file directory** (`lambda/` — handler + `helpers/` +
  `vendored/` sub-packages). Because the directory has several files it is a
  genuine multi-file ZIP, NOT inline `Code.fromInline`, forcing cdkd to zip
  the directory and upload it to the CDK bootstrap asset bucket, then wire the
  function's `Code.S3Bucket` / `Code.S3Key` to the uploaded object.
- **Generic `s3_assets.Asset`** (`ConfigAsset`, `asset-data/`) — a small
  config directory that is NOT Lambda code. cdkd zips + uploads it to the same
  bootstrap bucket; its resolved `s3BucketName` / `s3ObjectKey` are threaded
  into the Lambda as `CONFIG_BUCKET` / `CONFIG_KEY` env vars and read back at
  runtime via the SDK.
- **IAM role + policy** (auto-created by CDK; `configAsset.grantRead(fn)` adds
  read access to the asset object).

No VPC — kept cheap (a Lambda + role + 2 asset uploads).

## Features tested in cdkd

1. **File/ZIP asset publishing** — local directory zipped + uploaded to the
   bootstrap asset bucket by `FileAssetPublisher` (content-addressed by hash,
   skip-upload-if-exists).
2. **Lambda Code S3 ref wiring** — the function runs from the uploaded ZIP
   (`get-function-configuration` shows a non-inline `CodeSize`, and an invoke
   returns the handler's marker).
3. **Generic `s3_assets.Asset` upload** — read back at runtime, proving the
   resolved bucket/key env vars were wired through cdkd's intrinsic resolver.
4. **Clean destroy** — the Lambda + role are deleted and the state file is
   gone. Bootstrap-bucket asset OBJECTS persist by design (CDK's bootstrap
   bucket is shared infrastructure cdkd never deletes), so the verify script
   does NOT fail on residual asset objects.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```

(Use `/run-integ s3-asset-deploy`.)
