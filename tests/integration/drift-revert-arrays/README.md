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
`canonicalizeIdArraysDeep`) applied to both comparison sides, and issue
[#1620](https://github.com/go-to-k/cdkd/issues/1620) extended the
provider-declared opt-in pass (`canonicalizeUnorderedArraysAtPaths`, via
`getDriftUnorderedPaths`) from plain-string arrays to arrays of OBJECTS —
which is what let `ElasticLoadBalancingV2::TargetGroup.Targets` move out of
`getDriftUnknownPaths` and start being compared at all.

The existing `drift-revert` / `drift-revert-vpc` fixtures exercise the
per-provider `readCurrentState -> compare -> --revert` round-trip but none
of their resources carry the unordered-set array shapes #802 fixed. This
fixture targets exactly those shapes.

## What it does

1. `cdkd deploy CdkdDriftArraysExample` — an S3 Bucket, SNS Topic, SQS
   Queue (each with six user tags), an IAM ManagedPolicy with a
   multi-statement document carrying multiple `Action[]` + multiple
   `Resource[]` (ARN arrays) + six tags, a VPC (no NAT) +
   SecurityGroup with four CIDR ingress rules + six tags, and a standalone
   ELBv2 TargetGroup (`targetType: 'ip'`, no load balancer) with three
   registered IP targets.
2. **No-false-positive on a clean deploy** — `cdkd drift` immediately
   after deploy must report **exit 0** even though AWS reorders the tag
   lists / ARN arrays / target lists on readback.
3. **Repeated runs agree** — a SECOND back-to-back `cdkd drift` must also
   report **exit 0**. Two consecutive runs disagreeing with no code change
   in between is the signature the unordered-readback class produces
   (issues [#1620](https://github.com/go-to-k/cdkd/issues/1620) /
   [#1515](https://github.com/go-to-k/cdkd/issues/1515)), and one run
   cannot detect it. The step also asserts the templated target set
   directly, order-insensitively.
   The same two steps also cover the VALUE-mapping sibling of that class
   (issue [#1643](https://github.com/go-to-k/cdkd/issues/1643)): EC2 stores a
   declared `IpProtocol: 6` as `tcp`, so the recorded and read-back values are
   two spellings of ONE protocol. Both affected shapes are present because
   they break at different layers — the INLINE 5th rule on
   `ArraysSecurityGroup` (injected at the L1, since the L2 `addIngressRule`
   can only emit a name) is read back fine but compares unequal until
   `src/analyzer/drift-protocol-normalize.ts` canonicalizes both sides, while
   the STANDALONE `NumericProtocolIngress` fails one layer lower: its
   physicalId carries the protocol cdkd SENT, so the rule lookup matched no
   AWS rule at all and drift reported it as "drift unknown" forever. The
   standalone rule sits on its OWN security group on purpose — on the shared
   one it would materialize a member into the parent's live `IpPermissions`
   that the parent's template does not declare, which is real drift on the
   parent (the #1498 sibling-materialization class).
4. **No-false-positive on an induced reorder** — `inject-drift.ts reorder`
   re-PUTs the S3 bucket's existing six tags in reversed order (same set,
   different order). `cdkd drift` must still report **exit 0**
   (`canonicalizeTagListsDeep` absorbs the reorder).
5. **True drift detected** — `inject-drift.ts drift` changes a tag VALUE
   (S3), adds an Action to a managed-policy statement, authorizes a
   NEW SG ingress rule, and registers a fourth, untemplated IP target on
   the target group, all out of band. `cdkd drift` must report **exit 1**,
   and the fixture asserts the fourth target is genuinely live first — so
   the revert assertion below cannot pass vacuously. The drift REPORT must
   also name a `Targets` path: exit 1 on its own is satisfied by the S3 /
   IAM / SG drifts, so without that grep the step would pass identically
   with `Targets` back in `getDriftUnknownPaths` (never compared at all).
6. `cdkd drift --revert -y` — assert exit **0** (revert succeeds), then a
   follow-up `cdkd drift` is clean (**exit 0**) and the target group is
   back to exactly its three templated targets (the untemplated one
   deregistered, the other three RETAINED).
7. `cdkd destroy --force` — clean up.

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
