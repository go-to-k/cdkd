---
description: cdkd SDK-provider ARN/URL attribute-coverage matrix + CI critic - what it parses, why it ignores the schema primaryIdentifier, and its one allow-list entry
paths:
  - 'scripts/gen-sdk-attr-coverage.ts'
  - 'tests/unit/scripts/gen-sdk-attr-coverage.test.ts'
  - 'docs/_generated/sdk-attr-coverage.json'
  - 'docs/_generated/sdk-attr-coverage.md'
---

# sdk-attr-coverage critic

The rest of the generator family is in
[layout-scripts.md](layout-scripts.md), which keeps the pointer to this file.

Split out of it by issue
[#3324](https://github.com/go-to-k/cdkd/issues/3324) for the reason
`provisioning-sticky-routing.md` and `no-change-outputs-merge.md` were split
out of theirs, not for length: `scripts/refresh-cfn-schemas.mjs` loads
`layout-scripts.md` whole and sat 5 B under its 90,000 B payload cap, so
CORRECTING one stale sentence in this entry could not land in place. The name
carries no `layout-` prefix on purpose — that prefix obliges a `code-layout.md`
table row, and the row's own bytes put two unrelated paths
(`src/deployment/secret-redaction.ts`, `src/utils/aws-client-defaults.ts`) over
THEIR caps.

- **scripts/gen-sdk-attr-coverage.ts** + **docs/_generated/sdk-attr-coverage.{json,md}** - SDK-provider ARN/URL attribute-coverage matrix + CI critic (`vp run gen:sdk-attr-coverage` / `vp run audit:sdk-attr-coverage:check`; CI fails on drift AND on an unresolvable Arn/Url attribute). SDK-side sibling of `gen-enrichment-coverage.ts`. Makes the #1179 GetAtt-key class (ARN recorded under a non-CFn key) non-regressing. Filed as issue #1187.
  - Why it matters: cross-resource `Fn::GetAtt` reads cached `resource.attributes[<CFnName>]` in `IntrinsicFunctionResolver.constructAttribute` (never calls a provider's `getAttribute`), and a `*Arn`/`*Url` name under the wrong key HARD-FAILS the resolver's shape guard (#1179 stored `Arn` not `AgentRuntimeArn`, breaking a `CfnOutput`).
  - Parses via the TS Compiler API: (a) each provider's stored attribute keys (`collectStoredAttributeKeys`, object-literal + element-access-assignment keys; a `case '<Attr>':` label in `getAttribute` is deliberately NOT collected, so a provider handling the ARN only there is still flagged) — pooled per FILE, not per method (a provider may build attributes in a `buildAttributes()` helper, #1179), so ANY one of create / update / import literals classifies the type `cached`; per-path binding belongs in the provider's own unit suite, the file-level false-negative documented in the function's JSDoc; (b) `handledProperties` maps; (c) the `constructAttribute`-referenced type set.
  - An `Arn`/`Url` read-only attribute is a `gap` iff NEITHER cached NOR `constructAttribute`-handled NOR allow-listed. Scoped to `Arn`/`Url` because those are the ONLY suffixes the guard hard-fails on (non-ARN attrs warn-and-fallback and are legitimately uncached).
  - **`primaryIdentifier` is deliberately NOT consulted**, which is where this critic parts company with its `gen-enrichment-coverage.ts` sibling; the script header carries the reasoning and the per-type audit. In short: that field names the CLOUD CONTROL identifier, so auto-classifying on it stays right for the enrichment critic, whose subject IS the CC path, and is wrong here — every type this one classifies is Tier 1, and a Tier-1 physical id is minted by its own SDK provider, which (measured 2026-09-17) for **20 of the 89** auto-classified types is a different value or a `|`-joined composite (`AWS::AppSync::{ApiKey,DataSource,Resolver}`, `AWS::EC2::{EIP,Route,NetworkAclEntry,SecurityGroupIngress,VPCGatewayAttachment}`, `AWS::Glue::Table`, `AWS::S3Tables::Table`, `AWS::SQS::QueuePolicy`, `AWS::WAFv2::WebACL`, …; `AWS::EC2::SecurityGroupIngress`'s provider comment says outright that its composite "is NOT the CFn identifier").
  - It surfaced as a SILENT GUARD RETIREMENT rather than as a false gap, which is the half worth remembering: the 2026-09-17 refresh (#3320) carried an AWS change flipping `AWS::AppSync::GraphQLApi`'s `primaryIdentifier` from `ApiId` to `Arn`, and the filter then DROPPED that type's `Arn (cached)` row — no gap reported, nothing failing, a live guard gone. Removing the filter un-suppressed **22 attributes** (all figures in this bullet measured 2026-09-17; the live ones are in `docs/_generated/sdk-attr-coverage.json`, which a schema refresh moves) — a different set from the 20 divergences above, intersecting them in three members, since only 22 of the 89 had an `Arn`/`Url`-SUFFIXED identifier member for the filter to match — and moved 20 types out of `no-arn-attr` into the audit (covered 43 -> 63), surfacing exactly one finding.
  - **Which fence watches the regression, and which does not yet.** The live one is a case in the suite's `buildReport / findGaps` block that writes a TEMP FIXTURE DIRECTORY naming an ARN as its `primaryIdentifier` — the level matters, because the removed filter read a fixture FIELD and `classifyType` no longer has a parameter that could express the old behaviour, so a case written there passes under both implementations. The `AWS::AppSync::GraphQLApi` / `Arn` pair in `CACHED_ARN_PAIRS` is a SECOND fence and is LATENT: the committed fixture still names `ApiId`, so it starts discriminating only once that refresh lands. The allow-list staleness loop is live today but retires with its entry (#3329).
  - `SDK_ATTR_ALLOW_LIST` is EMPTY, and that is its green state — the same one issue #1824 left it in. Its one entry between #3324 and #3329 was `AWS::SNS::Subscription.Arn`, a NOT-A-BUG (the physical id IS the subscription ARN). #3324 restored it when the `primaryIdentifier` filter went, stating its own retirement condition; #3329 met that condition by CACHING the ARN in `SNSSubscriptionProvider.create`, the shape `AWS::Lambda::EventSourceMapping.EventSourceMappingArn` (#1190) and `AWS::RDS::DBSubnetGroup` / `AWS::SSM::Parameter` (#1800, fixed #1824) took. Deleting the entry is what VERIFIES such a fix: `classifyType` reads `cachedKeys` BEFORE the list, so one left behind goes inert while the matrix still reports the type as a carve-out — probed, reverting the caching makes the critic name `AWS::SNS::Subscription: Arn` again. The provider caches ONLY the ARN AWS returned: never its constructed `<topicArn>:<logicalId>` fallback (ARN-SHAPED, so a cached copy would be a fabricated value nothing downstream can distinguish) and never an imported id (which can be the literal `PendingConfirmation`, where a cached non-ARN would turn the resolver's LOUD refusal into a silent wrong value). Adding an entry back needs a rationale and, for a real gap, a tracking issue.
  - Unit-tested incl. a real-repo coverage floor (`tests/unit/scripts/gen-sdk-attr-coverage.test.ts`). NO AWS integ (pure static analysis).
