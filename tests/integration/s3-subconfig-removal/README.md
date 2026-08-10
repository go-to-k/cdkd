# s3-subconfig-removal

cdkd S3 sub-config **removal** semantics integration test (issue
[#1466](https://github.com/go-to-k/cdkd/issues/1466)).

An `AWS::S3::Bucket` declaring four sub-configs that all used to sit on the
provider's unconditional "always-PUT" path. Removing one from the template was a
**silent no-op**: the guarded `if (properties['X'])` branch simply never ran, so
the old value survived on the real bucket while `cdkd deploy` reported `updated`
and `cdkd drift` reported `no drift` — no command surfaced the difference.

## What it covers

- `AWS::S3::Bucket`

## Why the expectations are not uniform

CloudFormation resets a removed property to its type default, but "the default"
differs per property — and for one of the four, CFn keeps the value. Each row
below was pinned by a **live CloudFormation A/B** on this same template pair
(base → stripped), not inferred from cdkd's source:

| Property removed | CloudFormation | cdkd (after the fix) |
| --- | --- | --- |
| `VersioningConfiguration` | `Status: Suspended` | `PutBucketVersioning(Suspended)` |
| `OwnershipControls` | deleted | `DeleteBucketOwnershipControls` |
| `BucketEncryption` | reset to `AES256` | `DeleteBucketEncryption` |
| `PublicAccessBlockConfiguration` | **kept** | **no call** — already at parity |

The `PublicAccessBlockConfiguration` row is the reason this fixture asserts a
*negative*. In the provider source it looks identical to the other three, so
without a real-AWS assertion that it SURVIVES, a later "make these consistent"
refactor would turn correct behavior into a divergence.

## Phases

1. **Deploy** the baseline and assert all four sub-configs reached AWS.
2. **Re-deploy with `CDKD_TEST_UPDATE=true`**, which removes all four from the
   template. Assert versioning is `Suspended`, ownership controls are gone,
   encryption is back to `AES256`, the public access block is untouched, and
   the bucket was **not replaced**. Then assert `cdkd drift` is clean — which
   also exercises the `GetBucketOwnershipControls` read the same issue added
   (without it, drift was structurally blind to this property).
   The first three assertions FAIL against the pre-fix binary.
3. **Destroy** and assert the bucket and the state file are gone.

## Run

```bash
vp run build                       # from repo root — verify.sh runs dist/cli.js
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```

Or via the skill: `/run-integ s3-subconfig-removal`.
