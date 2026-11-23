---
title: "Design: the edge, API and policy normalization rules, and what each may equate (#6854, lane C)"
unlisted: true
---

# Design: the edge, API and policy normalization rules, and what each may equate (#6854, lane C)

## Scope

This page is one of the #6854 slices of the #6852 audit (the analyzer slice is
`docs/design/6852-drift-normalization-rules.md`). It covers the normalization
and equivalence rules of the API Gateway, API Gateway V2, AppSync, CloudFront
distribution, CloudTrail, Route 53, Budgets, SNS topic, Cloud Map
(ServiceDiscovery) and CodeCommit providers, the SNS / SQS policy providers,
and the shared policy-document key (`src/provisioning/policy-document-content.ts`).

A rule may equate two values only when AWS treats them as one. Where AWS
behavior is unknown, the values compare as different. A rule that SKIPS a path
(`getDriftUnknownPaths`) hides differences the same way, so skips are listed
too.

Tests: `tests/unit/provisioning/edge-api-policy-normalization-boundaries-6854.test.ts`
holds a pair each rule must equate and a pair it must not;
`tests/unit/provisioning/policy-document-content-4612.test.ts` holds the policy
key's (`policyContentKey boundaries (go-to-k/cdkd#6854)`), and the SQS / SNS
`*-orphan-content-4612.test.ts` suites hold the partition cases end to end.

Measurements below were made in account-scoped throwaway resources in
us-east-1 on 2026-11-23, each deleted afterwards.

## The rules

### Policy documents

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary (what stays different) | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| A bare account id is its root ARN | `policy-document-content.ts` `accountKey`, used by `policyContentKey` | IAM documents `"AWS": "<id>"` as the short form of `arn:<partition>:iam::<id>:root`. Measured: SQS and SNS store a bare id as `arn:aws:iam::<id>:root`. | Only in `Principal.AWS` / `NotPrincipal.AWS`. A role or user of the same account (`:role/root`, `:user/root`), an STS ARN, an 11-digit id, an id in `Condition` or `Resource`, a `Service` principal: all different. With the resource's partition given (SQS: the region the queue URL names, else the client's; SNS: the topic ARN's), a root ARN of ANOTHER partition is a different principal: SQS (`InvalidAttributeValue`) and SNS (`InvalidParameter`) refuse `arn:aws-cn:...` and `arn:aws-us-gov:...` in us-east-1. Principal text cannot spell an account key (`account:<id>`) or the anyone key (`anyone:*`): every other string is tagged. | `policyContentKey boundaries`, SQS / SNS orphan partition tables | Tightened: the partition was not compared and text could collide with a key. Callers without a partition (`s3-bucket-policy-provider.ts`, `settle-after-own-write.ts`, outside this lane) keep the partition-free match; see Residuals. |
| `"*"` is `{ "AWS": "*" }` | `policy-document-content.ts` `normalizePrincipal` | IAM documents the two as equivalent. Measured: SNS stores each as written; both grant everyone. | `{ "AWS": "*" }` only, in any list spelling. `{ "Federated": "*" }`, `{ "Service": "*" }`, or `"*"` plus another key are different. | `"*" is not {Service: "*"}`, `{AWS: "*", Service: "x"}`, `a Federated "*" is not anyone` | Keep |
| A one-element list is its scalar | `policy-document-content.ts` `unwrapSingle` | IAM reads `Action` / `NotAction` / `Resource` / `NotResource` and each principal value as a string or a list of strings. Measured: SNS stores `["sns:Publish"]` as `"sns:Publish"`. | Only one element. Two equal elements are not one; list order is kept (a reorder compares different: safe, never over-equating). Condition values are NOT folded here. | `two elements are not one`, `list order is kept`, `principal list order is kept`, `a one-element Condition value list is not its scalar here` | Keep |
| A single `Statement` object is a one-element list | `policy-document-content.ts` `policyContentKey` | IAM grammar. Measured: SNS stores a statement object as a one-element list. | Statement order is kept; `Sid`, `Effect` and every other key are compared. | `Effect is compared`, `Action case is kept` | Keep |
| Object key order | `policyContentKey` `canonicalJson`; `canonicalPolicy` in the SQS / SNS policy providers | JSON object members carry no order. | Array order kept. `canonicalPolicy` (the update / revert-failed path) folds key order ONLY, no IAM spellings: stricter than AWS, so it can miss a policy AWS stored in another spelling (a queue left in place, never a wrong one cleared). | `list order is kept` | Keep (under-equates; documented in the providers) |

