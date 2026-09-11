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
 *       per-resource Cloud Control API routing for silent-drop properties
 *       (issue [#614](https://github.com/go-to-k/cdkd/issues/614)). When
 *       a fresh deploy detects a silent-drop top-level CFn property on a
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
 *       `DeployEngine.kickOffAutoRefreshObservedProperties` at deploy start,
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
 * cdkd readers handle every prior version. Writers always emit
 * `STATE_SCHEMA_VERSION_CURRENT`. An older cdkd binary that only knows an
 * earlier version will fail with a clear error when it encounters a higher
 * version, rather than silently mishandling the new format.
 */
export type StateSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export const STATE_SCHEMA_VERSION_LEGACY: StateSchemaVersion = 1;
export const STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 10;

/**
 * Every schema version this binary can read. Writers always emit
 * `STATE_SCHEMA_VERSION_CURRENT`; older versions are accepted for
 * forward-migration, and an unknown / future version triggers an explicit
 * "upgrade cdkd" error in the parser.
 */
export const STATE_SCHEMA_VERSIONS_READABLE: readonly StateSchemaVersion[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
];

/**
 * One `Fn::ImportValue` reference recorded during a consumer stack's
 * deploy. Persisted in `StackState.imports` so `cdkd destroy` can refuse
 * to delete the producer while the consumer still references its outputs
 * (strong reference, matches CloudFormation behavior).
 *
 * Only `Fn::ImportValue` populates this — `Fn::GetStackOutput` is a weak
 * reference by design (cdkd-specific) and is tracked separately in
 * `StackState.outputReads` (schema v8+) for downstream-consumer
 * enumeration only, NOT for destroy-time refusal.
 */
export interface StateImportEntry {
  /** The producer stack whose Output `Export.Name` was imported. */
  sourceStack: string;
  /**
   * The producer's region. Required so destroy-time strong-ref checks
   * can scan the producer's exact `state.json` key (cdkd state is keyed
   * by `(stackName, region)` since schema v2).
   */
  sourceRegion: string;
  /** The CloudFormation Output `Export.Name` that was imported. */
  exportName: string;
}

/**
 * One `Fn::GetStackOutput` reference recorded during a consumer stack's
 * deploy (schema v8+, issue
 * [#668](https://github.com/go-to-k/cdkd/issues/668)). Persisted in
 * `StackState.outputReads` so `findDownstreamConsumers` (called from the
 * `--recreate-via-cc-api` / `--recreate-via-sdk-provider` warn block) can
 * name the downstream stacks that will see a stale value after the
 * producer's recreate.
 *
 * Unlike `StateImportEntry`, this does NOT influence destroy semantics —
 * `Fn::GetStackOutput` is a weak reference by design (cdkd-specific),
 * and the producer stays deletable independently of consumers. The
 * enumeration is informational only.
 *
 * Cross-account RoleArn-based reads are NOT recorded in v8 (deferred to
 * a future schema bump alongside a `sourceAccountId` field — `RoleArn`
 * lookups already pay an STS hop at resolve time, so the cross-account
 * consumer set is rarely large in practice).
 */
export interface StateOutputReadEntry {
  /** The producer stack whose Output `Name` was read. */
  sourceStack: string;
  /**
   * The producer's region. Required so the enumeration's
   * `(producerStack, producerRegion)` match key is stable across
   * cross-region `Fn::GetStackOutput` references.
   */
  sourceRegion: string;
  /** The CloudFormation Output `Name` (template `Outputs.<Name>`) that was read. */
  outputName: string;
}

/**
 * Stack state stored in S3
 */
export interface StackState {
  /**
   * Schema version. `1` is the legacy unversioned-key layout, `2` is the
   * region-prefixed layout. New writes always use the current version.
   */
  version: StateSchemaVersion;

  /** Stack name */
  stackName: string;

  /**
   * Target region for this stack. Required on `version: 2` since the region
   * is part of the S3 key. Optional on `version: 1` for backwards compat.
   */
  region?: string;

  /** Resources in the stack */
  resources: Record<string, ResourceState>;

  /** Stack outputs (values can be any type) */
  outputs: Record<string, unknown>;

  /**
   * `Fn::ImportValue` references this stack resolved during its last
   * successful deploy. Populated on schema v4+; absent (or undefined)
   * on state written by an older cdkd binary, in which case the
   * destroy-time strong-reference check degrades gracefully (no
   * recorded imports = no consumers known = destroy proceeds). The
   * next deploy of an upgraded stack repopulates the field.
   */
  imports?: StateImportEntry[];

  /**
   * `Fn::GetStackOutput` references this stack resolved during its last
   * successful deploy (schema v8+, issue
   * [#668](https://github.com/go-to-k/cdkd/issues/668)). Sibling of
   * `imports` for the weak-reference `Fn::GetStackOutput` intrinsic —
   * consumed by `findDownstreamConsumers` so the recreate warn block
   * can name downstream stacks whose cached output values will go
   * stale after a producer's recreate.
   *
   * Absent (or undefined) on state written by a pre-v8 binary; the
   * enumeration degrades to imports-only in that case (matches the v4
   * shipped behavior). The next deploy of an upgraded stack
   * repopulates the field. Same persistence policy as `imports`:
   * emitted only when the resolved set is non-empty so an empty array
   * doesn't bloat every state file. Cross-account (`RoleArn`-based)
   * reads are deferred to a future schema bump alongside a
   * `sourceAccountId` field.
   */
  outputReads?: StateOutputReadEntry[];

  /**
   * The keys of `outputs` that are `Export.Name` aliases — the ONLY names an
   * `Fn::ImportValue` may bind to (schema v9+, issue
   * [#2193](https://github.com/go-to-k/cdkd/issues/2193)). `outputs` keys
   * both the plain Output names and the export aliases, and before this
   * field nothing distinguished them, so every reader deriving "what does
   * this stack export" from the bag took every key.
   *
   * `undefined` means NOT KNOWN — a record written before v9, or a v9
   * partial save that carried a pre-v9 bag forward without re-resolving it —
   * and reads as the legacy "every key is importable" rule, so no existing
   * cross-stack reference breaks on upgrade. `[]` means KNOWN to export
   * nothing. Writers that re-resolve outputs therefore always emit the
   * field, empty included (unlike `imports` / `outputReads`, where absent
   * and empty are the same record); writers that carry a bag forward carry
   * this field with it, through {@link exportNamesCarriedFrom}. Read
   * through {@link importableOutputKeys} rather than directly, so the
   * legacy rule lives in one place.
   */
  exportNames?: string[];

  /**
   * The template `Outputs` keys the last deploy could NOT resolve and SKIPPED
   * — the resolver threw under the default (non-`--strict-getatt`) arm, or
   * returned nothing at all — each mapped to a digest of
   * every template input that fed its resolution (issue
   * [#2740](https://github.com/go-to-k/cdkd/issues/2740)). Such a key is
   * absent from `outputs` when the save re-resolved the bag; the no-change
   * path keeps the PREVIOUS bag when any output fails, so a key that resolved
   * on an earlier deploy can sit in `outputs` beside its record — the diff
   * then ignores the record for it (it checks absence first). `cdkd diff`
   * cannot reproduce the failure when
   * it happened inside a secret lookup the diff deliberately skips — so
   * without this record the diff previewed an `ADD` the deploy would never
   * perform, on every run of an unchanged stack. The diff previews a recorded
   * key as ABSENT (no row; its siblings are previewed normally) while three
   * things hold: the key is still absent from `outputs`, today's digest
   * equals the recorded one, and no resource the output references is
   * changing on this run (`Resources` is not digested, so that last one comes
   * from the resource diff). Any change to the digested inputs puts it back
   * under the ordinary
   * preview rules (usually an `ADD`; an intrinsic `Export.Name` that stays
   * unresolvable still suppresses the section as before), and the next deploy
   * re-decides it — publishing it if the repair took, or recording it again
   * under the new digest. The digest is computed by
   * `skippedOutputDigest` in `src/analyzer/skipped-outputs.ts`, the ONE place
   * both writer and reader spell what it covers, always from a snapshot taken
   * before any resolution (that module says why).
   *
   * Informational, NO schema bump (the `outputReads` read policy): absent on a
   * record written before this field existed, in which case the diff behaves
   * as before and the next deploy under this binary writes it. Omitted from
   * JSON when the last deploy skipped nothing — a record that carries the
   * field says at least one output was skipped. Writers that re-resolve
   * outputs replace the whole map (an output that resolved, or left the
   * template, drops out) — the no-change path included, even when it keeps
   * the previous bag because an output failed; a failed deploy's partial saves
   * carry `outputs` forward WITHOUT re-resolving and carry this field with it,
   * through {@link skippedOutputsCarriedFrom}, and a partial-destroy snapshot
   * carries it through its `...rest` spread, which the next deploy re-decides.
   *
   * Every writer that rebuilds state OUTSIDE a deploy DROPS the field — with
   * ONE enumerated exception, the partial-destroy snapshot above, which
   * carries it deliberately: a destroy removes resources, every removed one
   * returns as a CREATE on the next diff, and the change map un-binds any
   * record that references it, so a repair-through-destroy could not be
   * constructed by either side of the review. The droppers:
   * `cdkd import`, `cdkd drift --accept`, `cdkd drift --revert`,
   * `cdkd rollback`, `cdkd scrub`, the orphan rewrite behind `cdkd orphan`,
   * and `cdkd state refresh-observed`. The record says what the last DEPLOY
   * could not resolve; six of those can change the values an output's
   * resolution reads while every resource still reports `NO_CHANGE`, so the
   * diff's change map has nothing to un-bind on and a carried record would
   * preview a key as absent while the next deploy publishes it. The seventh,
   * `refresh-observed`, writes only `observedProperties`, which the resolver
   * does not read — it drops anyway once it refreshed at least one resource,
   * because the rule is flat; a run that refreshed nothing rebuilt nothing
   * and keeps the record.
   *
   * It is a flat rule ON PURPOSE. Three per-writer arguments for carrying it
   * were written during review. Two were shown wrong: substituting a value
   * can repair an output when an enclosing intrinsic was choking on what was
   * there, and scrubbing a plaintext back to its expression changes a string
   * outputs read verbatim. The third — that DELETING a property can expose an
   * attribute of the same name — could not be settled between two careful
   * readers: `refStateLookupFromResource` already falls through from
   * `properties` to `attributes` when the property holds nothing usable, so
   * a deletion may remove a hit rather than reveal one. A case that hard to
   * settle is the strongest reason for a flat rule. A new writer owes the
   * drop, not an argument. The cost is bounded and visible: those keys return
   * to pre-#2740 behaviour until the next deploy recomputes the record.
   */
  skippedOutputs?: Record<string, string>;

  /**
   * Parent stack's physical name when THIS state record describes a
   * nested-stack child (issue [#459](https://github.com/go-to-k/cdkd/issues/459)).
   * Undefined on top-level stacks. The pre-v6 reader sees the field as
   * undefined and degrades to "I am a top-level stack" — which is correct
   * for every state file written before nested-stack support shipped.
   * v6+ writers populate this on child state records so `cdkd state list`
   * can surface the parent → child tree and `cdkd destroy <child-only>`
   * can reject with a pointer at the parent (matches CFn's "cannot
   * directly destroy a nested stack" semantic).
   *
   * v6 prep PR adds the field shape only; no writer touches it yet —
   * the `NestedStackProvider` that consumes it lands in the follow-up.
   */
  parentStack?: string;

  /**
   * The `AWS::CloudFormation::Stack` logical ID inside the parent's
   * template that produced this child. Combined with `parentStack`, the
   * pair uniquely identifies the child's position in the parent's DAG.
   * Used by `cdkd destroy` to reject `destroy <child-only>` with a
   * clear "destroy the parent instead" error message that names the
   * specific parent + child-logical-id pair, mirroring CFn's behavior.
   *
   * Undefined on top-level stacks; populated by v6+ writers on child
   * state records. Always paired with `parentStack` / `parentRegion`
   * (never set independently).
   */
  parentLogicalId?: string;

  /**
   * Region of the parent stack. Always equals `region` in v1 of the
   * nested-stack feature (AWS does not support cross-region nested
   * stacks — the `AWS::CloudFormation::Stack` resource lives in the
   * same region as its parent) but recorded explicitly so a future
   * cross-region capability does not require another schema bump.
   *
   * Undefined on top-level stacks; populated by v6+ writers on child
   * state records.
   */
  parentRegion?: string;

  /**
   * Resources a rollback left in AWS under `DeletionPolicy: Retain` and
   * dropped from {@link resources} (issue #2934).
   *
   * cdkd's generated physical names are deterministic
   * (`generateResourceName` — no random component), so an orphan of this kind
   * holds the exact name the NEXT deploy will ask AWS for. Without this record
   * that deploy collides, rolls back, and repeats forever; with it, the deploy
   * re-adopts the resource instead of creating one.
   *
   * Each entry carries the `ResourceState` the rollback discarded, VERBATIM.
   * That is load-bearing: its `properties` are the failed deploy's resolved
   * TEMPLATE values, which is what {@link DiffCalculator} expects on the old
   * side (`state.properties` holds template values; AWS-observed defaults live
   * in `observedProperties`). Re-adopting from an AWS readback instead would
   * put keys in the bag that the template omits — a generated `RoleName`,
   * `BucketName`, `TableName` — and the next diff would read them as removals
   * of create-only properties and REPLACE the resource, destroying the data
   * the adoption exists to preserve.
   *
   * Informational to a reader that does not know the field, so NO schema bump
   * (the `skippedOutputs` / rollback-journal precedent): absent means today's
   * behaviour — the deploy collides and the go-to-k/cdkd#2916 diagnosis fires.
   * An OLD binary drops the field on its next save, which degrades to that
   * same behaviour rather than corrupting anything. Unlike `skippedOutputs`
   * this field can drive a STOP, so that downgrade is a stated consequence
   * rather than an assumed-harmless one.
   *
   * **Every writer must carry it forward through {@link orphansCarriedFrom}.**
   * The `StackState` literals are field-enumerated, so a save that forgets it
   * DELETES the record silently, and the resource becomes untrackable.
   *
   * **Secret-bearing.** The entry holds a whole `ResourceState`, so
   * `redactStateForPersist` must scrub `orphans[*].state` exactly as it scrubs
   * `resources` — a top-level field otherwise rides the `...state` spread
   * untouched, and the automatic rollback captures from the in-memory map,
   * which holds REAL resolved values by design.
   */
  orphans?: StackOrphanRecord[];

  /** Last modification timestamp (Unix milliseconds) */
  lastModified: number;
}

/**
 * One resource a rollback left in AWS and dropped from state (issue #2934).
 *
 * See {@link StackState.orphans} for why the whole `ResourceState` is kept
 * rather than a physical id alone.
 */
export interface StackOrphanRecord {
  /** The logical id the resource had in the template that created it. */
  logicalId: string;

  /** When the rollback dropped it (Unix milliseconds). */
  orphanedAt: number;

  /** The `ResourceState` the rollback discarded, verbatim. */
  state: ResourceState;
}

/**
 * Individual resource state
 */
export interface ResourceState {
  /** Physical resource ID (ARN, name, etc.) */
  physicalId: string;

  /** CloudFormation resource type (e.g., AWS::Lambda::Function) */
  resourceType: string;

  /** Resource properties */
  properties: Record<string, unknown>;

  /**
   * AWS-current snapshot of this resource's properties as returned by
   * `provider.readCurrentState` immediately after a successful create /
   * update / import. Used as the drift comparator's baseline (instead of
   * `properties`) so console-side changes to keys the user did not
   * template still surface as drift.
   *
   * Optional for backwards compatibility — resources written by an older
   * cdkd binary (v2 state, or v3 state on a provider that does not
   * implement `readCurrentState`) keep this field undefined; the drift
   * command falls back to comparing against `properties` in that case.
   */
  observedProperties?: Record<string, unknown>;

  /** Resource attributes for Fn::GetAtt resolution */
  attributes?: Record<string, unknown>;

  /** Resource dependencies (logical IDs) for proper deletion order */
  dependencies?: string[];

  /** Additional metadata */
  metadata?: Record<string, unknown>;

  /**
   * CloudFormation `DeletionPolicy` attribute recorded at deploy time
   * (schema v5+). Compared against the template on the next deploy so an
   * attribute-only change (e.g. `RemovalPolicy.DESTROY` removed →
   * `DeletionPolicy: Retain`) is surfaced as a diff instead of silently
   * being marked `No changes`. Optional for backwards compatibility — v4
   * state writes leave this undefined; the diff comparator treats
   * `undefined` as "no attribute recorded" rather than "Delete" so the
   * first post-upgrade deploy only fires the diff when the template
   * actually carries the attribute.
   *
   * The `| undefined` is explicit (vs bare `?:`) so a state-update site
   * can spread `{ ...current, deletionPolicy: undefined }` to clear a
   * previously-recorded value when the user removes the attribute from
   * their CDK code; under `exactOptionalPropertyTypes: true` a bare `?:`
   * would reject the literal-undefined assignment.
   */
  deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;

  /**
   * CloudFormation `UpdateReplacePolicy` attribute recorded at deploy time
   * (schema v5+). Same semantics as `deletionPolicy` above.
   */
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;

  /**
   * Which provisioning layer owns this resource (schema v7+, issue
   * [#614](https://github.com/go-to-k/cdkd/issues/614)).
   *
   * - `'sdk'` — SDK Provider (the cdkd-preferred fast path: direct
   *   synchronous AWS SDK calls per resource type, no polling).
   * - `'cc-api'` — Cloud Control API (the fallback path: async polling
   *   create/update/delete via the unified CloudControlClient). Routed
   *   automatically when the resource's template uses a top-level CFn
   *   property the SDK Provider would silently drop. CC API forwards
   *   the full property map to AWS, closing the silent-drop bug.
   *
   * Absent / `undefined` means SDK Provider (legacy v6-and-earlier
   * default — every resource pre-#614 was SDK-managed). v7 writers always
   * emit the field explicitly so the routing decision is durable.
   *
   * The field is **sticky** BY DEFAULT: once a resource is `'cc-api'`, an
   * SDK Provider backfill (issue #609) does not by itself migrate it back.
   * Avoids physical-ID churn + destroy + recreate cycles on every backfill
   * release.
   *
   * Three things end the stickiness, in increasing order of how much the
   * user has to do:
   *
   * 1. **Automatic, per resource** (issue #2719) — the type carries an
   *    `'sdk-coverage'` entry in `STICKY_CC_MIGRATION_EXEMPT` (measured
   *    physicalId parity), AND neither the desired nor the recorded property
   *    bag of THIS resource has an actionable silent drop. The next mutating
   *    deploy writes `'sdk'` with the physical id unchanged. `--pin-cc-api`
   *    declines it for one deploy.
   * 2. **Automatic, per type** — a `'cc-broken'` entry (issue #961), where
   *    Cloud Control cannot manage the type at all, so the escape is
   *    unconditional.
   * 3. **User-initiated, either direction** — `--recreate-via-cc-api` (issue
   *    #615) and `--recreate-via-sdk-provider` (issue #651). Both DESTROY and
   *    recreate, so they are the heavy option, not the routine one.
   *
   * This comment previously described (3)'s CC → SDK half as "a future
   * counterpart"; it shipped in #651, and (1) has since shipped too.
   */
  provisionedBy?: 'sdk' | 'cc-api' | undefined;

  /**
   * Schema v10+. `true` when `cdkd import` DECLINED to capture an
   * `observedProperties` baseline for this resource, and therefore that no
   * later writer may synthesize one from `properties` either (issue
   * [#2944](https://github.com/go-to-k/cdkd/issues/2944)).
   *
   * WHAT IT RECORDS is a fact about `properties`, not about the resource: the
   * import's resolve could not vouch that this record's `properties` still
   * SPELL the dynamic reference the template had
   * (`resolveImportedProperties`' three arms — the resolve threw, it lost a
   * `{{resolve:` opener, or it discarded a subtree that is not provably inert).
   * `captureObservedForImportedResources` skips the capture on that verdict,
   * because the redaction it would apply is POSITION-based and an unvouched
   * bag gives it no evidence.
   *
   * WHY IT HAS TO BE PERSISTED, when the skip alone was thought sufficient:
   * the refusal leaves `observedProperties: undefined`, and that is ALSO what
   * a pre-v3 record and a provider without `readCurrentState` leave — so the
   * two writers whose job is to fill a missing baseline cannot tell the cases
   * apart. `DeployEngine.kickOffAutoRefreshObservedProperties` selects exactly
   * `observedProperties === undefined` at deploy start, and
   * `cdkd state refresh-observed` refreshes every resource unconditionally.
   * Both position the readback against this record's `properties`, which after
   * a refusal can hold the WRONG-BRANCH LITERAL the refusal distrusted; a
   * literal source leaf against a string readback PAIRS as an ordinary drifted
   * literal, so the redaction walk refuses nothing and persists the decrypted
   * value. The evidence the refusal was based on — the imported template and
   * its downgraded conditions — exists only inside that `cdkd import` process,
   * so nothing but the record can carry it to them.
   *
   * IT IS A REFUSAL RECORD, NOT A BRAND. Any writer that produces a
   * trustworthy baseline clears it: an import capture that SUCCEEDS FOR A
   * RESOURCE THAT RUN RE-IMPORTED, and a deploy that CREATEs or UPDATEs the
   * resource from the template (which holds the evidence the import lacked,
   * and whose own capture overwrites the baseline anyway). Left uncleared it
   * would cost the resource its drift baseline for the life of the record.
   *
   * THE "RE-IMPORTED" QUALIFIER IS LOAD-BEARING, and `cdkd import` is itself
   * the FIFTH writer the marker has to be honoured by. A selective merge seeds
   * `buildStackState` from `existingState.resources` and overwrites only the
   * rows that run re-imported, so a PRESERVED record keeps a previous run's
   * downgraded `properties` — the wrong-branch literal — along with the marker.
   * Re-resolving a plain literal trips none of the three refusal arms, so that
   * run's refusal set does not name it; capturing against it would persist the
   * decrypted value, and clearing the marker would stand the other four writers
   * down permanently. `captureObservedForImportedResources` therefore skips
   * such a record without clearing it, keyed on the ids that run actually
   * rebuilt.
   *
   * `undefined` — the only other value, and the one every pre-v10 record
   * carries — means "not refused", which is the behaviour both writers had
   * before this field existed. Only `true` is ever written; there is no
   * `false`, so a reader tests presence.
   */
  observedBaselineRefused?: true | undefined;
}

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

/**
 * Change type for resource diff
 */
export type ChangeType = 'CREATE' | 'UPDATE' | 'DELETE' | 'NO_CHANGE';

/**
 * Resource change information
 */
export interface ResourceChange {
  /** Logical ID from CloudFormation template */
  logicalId: string;

  /** Type of change */
  changeType: ChangeType;

  /** Resource type */
  resourceType: string;

  /** Current properties (for UPDATE/DELETE) */
  currentProperties?: Record<string, unknown>;

  /** Desired properties (for CREATE/UPDATE) */
  desiredProperties?: Record<string, unknown>;

  /** Property-level changes (for UPDATE) */
  propertyChanges?: PropertyChange[];

  /**
   * `DeletionPolicy` / `UpdateReplacePolicy` attribute changes (schema v5+).
   * Populated when the template attribute differs from the value recorded in
   * cdkd state. AWS has no API to mutate these attributes per-resource, so
   * the deploy engine handles the change by updating cdkd state only — no
   * provider call. UPDATE classification still fires when only these change
   * (DiffCalculator does not stay at `NO_CHANGE`), so users see the diff
   * instead of `No changes detected`.
   */
  attributeChanges?: AttributeChange[];
}

/**
 * Template-level resource attribute change (schema v5+).
 *
 * `DeletionPolicy` / `UpdateReplacePolicy` are CloudFormation template
 * metadata — they have no AWS API per-resource and are mutated through the
 * cdkd state record alone.
 */
export interface AttributeChange {
  /** Attribute name: `DeletionPolicy` or `UpdateReplacePolicy`. */
  attribute: 'DeletionPolicy' | 'UpdateReplacePolicy';
  oldValue: string | undefined;
  newValue: string | undefined;
}

/**
 * Returns true when a recorded `DeletionPolicy` should prevent cdkd from
 * deleting the underlying AWS resource. `Retain` and `RetainExceptOnCreate`
 * both keep the resource around; `Delete` / `Snapshot` / undefined all
 * fall through to the normal delete path. Shared between
 * `runDestroyForStack` (state-only, no template) and `DeployEngine`'s
 * DELETE branch (state-preferred, template-fallback) so the two paths
 * cannot drift on the policy semantics. Lives here (not in
 * deploy-engine or destroy-runner) because both consumers already
 * depend on this module — placing it in either would create a cycle.
 */
export function shouldRetainResource(
  deletionPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined
): boolean {
  return deletionPolicy === 'Retain' || deletionPolicy === 'RetainExceptOnCreate';
}

/**
 * The keys of `state.outputs` an `Fn::ImportValue` may bind to (issue
 * [#2193](https://github.com/go-to-k/cdkd/issues/2193)) — THE predicate
 * behind "what does this stack export". Four readers used to answer that
 * by walking `outputs` wholesale (the exports index on update and on
 * rebuild, the resolver's state scan, and the local-command loader's
 * `Fn::ImportValue` fallback scan), and each therefore took a plain Output
 * name for an export; they all go through here now, so the rule cannot
 * drift between them.
 *
 * A record whose `exportNames` is unknown (pre-v9, or a v9 partial save that
 * carried a pre-v9 bag forward) keeps the legacy rule — every key — until
 * its next deploy writes the set. A known set is intersected with the bag:
 * an alias whose value did not resolve publishes nothing, and a name the
 * bag does not hold cannot be served.
 *
 * `outputs` is typed required but every consumer treats it as optional (a
 * state file may simply have none), so it is read defensively here too.
 */
export function importableOutputKeys(state: Pick<StackState, 'outputs' | 'exportNames'>): string[] {
  const outputs = state.outputs ?? {};
  if (state.exportNames === undefined) return Object.keys(outputs);
  return state.exportNames.filter((name) => Object.hasOwn(outputs, name));
}

/** `state.outputs` narrowed to its {@link importableOutputKeys}. */
export function importableOutputs(
  state: Pick<StackState, 'outputs' | 'exportNames'>
): Record<string, unknown> {
  const outputs = state.outputs ?? {};
  // `Object.create(null)`, NOT `{}`: a JSON-parsed `state.outputs` can carry an
  // OWN key named `__proto__` (JSON.parse makes it own, not the setter), and an
  // `Export.Name` of `__proto__` would then reach this reconstruction. Assigning
  // `picked['__proto__'] = value` onto a plain object literal walks the prototype
  // setter — the key vanishes from the bag fed to the exports index / resolver,
  // and an object value pollutes `picked`'s prototype. Same defense the resolver
  // uses at `intrinsic-function-resolver.ts` (do not "simplify" back to `{}`).
  const picked: Record<string, unknown> = Object.create(null);
  for (const name of importableOutputKeys(state)) picked[name] = outputs[name];
  return picked;
}

/**
 * The `exportNames` half of a record whose `outputs` bag is being CARRIED
 * FORWARD unchanged rather than re-resolved (a partial save on a failed
 * deploy, `cdkd import` over an existing record). The two travel together:
 * carrying the bag without its set would turn a known-exports record back
 * into a "not known" one, and inventing `[]` for a pre-v9 bag would deny
 * every consumer of a stack that never had the chance to write the set.
 * Spread this next to `outputs: previous.outputs` — never write the field
 * by hand at such a site.
 */
export function exportNamesCarriedFrom(
  previous: Pick<StackState, 'exportNames'>
): Pick<StackState, 'exportNames'> {
  return previous.exportNames === undefined ? {} : { exportNames: previous.exportNames };
}

/**
 * The `skippedOutputs` field to write when a save carries the PREVIOUS
 * record's `outputs` bag forward instead of re-resolving it (issue #2740). The
 * record describes that bag — which keys the deploy that wrote it could not
 * resolve — so it travels with the bag, exactly like {@link
 * exportNamesCarriedFrom}: absent stays absent, present stays as it was. A
 * writer that re-resolves outputs does NOT call this; it writes the set the
 * resolution produced, or omits the field when nothing was skipped.
 */
export function skippedOutputsCarriedFrom(
  previous: Pick<StackState, 'skippedOutputs'>
): Pick<StackState, 'skippedOutputs'> {
  return previous.skippedOutputs === undefined ? {} : { skippedOutputs: previous.skippedOutputs };
}

/**
 * Carry {@link StackState.orphans} across a rebuild that does not re-decide it
 * (issue #2934): absent stays absent, present stays as it was.
 *
 * **Every** field-enumerating `StackState` literal must spread this. The field
 * is the only record that a `Retain`-orphaned resource exists at all, so a save
 * that omits it does not merely lose a hint — it makes a live, billing AWS
 * resource untrackable and re-opens the deploy loop the record closes. That is
 * a stronger duty than {@link skippedOutputsCarriedFrom}'s, whose loss costs a
 * diff preview.
 *
 * Writers that re-DECIDE the set do not call this: the rollback arms append,
 * and the deploy drops an entry once it has been adopted or found absent from
 * AWS. Spread-form writers (`{ ...previous, ... }`) carry the field already and
 * need nothing.
 */
export function orphansCarriedFrom(
  previous: Pick<StackState, 'orphans'>
): Pick<StackState, 'orphans'> {
  return previous.orphans === undefined ? {} : { orphans: previous.orphans };
}

/**
 * The `orphans` set a post-rollback save should persist (issue #2934): what the
 * record already carried, plus what THIS rollback just left in AWS.
 *
 * A merge rather than a carry, because a rollback both inherits and produces.
 * Keyed by `logicalId`, newest wins: a resource orphaned twice (deploy fails,
 * user retries, it fails again) has one live AWS resource, and the later record
 * describes the deploy that actually left it there. Keeping both would make the
 * next adoption pick arbitrarily between two states of the same resource.
 *
 * Returns `{}` when there is nothing on either side, so a stack that has never
 * orphaned anything keeps a byte-identical `state.json` and an old binary sees
 * exactly what it saw before.
 */
export function orphansAfterRollback(
  previous: Pick<StackState, 'orphans'>,
  newlyOrphaned: readonly StackOrphanRecord[]
): Pick<StackState, 'orphans'> {
  if (previous.orphans === undefined && newlyOrphaned.length === 0) return {};
  const byLogicalId = new Map<string, StackOrphanRecord>();
  for (const entry of previous.orphans ?? []) byLogicalId.set(entry.logicalId, entry);
  for (const entry of newlyOrphaned) byLogicalId.set(entry.logicalId, entry);
  return { orphans: [...byLogicalId.values()] };
}

/**
 * Property-level change
 */
export interface PropertyChange {
  /** Property path (e.g., "Code.S3Key") */
  path: string;

  /** Old value */
  oldValue: unknown;

  /** New value */
  newValue: unknown;

  /** Whether this change requires replacement */
  requiresReplacement: boolean;

  /**
   * Set on synthetic changes created by replacement propagation (issue
   * #807): the property's template value did not change, but a resource it
   * references via Ref / Fn::GetAtt will be REPLACED, so the resolved
   * physical ID / ARN it points at will change at deploy time. `oldValue`
   * is the resolved current value (e.g. an old ARN) while `newValue` is the
   * still-unresolved intrinsic — the diff renderer annotates this so the
   * apparent string -> {Ref} delta reads as a propagated replacement rather
   * than a literal value edit.
   */
  replacementPropagated?: boolean;
}
