# Multi-region same-name integration test

Verifies that the same `stackName` deployed to two different regions produces
two independent state files at the new region-prefixed key layout
(`cdkd/{stackName}/{region}/state.json`). This exercises the silent-failure
fix from PR 1: a `region` change in CDK no longer overwrites the prior
region's state.

## Manual test plan

```bash
export STATE_BUCKET="<your bucket>"
STACK="CdkdMultiRegionExample"

# 1. Deploy to us-west-2.
CDKD_INTEG_REGION=us-west-2 \
  node ../../../dist/cli.js deploy "$STACK" \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket "$STATE_BUCKET" --region us-west-2

# 2. Deploy to us-east-1 (same stack name).
CDKD_INTEG_REGION=us-east-1 \
  node ../../../dist/cli.js deploy "$STACK" \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket "$STATE_BUCKET" --region us-east-1

# 3. Confirm both state files coexist.
aws s3 ls "s3://$STATE_BUCKET/cdkd/$STACK/"
# Expected: us-east-1/ and us-west-2/ both listed.

node ../../../dist/cli.js state list --state-bucket "$STATE_BUCKET"
# Expected: two rows
#   CdkdMultiRegionExample (us-east-1)
#   CdkdMultiRegionExample (us-west-2)

# 4. Clean up both regions.
CDKD_INTEG_REGION=us-west-2 \
  node ../../../dist/cli.js destroy "$STACK" --yes \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket "$STATE_BUCKET" --region us-west-2

CDKD_INTEG_REGION=us-east-1 \
  node ../../../dist/cli.js destroy "$STACK" --yes \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket "$STATE_BUCKET" --region us-east-1
```
