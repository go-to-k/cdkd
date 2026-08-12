# s3-analytics-inventory

Live coverage for the `AWS::S3::Bucket` **analytics** and **inventory**
destination blocks (issue #1493 items 2/3).

Both appliers pick between the CFn FLATTENED destination shape and the SDK
NESTED one by probing member presence. A `Destination` that is a string /
array / unresolved intrinsic used to index every probe to `undefined` and the
whole block was omitted from the Put — the configuration deployed with no
destination and no error anywhere. Nothing in the integ tree exercised either
configuration before this fixture.

Phases 2-4 additionally cover the warn-and-SUBSTITUTE arms of issue
[#1670](https://github.com/go-to-k/cdkd/issues/1670): the analytics
`StorageClassAnalysis.DataExport.OutputSchemaVersion` and both destination
`Format` reads WARN and send a default when the declared value is unusable, and
the deploy then SUCCEEDS — so the engine used to record the DECLARED value for a
configuration AWS holds with the default, which `readCurrentState` can never
match. A correct template never reaches those arms, so phases 1 and 5 cannot
see the defect.

- **Phase 1** — deploy; assert both configurations reached AWS carrying the
  declared destination bucket, format and prefix.
- **Phase 2** (#1670) — `CDKD_TEST_UPDATE=malformed-substitute`; three fields
  are BLANK. Assert the deploy succeeds, that each substitution was WARNED (the
  anti-vacuity guard — the substituted values equal phase 1's, so a run where
  the Put never fired would satisfy the state assertions without exercising
  anything), that AWS holds the defaults, and that the STATE record holds the
  SUBSTITUTED value. Also assert the recorded AND observed analytics
  destinations are the FLATTENED CFn shape — `analyticsSdkToCfn` used to emit
  the SDK's nested `S3BucketDestination` wrapper, which no CFn template can
  equal, so no send-side record could converge with the readback.
- **Phase 3** (#1670) — convergence. The malformed mode leaves every other value
  at its phase-1 setting, so the substituted result is byte-identical to the
  phase-1 template and `cdkd diff` must report no analytics/inventory
  difference — asserted twice. A NEGATIVE twin then rewrites the recorded
  destination into the pre-fix NESTED shape and requires `cdkd diff --fail` to
  report it, so the flattening assertions cannot pass vacuously. `diff`, not
  `drift`: the drift comparator prefers `observedProperties`, and both sides of
  that comparison come from the same readback mapper, so a mapper emitting the
  wrong shape agrees with itself.
- **Phase 4** (#1670) — hand-patch the state record malformed and redeploy the
  valid template. On a redeploy the desired bag comes from the TEMPLATE, so this
  does not reach the substitution arms; what it covers is that only the DESIRED
  side is guarded, so a value an older binary recorded cannot wedge the stack.
- **Phase 5** — `CDKD_TEST_UPDATE=true`; changed prefixes and inventory format.
  Runs the per-id diff path where the update-path warn callback is wired and
  asserts the readback shows the new values (i.e. the destination was updated,
  not dropped).
- **Phase 6** — destroy; assert both buckets and the state file are gone.

The fourth substitution arm — the inventory `ScheduleFrequency` ->
`Schedule.Frequency` fall-through — is **not** covered live: the CFn schema
declares no `Schedule` member, and aws-cdk-lib's L1 renderer drops a member it
does not declare, so no CDK template can carry the second source. It stays
unit-covered in
`tests/unit/provisioning/s3-bucket-provider-substituted-properties.test.ts`.

Only the FLATTENED shape is covered live: it is the only one a CDK template can
express. `S3BucketDestination` is the SDK spelling cdkd additionally accepts for
state records and hand-written templates, and aws-cdk-lib's L1 renderer drops a
member it does not declare — that branch is unit-covered in
`tests/unit/provisioning/s3-bucket-provider-destination-shape.test.ts`.

The report bucket carries a bucket policy allowing `s3.amazonaws.com` to write:
S3 rejects `PutBucketAnalyticsConfiguration` / `PutBucketInventoryConfiguration`
outright when the destination policy is missing, so it is part of the fixture
rather than incidental setup.

## Run

```bash
STATE_BUCKET=cdkd-state-$(aws sts get-caller-identity --query Account --output text) ./verify.sh
```