### API Gateway

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| RestApi `Policy` text is its parsed document | `apigateway/read-state.ts` `canonicalizeDriftProperties` | `GetRestApi` returns the policy as a document; a template may write the same JSON as text (go-to-k/cdkd#6139). | Only text that parses; unparseable text stays text. Then the document compares exactly. | `a RestApi Policy written as JSON text...` | Keep |
| Method `AuthorizationScopes` is a set (a repeat counts once) | `apigateway/read-state.ts` `canonicalizeDriftProperties` + `getDriftUnorderedPaths` | A method authorizes a token carrying any listed scope; a repeated scope grants nothing more, and the update path diffs scopes as a set (go-to-k/cdkd#5408). | Another scope or a scope in another case is drift. | `Method AuthorizationScopes...` | Keep |
| Authorizer `ProviderARNs`, RestApi `BinaryMediaTypes` are multisets | `apigateway/read-state.ts` `getDriftUnorderedPaths` | A user-pool list and a media-type list act on membership; API Gateway returns them in its own order (go-to-k/cdkd#5408). | Sorted, length kept: a changed or repeated member is drift. Other types' lists keep their order. | `%s %s is a multiset...` | Keep |
| Write-only RestApi inputs are skipped | `apigateway/rest-api.ts` `REST_API_WRITE_ONLY_PATHS` | `Body`, `BodyS3Location`, `CloneFrom`, `FailOnWarnings`, `Mode`, `Parameters` are import inputs `GetRestApi` never returns. | Only those keys. | (skip; covered by the RestApi read tests) | Keep |
| V2 Integration `TlsConfig` is skipped on a public integration | `apigatewayv2/core.ts` `getDriftUnknownPaths` | Measured (#1602): AWS discards `TlsConfig` unless `ConnectionType` is `VPC_LINK`. | Only with a recorded, non-empty bag whose `ConnectionType` is not `VPC_LINK`; a VPC link or an empty bag compares it. | `TlsConfig is skipped only...` | Keep |
| V2 legacy tag baseline is completed from the template | `apigatewayv2/core.ts` `canonicalizeDriftPair` | Not an equivalence: a pre-#5390 baseline lacks the tags AWS never received, so the template's tags are put on the baseline to report them. The readback is never changed. | Leaves the pair alone when the source holds a dynamic reference or mask. | `a legacy baseline is completed...` | Keep |
| V2 update-skip equality | `apigatewayv2/update-helpers.ts` `deepEqual`, `mapEntryAddedOrChanged` | JSON serialization: key order, `undefined` vs `{}` and list order all differ (stricter than AWS: at worst an extra Update call). A dropped map key is not a change, as CloudFormation measured (#5004). | — | `the update-skip equality is strict...` | Keep |

### AppSync

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| SDL compared after `parse` / `print` | `appsync/read-state.ts` `canonicalizeSdl` | Comments and whitespace are not part of a GraphQL document (GraphQL spec, ignored tokens). | Descriptions, field order, field types and directives are compared. Unparseable text compares raw. | `a field order`, `a description`, `a field type` | Keep |
| A default `schema { query: Query ... }` block is dropped | `appsync/read-state.ts` `canonicalizeSdl` | The GraphQL spec defines a schema with no schema block as rooted at `Query` / `Mutation` / `Subscription`; AppSync's SDL always prints the block (#6779). | Kept when it names a non-default root, carries a description or directive, or lists fewer roots than the default-named types present. | `a non-default root name`, `a schema block listing fewer roots...`, `a directive on the schema block` | Keep |
| Write-only S3 locations are skipped | `appsync/errors-delete.ts` `getDriftUnknownPaths` | `GetIntrospectionSchema` / `GetResolver` return the body, never the S3 URL it came from. | Only `DefinitionS3Location` and the resolver `*S3Location` keys; the body itself is compared. | `only the write-only S3 locations are skipped` | Keep |

### CloudFront

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| `GeoRestriction.Locations` is a multiset | `cloudfront-distribution/read-state.ts` `getDriftUnorderedPaths` | A country allow / deny list acts on membership; observed live read back reordered (`s3-cloudfront`, 2026-08-09). | Sorted, length kept. | `GeoRestriction.Locations order...` | Keep |
| `CallerReference` is skipped | `cloudfront-distribution/read-state.ts` `getDriftUnknownPaths` | A cdkd-generated idempotency token, never templated. | Only that key. | — | Keep |
| `Logging.Bucket` was skipped | `cloudfront-distribution/read-state.ts` `getDriftUnknownPaths` | The skip's premise ("CloudFront rewrites the domain on read") is false. Measured: CloudFront returns `<b>.s3.us-east-1.amazonaws.com`, `<b>.s3.amazonaws.com` and `<b>.s3-us-east-1.amazonaws.com` each exactly as written, and refuses a bare bucket name. | Now compared exactly. Two spellings of one bucket compare different (strict: AWS stores the text as written). | `Logging.Bucket is compared...`; integ `s3-cloudfront` switches the bucket out of band | Tightened: the skip is removed. |

### CloudTrail

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| `AdvancedEventSelectors`, `AggregationConfigurations` are multisets at every depth | `cloudtrail-provider.ts` `getDriftUnorderedPaths`, `cloudtrail/shared.ts` `UNORDERED_LIST_BLOCKS` | Selectors are OR-ed, field selectors AND-ed, value lists OR-ed: no list in these blocks has order. CloudTrail returns `FieldSelectors` sorted by `Field`. | Sorted, length kept: a changed value or a dropped selector is drift. | `selector, field-selector and value order...` | Keep |
| Update-skip set key | `cloudtrail/shared.ts` `setKey` | The same sets, for deciding whether a Put is needed. | `undefined` is not `[]`; `1` is not `'1'`; a repeat is not one. | `the update-skip set key folds order only...` | Keep |

### Route 53

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| Record name: trailing dot, letter case, octal escapes | `route53/record-name.ts` `normalizeRecordName` | Route 53 returns names fully qualified, lowercased and with special characters as `\ddd` escapes (Route 53 "DNS domain name format"); DNS names are case-insensitive (RFC 4343). | `\056` (a period inside a label) and `\134` (a backslash) are never decoded, so `a\056b` is not `a.b`. Non-ASCII decodes to bytes (a false miss, never a false match). | four `normalizeRecordName` negatives | Keep |
| Record-set equality | `route53/record-set-group-shape.ts` `sameRecordSet` | Key order, the name rules above, and an alias target's DNS name by the same rules. | `ResourceRecords` order, TTL and every other field are compared; `dualstack.` is not folded. | `a record set: ...` | Keep |
| HostedZone `VPCs` is a multiset | `route53/read-state.ts` `getDriftUnorderedPaths` | A zone's VPC associations have no order. | Each `{VPCId, VPCRegion}` compared whole. | `HostedZone VPCs are a multiset...` | Keep |

### Budgets

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| An absent `ThresholdType` is `PERCENTAGE` | `budgets-budget/shared.ts` `canonicalizeBudgetDriftBag` | Measured: a notification created without `ThresholdType` reads back with none; creating a `PERCENTAGE` twin of it is refused as a duplicate, and deleting with `PERCENTAGE` removes it. An `ABSOLUTE_VALUE` twin is a separate notification. | `ABSOLUTE_VALUE` is drift. | `an absent ThresholdType is PERCENTAGE...` | Keep |
| Amounts and thresholds are numbers | `budgets-budget/shared.ts` `canonicalSpend`, `finiteNumber` | Budgets stores a decimal amount (`"100.0"` reads back as written); `"100"`, `100` and `"100.00"` are one amount. | Another number is drift; a non-numeric value is compared as written. | `an amount or threshold in another spelling...` | Keep |
| `TimePeriod` dates are instants | `budgets-budget/shared.ts` `isoDate` | The same instant in two spellings. | Another instant is drift. | `a TimePeriod date is compared as an instant` | Keep |
| Notifications and subscribers are multisets | `budgets-budget-provider.ts` `getDriftUnorderedPaths` | Budgets addresses each by value and returns them in its own order. | Sorted, length kept. | `notifications and subscribers are multisets...` | Keep |
| Elapsed planned limits leave the baseline | `budgets-budget/read-state.ts` `canonicalizeDriftPair` | `DescribeBudget` returns only current and future periods (#5188). | A future period missing from the readback is drift. | (`budgets-budget-*` suites) | Keep |
| AWS-owned or unreadable members are skipped | `budgets-budget-provider.ts` `getDriftUnknownPaths` | `BudgetLimit` is recomputed by AWS under `AutoAdjustData` / `PlannedBudgetLimits`; the legacy `CostTypes` / `CostFilters` are not returned beside `FilterExpression` / `Metrics` (measured, #5188). | Only under those declarations. | (`budgets-budget-*` suites) | Keep |

### SNS topic

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| `TracingConfig: PassThrough` is the unset `''` | `sns-topic-provider.ts` `canonicalizeDriftProperties` | A topic that never set it reads `''`; a reset writes `PassThrough`, SNS's default (#6226). | `Active` is drift. | `TracingConfig PassThrough...` | Keep |
| Delivery-status protocol spellings | `sns-topic/shared.ts` `normalizeDeliveryStatusProtocol`, `stateProtocolCaseMap` | AWS has one attribute prefix per protocol (`HTTP` for `http/s`, `http`, `https`, measured #1529); the read echoes the recorded spelling of that one prefix. | Distinct protocols stay distinct; an unknown one is refused. | `delivery-status protocol spellings...` | Keep |

### Cloud Map and CodeCommit

| Rule | Where | Why AWS treats the spellings as one (evidence) | Boundary | Negative tests | Verdict |
| --- | --- | --- | --- | --- | --- |
| PrivateDnsNamespace `Vpc` is skipped | `servicediscovery/read-state.ts` `getDriftUnknownPaths` | `GetNamespace` does not return the VPC. | Only that key. | — | Keep (unreadable) |
| `ServiceAttributes` scalars as strings | `servicediscovery/read-state.ts` `normalizeServiceAttributes` | Cloud Map attributes are strings; a number or boolean is sent as its string. Write-side shaping, not a drift fold. | A non-scalar is dropped, not stringified. | — | Keep |
| Tag maps | `codecommit-repository/shared.ts` `tagMapsEqual` | A map has no order. | A value, an added or a removed key is a change. | `tag maps compare as maps...` | Keep |
| Triggers | `codecommit-repository/shared.ts` `triggersEqual` | Serialized in order (stricter than AWS). | A reordered branch list is a change. | `triggers compare in order...` | Keep |
| `Code` is skipped | `codecommit-repository-provider.ts` `getDriftUnknownPaths` | Create-only seed content with no read-back (git history, not a repository attribute). | Only `Code`. | `does NOT surface create-only Code as drift` | Keep |
| `Triggers` was skipped | `codecommit-repository-provider.ts` `getDriftUnknownPaths`; now read by `codecommit-repository/read-state.ts` `readCurrentState` | It was readable (`GetRepositoryTriggers`) but not read. Measured: CodeCommit returns the trigger list, `branches` and `events` in the order put, `customData` only when sent (`''` as `''`), and refuses a trigger without `branches` or a duplicate name. The read runs beside `ListTagsForResource`, so the deploy's observed capture (created / updated resources only, off the critical path) gains one parallel call. | Compared in order, every field. A baseline captured before the read lacks the key and compares none (no phantom drift) until its next capture. | `Triggers (go-to-k/cdkd#6854)` cases in `codecommit-repository-provider.test.ts`; integ `codecommit` changes the events out of band | Tightened: read and compared (maintainer decision, 2026-11-23). |
| A declared trigger in the form cdkd sends it (an omitted `Branches` is `[]`, a scalar is its string, a `null` `CustomData` is omitted) | `codecommit-repository/shared.ts` `canonicalizeTriggers`, via `canonicalizeDriftProperties` and `canonicalizeUnsettledProperties` | cdkd sends an omitted list as `[]` (CodeCommit refuses a null one), CodeCommit stores `[]`, and `[]` is every branch, CloudFormation's documented meaning of an omitted list. | Only the coercions `toSdkTriggers` applies; any other value is compared. | `a declared trigger without Branches...`, `a declared value in the spelling cdkd sends...`, `the unsettled-update check folds Branches the same way` | Keep (new) |

## Residuals

- A repository whose template declares no `Triggers` and had none at capture
  records `Triggers: []`, which the comparator skips as an undeclared empty
  key (`undeclaredEmptyObservedKeys`), so a trigger added there out of band is
  not reported. Adding `Triggers` to that table's exceptions needs its own
  measurement.
- **Policy-key callers without a partition.** `s3-bucket-policy-provider.ts`
  (lane A) and `settle-after-own-write.ts` (outside the lanes) call
  `policyContentKey` / `accountKey` without the resource's partition, so for
  them a bare id still equals a root ARN of any partition. Both compare a
  document AWS accepted (the failed create's written document, or the declared
  one being settled) with what AWS stores, and AWS refuses a root ARN of
  another partition, so no reachable pair differs only there today; passing the
  partition closes it.
- The partition rule in the SQS / SNS orphan cleanup is likewise unreachable
  today: a failed create names only the topics or queues it wrote, so the
  compared document is one AWS accepted. It makes the key match AWS rather
  than rely on that.
- SQS and SNS store `["<id>", "arn:aws:iam::<id>:root"]` as one principal
  (measured). The key keeps it as two, so such a document is left in place
  rather than cleared: an under-equation, the safe direction.
