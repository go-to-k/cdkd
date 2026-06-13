# cross-region-state-bucket

Integration test fixture that verifies cdkd works when the state bucket
lives in a different AWS region from the CLI's profile region.

## Background

Pre-PR #60 (v0.10.0), running `cdkd state list --state-bucket
<bucket-in-us-west-2>` from a profile defaulting to `us-east-1`
would fail with the AWS SDK v3
synthetic `UnknownError` — the SDK's region-redirect middleware does not
recover cleanly from the empty-body 301 HEAD response S3 returns when the
client's region does not match the bucket's region.

After PR #60, the state backend resolves the bucket region via
`GetBucketLocation` (a GET, not a HEAD — has a body and is not subject to
the SDK glitch) and rebuilds its S3 client for the bucket's actual region
before issuing any state operation. Provisioning clients are unaffected
and continue to use `env.region`.

Issue #803 extended the same region resolution to the `LockManager`:
PR #60 only fixed the state backend, so state reads/writes succeeded
against a cross-region bucket while every lock acquisition still failed
with S3's 301 PermanentRedirect ("must be addressed using the specified
endpoint"). `LockManager` now resolves the bucket's actual region before
its first S3 operation and rebuilds its own client when it differs.

Issue #819 closed the last instance of the same class: the exports index
store (`Fn::ImportValue` cross-stack reference tracking, writes
`_index/{region}/exports.json`) also used a CLI-base-region client, so its
index write (after deploy) and remove (after destroy) hit the 301 — logged
as `Exports index ... failed (non-retryable): ... must be addressed using
the specified endpoint; continuing without index update`. Non-fatal (the
canonical `state.json` is unaffected and the index self-heals), so the run
still passed while the cross-region index was silently never maintained.
`ExportIndexStore` now resolves the bucket region the same way before its
S3 ops. To exercise the path, the fixture stack publishes a CloudFormation
Output with an `Export.Name` (an export-less stack short-circuits the index
write), and `verify.sh` greps the deploy + destroy output to assert the 301
warning is gone AND that `_index/{region}/exports.json` was actually written
to the cross-region bucket.

## Automated run (`verify.sh`)

`verify.sh` sets up the cross-region precondition itself — no pre-existing
bucket needed:

1. Creates a **temporary, uniquely-named** state bucket in `us-west-2`
   (`BUCKET_REGION` override supported; auto-flips to `us-east-1` if the
   base region already is `us-west-2`).
2. Runs `cdkd deploy` / `cdkd state ls` / `cdkd destroy` with `AWS_REGION`
   pointed at `us-east-1` (the base region) while the state bucket lives in
   `us-west-2`. Pre-#803 the deploy failed at lock acquisition.
3. Asserts after deploy: `state.json` AND the exports index
   `_index/{region}/exports.json` exist in the bucket, `lock.json` was
   released (the lock path round-tripped cross-region), the fixture's SSM
   parameter exists in the base region, and the deploy output carries NO
   exports-index 301 warning (issue #819).
4. Asserts after destroy: state and the SSM parameter are gone, and the
   destroy output carries NO exports-index 301 warning.
5. Deletes the temporary bucket at the end — including on failure, via an
   EXIT trap that also attempts `cdkd destroy` / direct SSM cleanup first.

```bash
bash tests/integration/cross-region-state-bucket/verify.sh
```

Run it via `/run-integ cross-region-state-bucket` like any other fixture.

## Manual run

Create a state bucket in a non-default region, then run cdkd commands
under a different default region:

```bash
# Bucket in us-west-2.
aws s3api create-bucket \
  --bucket cdkd-state-test-cross-region \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

# CLI defaults to us-east-1, but the state bucket lives in us-west-2.
AWS_REGION=us-east-1 cdkd deploy   --state-bucket cdkd-state-test-cross-region
AWS_REGION=us-east-1 cdkd state ls --state-bucket cdkd-state-test-cross-region
AWS_REGION=us-east-1 cdkd destroy  --state-bucket cdkd-state-test-cross-region

# Cleanup.
aws s3 rb s3://cdkd-state-test-cross-region --region us-west-2 --force
```

Expected: every command runs to completion. Pre-PR-#60 the `state ls` /
`deploy` commands would surface `UnknownError` and abort; pre-#803 the
`deploy` / `destroy` commands failed at lock acquisition with a 301
PermanentRedirect even after the state backend fix.

## What this fixture does NOT cover

- The provisioning clients (CC API, Lambda, IAM, etc.) are still pointed
  at `env.region`. This test only exercises the state-bucket S3 clients'
  (state backend + lock manager) region resolution.
