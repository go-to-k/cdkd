# Integration test: legacy-bucket-name-fallback

Verifies that cdkd falls back to the **legacy** default state bucket name
(`cdkd-state-{accountId}-{region}`) when the **new** default name
(`cdkd-state-{accountId}`) does not exist, and emits a deprecation warning.

This guards the backwards-compat read path introduced in PR 4
(`docs/plans/04-state-bucket-naming.md`). Without it, users who already
bootstrapped cdkd with the pre-v0.8 default would see a hard "run cdkd
bootstrap" error after upgrading.

## Manual run

This test is **not** part of the standard `/run-integ` rotation because it
mutates account-wide bucket inventory. Run it manually:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-us-east-1}

# 1. Pre-condition: the NEW name must NOT exist; the LEGACY name MUST exist.
#    If the new name already exists in your account, this test cannot run as
#    intended — pick a different account or temporarily rename the bucket.
aws s3api head-bucket --bucket "cdkd-state-${ACCOUNT_ID}" 2>/dev/null && {
  echo "FAIL: new-name bucket already exists; aborting"; exit 1;
}
aws s3 mb "s3://cdkd-state-${ACCOUNT_ID}-${REGION}" --region "${REGION}"

# 2. Deploy with no --state-bucket; expect the legacy fallback path.
pushd tests/integration/legacy-bucket-name-fallback >/dev/null
node ../../../dist/cli.js deploy --region "${REGION}" 2>&1 | tee /tmp/cdkd-fallback.log

# 3. Verify the warning was emitted.
grep -F "Using legacy state bucket name" /tmp/cdkd-fallback.log || {
  echo "FAIL: deprecation warning was not emitted"; exit 1;
}

# 4. Tear down: destroy the stack, remove the bucket.
node ../../../dist/cli.js destroy --region "${REGION}" --force
popd >/dev/null
aws s3 rb "s3://cdkd-state-${ACCOUNT_ID}-${REGION}" --force --region "${REGION}"
```

## Why this is a scaffold, not a full automated test

The fallback exercises real AWS S3 inventory (the existence / non-existence
of two specific bucket names per account), so it cannot be parallelized with
other tests in the same account, and it cannot be safely left in `/run-integ`
without an account-isolation step. The scaffold gives reviewers a clear
manual path; a follow-up PR can wire it into `/run-integ` once an isolated
test account is provisioned.

## Cleanup checklist

After running the test:

- `aws s3 ls | grep cdkd-state-${ACCOUNT_ID}-${REGION}` should be empty.
- `aws s3 ls | grep cdkd-state-${ACCOUNT_ID}` should be empty (unless you
  bootstrapped the new name during the test).
- `aws ssm describe-parameters --filters "Key=Name,Values=/cdkd/legacy-bucket-fallback/test"`
  should be empty.
