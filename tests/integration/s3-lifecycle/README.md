# s3-lifecycle

cdkd S3 lifecycle V1/V2 normalization integration test.

An `AWS::S3::Bucket` whose `LifecycleConfiguration` mixes a **prefix-scoped rule**
(CloudFormation emits a top-level `Prefix`, the deprecated "V1" form) with a rule
that has **no prefix and no filter** (an `AbortIncompleteMultipartUpload`-only
rule). S3 rejects a single `PutBucketLifecycleConfiguration` that mixes V1
(top-level `Prefix`) and V2 (`Filter`) rules with
`Filter element can only be used in Lifecycle V2`. CloudFormation normalizes
this transparently; cdkd must too. Regression coverage for the bug found by the
2026-06-29 bug-hunt sweep (cdkd produced a mixed payload — the prefix rule stayed
V1 while the scope-less rule got an empty `Filter` — so both CREATE and UPDATE
failed against real S3).

## What it covers

- `AWS::S3::Bucket`

## Phases

0b. **Same-region adopt** — the negative control, run **first**. Plant a
   **per-run unique** name in the region this stack deploys to (the same
   `CDKD_XR_ARM_BUCKET` hook Phase 0 uses); cdkd must **adopt** it and complete
   the deploy. Under the default `us-east-1` this does **not** enter the guard
   at all — S3 answers a same-region re-create with a legacy 200 OK rather than
   the 409 — so there it is a regression net for "cdkd deploys cleanly over a
   pre-existing same-region bucket", **not** a discriminating negative control.
   Set `AWS_REGION` elsewhere and it becomes one. The guard's adopt arm is
   fenced by the unit suite either way.

   Neither arm may plant a name the fixture itself reuses. An earlier version
   planted the stack's **own** bucket name cross-region, which poisoned that
   name for Phase 1 as well and wedged the whole fixture for over 20 minutes.

0. **Cross-region adopt refusal** (issue
   [#2227](https://github.com/go-to-k/cdkd/issues/2227)) — plant a **per-run
   unique** bucket name in another region, and add a bucket of that name to the
   stack via `CDKD_XR_ARM_BUCKET` (the stack creates it only when that variable
   is set, so every other phase deploys the stack it always deployed). Then
   deploy. `CreateBucket` answers `BucketAlreadyOwnedByYou` on account-global
   **ownership**, so cdkd must read the bucket's real region back — from the
   409's own `x-amz-bucket-region` header — and **refuse** rather than adopt and
   reconfigure a bucket that lives elsewhere. Asserts the refusal text naming
   both regions, not merely that the deploy failed. Phase 1 is **not** its
   negative control (nothing collides there); Phase 0b is.

   The name is unique per run for a measured reason: once an S3 bucket name has
   existed in one region, re-creating it in **another** answers
   `OperationAborted` for well over ten minutes (40 retries across 10 minutes
   never cleared it) while `HeadBucket` already reports 404. Planting the
   collision on a name the fixture reuses poisons that name for the rest of the
   run and for the next one.
0c. **Cloud-Control-routed delete identity** (issue
   [#2283](https://github.com/go-to-k/cdkd/issues/2283)) — the Phase 0 guard
   lives in `S3BucketProvider`, on the **SDK** route. A bucket whose state
   record says `provisionedBy: cc-api` never reaches that provider:
   `ProviderRegistry.getProviderFor` step 2 (the sticky rule) hands it to
   `CloudControlProvider` **before** the SDK provider is consulted, and that
   provider's only region check fires on the `NotFound` branch — which, per the
   mechanism issues [#2245](https://github.com/go-to-k/cdkd/issues/2245) /
   #2283 record, S3 does not produce here, because it follows the region
   redirect for a body-bearing operation. The destroy would then delete a live
   bucket in another region and report success. This phase is what holds that
   mechanism to account on the Cloud Control route.

   Both arms plant a **hand-written** single-resource state record rather than
   deploying one, because that **is** the defect's premise: a record written by
   a cdkd build from before the guards existed, whose `physicalId` names a
   bucket that is ours but lives elsewhere. It also leaves the CDK app entirely
   untouched, so every other phase synthesizes exactly the stack it always did.

   - **Arm OK** (the negative control, and load-bearing): a bucket really in
     this region must still delete through the Cloud Control route. Without it,
     Arm XR would "pass" on any malformed-state failure — a destroy that died
     for an unrelated reason also leaves a bucket standing.
   - **Arm XR**: a **per-run unique** bucket planted in another region, named by
     a state record that claims this one. cdkd must refuse — asserted on the
     refusal text naming both regions **and** on the bucket still being there
     afterwards, which is the half that distinguishes fixed from broken.
   - **Arm ID** (issue [#2301](https://github.com/go-to-k/cdkd/issues/2301)
     item 3): the third outcome, and the one the attack produces — the probe
     cannot ANSWER. A bucket policy on the target denies
     `s3:GetBucketLocation`, which is what anyone holding `s3:PutBucketPolicy`
     on it can set. cdkd must PROCEED (refusing would strand every
     least-privilege destroy) **and** leave a durable trace: the arm asserts on
     the `RESOURCE_GUARD_INDETERMINATE` row inside the persisted
     `deployments/{runId}.jsonl` OBJECT, not on console text, because console
     output not surviving the run IS the defect. It also asserts the row sits
     ALONGSIDE the resource's `RESOURCE_SUCCEEDED` rather than replacing it.
     Two things about it are decisions: it drives `cdkd destroy` rather than
     `cdkd state destroy` (the latter threads no event recorder, so it writes
     no events at all — issue
     [#2423](https://github.com/go-to-k/cdkd/issues/2423)), which is why it
     runs from a scratch directory with no `cdk.json` so the CLI falls back to
     its state-based stack list; and the delete still succeeding under the deny
     was MEASURED, not assumed — `cloudformation describe-type --type-name
     AWS::S3::Bucket` (us-east-1, 2026-09-02) lists `s3:GetBucketLocation` in
     none of the five handlers, and `delete` needs only `s3:DeleteBucket` +
     `s3:ListBucket`.

1. **Deploy** the bucket with a V1 prefix rule (`archive`, `logs/`) + a scope-less
   abort rule (`abort-mpu`). Assert both rules reached AWS, **none** carries a
   top-level `Prefix` (all normalized to V2 `Filter` form), and the `archive`
   rule's expiration is 730 days.
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` — shortens the GLACIER transition
   (90 → 60), lowers expiration (730 → 365), and adds a third **Filter-based**
   rule (`big-objects`, `ObjectSizeGreaterThan`). Assert the new values reached
   AWS, there are 3 rules, and the bucket was **not** replaced (same
   `CreationDate`).
3. **Destroy** and assert the bucket is gone and the cdkd state file is removed.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
