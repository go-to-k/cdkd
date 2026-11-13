/**
 * Schema versions for cdkd state.json.
 *
 * - 1 — legacy layout: `s3://{bucket}/cdkd/{stackName}/state.json` (pre PR 1).
 * - 2 — region-prefixed layout: `s3://{bucket}/cdkd/{stackName}/{region}/state.json`.
 * - 3 — adds `ResourceState.observedProperties` (AWS-current snapshot
 *       captured at deploy/import time, used as the drift comparator's
 *       baseline). Layout is the same as v2; only the resource-level shape
 *       grew. v2 readers see v3 as `version: 3` and fail clearly.
 * - 4 — adds `StackState.imports` (the set of `Fn::ImportValue` references
 *       this stack resolved during its last deploy). Consumed by
 *       `cdkd destroy` to refuse deleting a producer while a consumer still
 *       references its outputs (strong reference, matches CloudFormation).
 *       Layout is the same as v3; only the stack-level shape grew. v3
 *       readers see v4 as `version: 4` and fail clearly.
 * - 5 — adds `ResourceState.deletionPolicy` and `updateReplacePolicy`, the
 *       CloudFormation template attributes recorded at deploy time. cdkd
 *       compares these against the next deploy's template to detect
 *       attribute-only changes (e.g. `RemovalPolicy.DESTROY` removed →
 *       `DeletionPolicy: Retain` now in template), which previously fell
 *       through DiffCalculator as `No changes detected`. Layout is the same
 *       as v4; only the resource-level shape grew. v4 readers see v5 as
 *       `version: 5` and fail clearly.
 * - 6 — adds `StackState.parentStack` / `parentLogicalId` / `parentRegion`
 *       to support `AWS::CloudFormation::Stack` nested-stack adoption (issue
 *       [#459](https://github.com/go-to-k/cdkd/issues/459)). Child stacks
 *       record their parent's name + the child's logical id in the parent's
 *       template, so `cdkd state list` / `state show` can surface the
 *       parent → child tree and `cdkd destroy <child-only>` can reject
 *       with a clear pointer at the parent. The child's S3 key uses
 *       `cdkd/<parent>~<NestedStackLogicalId>/<region>/state.json` (the `~`
 *       separator avoids ambiguity with CDK Stage's `/`). Layout
 *       superset of v5; only the stack-level shape grew. v5 readers
 *       see v6 as `version: 6` and fail clearly. v6 writers always emit
 *       the new fields (undefined on top-level stacks, populated on
 *       nested-stack children). This prep PR adds the type bump alone —
 *       the `NestedStackProvider` that consumes the fields lands in a
 *       follow-up.
 * - 7 — adds `ResourceState.provisionedBy: 'sdk' | 'cc-api'` to support
 *       per-resource Cloud Control API routing for SDK-unwired properties
 *       (issue [#614](https://github.com/go-to-k/cdkd/issues/614)). When
 *       a fresh deploy detects an SDK-unwired top-level CFn property on a
 *       Tier 1 type, the resource is routed through Cloud Control API
 *       (which forwards the full property map to AWS) instead of the SDK
 *       Provider (which would drop the field). The state record's
 *       `provisionedBy: 'cc-api'` then sticks for subsequent
 *       deploy / drift / destroy operations on that resource — old
 *       state with the field absent defaults to SDK Provider (matches
 *       pre-v7 behavior). A v6 reader sees the field but doesn't know
 *       what it means and would route a CC-managed resource through
 *       the SDK Provider on update / destroy → silent data corruption
 *       (mid-life provider swap). The bump from 6 to 7 forces a v6
 *       reader to fail with a clear "upgrade cdkd" error instead.
 *       v7 writers always emit `provisionedBy` explicitly (`'sdk'` or
 *       `'cc-api'`); resources read from v6 state with the field
 *       absent are treated as `'sdk'` (legacy default) and the next
 *       write persists it explicitly. Layout superset of v6; only the
 *       resource-level shape grew.
 * - 8 — adds `StackState.outputReads` (the set of `Fn::GetStackOutput`
 *       references this stack resolved during its last deploy), the
 *       sibling of v4's `imports` for the weak-reference `Fn::GetStackOutput`
 *       intrinsic (issue [#668](https://github.com/go-to-k/cdkd/issues/668)).
 *       Consumed by `findDownstreamConsumers` in the
 *       `--recreate-via-cc-api` / `--recreate-via-sdk-provider` warn block
 *       so users can see exactly which downstream stacks read the
 *       recreated resource's outputs via `Fn::GetStackOutput` (in
 *       addition to the v4 `Fn::ImportValue` walk). Unlike `imports`,
 *       this field is purely informational — no destroy-time refusal
 *       (`Fn::GetStackOutput` is a weak reference by design; the
 *       producer stays deletable independently of consumers). Layout
 *       superset of v7; only the stack-level shape grew. v7 readers
 *       see v8 state with `outputReads` undefined → degrade gracefully
 *       (the enumeration just reports no `GetStackOutput` consumers).
 *       v8 writers always emit the field (omitted from JSON when the
 *       set is empty, matching how `imports` is persisted). v7 binary
 *       on v8 state → existing "Upgrade cdkd" hard-fail.
 * - 9 — adds `StackState.exportNames` (the keys of `outputs` that are
 *       `Export.Name` aliases, issue
 *       [#2193](https://github.com/go-to-k/cdkd/issues/2193)). `outputs`
 *       has always held plain Output names AND export aliases in ONE bag,
 *       and nothing in the record said which was which — so the exports
 *       index and the `Fn::ImportValue` state scan treated EVERY key as an
 *       export, and a same-named plain Output in an unrelated stack could
 *       silently shadow a real one. The field is the missing half of that
 *       bag: `importableOutputKeys` reads it, and every reader that used to
 *       walk `outputs` wholesale goes through that one predicate. The
 *       discriminator is the FIELD, not the version: a v9 writer that
 *       carries a pre-v9 record forward without re-resolving its outputs
 *       (a partial save on a failed deploy) keeps the field absent, and
 *       absent reads as the legacy "every key" rule until the stack's next
 *       deploy re-resolves outputs and writes the set (empty included —
 *       `[]` means "no exports", `undefined` means "not known"). Layout
 *       superset of v8; only the stack-level shape grew. A v8 binary
 *       rewriting a v9 record would DROP the field and silently regress
 *       the stack to the "every key" rule, which is why this is a version
 *       bump rather than a bare optional field: v8 readers see `version: 9`
 *       and fail clearly instead.
 *
 * - 10 — adds `ResourceState.observedBaselineRefused` (issue
 *       [#2944](https://github.com/go-to-k/cdkd/issues/2944)). `cdkd import`'s
 *       observed-baseline refusal (issues
 *       [#2828](https://github.com/go-to-k/cdkd/issues/2828) /
 *       [#2850](https://github.com/go-to-k/cdkd/issues/2850)) leaves the record
 *       with `observedProperties: undefined` and `properties` that can hold a
 *       WRONG-BRANCH LITERAL — a downgraded `Fn::If` persisting
 *       `"dev-placeholder"` where AWS holds the secret the deployed branch
 *       resolved. TWO other writers then refill exactly such a missing
 *       baseline against those same `properties`:
 *       `DeployEngine.observedCapture.kickOffAutoRefreshObservedProperties` at deploy start,
 *       and `cdkd state refresh-observed`. Neither holds the template the
 *       refusal was based on, and a literal source leaf against a string
 *       readback PAIRS as an ordinary drifted literal, so the redaction walk
 *       has nothing to refuse on and the decrypted value is persisted — the
 *       GHSA-p5qg-v9gv-hc7w direction, re-opened by a later run.
 *       The field is the refusal's PROVENANCE, carried in the only thing that
 *       survives between those processes. `undefined` means "not refused",
 *       which is what every pre-v10 record means and what the two writers
 *       already assume; `true` means the import declined to capture and no
 *       later writer may synthesize one from `properties`. It is CLEARED by
 *       any writer that produces a trustworthy baseline — a deploy that
 *       resolved the resource from the template, or an import capture that
 *       succeeded — so it is a refusal record, never a permanent brand.
 *       Layout superset of v9; only the resource-level shape grew.
 *       **This is a version bump rather than a bare optional field, and the
 *       reason is the opposite of v9's**: there a v8 writer DROPPING the field
 *       regressed the stack, here a pre-v10 binary would simply IGNORE the
 *       marker and refill the refused baseline — which is the disclosure
 *       itself. Making such a binary fail with the existing "Upgrade cdkd"
 *       error is the correct behaviour, and the bump is how it is expressed.
 *       **State it as a TRADE, not a free win.** `saveState` stamps
 *       `STATE_SCHEMA_VERSION_CURRENT` unconditionally, so the bump does not
 *       fence the MARKER — it fences every state file a v10 binary writes.
 *       After one v10 deploy of any stack, every older binary hard-fails on
 *       that stack, including the great majority carrying no refused record at
 *       all. What it buys is a guaranteed fail-closed for a narrow leak; what
 *       it costs is that fleet-wide refusal. The trade is taken because it is
 *       this repo's standing policy for every bump since v2 and the failure is
 *       loud with a named remedy — but the cost is real and is not the
 *       marker's own scope.
 *
 * - 11 — adds `ResourceState.noEchoLeaves` and
 *       `ResourceState.noEchoAttributeNames` (issues
 *       [#4043](https://github.com/go-to-k/cdkd/issues/4043) /
 *       [#2449](https://github.com/go-to-k/cdkd/issues/2449)). A `NoEcho: true`
 *       template parameter's value, and a value an attribute declared `NoEcho`
 *       served, is persisted as `***` in `properties` / `observedProperties` /
 *       `attributes` / `outputs`; the first field names WHERE in `properties`
 *       (and so in `observedProperties`) the mask stands for such a value, the
 *       second WHICH of the record's own `attributes` were declared `NoEcho`.
 *       A comparison that needs the value reads it back from AWS or
 *       re-resolves it; nothing derived from it is stored.
 *       A bump, for v10's reason: a v10 binary would compare its plaintext
 *       desired value with `***`, and on a create-only property that is a
 *       REPLACEMENT every deploy. Failing with "Upgrade cdkd" is the safe
 *       direction.
 *       **The same TRADE as v10, plus one of its own.** `saveState` stamps the
 *       current version unconditionally, so every stack a v11 binary writes
 *       refuses older binaries, and that includes writes that hold no template
 *       and so redact nothing (`cdkd state refresh-observed`, `cdkd drift
 *       --accept`, `cdkd orphan`, a destroy's partial save, a rollback
 *       restore). `version: 11` therefore never certifies "redacted"; readers
 *       read the two fields, and their ABSENCE means "not known", which keeps
 *       the v10 reading of a `***` (the custom-resource class) and makes a
 *       stored plaintext the MIGRATION WITNESS the next deploy compares with.
 *       No read-time migration: a v10 document is read unchanged and the next
 *       `cdkd deploy` rewrites it.
 *
 * - 12 — adds `ResourceState.referenceProvenance` and
 *       `StackState.outputReferenceProvenance` (issues
 *       [#4847](https://github.com/go-to-k/cdkd/issues/4847) /
 *       [#4852](https://github.com/go-to-k/cdkd/issues/4852)). A stored
 *       `{{resolve:...}}` token says neither WHERE it was resolved nor WHICH
 *       value it stood for; the fields record, per token, the region that
 *       answered and the secret's own version ids (a Secrets Manager
 *       `VersionId`, an SSM parameter `Version`), never a value or a hash.
 *       Read through `referenceProvenanceOf` / `outputReferenceProvenanceOf`
 *       (`src/deployment/reference-provenance-record.ts`), which
 *       validate each entry and read a malformed one as absent.
 *       A bump, for v10's reason: a v11 binary rewriting a record would drop
 *       the fields, and the readers that rely on them would then take a
 *       version recorded for an older value as current. ABSENT means "not
 *       known" and keeps the v11 reading in every reader; a v11 document is
 *       read unchanged, and the next `cdkd deploy` writes the fields: a record
 *       it WRITES from this run's resolution, an unchanged one through a
 *       one-time capture that sends nothing and changes no other field.
 *
 * - 13 — adds `StackState.stackInstanceId` (issue
 *       [#5064](https://github.com/go-to-k/cdkd/issues/5064)): a random id
 *       minted at the FIRST state write of a stack (its first deploy, the
 *       partial save of a failed first deploy, or `cdkd import` creating the
 *       record), naming one lifetime of the stack between its creation and
 *       its record's deletion. A first deploy writes it ahead to the
 *       `stack-instance.json` sibling (`src/state/stack-instance-id.ts`)
 *       before any resource create, so a re-run after a crash reuses it.
 *       ABSENT means a LEGACY stack, and it stays legacy: no writer mints one
 *       for a stack that already has a record.
 *       A bump, for v10's reason: an older binary rebuilds a record field by
 *       field and would drop the id, turning the stack legacy behind the
 *       next reader's back. A v12 document is read unchanged (legacy).
 *
 * - 14 — adds `ResourceState.unsettledProperties` (issue
 *       [#5380](https://github.com/go-to-k/cdkd/issues/5380)): the top-level
 *       property NAMES (never values) a provider's `update()` declared it was
 *       about to change with an irreversible call before that update failed,
 *       so AWS may hold either side. The next deploy treats each as changed
 *       and the provider converges it against AWS. Read through
 *       `unsettledPropertiesOf` (malformed = none).
 *       A bump, for v10's reason: an older binary rewriting the record would
 *       drop the names, and a later deploy back to the recorded template would
 *       diff empty and leave AWS on the other side. A v13 document is read
 *       unchanged (nothing unsettled).
 *
 * - 15 — adds `ResourceState.unsettledItems` (issue
 *       [#5498](https://github.com/go-to-k/cdkd/issues/5498)): per unsettled
 *       collection, the IDENTITY NAMES (an index name, a replica region, a
 *       metric, a tag key — never a value) a failed update's call had been
 *       ACCEPTED for adding, so the next convergence (and the automatic
 *       revert) can remove exactly what cdkd started. Read through
 *       `unsettledItemsOf` (only paths under an unsettled key; malformed or
 *       over-cap = none). A bump, for v10's reason: an older binary rewriting
 *       the record would drop the names, and the item would be kept instead of
 *       removed. A v14 document is read unchanged (nothing attempted).
 *
 * - 16 — adds `StackState.stackIdFromInstance` (issue
 *       [#6170](https://github.com/go-to-k/cdkd/issues/6170)): `true` on a
 *       stack whose first state write minted its `stackInstanceId` with this
 *       version, whose `AWS::StackId` then ends in a UUID derived from that id
 *       instead of the constant `cdkd`. Read through `stackIdTailOf`. A bump,
 *       for v10's reason: an older binary rewriting the record would drop the
 *       marker, and the next deploy would resolve `AWS::StackId` back to
 *       `.../cdkd`, replacing every resource named from it. A v15 document is
 *       read unchanged (the `cdkd` tail it was deployed with).
 *
 * cdkd readers handle every prior version. Writers always emit
 * `STATE_SCHEMA_VERSION_CURRENT`. An older cdkd binary that only knows an
 * earlier version will fail with a clear error when it encounters a higher
 * version, rather than silently mishandling the new format.
 */
