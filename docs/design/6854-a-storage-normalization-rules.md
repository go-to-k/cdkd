---
title: "Design: the storage providers' drift and diff normalization rules (#6854, lane A)"
unlisted: true
---

# Design: the storage providers' drift and diff normalization rules (#6854, lane A)

This page lists every normalization rule the DynamoDB, S3, Kinesis and Cognito
providers apply before `cdkd drift` and `cdkd diff` compare. For each rule it
gives what the rule equates, the AWS behavior that makes the two spellings one
value, and the boundary: what still compares as different. It is the provider
half of the analyzer inventory in `6852-drift-normalization-rules.md`, in the
same shape.

A rule may equate two values only when AWS treats them as one. Where AWS
behavior is unknown, the values compare as different. A skip that matches
CloudFormation's drift scope (only declared properties) is CloudFormation
parity, not over-normalization.

Tests: `tests/unit/provisioning/storage-normalization-boundaries-6854.test.ts`
holds a pair each rule must equate and a pair it must not, run through the
provider hooks the way the drift and diff commands call them. A rule it does
not cover (the `canonicalizeDriftPair` completions, the read-side folds, the
bucket policy) is tested in that provider's own suites under
`tests/unit/provisioning/`, which the issue numbers in the table name.

## How the hooks apply

| Hook | Applied to | Effect |
| --- | --- | --- |
| `getDriftUnorderedPaths` | both drift sides | Sorts the list at the path. `X[]` sorts only that list; a plain entry also sorts every list inside its elements. |
| `getDriftUnknownPaths` | drift | The path is not compared. |
| `canonicalizeDriftProperties` | each drift side | Rewrites one bag. |
| `canonicalizeDriftPair` | both drift sides together | Reads one side, or the template, to decide the other. |
| `canonicalizeDesiredProperties` | both `cdkd diff` / deploy bags | Narrows a bag to what the provider sends. |

