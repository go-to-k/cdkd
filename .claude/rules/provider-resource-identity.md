---
description: Confirming WHICH resource a provider is about to act on - globally-scoped "already exists" errors, and a state record's physical id before update/delete
paths:
  - 'src/provisioning/providers/**'
---

# Act on the resource you MEAN, not the one the name matched

Before short-circuiting a create-conflict error to an idempotent success, ask
what NAMESPACE the error is scoped to, and whether it is narrower, equal to, or
WIDER than the region the client points at. The short-circuit is sound only when
the error can mean nothing but "the resource I want, where I want it, is already
there". Nearly every type makes this trivial — the namespace is regional, or
global over a global resource — which is why the one exception is easy to miss.
`AWS::S3::Bucket` is that exception — a globally unique name over a regionally
located resource — and it broke three separate ways (issues
[#2227](https://github.com/go-to-k/cdkd/issues/2227) /
[#2241](https://github.com/go-to-k/cdkd/issues/2241) /
[#2245](https://github.com/go-to-k/cdkd/issues/2245)).

**Short because of a BUDGET, not because the rest did not matter**: `.claude/rules`
has a corpus byte ceiling the repo now sits against (issue
[#2310](https://github.com/go-to-k/cdkd/issues/2310)), so anything the CODE can
state lives in `s3-bucket-provider.ts` — read `assertExistingBucketRegion`,
`assertStateBucketRegion`, `announceUnverifiedBucketIdentity` and
`probeBucketRegion` (which carries the us-east-1 legacy-200 case, and the
lesson that a probe wants exercising in BOTH directions) there, and
`src/utils/aws-region-resolver.ts` for the fail-OPEN probe traps. Below is only
what opening the provider will not tell you.

**These guards are SDK-ROUTE-ONLY.** `AWS::S3::Bucket` declares silent-drop
properties (`AccessControl`, still emitted by CDK's L1 for `accessControl:`), so
`provider-registry.ts` auto-routes such a bucket to `CloudControlProvider` and
pins `provisionedBy: 'cc-api'` STICKILY — the type is not in
`STICKY_CC_MIGRATION_EXEMPT`. On that route `S3BucketProvider.delete` never runs
at all: no probe, no refusal, no warning, and `CloudControlProvider`'s
client-region `assertRegionMatch` cannot see a physical id naming a bucket
elsewhere. One ordinary CDK property gets you there. Tracked as issue
[#2283](https://github.com/go-to-k/cdkd/issues/2283) and NOT fixed by these
guards — stated here because a rule file that overstates its coverage is worse
than one that admits a hole.

**A guard reporting a failed probe names the error CLASS, never AWS's message,
and the invariant is per-READER.** That message is not neutral text: on the
population these guards exist for — a bucket policy denying the probe — S3
answers `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not
authorized to perform: ...`, so one default-level line prints the account, the
role and the session to the terminal and to CI logs. Class in the warning, AWS's
text behind `logger.debug`, a `--verbose` pointer between them
(`dynamodb-index-busy-delete.ts` is the other instance). Redaction that DISCARDS
the message is its own defect — the message is what separates a missing IAM
grant from a bucket policy — so fence BOTH halves. And fix it by GREPPING every
reader of the field rather than by reading the diff: this leak shipped twice in
one lane because the missed readers were sibling call sites of the fixed one.

**A probe has THREE outcomes, and "could not answer" must never collapse into
"absent".** Absence is a positive answer from the API; an unanswered probe is no
answer at all. They license opposite things, because `absent` is what re-enables
the destructive branch the guard exists to withhold — so a two-state
`region | undefined` hands every permission error, throttle and gateway 404 to
the delete it was probing to prevent. Keep them distinct in the TYPE
(`BucketRegionProbe`) and decide each caller's arms separately.
