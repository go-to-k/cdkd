# Drift Revert E2E Test

Real-AWS end-to-end test for `cdkd drift` + `cdkd drift --revert`.

The mocked round-trip unit tests (one per SDK provider's
`readCurrentState` round-trip via `provider.update`) catch logic bugs.
This fixture catches the AWS-shape divergences and timing flakiness that
mocks miss — the comparator, the AWS-current snapshot read, and the
revert update are all exercised against live AWS.

## What it does

1. `cdkd deploy` an S3 Bucket (with two tags) + an SNS Topic (with a
   DisplayName).
2. Mutate them out-of-band via direct AWS SDK calls:
   - `PutBucketTagging` adds a third tag (`IntegInjected=yes`,
     preserving the existing two).
   - `SetTopicAttributes` flips `DisplayName` from `integ-display` to
     `integ-display-DRIFTED`.
3. `cdkd drift CdkdDriftRevertExample` — assert exit code **1** (drift
   detected on both resources).
4. `cdkd drift CdkdDriftRevertExample --revert -y` — assert exit code
   **0** (revert succeeds for both).
5. `cdkd drift CdkdDriftRevertExample` again — assert exit code **0**
   (state and AWS are back in sync).
6. `cdkd destroy CdkdDriftRevertExample --force` — clean up.

## Run

```bash
bash tests/integration/drift-revert/verify.sh
```

The script:

- Resolves the AWS account ID via `aws sts get-caller-identity`.
- Picks the cdkd state bucket as `cdkd-state-${accountId}` (override
  with the `STATE_BUCKET` env var).
- Builds cdkd from the repo root.
- Hard-fails with exit 1 if any assertion fails. On failure it still
  attempts a final `cdkd destroy --force` so a botched run does not
  leave AWS resources behind — except when the deploy was refused on
  another process's lock: this run then created nothing, and the stack
  belongs to that peer, so the destroy is skipped.

## Resources

- `AWS::S3::Bucket` (DriftBucket) — `removalPolicy: DESTROY`,
  `autoDeleteObjects: true`. Two user tags at deploy time.
- `AWS::SNS::Topic` (DriftTopic) — `displayName: 'integ-display'`.

Both providers (`S3BucketProvider`, `SNSTopicProvider`) implement
first-class `readCurrentState` and have working `update()`, so the
revert path exercises real AWS calls (`PutBucketTagging`,
`SetTopicAttributes`), not the CC API fallback.

The full resource list is in the stack's doc comment
(`lib/drift-revert-stack.ts`). Step 6e (issue
[#4023](https://github.com/go-to-k/cdkd/issues/4023)) covers a NAMED
`AWS::IAM::Role` and `AWS::IAM::ManagedPolicy`: the stack is deployed with
`CDKD_PREFIX_USER_SUPPLIED_NAMES=true` (the legacy prefixing), their observed baselines are stripped, and
`--revert` must update the prefixed resources in place rather than replace
them under the bare template names. On failure `cleanup` also deletes any
copies left under those bare names. Step 6f (issue
[#4081](https://github.com/go-to-k/cdkd/issues/4081)) then runs a plain
`cdkd drift --json` on the same records and requires neither to report a name
drift, since the live name is the prefixed form of the recorded one.