export type StateSchemaVersion =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16;
export const STATE_SCHEMA_VERSION_LEGACY: StateSchemaVersion = 1;
export const STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 16;

/**
 * Every schema version this binary can read. Writers always emit
 * `STATE_SCHEMA_VERSION_CURRENT`; older versions are accepted for
 * forward-migration, and an unknown / future version triggers an explicit
 * "upgrade cdkd" error in the parser.
 */
export const STATE_SCHEMA_VERSIONS_READABLE: readonly StateSchemaVersion[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];

// The record shapes and their helpers live in the sibling `state/`
// directory; this entry re-exports every one of them, so callers keep
// importing from `src/types/state.ts` only.
export type {
  StateImportEntry,
  StateOutputReadEntry,
  StackState,
  ReferenceProvenance,
  PendingMoveOut,
  RecordedConditionVerdict,
  StackOrphanRecord,
  SupersededResourceRecord,
} from './state/stack-state.js';
export type { ResourceState } from './state/resource-state.js';
export {
  hasUnverifiableParameterRefusal,
  hasReasonlessBaselineRefusal,
} from './state/resource-state.js';
export type {
  ChangeType,
  ResourceChange,
  AttributeChange,
  PropertyChange,
} from './state/changes.js';
export {
  shouldRetainResource,
  isReadableBag,
  describeRegionValueKind,
  importableOutputKeys,
  acceptedCreateOnlyDropsOf,
  hasReadableExportSet,
  importableOutputs,
  exportNamesCarriedFrom,
  stackInstanceIdCarriedFrom,
  skippedOutputsCarriedFrom,
  orphansCarriedFrom,
  orphansAfterRollback,
} from './state/helpers.js';

/**
 * Lock information for stack operations
 */
export interface LockInfo {
  /** Lock owner (e.g., username, CI job ID) */
  owner: string;

  /** Lock acquisition timestamp (Unix milliseconds) */
  timestamp: number;

  /** Lock expiration timestamp (Unix milliseconds) */
  expiresAt: number;

  /** Optional operation being performed */
  operation?: string;
}
