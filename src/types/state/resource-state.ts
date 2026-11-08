import type { ReferenceProvenance } from './stack-state.js';

/**
 * Individual resource state
 */
export interface ResourceState {
  /** Physical resource ID (ARN, name, etc.) */
  physicalId: string;

  /**
   * State schema v13 (go-to-k/cdkd#5064): the GENERATION of the name cdkd
   * generated for this resource on a stack with a `stackInstanceId`. ABSENT =
   * 0, the generation every first create takes. A replacement creates the new
   * resource under the next generation (a new name, so it is created before
   * the old one is deleted, as CloudFormation does); a CREATE of a logical id
   * whose earlier record left the stack takes the generation after
   * `StackState.retiredNameGenerations`. Never written on a legacy stack.
   * Read through `nameGenerationOf` (`src/state/name-generation.ts`).
   */
  nameGeneration?: number;

  /**
   * State schema v13 (go-to-k/cdkd#5064): the highest generation a
   * replacement of this resource ever CREATED, when it exceeds
   * `nameGeneration` -- a rollback put the older resource back. The next
   * replacement goes past it, so a name a rolled-back copy held is never asked
   * for again. ABSENT = `nameGeneration`.
   */
  nameGenerationHigh?: number;

  /**
   * State schema v14 (go-to-k/cdkd#5380): top-level property NAMES (never
   * values) whose change a failed `update()` had started with an irreversible
   * call, so AWS may hold either the recorded value or the attempted one.
   * `properties` keeps the recorded value; the next deploy treats each name as
   * changed and the provider converges it against AWS. ABSENT = nothing
   * unsettled. Cleared by a successful update, `cdkd rollback --revert-failed`
   * and `cdkd drift --accept` / `--revert`. Read through
   * `unsettledPropertiesOf` (`src/state/unsettled-properties.ts`).
   */
  unsettledProperties?: string[];

