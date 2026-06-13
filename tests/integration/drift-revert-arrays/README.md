# Drift Revert Arrays E2E Test

Real-AWS end-to-end test for `cdkd drift` + `cdkd drift --revert` against
**tag-heavy** and **array-heavy** resource types — the issue
[#802](https://github.com/go-to-k/cdkd/issues/802) canonicalization path
(`src/analyzer/drift-normalize.ts`).

## Why this exists (vs `drift-revert` / `drift-revert-vpc`)

`cdkd drift` compares each resource's deploy-time AWS snapshot
(`observedProperties`) against a later AWS read, and the comparator in
`drift-calculator.ts` compares arrays **positionally**. AWS does not
guarantee element ordering across reads, so when a tag list
(`{Key,Value}[]`) or a resource-id / ARN array comes back in a different
order, the unchanged set surfaces as **phantom drift**. Issue #802 added
two order-canonicalizers (`canonicalizeTagListsDeep`,
`canonicalizeIdArraysDeep`) applied to both comparison sides.

The existing `drift-revert` / `drift-revert-vpc` fixtures exercise the
per-provider `readCurrentState -> compare -> --revert` round-trip but none
of their resources carry the unordered-set array shapes #802 fixed. This
fixture targets exactly those shapes.

## What it does

1. `cdkd deploy CdkdDriftArraysExample` — an S3 Bucket, SNS Topic, SQS
   Queue (each with six user tags), an IAM ManagedPolicy with a
   multi-statement document carrying multiple `Action[]` + multiple
   `Resource[]` (ARN arrays) + six tags, and a VPC (no NAT) +
   SecurityGroup with four CIDR ingress rules + six tags.
2. **No-false-positive on a clean deploy** — `cdkd drift` immediately
   after deploy must report **exit 0** even though AWS reorders the tag
   lists / ARN arrays on readback.
3. **No-false-positive on an induced reorder** — `inject-drift.ts reorder`
   re-PUTs the S3 bucket's existing six tags in reversed order (same set,
   different order). `cdkd drift` must still report **exit 0**
   (`canonicalizeTagListsDeep` absorbs the reorder).
4. **True drift detected** — `inject-drift.ts drift` changes a tag VALUE
   (S3), adds an Action to a managed-policy statement, and authorizes a
   NEW SG ingress rule out of band. `cdkd drift` must report **exit 1**.
5. `cdkd drift --revert -y` — assert exit **0** (revert succeeds), then a
   follow-up `cdkd drift` is clean (**exit 0**).
6. `cdkd destroy --force` — clean up.

## Run

```bash
bash tests/integration/drift-revert-arrays/verify.sh
```

The script:

- Resolves the AWS account ID via `aws sts get-caller-identity`.
- Picks the cdkd state bucket as `cdkd-state-${accountId}` (override with
  the `STATE_BUCKET` env var).
- Builds cdkd from the repo root.
- Captures the real exit code of each `cdkd drift` and hard-fails with a
  pointed message naming the regressed canonicalizer. On any failure it
  still attempts a final `cdkd destroy --force` so a botched run does not
  leave AWS resources behind, and only prints `[verify] PASS` on full
  success.

## Coverage note

The IAM ManagedPolicy `Resource: [arn, arn, ...]` arrays exercise the
ARN branch of `canonicalizeIdArraysDeep`; the `subnet-…` / `sg-…`
resource-id branch of the same function is covered by the unit tests in
`tests/unit/analyzer/drift-normalize.test.ts`. The `Action: [...]` arrays
are plain scalar lists, intentionally **not** canonicalized (they are
order-significant by design) — the true-drift step proves a real Action
change still surfaces.
