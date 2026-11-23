---
title: "Design: the drift and diff normalization rules, and what each may equate (#6852)"
unlisted: true
---

# Design: the drift and diff normalization rules, and what each may equate (#6852)

## Problem

Before comparing, `cdkd drift` and `cdkd diff` normalize values to absorb
differences that are only spelling: order, a statement object returned as a
one-element list, an id returned in place of an ARN. A rule that normalizes too
much makes two values AWS treats differently compare equal, so the command
reports "no drift" or "no change" over a real difference (#6680, #6842).

This page lists every rule in the analyzer layer: what it equates, the AWS
behavior that makes the two spellings one value, and the boundary. The provider
canonicalizers, the Cloud Control read-back tables and the drift command's own
steps (`src/cli/commands/drift/**`) are audited in #6854, in their own pages
(see [Rules outside src/analyzer](#rules-outside-src-analyzer-6854)).

A rule may equate two values only when AWS treats them as one. Where AWS
behavior is unknown, the values compare as different. A rule that SKIPS a key
(compares nothing there) is listed too, since it hides differences the same
way, but a skip that matches CloudFormation's drift scope (only declared
properties) is CloudFormation parity, not over-normalization.

Tests: `tests/unit/analyzer/drift-normalization-boundaries-6852.test.ts` holds a
positive and negative case per rule, plus a property test that runs seeded
random value pairs through the comparator and checks every "no drift" against
an oracle that knows only the equivalences below.

## The rules

### `cdkd drift` comparator (`src/analyzer/drift-calculator.ts`, `drift-normalize.ts`, `drift-verbatim-paths.ts`)

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) |
| --- | --- | --- | --- |
| Tag lists are multisets | `drift-normalize.ts` `canonicalizeTagListsDeep` | A list of `{Key, ...}` objects is a tag (or key-value attribute) set: AWS returns it in any order and acts on no order. | Sorted by `Key`, length and every member compared: a changed value, an added, removed or duplicated tag, a key in another case. Only arrays whose EVERY element has a string `Key`. |
| Id / ARN lists are multisets | `drift-normalize.ts` `canonicalizeIdArraysDeep`, `ORDER_SIGNIFICANT_ID_ARRAY_PATHS` | Lists of two or more ARNs or AWS ids (`subnet-…`, `sg-…`) are sets in nearly every CFn property (subnets, security groups, target groups, alarm actions, policy `Resource`); AWS returns them in another order than submitted (observed by cdk-real-drift dogfooding). | Never sorted at a path the type acts on in order: Lambda `Layers` (#6761) and every container argument vector (#6852: Lambda `ImageConfig.Command` / `EntryPoint`, ECS `ContainerDefinitions.Command` / `EntryPoint` / `HealthCheck.Command`, Batch job definition `Command` / `Args`, EMR step and bootstrap `Args`; the ECS and Batch registry schemas mark these `insertionOrder: true`). A list with a non-id member is not sorted. Residual: an order-significant all-ARN list of a type not in the table still compares as a set; add a row once a list is documented as ordered. |
| Declared unordered lists | `drift-normalize.ts` `canonicalizeUnorderedArraysAtPaths` | Only at paths a provider declares (`getDriftUnorderedPaths`), each a documented set. | Undeclared paths compare in order; a `[]` (leaf-only) entry does not reach lists inside an element (`GlobalSecondaryIndexes[]` leaves `KeySchema` ordered); mixed and nested arrays are never sorted. The declarations are audited in #6854. |
| Undefined key = absent key | `drift-calculator.ts` `definedKeys` | State is JSON, which cannot hold `undefined`; an SDK readback carries absent members as `undefined`. | `null`, `''`, `0`, `false`, `[]` and `{}` are all values: each differs from absent and from the others. No type coercion: `1` / `'1'` and `true` / `'true'` differ. |
| A `Date` equals its ISO string | `drift-calculator.ts` `jsonForm` | The persisted baseline holds the ISO string `JSON.stringify` writes for the `Date` the SDK returned. | Only via `toJSON`: two different instants differ. |
| A non-plain object compares by its own keys | `drift-calculator.ts` `jsonForm`, `deepEqual` | A typed array the SDK returns persists as its index-keyed object (`{"0":1}`), and a `Buffer` as its `toJSON` form, so the two spellings converge. | Values and key counts are compared. Residual: a `Map`, `Set` or keyless class instance has no own keys and equals `{}` and any other keyless one; no SDK v3 readback returns one. |
| A statement object equals a ONE-element list | `drift-calculator.ts` `asStatementList`, `drift-verbatim-paths.ts` `isVerbatimStatementPath` | The IAM policy grammar allows `Statement` as one object or a list; S3, SQS, SNS, KMS, Secrets Manager and IAM trust policies return the object form as a one-element list (#6624, measured). | Only at `<verbatim key>.Statement`. A list of two, an empty list, or one differing statement differs. A Condition value's scalar against a list is NOT folded (#6842). |
| A one-element list equals its scalar, in a statement | `drift-verbatim-paths.ts` `canonicalPolicyFoldForm` | S3, SQS, SNS and IAM's role trust policy return a one-element `Action` / `Resource` / `Principal.<key>` list as the scalar (measured 2026-11-23; IAM's managed policy keeps the list). | `Action`, `NotAction`, `Resource`, `NotResource` and each `Principal` / `NotPrincipal` key, inside `<verbatim key>.Statement` only. Two or more members, an empty list, and a Condition value (#6842) compare as written. |
| A bare account id equals its root ARN, under `Principal.AWS` | `drift-verbatim-paths.ts` `canonicalPolicyFoldForm` | IAM's role trust policy returns `"AWS": "<id>"` as `arn:aws:iam::<id>:root`, and SQS stores it the same way (measured 2026-11-23). | Only under `Principal.AWS` / `NotPrincipal.AWS`; the same 12-digit value under `Service`, `Federated` or `CanonicalUser`, another account's root, a user named `root`, or an id outside a principal differ. The ARN may be in any real partition (the comparator cannot know the resource's), but two root ARNs compare as strings, so a partition change between them differs. |
| `Effect` is case-insensitive | `drift-verbatim-paths.ts` `canonicalPolicyFoldForm` | S3 accepts `"allow"` and returns `"Allow"`; IAM refuses it (measured 2026-11-23). | `Effect` only: a `Sid`, an action or any other value differing in case differs; `Deny` against `allow` differs. |
| A Condition number or boolean equals its `String()` | `drift-verbatim-paths.ts` `canonicalPolicyFoldForm` | S3 returns `1.2` as `"1.2"` and `false` as `"false"` (measured 2026-11-23; CDK's `minimumTLSVersion` writes `NumericLessThan {"s3:TlsVersion": 1.2}`). | Exactly the string form: `1.2` against `"1.20"`, `false` against `"False"` or `"0"` differ; list members fold one by one, in order; a scalar against a one-element list still differs (#6842). |
| An omitted `Version` equals `2008-10-17` | `drift-verbatim-paths.ts` `isOmittedVersionDefault` | IAM: a policy without `Version` is evaluated as `2008-10-17`, and those services write it in (#6624, measured). | Only on the template baseline, only at `<verbatim key>.Version`, only when the template omits it. `2012-10-17` there, a changed declared `Version`, or the default on the observed baseline differs. |
| Keys only AWS holds are not compared (template baseline) | `drift-calculator.ts` `diffAt` | CloudFormation drift compares only declared properties; a readback carries AWS defaults the template never set. | The key union is walked under the verbatim-echo properties (#6622) and under every nested object on the observed baseline. Top-level keys only AWS holds are never compared on either baseline (CloudFormation parity). |
| Undeclared captured-empty keys are skipped | `drift-calculator.ts` `undeclaredEmptyObservedKeys` | A sibling resource fills these after the capture (#1498); CloudFormation compares only declared properties. | Only an undeclared key captured as absent, `null`, `[]` or `{}`; `''`, `0`, `false` and any value are compared, and so are the per-type `undeclaredEmptyComparedDriftKeys` (#6651). |
| Unresolved `{{resolve:...}}` baseline leaf | `drift-calculator.ts` `diffAt` | Not an equivalence: the reference cannot be compared, and the drift command reports the resource `notCompared` (`unresolvedToken`). | Keyed on the BASELINE leaf; a token in the live value compares like any string. |
| A mask matches a present value | `drift-calculator.ts` `equalModuloMask`, `equalModuloMarkedMask` | Not an equivalence: a `***` position cannot be certified, so such a change is reported `notCompared` (`uncertifiedBaseline` / `noEchoParameter`, exit 2), never clean. | An absent or `null` live value, a list whose length changed, and any difference outside the masked position stay drift. |

### `cdkd drift` value canonicalizers (`drift-principal-normalize.ts`, `drift-protocol-normalize.ts`, `drift-undeclared-grants.ts`)

| Rule | Where | Why | Boundary |
| --- | --- | --- | --- |
| IAM unique id equals the principal's ARN | `drift-principal-normalize.ts` `canonicalizePrincipalUniqueIds` | IAM renders a role / user principal as `AROA…` / `AIDA…` while the principal is being created or replaced (#1515). | Only a pair the resolver PROVES (the live role's id equals the recorded id and its ARN equals the policy's); a re-created role's new id, an unanswered lookup, or an id outside a `Principal` / `NotPrincipal` position stays drift. A JSON-string document is not rewritten. |
| EC2 `IpProtocol` numbers equal their names | `drift-protocol-normalize.ts`, `src/utils/ip-protocol.ts` | EC2 stores `1` / `6` / `17` / `58` as `icmp` / `tcp` / `udp` / `icmpv6` and lower-cases those names (measured, #1643). | Those four only; every other number, `-1` against `all`, `06`, and any type outside the security-group table compare as written. |
| Undeclared IAM grants compared one way | `drift-undeclared-grants.ts` | Not an equivalence: a member the baseline holds and AWS lost is not reported (#6328: losing an undeclared grant is not a widening, and reporting it made `--revert` re-grant a sibling's member). | A live member the baseline lacks is drift; a shared member is compared by value; `PermissionsBoundary` both ways. Group names are matched case-insensitively, as IAM names them. |

### `cdkd diff` / deploy change detection (`src/analyzer/diff-calculator/compare.ts`)

| Rule | Where | Why | Boundary |
| --- | --- | --- | --- |
| Object key order | `valuesEqual` | JSON objects are unordered. | Every key both ways; arrays positional; no type coercion; `null` differs from absent. |
| Unresolved intrinsics | `valuesEqual` | Two identical intrinsics are the same unresolved reference. | An intrinsic against a value, or two different intrinsics, differ. |
| Custom resource `Timestamp` | removed (#6853) | The diff ignored it, so a fresh `Timestamp` re-ran no handler, while CloudFormation sends an Update. Now compared like any property. | - |

### Not equality rules

- `src/analyzer/security-diff.ts` and `security-changes/` port the AWS CDK
  CLI's security-change classifier, including its CloudFormation equality
  (`cfnEqual`: a string equals a number or boolean of the same text, as
  CloudFormation reads them). CDK CLI parity.
- `src/analyzer/drift-cc-api-deny-list.ts` routes a type to "drift unknown";
  it equates nothing.
- `src/provisioning/canonicalize-properties.ts` only dispatches to each
  provider's `canonicalizeDesiredProperties` (#6854).

## Cross-check: awspolicyequivalence and cdk-real-drift

The policy rules above were checked against
[hashicorp/awspolicyequivalence](https://github.com/hashicorp/awspolicyequivalence)
(`aws_policy_equivalence.go`, the Terraform AWS provider's policy comparator)
and cdk-real-drift's `src/normalize/policy-canonical.ts`, and each difference
was probed on real AWS (us-east-1, 2026-11-23, the services' plain APIs:
`PutBucketPolicy` / `GetBucketPolicy`, `SetQueueAttributes` /
`GetQueueAttributes`, `SetTopicAttributes` / `GetTopicAttributes`,
`CreateRole` / `GetRole`, `CreatePolicyVersion` / `GetPolicyVersion`, and S3
through Cloud Control).

| Rule | awspolicyequivalence | cdk-real-drift | cdkd | AWS evidence | Verdict |
| --- | --- | --- | --- | --- | --- |
| Statement object = one-element list | equal | equal | equal (#6624) | S3, SQS, SNS, KMS, Secrets Manager, IAM trust return the list | Kept. |
| One-element `Action` / `Resource` / principal list = scalar | equal (string sets) | equal (`toSortedArray`) | equal (#6852) | S3, SQS, SNS, IAM trust return the scalar; IAM managed policy keeps the list | Added: phantom drift on the template baseline before. |
| Bare account id = root ARN | equal under every principal key, and for a string principal | equal under every principal key (`normalizeAccountPrincipal`) | equal under `AWS` only, bare id against root ARN only (#6852) | IAM trust policy returns `"<id>"` as `arn:aws:iam::<id>:root` | Added, under `AWS` only: a 12-digit value elsewhere names no account. Two root ARNs of different partitions stay different, as in awspolicyequivalence; cdk-real-drift equates them. |
| `Effect` case | case-insensitive (`strings.EqualFold`) | case-sensitive | case-insensitive (#6852) | S3 returns `"allow"` as `"Allow"`; IAM refuses `"allow"` | Added. |
| Condition number / boolean = its string | equal (`FormatFloat` / `FormatBool`) | strict | equal to exactly `String()` (#6852) | S3 returns `1.2` as `"1.2"`, `false` as `"false"` | Added. `1.2` against `"1.20"` stays different. |
| Condition scalar = one-element list | equal | equal (sorted sets) | strict (#6842) | Not reshaped by the services probed | Kept strict, the #6842 decision. |
| Order of `Action` / `Resource` / Condition values | ignored (sets) | ignored (sorted) | compared | S3, IAM and SQS (`Action`) return the order sent | Kept strict: a reorder in the readback is a rewrite out of band. |
| Statement order | ignored (matched as a set) | ignored (sorted) | compared | Returned as sent | Kept strict. |
| `"Sid": ""` vs no Sid | equal (Go zero value) | strict | strict | SQS, S3 and IAM return `"Sid": ""` as sent | Kept strict. |
| Numeric Sid dropped (C1) | strict | dropped on both sides (`/^\d+$/`) | strict | No Sid is added to a Sid-less statement (S3, SQS, SNS plain API; S3 through Cloud Control) | cdk-real-drift finding: its premise (an auto-assigned numeric Sid) is contradicted by the probe, and the rule hides a change to a numeric Sid. |
| AWSLogDelivery statement subtracted (C2) | no such rule | subtracted on both sides when Sid, service principal and actions match the vended shape | no such rule: an added statement is drift | Not probed (needs a log delivery to write it) | cdk-real-drift finding: looser than cdkd and awspolicyequivalence; cdkd reports the statement AWS appended. |
| Omitted `Version` (C3) | strict (`""` differs from any version) | not compared when the template omits it | equals `2008-10-17` only, template baseline (#6624) | S3, SQS, SNS, KMS, Secrets Manager, IAM trust write `2008-10-17` | cdk-real-drift finding: dropping it hides a live `2012-10-17`, which turns policy variables on. |
| `"*"` = `{"AWS": "*"}` | strict | strict | strict (the failed-create `policyContentKey` equates them; the drift comparator does not) | Not probed | Kept strict until measured. |
| Document `Id` | strict | strict | strict | - | Kept. |
| SQS / SNS: two `Resource` values in one statement | - | - | - | Both services refuse it | No rule needed. |

## Rules outside src/analyzer (#6854)

Each area's inventory, in the same table shape, is its own page in this
directory:

- `6854-a-storage-normalization-rules.md`: DynamoDB, S3, Kinesis and Cognito
  providers.
- `6854-b-db-compute-normalization-rules.md`: RDS, DocumentDB, Neptune, FSx,
  Auto Scaling, EC2, ELBv2, CodeBuild and Lambda providers.
- `6854-c-edge-api-policy-normalization-rules.md`: API Gateway, AppSync,
  CloudFront, CloudTrail, Route 53, Budgets, SNS, Cloud Map, CodeCommit, and
  the SNS / SQS policy providers.
- `6854-d-drift-cc-normalization-rules.md`: the drift command's comparison
  steps and the Cloud Control read-back tables.