  /**
   * State schema v15 (go-to-k/cdkd#5498): per member path of an unsettled
   * collection (`GlobalSecondaryIndexes`, `Tags`, `DesiredShardLevelMetrics`,
   * `Replicas[eu-west-1].GlobalSecondaryIndexes` — closed-vocabulary segments
   * only), the identity names a failed update's call was ACCEPTED for adding.
   * Names only, redacted like `properties`; a name holding `{{resolve:` or
   * `***` never matches a live item. Written only by the deploy's failure
   * save; stripped with `unsettledProperties`. Read through `unsettledItemsOf`
   * (`src/state/unsettled-properties.ts`).
   */
  unsettledItems?: Record<string, string[]>;

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
   * The template resource's `aws:cdk:path` at its last deploy, stamped on every
   * deploy save. Shown for a resource the template no longer declares, which a
   * developer knows by construct path rather than logical ID. Informational: no
   * behavior reads it, so an older binary dropping it changes nothing (no
   * schema bump).
   */
  constructPath?: string;

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
   *   property the SDK Provider does not wire. CC API forwards
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
   *    physicalId parity, or a declared normalizer of the Cloud Control id),
   *    AND neither the desired nor the recorded property bag of THIS resource
   *    has an actionable SDK-unwired property. The next mutating deploy writes `'sdk'`
   *    with the physical id unchanged, or in the SDK form a normalizer gives
   *    (`AWS::ECS::Service`, go-to-k/cdkd#5654). `--pin-cc-api`
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
   * apart. `DeployEngine.observedCapture.kickOffAutoRefreshObservedProperties` selects exactly
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
   * ONE CLASS IS EXCLUDED from the UPDATE half of that, because a deploy holds
   * no more evidence for it than the import did — see
   * `observedBaselineRefusalReason` below.
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
   * rebuilt — and DROPS any `observedProperties` it carried, since a baseline
   * captured against distrusted `properties` is no evidence either (issue
   * [#2872](https://github.com/go-to-k/cdkd/issues/2872)).
   *
   * `undefined` — the only other value, and the one every pre-v10 record
   * carries — means "not refused", which is the behaviour both writers had
   * before this field existed. Only `true` is ever written; there is no
   * `false`, so a reader tests presence.
   */
  observedBaselineRefused?: true | undefined;

  /**
   * WHY the baseline was refused (issues
   * [#3462](https://github.com/go-to-k/cdkd/issues/3462),
   * [#3468](https://github.com/go-to-k/cdkd/issues/3468)). Optional, no schema
   * bump. Every writer in this binary records one beside the marker; a record
   * that only PRESERVES a marker (a spread, a selective merge) keeps whatever
   * it had.
   *
   * ABSENT (or any value this binary does not know, read the same way) — a
   * marker written by a cdkd that predates the reasons, whose cause is
   * unknown: 0.290.35 wrote unverifiable-parameter refusals without a reason.
   * It is therefore read FAIL CLOSED: when the resource's definition in the
   * template at hand names a declared template parameter
   * (`resourcesNamingDeclaredParameter`, which also answers "yes" for a
   * template it cannot read, and for a bag it cannot classify once anything in
   * the template names a declared parameter), `cdkd deploy` stamps it
   * `'unverifiable-parameter'` at deploy start and `cdkd import` carries it as
   * one; otherwise an UPDATE clears it, as before. The accepted cost is that an
   * old refusal of the other class on such a resource becomes sticky too. Known
   * residual: a template edited to replace the parameter reference with its
   * literal (or any expression naming no parameter) before the first deploy or
   * re-import by a fixed binary that saves state shows no dependence, and the
   * marker clears.
   *
   * `'incomplete-resolution'` — one of `cdkd import`'s other three arms fired
   * and ARM 4 did not: the import-time resolve of the record's properties
   * threw, lost a `{{resolve:` opener, or discarded a non-inert subtree. The
   * name states what the three share — the resolve did not yield a complete
   * bag whose leaves can position a redaction — and nothing about parameters.
   * A deploy that CREATEs or UPDATEs the resource clears it (the marker's own
   * doc above). It exists so that a marker of this class is never mistaken for
   * an ABSENT-reason one; the one reader that branches on it is
   * `state refresh-observed --accept-refused`, which refuses this class. A binary that
   * predates it sees "not `'unverifiable-parameter'`" and clears on UPDATE,
   * which is the same behaviour.
   *
   * `'unverifiable-parameter'` — `cdkd import`'s ARM 4 (issue #2854) named this
   * resource: its properties depend on a template parameter whose DEPLOYED
   * value was not provably the `Default` the import bound. `cdkd deploy` takes
   * no parameter input either, so a top-level deploy binds the SAME `Default`
   * (a nested child gets its values from the parent; the rule is applied there
   * too, conservatively); the "a deploy
   * holds the template evidence the import lacked" premise above is false for
   * this class. An in-place UPDATE that does not rewrite the placeholder-bound
   * leaf leaves the deployed value in AWS, and a readback positioned against
   * the placeholder would persist it. So:
   *
   * - an IN-PLACE UPDATE KEEPS the marker and this reason, and takes NO
   *   readback for the resource, whatever the update changed — the engine
   *   cannot know which leaves a provider actually wrote;
   * - a REPLACEMENT or CREATE clears both: a new physical resource was built
   *   from the bag cdkd sent, so its readback holds nothing cdkd did not send.
   *   Inside `update()` that needs `wasReplaced` AND a changed physical id —
   *   either signal alone keeps the refusal;
   * - `cdkd import` clears both only for a row it re-imported while it HAD a
   *   deployed-parameter source and ARM 4 did not name the resource. A
   *   re-import with no source (the CloudFormation stack is gone after a
   *   migration) carries both forward when the physical id is unchanged;
   * - `cdkd state refresh-observed --accept-refused` (issue #3466) clears both
   *   for ONE resource on the user's assertion, judged fail closed against the
   *   `--template` they deployed (`src/cli/commands/state-refresh-observed.ts`),
   *   and only after its readback succeeded. An absent reason is accepted there
   *   as this class.
   *
   * INVARIANT: never present without `observedBaselineRefused: true`. Every
   * reader that only asks "is a baseline refused?" keeps testing the marker;
   * the two commands that stamp or clear it on evidence (`cdkd deploy`,
   * `cdkd import`) read this field through the two helpers below;
   * `--accept-refused` (above) clears it on the user's assertion; the other
   * template-less commands read it only to word the remedy
   * (`refusedBaselineRemedy`, issue #3465).
   */
  observedBaselineRefusalReason?: 'unverifiable-parameter' | 'incomplete-resolution' | undefined;

  /**
   * v11+ (go-to-k/cdkd#4043): the coordinates, within `properties`, persisted
   * as `***` because a `NoEcho: true` template PARAMETER served them, or an
   * `Fn::GetAtt` of an attribute its producer declared `NoEcho`. Each entry is
   * a SEGMENT ARRAY (keys and array indexes), never a dotted string, since a
   * dotted key is legal in a property bag. `observedProperties` holds the mask
   * at the same coordinates, found through an array's identity field.
   *
   * The entries name POSITIONS, never values or parameter names: nothing in
   * the field is derived from the value.
   *
   * ABSENT means "not known", which is every record a pre-v11 binary wrote:
   * a reader then treats a `***` as before (the custom-resource class), and a
   * deploy reads a non-mask leaf at a position the template names as the
   * MIGRATION WITNESS, the exact value last sent. Every writer that rebuilds
   * `properties` from a template recomputes it (and omits the field when the
   * record has none); every writer that carries a record forward keeps it.
   * Read through `noEchoLeavesOf` (malformed reads as absent).
   */
  noEchoLeaves?: (string | number)[][] | undefined;

  /**
   * No bump (go-to-k/cdkd#4656): the `noEchoLeaves` coordinates a `NoEcho`
   * PARAMETER serves at which this resource's provider has been seen to ECHO
   * the value exactly. It is derived from the provider's echo behaviour, never
   * from the value: an entry says only that a readback handed the record with
   * `***` at that coordinate returned, there, a string strictly equal to what
   * was sent. Only a whole scalar string leaf under a create-only property,
   * reached by object keys alone, is eligible.
   *
   * Set by the readback at the deploy that creates (or replaces) the
   * resource, at the deploy that migrates a pre-v11 record, and by any later
   * readback that holds the value. A readback that differs never changes it;
   * one that fails or cannot report the property leaves it absent. A save
   * that writes `noEchoLeaves` keeps only entries still in it.
   *
   * Read by the UPDATE arm: a create-only coordinate named here whose
   * readback differs is a proven change and replaces the resource. ABSENT
   * (or an entry missing) keeps the never-replace rule of #4043 Phase B.
   * Read through `noEchoExactEchoLeavesOf` (malformed reads as absent).
   */
  noEchoExactEchoLeaves?: string[][] | undefined;

  /**
   * No bump (go-to-k/cdkd#3869): on an `AWS::CloudFormation::Stack` row, the
   * keys of `attributes` (`Outputs.<Key>`) whose value holds the name of a
   * child resource NAMED from a secret, judged from the child's state records
   * when the row was last provisioned. KEYS only, never a value. Read by the
   * derived-name judge (`secretNameNeedlesOf`): every string leaf of each named
   * attribute is a LOG-ONLY needle, so a parent reader of that output masks
   * what it prints, on a deploy where the row is `NO_CHANGE` too. Print-only:
   * nothing persisted, compared or sent reads it.
   *
   * Rewritten by every create or update of the row (absent when none holds
   * such a name); a carried record keeps it. ABSENT means "not known" (an
   * older cdkd's record, or a row not provisioned since): the reader then
   * masks as before. An older binary ignores the field, losing only the mask.
   */
  secretNamedAttributes?: string[] | undefined;

  /**
   * v11+ (go-to-k/cdkd#2449): the keys of this record's OWN `attributes` that
   * its provider DECLARED `NoEcho` (a custom resource answering `NoEcho: true`
   * declares every attribute it returned; a nested stack names the outputs it
   * recovered from a masked child output), plus each attribute that echoed a
   * `NoEcho` value of this resource. Each is persisted as `***` whatever its
   * type or length.
   *
   * Sourced from the DECLARATION, never from "which attributes hold `***`":
   * a 1-3 character or `Number` value has no needle, and a record naming only
   * masked keys would leave it in the clear for the next dependent. A write
   * that registers no declaration (an update whose provider returned none, a
   * carried record) keeps every earlier name whose attribute still holds the
   * mask. ABSENT means "not known" (pre-v11): a `***` attribute is then read
   * as today, fail closed.
   *
   * A dependent that reads a declared attribute out of a previous run's
   * record is still REFUSED with the remedy (the maintainer's decision on
   * #2449): this field only makes the refusal name the attribute exactly.
   * cdkd never forces the producer to run again.
   */
  noEchoAttributeNames?: string[] | undefined;

  /**
   * v12+ (go-to-k/cdkd#4847 / go-to-k/cdkd#4852): for each whole
   * `{{resolve:...}}` token this record holds in `properties`, `attributes` or
   * `observedProperties`, the region that resolved it and the version ids it
   * was resolved at ({@link ReferenceProvenance}).
   *
   * The FIELD is the discriminator, not `version`: absent means "not known"
   * (every pre-v12 record, and a record that holds no token), `{}` means
   * known with nothing attributed. A record a deploy WROTE takes this run's
   * entries for the tokens it holds; a record it did NOT write keeps its
   * field verbatim (a stale key is bounded dead weight until the next write);
   * an unchanged pre-v12 record that holds a token gains it once, from the
   * migration capture, which sends nothing. A token under a create-only path
   * of a record UPDATED IN PLACE keeps every generation AWS may still hold
   * (previous versions unioned with this run's, at most 8). Spreading writers
   * carry it. Read through `referenceProvenanceOf` / `recordedProvenanceOf`.
   */
  referenceProvenance?: Record<string, ReferenceProvenance> | undefined;

  /**
   * The CREATE-ONLY SDK-unwired properties in `properties` that the SDK route was told to
   * drop (`--prefer-sdk-route`) when this record was written, and so never sent
   * to AWS (issue [#2790](https://github.com/go-to-k/cdkd/issues/2790)).
   * Optional, no schema bump.
   *
   * It is EVIDENCE, and only evidence licenses the #2790 rule: a deploy that no
   * longer accepts the drop reads such a key as an addition, which is a
   * replacement it refuses unless opted into. Without it the key is presumed
   * to be in AWS — a `cdkd import` record holds the template's full bag with
   * `provisionedBy: 'sdk'`, a pre-v7 record may have been created by Cloud
   * Control, and an older binary wrote no marker — so ABSENT (or malformed,
   * read through `acceptedCreateOnlyDropsOf`) keeps the pre-#2790
   * behaviour.
   *
   * Writers: an SDK-route CREATE or REPLACEMENT records every create-only drop
   * it kept; an SDK-route IN-PLACE update carries the previous record's
   * entries that are still in `properties` (an in-place update cannot set a
   * create-only key, so it adds no evidence); a Cloud Control write clears it,
   * since Cloud Control sends the full bag. A writer that spreads an existing
   * record (an attribute-only refresh, a heal, `cdkd drift`, orphan adoption)
   * carries it. Entries are property NAMES from the schema snapshot, never
   * values.
   */
  acceptedCreateOnlyDrops?: string[] | undefined;

  /**
   * Per top-level property `properties` holds as the secret mask `***`,
   * `sha256:<hex>` over the template value's TEXT it was written from
   * (go-to-k/cdkd#4451). Optional, no schema bump. Its sibling
   * {@link maskedPropertyInputFingerprints} covers the resolved inputs.
   *
   * The mask identifies nothing, so without it an edit around a secret
   * reference inside one `Fn::Base64` (EC2 `UserData`) compared `***` with
   * `***` and was never sent. The diff and the deploy's no-change skip treat
   * a property whose fingerprint moved as changed; a rotated secret behind an
   * unchanged template leaves it equal. Only template text is hashed, and a
   * property whose template text holds, as a literal, a `NoEcho` parameter
   * value or a value the same resource resolved as a secret gets
   * `REFUSED_FINGERPRINT` instead of a hash, so the field is no oracle for
   * the secret.
   *
   * ABSENT (or malformed, or refused, read through
   * `maskedPropertyFingerprintsOf`) keeps the pre-#4451 comparison, and a
   * deploy backfills each masked property with no entry from the template it
   * deploys. Writers: the save rebuilds it for a record this deploy wrote
   * through `propertiesToRecord`; every writer that spreads a record carries
   * it. Helpers: `src/deployment/masked-property-fingerprints.ts`.
   */
  maskedPropertyFingerprints?: Record<string, string> | undefined;

  /**
   * Per masked property, `inputs-sha256:<hex>+sha256:<hex>`: a hash of the
   * template value with its NON-SECRET inputs resolved (a parameter value, a
   * `Ref` / `Fn::GetAtt` result, an evaluated condition's branch,
   * go-to-k/cdkd#4543), then the text fingerprint it is BOUND to. Optional, no
   * schema bump. A separate field so an older cdkd, which reads only
   * {@link maskedPropertyFingerprints}, still compares the text and still
   * sends a template edit.
   *
   * Moved means changed, so a new parameter value, a replaced resource's
   * `Ref` or a flipped condition behind unchanged text is sent. A `NoEcho`
   * parameter, a `{{resolve:...}}` reference and anything derived from one
   * stay in template form, so no secret-derived value is hashed. A
   * non-`NoEcho` parameter value and a cross-stack output value are treated
   * as public and may be recoverable from the hash when low in entropy:
   * declare a sensitive one `NoEcho`.
   *
   * An entry whose text half differs from the text fingerprint (absent, or an
   * older cdkd rewrote the text field and carried this one) reads as absent,
   * and the deploy's diff re-baselines it from today's inputs without sending.
   * Read through `maskedPropertyInputFingerprintsOf`.
   */
  maskedPropertyInputFingerprints?: Record<string, string> | undefined;
}

/**
 * Whether `record` carries a baseline refusal no in-place UPDATE may clear.
 * Requires the marker AND the reason: a reason with no marker is not a state
 * any writer produces, and honouring it would invent a refusal.
 */
export function hasUnverifiableParameterRefusal(
  record:
    | Pick<ResourceState, 'observedBaselineRefused' | 'observedBaselineRefusalReason'>
    | undefined
): boolean {
  return (
    record?.observedBaselineRefused === true &&
    record.observedBaselineRefusalReason === 'unverifiable-parameter'
  );
}

/**
 * Whether `record` carries a marker with NO reason this binary knows — written
 * by an older cdkd, cause unknown. The one caller-side question is whether to read it
 * fail closed; see `observedBaselineRefusalReason`'s doc.
 */
export function hasReasonlessBaselineRefusal(
  record:
    | Pick<ResourceState, 'observedBaselineRefused' | 'observedBaselineRefusalReason'>
    | undefined
): boolean {
  // Anything but the two values this binary knows — absent, `null`, a value a
  // later binary invented — is a cause this binary cannot name: fail closed.
  const reason: unknown = record?.observedBaselineRefusalReason;
  return (
    record?.observedBaselineRefused === true &&
    reason !== 'unverifiable-parameter' &&
    reason !== 'incomplete-resolution'
  );
}
