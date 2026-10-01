---
description: Global name collisions, region guards, and probe outcomes in providers
paths:
  - 'src/provisioning/providers/**'
---

# Act on the resource you MEAN, not the one the name matched

Before short-circuiting a create-conflict error to an idempotent success, or adopting a same-named resource on a create retry, ask what NAMESPACE the name is scoped to: it is sound only when the match can mean nothing but "the resource I want, in the region I want, already exists". The stack lock proves nothing here — it is per state bucket, prefix and stack, most names are per account + region, so a peer run's resource matches and destroy or the post-create cleanup deletes it ([#4256](https://github.com/go-to-k/cdkd/pull/4256) reports instead of adopting). `AWS::S3::Bucket` is the exception — a globally unique name over a regionally located resource ([#2227](https://github.com/go-to-k/cdkd/issues/2227)). Guards: `assert*BucketRegion` / `probeBucketRegion` in `s3-bucket-provider.ts`.

- **They are SDK-ROUTE-ONLY.** `AWS::S3::Bucket` declares silent-drop properties, so `provider-registry.ts` auto-routes it to `CloudControlProvider` and `S3BucketProvider.delete` never runs. Its pair, `confirmDeleteTargetIdentity` / `assertRecordedRegionAgainstClient`, splits on an INDETERMINATE region: the remote probe warns and PROCEEDS (a role may lack `s3:GetBucketLocation`), the local comparison against a recorded region REFUSES. Omitting `ExpectedBucketOwner` is deliberate: the hazard IS a foreign-account bucket, which the parameter would turn into a 403 and thence the proceed arm.
- **The proceed arm must report** — an `IndeterminateGuard` on `ResourceDeleteResult.indeterminateGuards` ([delete-outcome.md](delete-outcome.md)).
- **Report a failed probe by error CLASS, not AWS's message** (it quotes account, role and session); keep the text behind `logger.debug` rather than discarding it — it separates a missing IAM grant from a bucket policy.
- **A probe has THREE outcomes; "could not answer" must never collapse into "absent"** — `absent` re-enables the destructive branch, so a two-state `region | undefined` hands every permission error and throttle to the delete it was preventing. Keep them distinct in the TYPE (`BucketRegionProbe`).