## AWS::DynamoDB::Table

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| `AttributeDefinitions` is a set | `dynamodb-table/drift.ts` `getDriftUnorderedPaths` | Keyed by `AttributeName`; `DescribeTable` returned `[gsipk, pk]` for a `[pk, gsipk]` create (measured, #1760). | A changed type, an added or removed name. | Correct |
| `GlobalSecondaryIndexes[]`, `LocalSecondaryIndexes[]` are sets | same | Keyed by `IndexName`; read back in another order (measured, #1782). Leaf-only. | Each index's `KeySchema` stays ordered (HASH before RANGE); any member change. | Correct |
| `VectorIndexes` is a set, with every list inside it | same | Keyed by `IndexName`; the only lists inside are `SearchSchema` (attribute set) and `Projection.NonKeyAttributes` (set). No `KeySchema` there. | `Dimensions`, attribute names, a changed member set. | Correct |
| `WarmThroughput` skipped when undeclared | `getDriftUnknownPaths` | AWS reports a computed value for every table (12000 / 4000, measured, #1760). CloudFormation parity. | A declared block is compared. | Correct |
| `GlobalSecondaryIndexes` / `LocalSecondaryIndexes` skipped when the template declares no list | same | An index the template never declared is out-of-band (#1767, #1498). CloudFormation parity. | Declared lists are compared, including an out-of-band add. | Correct |
| `DeletionProtectionEnabled` string equals the boolean | `canonicalizeDriftProperties`, `coerceCfnBoolean` | `create()` / `update()` send `'true'` / `'false'` as the boolean (#5354). | Any other value (`'yes'`, `1`) is compared as written. | Correct |
| Stale per-index SDK description converged | `indexes.ts` `canonicalizeStaleIndexDescription` | Records written before #1767 hold `IndexStatus`, `ItemCount`, `IndexArn` and the like, which no template declares (#1812). | Only entries carrying SDK-only members. A current-shape entry's `0/0` block or `WarmThroughput` is compared. A capacity change inside a stale entry is reported. | Correct |
| Unsent `WarmThroughput` members trimmed from the baseline | `canonicalizeDriftPair`, `warm-throughput.ts` | The readback emits only the members cdkd sent (#3777). AWS cannot lower or unset them. | A sent member is compared. | Correct |
| Missing `ContributorInsightsSpecification` completed from the declaration | `dynamodb-contributor-insights.ts` `completeTableContributorInsightsBaseline` | A baseline captured while the toggle read `ENABLING` lacks the key (#6778). | Only when the baseline lacks the key and the live read has a block. An out-of-band disable is reported. An undeclared `Mode` takes the live one (CloudFormation parity). | Correct |
| Transient `ENABLING` / `DISABLING` reads as its target | `dynamodb-contributor-insights.ts` reverse-map | The toggle settles to the target; `Mode` is present while enabling (measured, #6778). | `FAILED` or no answer emits nothing. | Correct |
| Live `WarmThroughput` while `UPDATING` reads as the higher of live and declared | `warm-throughput.ts` `readbackWarmThroughput` | A raise holds `UPDATING` for about 10 minutes and AWS accepts the re-sent value (measured, #5606, #5607). | Only while `UPDATING`; a live value above the declared one stands. | Correct |

## AWS::DynamoDB::GlobalTable

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| `AttributeDefinitions` is a set | `dynamodb-globaltable/drift.ts` `getDriftUnorderedPaths` | As on the table (measured, #1742). | As on the table. | Correct |
| `Replicas[]` is a set | same | Registry schema `insertionOrder: false` (DescribeType, #3573). Keyed by `Region`. Leaf-only. | A replica member change, another region. Lists inside a replica keep their order. | Correct |
| `VectorIndexes` is a set, with every list inside it | same | As on the table. | As on the table. | Correct |
| `TableType` skipped | `getDriftUnknownPaths` | No API member returns it (measured readback). | Never compared: nothing to compare with. | Correct (not comparable) |
| Table-level `WarmThroughput` skipped when the template declares no usable block | `getDriftUnknownPaths` | AWS reports a computed value for every table (#2762). CloudFormation parity. | A declared block is compared. | Correct |
| `ReadProvisionedThroughputSettings` skipped unless `BillingMode` is `PROVISIONED` | same | CloudFormation accepts and ignores it on on-demand tables (measured). | Compared on a provisioned table. | Correct |
| Per-index `WarmThroughput` read against the declaration | `canonicalizeDriftPair`, `canonicalizeIndexWarmThroughput` | AWS reports a computed value for every index (12000 / 4000, measured, #1742), so an index declaring none is stripped, as is every index when no template is recorded. | A declared index compares its declared members, a value AWS grew included (CloudFormation parity); `--revert` skips that decrease (#1857). While a raise is `UPDATING` the readback reads the declared value (#5606). A quoted number equals the number. A baseline an earlier binary captured mid-raise reports once. | Tightened in #6854 |
| Implied stream on a multi-replica table | `canonicalizeDesiredProperties` | `create()` enables `NEW_AND_OLD_IMAGES` there (#1723). | Another view type, one replica, or a declared `MultiRegionConsistency` stays different. | Correct |
| Local replica completed on a legacy baseline | `replica-shape.ts` `completeLegacyLocalReplica` | Records before #3573 lacked the local region's entry; CloudFormation requires the stack region in `Replicas`. | Only when the baseline has no local entry. | Correct |
| Pre-#5381 replica baseline converged | `dynamodb-replica-settings.ts` | Moves the legacy top-level spelling onto the local replica (#5381). | Only when the baseline carries the legacy keys. | Correct |
| Replica defaults completed | `replica-shape.ts` `completeReplicaDefaults` | An omitted member equals the live default (#5789). | A non-default live value is reported. | Correct |
| AWS managed replica key equals no key | `replica-shape.ts` `completeAwsManagedReplicaKeys` | Only when KMS reports the AWS-managed key for every replica (#5790). | A customer key is reported; a failed lookup completes nothing. | Correct |
| Absent `SSESpecification` equals the AWS owned key | `canonicalizeDriftPair` | Encryption at rest is always on (#5399). | Not when the template enables SSE. | Correct |
| `gsi-diff.ts` compares replicas by `Region`, indexes by `IndexName` | `gsi-diff.ts` | Both are keyed sets in the API. | Every member of a matched entry is compared. | Correct |

## AWS::Kinesis::Stream

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| `DesiredShardLevelMetrics` is a set | `kinesis/read-state.ts` `getDriftUnorderedPaths` | `DescribeStream` returns the metrics in no stable order (measured); enhanced monitoring acts on the set. | A changed member set. | Correct |
| `ALL` equals the seven metrics | `kinesis/shared.ts` `expandShardLevelMetrics` | `DescribeStream` reports the seven names, never `ALL` (measured). Shared with create and update. | Any set other than all seven. | Correct |
| Live metrics projected onto named ones on the unsettled read | `kinesis/read-state.ts` `readUnsettled` | CloudFormation's update leaves out-of-band metrics enabled (#5503). Deploy convergence only. | The drift read is not projected. | Correct |
| Unencrypted reads as `EncryptionType: NONE` | `readCurrentState` | `NONE` is the unencrypted state. | `KMS` with any key is compared. | Correct |

## AWS::Cognito::UserPool

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| Blank `MfaConfiguration` narrowed to what cdkd sends | `cognito/read-state.ts` `canonicalizeDesiredProperties`, `mfa-request.ts` | Not an AWS equivalence: the same helper decides what create and update send, so state and template compare like for like. | A declared `ON` / `OPTIONAL` / `OFF` is never rewritten. | Correct |
| Placeholders for unset blocks | `readCurrentState` | An unset block reads as `[]`, `{}` or `''` so an out-of-band add is seen. | A set value is compared. | Correct |
| No unordered paths | (none) | Lists are compared as written, so a reorder is reported. | - | Correct (may over-report, never hides) |

## AWS::S3::Bucket

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| Inventory / analytics / intelligent-tiering defaults | `s3-bucket/effective-items.ts` | S3 fills these on write: `Enabled` true, `IncludedObjectVersions` `All`, `Format` `CSV`, `OutputSchemaVersion` `V_1`, `Status` `Enabled` (#1718). Shared with the send path. | Every explicit non-default (`Current`, `Disabled`). | Correct |
| Notification `Events: [x]` equals `Event: x`; empty families dropped | `effective-items.ts` | S3 returns one event as the scalar and omits empty families (#1748, #1759). | Two events, a different event. | Correct |
| Lifecycle folds (legacy singular transitions, aliases, dates, expiration, scope, `Status`) | `s3-bucket/lifecycle-fold.ts` | Each fold mirrors what the send path puts on the wire (#1754, #1755, #5311). | An unreadable value is left as written; rules stay ordered. | Correct |
| Write-only members skipped | `getDriftUnknownPaths` | S3 never returns them (#6664). | Nothing to compare with. | Correct (not comparable) |
| Absent `AbacStatus` / `MetadataConfiguration` compared as the default | `getDriftAbsentMeansDefaultKeys` | Compares MORE: a live move away from the default is reported. | - | Correct |
| Never-versioned / never-accelerated reads as `Suspended` | `s3-bucket/read-state*.ts` | Both states keep no new versions / no acceleration. | `Enabled` is compared. | Correct |
| Lifecycle rule `Id` S3 generated for an unnamed rule | `s3-bucket/lifecycle-baseline.ts` | S3 assigns an `Id` to a rule that declares none (measured). | Matched by position; a declared `Id` is compared. | Correct |

## AWS::S3Express::DirectoryBucket

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| `MetricsConfigurations`, `InventoryConfigurations` are sets | `s3-directory-bucket-provider.ts` `getDriftUnorderedPaths` | Keyed by `Id`; S3 documents no list order. The only inner list, `OptionalFields`, is a set. | Lifecycle rules stay ordered; any member change. | Correct |
| `BucketKeyEnabled` at its implied value dropped | `s3-directory-bucket/configurations.ts` | Off for SSE-S3; always on for SSE-KMS in a directory bucket (`PutBucketEncryption` reference). | The other value (`aws:kms` + `false`, `AES256` + `true`). | Correct |
| A lifecycle rule's empty `Prefix` dropped | same | An empty prefix matches every object, as no scope does. | A non-empty prefix. | Correct |

## AWS::S3::BucketPolicy

| Rule | Where | Why AWS treats the spellings as one | Boundary (what stays different) | Verdict |
| --- | --- | --- | --- | --- |
| OAI user ARN equals the OAI's `CanonicalUser` | `s3-bucket-policy-provider.ts` `normalizeOaiPrincipals` | S3 shows a `CanonicalUser` OAI grant as the OAI's IAM user ARN (#872). Resolved through the OAI's own `S3CanonicalUserId`. | Another OAI resolves to another id; a failed lookup leaves the ARN. | Correct |
| Bare `AIDA…` id equals the template statement's `CanonicalUser` | same | S3 shows a new OAI grant as a bare id first, then the ARN (measured: about 6 s after `PutBucketPolicy` with a fresh OAI). | Only on the read right after cdkd's own write. Elsewhere the id is compared as read. | Tightened in #6854 |
| A template-claimed bare id is re-read on any other read | `readCurrentState` `outwaitTransientUniqueId` | Not an equivalence: the read waits for the transient form to become the ARN. Cost: on a read that does not follow cdkd's own write (drift, refresh, import, the masked-baseline re-capture), up to 3 extra `GetBucketPolicy` calls and 9 s (2 + 3 + 4) per such policy per run. Never on the deploy or destroy path. | S3 keeps a deleted IAM user's grant as its `AIDA…` id (measured): that policy pays the wait on every drift run, and is reported as drift, until it is fixed. S3 refuses an authored `AIDA…` principal (measured `MalformedPolicy`). | Added in #6854 |
| A journal bag's live policy matched on create | `isOwnLeftover` | The bag is an earlier deploy's attempt, so a bare id there is no transient form. | Compared as read; the create's re-reads (3 x 5 s) cover a transient one. | Tightened in #6854 |
| One-element `Action` / `Resource` equals its scalar, for matching only | same, `findTemplateCanonicalUser` | S3 returns a one-element list as the scalar (#6109). | Selects the statement; rewrites no value. | Correct |
| Policy document comparison | `src/provisioning/policy-document-content.ts` | Audited in lane C. | - | Out of scope |
