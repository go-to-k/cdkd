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

**These guards are SDK-ROUTE-ONLY, and the Cloud Control route has its OWN
pair.** `AWS::S3::Bucket` declares silent-drop properties (`AccessControl`,
still emitted by CDK's L1 for `accessControl:`), so `provider-registry.ts`
auto-routes such a bucket to `CloudControlProvider` and pins
`provisionedBy: 'cc-api'` STICKILY — the type is not in
`STICKY_CC_MIGRATION_EXEMPT`. One ordinary CDK property gets you there, and on
that route `S3BucketProvider.delete` never runs at all. That was issue
[#2283](https://github.com/go-to-k/cdkd/issues/2283), and it is FIXED (PR
[#2309](https://github.com/go-to-k/cdkd/issues/2309), extended by
[#2378](https://github.com/go-to-k/cdkd/issues/2378)) — read
`confirmDeleteTargetIdentity` and `assertRecordedRegionAgainstClient` in
`cloud-control-provider.ts`. The one thing to carry across before reading them:
they answer an INDETERMINATE region in OPPOSITE directions on purpose. The probe
asks a remote service where a globally unique name lives, so it warns and
PROCEEDS rather than stranding a role never granted `s3:GetBucketLocation`; the
comparison is local against a positively recorded region, so it REFUSES. Its
omission of `ExpectedBucketOwner` is deliberate for the same reason the SDK-side
guards exist: the hazard is a foreign-account bucket, and passing the parameter
would turn that collision into a 403 and thence into the proceed arm.

Since issue [#2301](https://github.com/go-to-k/cdkd/issues/2301) item 3 the
proceed arm is no longer silent after the run: `confirmDeleteTargetIdentity`
RETURNS an `IndeterminateGuard`, `delete()` carries it out on
`ResourceDeleteResult.indeterminateGuards`, and the destroy runner persists a
`RESOURCE_GUARD_INDETERMINATE` event plus an `N unverified` summary count. That
is what makes proceeding defensible rather than merely convenient — the attack
these guards exist to catch works by DENYING the probe, so an outcome visible
only as a `logger.warn` left a destroy that had NOT confirmed its target
indistinguishable, afterwards, from one that had. Anything added to the proceed
arm must report through that channel; see
[delete-outcome.md](delete-outcome.md) for the write/read pair and
[provider-delete-path.md](provider-delete-path.md) for what a provider owes when
it reports one.

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
