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

0b. **Same-region name holder is refused** — run **first**. Plant a
   **per-run unique** bucket in the region this stack deploys to, and add a
   bucket of that name to the stack via `CDKD_XR_ARM_BUCKET` (the stack creates
   it only when that variable is set, so every other phase deploys the stack it
   always deployed). Since go-to-k/cdkd#4344, a plain create of an explicitly
   named bucket first asks `S3BucketProvider.import()` (a `HeadBucket`) whether
   a bucket already holds the name, and refuses with `NAMED_CREATE_COLLISION`,
   nothing created, when one does — the account's own bucket included
   (CloudFormation's "already exists"). Asserts the refusal's text ("already
   holds that name", "Nothing was created."), that the planted bucket keeps a
   marker tag planted before the deploy, and that no state record holds
   `XrArmBucket`.

   Neither arm may plant a name the fixture itself reuses. An earlier version
   planted the stack's **own** bucket name cross-region, which poisoned that
   name for Phase 1 as well and wedged the whole fixture for over 20 minutes.

0. **Cross-region name holder is refused** — the same lookup against a
   **per-run unique** bucket this account owns in another region. The
   `HeadBucket` in the stack's region answers 301, and cdkd refuses with that
   cause ("S3 answered 301 for that bucket", "already exists in another
   region") before `CreateBucket` runs. That message names the bucket, not the
   regions. The test also asserts that the issue
   [#2227](https://github.com/go-to-k/cdkd/issues/2227) guard ("Refusing to
   adopt existing S3 bucket", which reads the region back from `CreateBucket`'s
   `BucketAlreadyOwnedByYou`) did **not** fire: on a plain create it is now
   reached only if the name is taken between the lookup and `CreateBucket`,
   which this fixture cannot stage, and
   `tests/unit/provisioning/s3-bucket-provider-already-owned-region.test.ts` /
   `s3-bucket-provider-us-east-1-preflight.test.ts` cover it. Phase 1 is
   **not** its control (nothing collides there); Phase 0b is.

   The name is unique per run for a measured reason: once an S3 bucket name has
   existed in one region, re-creating it in **another** answers
   `OperationAborted` for well over ten minutes (40 retries across 10 minutes
   never cleared it) while `HeadBucket` already reports 404. Planting the
   collision on a name the fixture reuses poisons that name for the rest of the
   run and for the next one.
0c. **Cloud-Control-routed delete identity** (issue
   [#2283](https://github.com/go-to-k/cdkd/issues/2283)) — the #2227 /
   #2245 bucket-region guards live in `S3BucketProvider`, on the **SDK** route. A bucket whose state
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
     for an unrelated reason also leaves a bucket standing. It also reads back
     the `deployments/{runId}.jsonl` that `cdkd state destroy` records (issue
     [#2423](https://github.com/go-to-k/cdkd/issues/2423)): one `destroy` run,
     `SUCCEEDED` with one delete, a `RESOURCE_SUCCEEDED` row for the planted
     bucket, and no `RESOURCE_GUARD_INDETERMINATE` row — the guard answered.
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
     The stack holds **two** cc-api-routed buckets and only one is denied, so
     the guard rows' exact membership is the in-run control: the contract is "a
     row for the resource whose probe was denied, and for no other", and a
     one-resource stack yields one row under either reading — it would look
     fenced while discriminating nothing.
     Two things about it are decisions: it drives `cdkd destroy` rather than
     `cdkd state destroy` (Arm OK already pins the state verb's events, so this
     arm keeps the top-level verb's recorder pinned live), which is why it
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
