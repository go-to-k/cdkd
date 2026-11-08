import type { StateSchemaVersion } from '../state.js';
import type { ResourceState } from './resource-state.js';

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
  /**
   * The CloudFormation Output `Export.Name` that was imported.
   *
   * REDACTED at persist (issue
   * [#3289](https://github.com/go-to-k/cdkd/issues/3289)): this value is
   * TEMPLATE-derived, so an `Fn::Sub` assembling it around a resolved secret
   * used to persist that plaintext. It may therefore hold an unresolved
   * `{{resolve:...}}` expression, or `***` for the mask-only needle class.
   * `sourceStack` / `sourceRegion` above are NOT redacted — they come from the
   * producer's own record, not from this template.
   */
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
  /**
   * The producer stack whose Output `Name` was read.
   *
   * REDACTED at persist (issue
   * [#3289](https://github.com/go-to-k/cdkd/issues/3289)), and this field is
   * ALSO the literal key `findDownstreamConsumers` matches on — so a reader
   * comparing it must handle a value that cannot match any live stack name,
   * rather than silently failing to match. It reports such an entry instead.
   */
  sourceStack: string;
  /**
   * The producer's region. Required so the enumeration's
   * `(producerStack, producerRegion)` match key is stable across
   * cross-region `Fn::GetStackOutput` references.
   */
  sourceRegion: string;
  /**
   * The CloudFormation Output `Name` (template `Outputs.<Name>`) that was read.
   * REDACTED at persist, like `sourceStack` (issue
   * [#3289](https://github.com/go-to-k/cdkd/issues/3289)); `sourceRegion` above
   * is not, being gate-constrained before it can be recorded and read
   * structurally by `producerRegionsFromState`.
   */
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
   * — without `--strict-getatt`, the resolver threw or returned nothing at
   * all (under the flag either fails the deploy instead) — each mapped to a
   * digest of every template input that fed its resolution (issue
   * [#2740](https://github.com/go-to-k/cdkd/issues/2740)). Such a key is
   * absent from `outputs` when the save re-resolved the bag; the no-change
   * path keeps a failed key's STORED value (issue
   * [#2771](https://github.com/go-to-k/cdkd/issues/2771)), so a key that resolved
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

  /**
   * Resources a replacement superseded whose delete has not succeeded yet
   * (go-to-k/cdkd#5111): the old copy of a replaced resource, recorded the
   * moment its delete is deferred (an in-use target group a listener still
   * points at, say), in the same save that records the replacement. Without
   * it, a deploy killed before its end-of-deploy retry left the old resource
   * in AWS with no record at all.
   *
   * A deploy's cleanup retries each entry once the deploy's creates, updates
   * and deletes are done (a no-change deploy included) and drops it once
   * deleted; one still refused is kept, with a warning. `cdkd destroy`
   * deletes them after the stack's own resources, and keeps the state while
   * one fails. An entry whose physical id and type a record of `resources`
   * holds is not deleted -- a rollback took it back -- and is dropped.
   *
   * Each entry carries the superseded `ResourceState` verbatim, so it is
   * secret-bearing exactly as {@link orphans} is: `redactStateForPersist`
   * scrubs it the same way. Additive, so NO schema bump: an older binary
   * drops the field on its next save, which degrades to the pre-#5111
   * behaviour (the old resource left untracked). Carried by every writer
   * through {@link stackInstanceIdCarriedFrom}. Read through
   * `supersededResourcesOf` (`src/deployment/superseded-resources.ts`).
   */
  supersededResources?: SupersededResourceRecord[];

  /**
   * The verdict the last deploy computed for each condition `cdkd diff` reads
   * but cannot evaluate, because its closure reaches a parameter fed a secret
   * `{{resolve:...}}` reference (go-to-k/cdkd#4479). Keyed by condition name.
   *
   * Each entry carries a FINGERPRINT of the condition's definitions (its own
   * and every `{Condition: X}` it reaches) and of the parameter inputs they
   * read, a secret-fed one as its expression. The diff reuses a verdict only
   * when the fingerprint it recomputes is equal; otherwise an `Fn::If` on the
   * condition takes its FALSE branch, as before. Writer, reader and the
   * fingerprint's exact input: `src/deployment/condition-verdicts.ts`.
   *
   * Additive, so NO schema bump (the `skippedOutputs` / `orphans` precedent):
   * an older binary ignores it, and its fresh-built deploy saves drop it,
   * which only returns the diff to the FALSE branch. A writer that carries the
   * loaded record forward (rollback, drift, scrub, orphan rewrite) may carry
   * it too: none of them changes a definition or an input the fingerprint
   * covers. Read through `readRecordedConditionVerdicts`, which tolerates any
   * malformed shape.
   *
   * Written only by a deploy's FINAL save and its no-change save. Its
   * per-resource, rollback and output-failure saves rebuild state without it,
   * so a failed or interrupted deploy leaves NO record: the next diff falls
   * back to the FALSE branch, never to a stale verdict.
   */
  conditionVerdicts?: Record<string, RecordedConditionVerdict>;

  /**
   * v12+ (go-to-k/cdkd#4847 / go-to-k/cdkd#4852): per `outputs` bag key (an
   * output's name, or its `Export.Name` alias), the provenance of each
   * `{{resolve:...}}` token that key's value holds. Keyed by OUTPUT first, so
   * two outputs holding one token at two generations (one read through a
   * resource, one spelled literally) keep apart.
   *
   * Written by a save whose `outputs` bag this deploy resolved; a save that
   * CARRIES the previous bag carries this field with it; a merged bag (a
   * failed output on the no-change path) writes none. ABSENT means "not
   * known", the reading of every pre-v12 record. Omitted when no key holds a
   * token. Read through `outputReferenceProvenanceOf`, which validates each
   * entry.
   */
  outputReferenceProvenance?: Record<string, Record<string, ReferenceProvenance>>;

  /**
   * State schema v13 (go-to-k/cdkd#5064): the id of this LIFETIME of the
   * stack, a `crypto.randomUUID()` minted at the stack's first state write and
   * kept until its record is deleted. ABSENT = a legacy stack (every record
   * written before v13), which stays legacy: nothing mints one for a stack that
   * already has a record. Read through `stackInstanceIdOf`
   * (`src/state/stack-instance-id.ts`); carried by every field-enumerating
   * writer through {@link stackInstanceIdCarriedFrom}. Never logged.
   */
  stackInstanceId?: string;

  /**
   * State schema v13 (go-to-k/cdkd#5064): per logical id whose record LEFT
   * this stack (a deploy's delete, `Retain` included, or `cdkd orphan`), the
   * highest name generation that record reached (`max(nameGeneration,
   * nameGenerationHigh)`). A later CREATE of the same logical id takes the
   * next generation, so a re-added resource never asks for a name an earlier
   * copy held -- CloudFormation's random suffix gives the same guarantee.
   * Written only on a stack with a `stackInstanceId`; carried with it through
   * {@link stackInstanceIdCarriedFrom}. Read through
   * `retiredNameGenerationsOf` (`src/state/name-generation.ts`).
   */
  retiredNameGenerations?: Record<string, number>;

  /**
   * Resources an interrupted or in-progress `cdkd refactor` is moving OUT of
   * this stack (go-to-k/cdkd#5212). Written to the SOURCE record first, with
   * the moving record still in `resources`; the destination then adds the
   * record, and a last source save drops both the record and its entry. While
   * an entry is present, `cdkd deploy` and `cdkd destroy` of this stack refuse
   * (the record may also be in the destination, whose resource this stack's
   * deploy would delete), and the next `cdkd refactor` of this stack finishes
   * the move. Ids only, never a value.
   *
   * Additive, NO schema bump (the `orphans` precedent): an older binary drops
   * the field on its next save and does not refuse, a stated consequence.
   * Carried by every writer through {@link stackInstanceIdCarriedFrom}. Read
   * through `pendingMovesOutOf` (`src/state/pending-moves.ts`).
   */
  pendingMovesOut?: PendingMoveOut[];

  /**
   * The stack was last deployed with `terminationProtection: true`
   * (go-to-k/cdkd#5238). Each deploy writes it from the synthesized stack
   * (present only when true), so it is what the DEPLOYED stack says, as in
   * CloudFormation; `cdkd destroy` and `cdkd state destroy` refuse while it
   * is set unless `--remove-protection` is given. `cdkd state destroy` has no
   * CDK app, so this is the only place it can learn the setting.
   *
   * Additive, NO schema bump (the `orphans` precedent): an older binary drops
   * the field on its next save and does not refuse, a stated consequence.
   * Carried by every non-deploy writer through {@link stackInstanceIdCarriedFrom}.
   */
  terminationProtection?: true;

  /** Last modification timestamp (Unix milliseconds) */
  lastModified: number;
}

/**
 * What a deploy learned about one `{{resolve:...}}` token a record holds
 * (state schema v12, go-to-k/cdkd#4847 / go-to-k/cdkd#4852). Metadata only:
 * a region and the secret's own version ids, which AWS returns without the
 * value. Never a value, never a hash of one.
 *
 * Every member is optional, and ABSENT means "not known": a reader then takes
 * the v11 path for that arm. Validated on read (`reference-provenance-record.ts`):
 * a `region` that is not a canonical client-safe region reads as absent; a
 * version that fails its service's shape drops `versions` AND `readVersions`
 * (the region is kept); `readVersions` not a subset of `versions` makes the
 * whole entry read as absent.
 */
export interface ReferenceProvenance {
  /** The region whose resolution produced the value. Absent = a conflict, or not known. */
  region?: string;
  /**
   * The version ids the record's value was resolved at, over every route:
   * a Secrets Manager `VersionId`, or an SSM parameter `Version`. Sorted,
   * deduplicated, at most 8.
   */
  versions?: string[];
  /**
   * The subset of `versions` that reached the record through a READ: a
   * `Fn::GetAtt` / `Ref` of a recorded value, a cross-stack read, a nested
   * stack parameter. Persisted because a later deploy's diff compares it with
   * what the upstream holds; a literal spelling's version never enters it.
   */
  readVersions?: string[];
}

/** One entry of {@link StackState.pendingMovesOut} (go-to-k/cdkd#5212). */
export interface PendingMoveOut {
  /** The record's logical id in THIS stack. */
  from: string;
  /** The destination stack's name. */
  toStack: string;
  /** The destination stack's region. */
  toRegion: string;
  /** The record's logical id in the destination. */
  to: string;
  /** When the move started (Unix milliseconds). */
  startedAt: number;
}

/** One entry of {@link StackState.conditionVerdicts} (go-to-k/cdkd#4479). */
export interface RecordedConditionVerdict {
  /** The verdict the deploy computed against the real parameter values. */
  verdict: boolean;
  /** `sha256:<hex>` over the condition's definitions and parameter inputs. */
  fingerprint: string;
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
 * One resource a replacement superseded and has not deleted yet
 * (go-to-k/cdkd#5111). See {@link StackState.supersededResources}.
 */
export interface SupersededResourceRecord {
  /** The logical id whose replacement superseded it. */
  logicalId: string;

  /** When its delete was deferred (Unix milliseconds). */
  supersededAt: number;

  /** The superseded record, verbatim as state held it before the replacement. */
  state: ResourceState;

  /** The `UpdateReplacePolicy` the replacement's delete ran under. */
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate';

  /** The final snapshot the replacement's delete was to take (`Snapshot`). */
  finalSnapshotIdentifier?: string;

  /** The replacement ran under `--force-stateful-recreation`. */
  forceDataDelete?: true;

  /**
   * The replacement ran under `--skip-final-snapshot`. Only this consent
   * counts: a later run's flag never skips a snapshot this one promised.
   */
  skipFinalSnapshot?: true;
}
