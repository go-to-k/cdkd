# Legacy state migration integration test

Verifies that cdkd auto-migrates a pre-PR-1 (`version: 1`) state file from the
legacy key (`cdkd/{stackName}/state.json`) to the new region-prefixed key
(`cdkd/{stackName}/{region}/state.json`) on the next write, and that the
legacy key is removed afterward.

## Manual test plan

```bash
export STATE_BUCKET="<your bucket>"
export AWS_REGION="us-east-1"
STACK="CdkdLegacyMigrationExample"

# 1. Seed a legacy version: 1 state at the legacy key.
cat >/tmp/legacy.json <<EOF
{
  "version": 1,
  "stackName": "$STACK",
  "region": "$AWS_REGION",
  "resources": {},
  "outputs": {},
  "lastModified": $(date +%s)000
}
EOF
aws s3 cp /tmp/legacy.json "s3://$STATE_BUCKET/cdkd/$STACK/state.json" \
  --content-type application/json

# 2. Deploy the fixture (will read the legacy state and write the new key).
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket "$STATE_BUCKET" --region "$AWS_REGION"

# 3. Confirm the migration happened:
aws s3 ls "s3://$STATE_BUCKET/cdkd/$STACK/"
# Expected: only `${AWS_REGION}/` shows up. The bare `state.json` is gone.

# 4. Clean up.
node ../../../dist/cli.js destroy "$STACK" --yes \
  --state-bucket "$STATE_BUCKET" --region "$AWS_REGION"
```

The shared `scripts/verify-bc.sh PR-1` driver runs an equivalent sequence
without requiring a real CDK app deploy.
