---
title: "Issue #6868 — Cloud Control-shaped drift baseline decision"
unlisted: true
---

# Issue #6868 — Cloud Control-shaped drift baseline decision

## TL;DR

**Rejected (maintainer decision, 2026-11-23).** cdkd keeps one drift baseline per resource: the provider's own read, recorded in `observedProperties` right after cdkd's write. It does not add a second baseline read through Cloud Control `GetResource`. The normalization rules that make the comparison correct are audited instead, each with its AWS evidence, its boundary and negative tests ([#6852](https://github.com/go-to-k/cdkd/issues/6852), [#6854](https://github.com/go-to-k/cdkd/issues/6854); rule tables in `6852-drift-normalization-rules.md` and `6854-*-normalization-rules.md` in this directory).

Revisit for **one type** only if a provider mapping bug of class (a) below recurs in that type (the Tooling Policy's second-occurrence rule). The step then is a Cloud Control baseline for that type alone, not a fixed pilot list.

## The proposal

Record a Cloud Control-shaped read of each resource as a second baseline, and let `cdkd drift` detect by comparing a fresh Cloud Control read with it. The shape is the CloudFormation template shape (no mapping for reporting or `--revert`), and Cloud Control omits `writeOnly` properties. The idea came from cdk-real-drift, which compares Cloud Control reads. cdkd does not depend on cdk-real-drift and shares no package with it; rules are ported with a comment naming their source.

## Findings

### Most rules remain under a Cloud Control comparison

The six rule tables hold 203 rows. Asked "is this rule still needed when both sides are Cloud Control reads?":

| Class | Rows | What it is |
| --- | --- | --- |
| (a) removed | 32 | The SDK readback's shape differs from Cloud Control's (value types, echoes of the recorded spelling, legacy-baseline shims). The shims stay until every record is recaptured. |
| (b) remains | 119 | AWS itself rewrites, defaults or grows the value (policy folds, unique ids, CIDR identity, `WarmThroughput`), volatile values, sibling-owned members, write-only or unreadable members, set semantics. |
| (c) changes form | 6 | Same intent, different source (e.g. unordered paths from the registry schema's `insertionOrder`). |
| (d) not drift detection | 46 | Diff, update-skip, settle or lookup rules; unaffected. |

Of the 149 drift-detection rows, 125 (84%) stay. Both bugs that motivated the audit, #6680 (unique-id principal) and #6842 (Condition array vs scalar), are class (b). An S3 bucket policy read through Cloud Control came back in the same AWS-rewritten forms as the S3 API (one-element list as a scalar, bare account id as a root ARN, `Effect` case, Condition number or boolean as a string), so the policy folds are needed either way. Resources already routed through Cloud Control have a Cloud Control-shaped `observedProperties` today; the proposal only concerns SDK-provider types.

### Measured cost

Five existing integ fixtures, us-east-1, 2026-11-23 (deploy, one `GetResource` per resource, destroy; nothing left behind):

| Fixture | Resources | CC readable / tried | `state.json` today | Projected | CC calls, serial / 8-way |
| --- | --- | --- | --- | --- | --- |
| bench-cdk-sample | 40 | 34 / 39 | 61,006 B | 76,321 B (+25%) | 41.7 s / 6.5 s |
| multi-resource | 17 | 12 / 15 | 53,705 B | 66,158 B (+23%) | 16.3 s / 2.8 s |
| microservices | 19 | 15 / 19 | 32,011 B | 39,944 B (+25%) | 19.3 s / 3.5 s |
| iam-role-policies-drift-clean | 19 | 7 / 19 | 30,242 B | 37,340 B (+23%) | 17.7 s / 2.9 s |
| s3-cloudfront | 9 | 9 / 9 | 26,341 B | 33,948 B (+29%) | 10.2 s / 2.2 s |

A `GetResource` call takes about 1.0 s on average and 1.5 s at most. Cloud Control could not read `AWS::IAM::Policy` or `AWS::SQS::QueuePolicy` (`UnsupportedActionException`), so the policy types, where a hidden difference matters most, would still need an SDK reader.

### When the baseline would be captured

- **After cdkd's own write (today's observed capture).** The most correct, but adds a Cloud Control call per written resource to every deploy (2-6 s in the drain before the final save on the fixtures above) and a full read on the first deploy after upgrading. The performance rule in #6438 forbids an AWS call a deploy does not need.
- **On the first `cdkd drift` after a deploy, or by an explicit command.** No deploy cost, but a baseline captured later absorbs any out-of-band change made in between, plain `cdkd drift` would become a state writer, and records without the baseline would behave differently.
- **For a pilot set of types.** The suggested set (IAM, bucket policies, security groups) is almost entirely class (b), so it would remove almost no rules.

### State shape and secrets

The baseline would be a new optional field on the resource record. An older binary keeps an unknown field on save, but `drift --accept` and `--revert` rewrite only `observedProperties`, so the new field would go stale behind an older binary; storing a hash of the `observedProperties` it was captured with would avoid a schema bump. Cloud Control omits `writeOnly` properties, but readable properties can still carry secrets (Lambda and ECS environment variables, CodeBuild plaintext variables), and the new field would pass the state redaction unscrubbed until added to it and to the secret checks.

## Why rejected

The comparison would remove a small share of the rules, none of the ones behind the motivating bugs, and only after old records are recaptured. The price is an extra Cloud Control call per written resource on every deploy, a 23-29% larger state file, a second secret-bearing field to redact, and a second reader for the types Cloud Control cannot read.

## If it is revisited for one type

Port from cdk-real-drift only what a Cloud Control-to-Cloud Control comparison needs: stripping schema `readOnly` / `writeOnly` paths on both sides (`src/diff/classify.ts` `normalizeLiveModel`), sorting only schema-unordered sets (`sortUnorderedSetProps` with its order-significant exclusions), and per-type volatile path lists (`src/normalize/path-strip.ts` `deepStripPaths`). Do not port the rules that equate values AWS treats differently ([go-to-k/cdk-real-drift#1952](https://github.com/go-to-k/cdk-real-drift/issues/1952)), nor `src/normalize/pipeline.ts` `sortObjectArraysDeep`, which hides a reorder of an order-significant list.

The full analysis is on [#6868](https://github.com/go-to-k/cdkd/issues/6868).
