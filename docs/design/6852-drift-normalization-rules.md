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
steps (`src/cli/commands/drift/**`) are audited in #6854 and get rows here.

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
| A statement object equals a ONE-element list | `drift-calculator.ts` `asStatementList`, `drift-verbatim-paths.ts` `isVerbatimStatementPath` | The IAM policy grammar allows `Statement` as one object or a list; S3, SQS, SNS, KMS, Secrets Manager and IAM trust policies return the object form as a one-element list (#6624, measured). | Only at `<verbatim key>.Statement`. A list of two, an empty list, or one differing statement differs. A Condition value's scalar against a list is NOT folded (#6842). |
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
