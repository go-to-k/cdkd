// Type-only, and safe against a cycle: `secret-redaction.ts` is a LEAF (it
// imports nothing), which its own module doc states as a deliberate property
// because both the resolver and the deploy engine sit on a dense import ring.
// Placed here rather than at the top of the file to match how `DeleteContext`
// is imported below — next to what uses it.
import type { SecretMasker } from '../../deployment/secret-redaction.js';
// Re-exported for the same reason `DeleteContext` is re-exported below: a
// provider implementing this interface should only ever import from
// `src/types/resource.ts`. A provider that needs to NAME the masker type (to
// take it as a helper parameter, say) must use THIS alias rather than
// re-declaring `(text: string) => string` structurally — a re-declaration
// compiles identically today and is free to drift from the contract tomorrow.
export type { SecretMasker } from '../../deployment/secret-redaction.js';

/**
 * The masked-warning capability a caller may hand a provider (issue #1932
 * item 3), shared by {@link CreateContext}, {@link UpdateContext} and, since
 * issue [#2007](https://github.com/go-to-k/cdkd/issues/2007), `DeleteContext`.
 *
 * **Declared ONCE and inherited by all three on purpose.** The gap this closes
 * is a provider echoing a RESOLVED value into its own log line, and a masker
 * present on one path and absent on another is not a partial fix, it is a fix
 * with a hole in the shape of whichever path the template happens to take.
 * Putting the field on a shared base makes the twin structural rather than a
 * convention doc comments have to keep agreeing about.
 *
 * **A delete bag CAN carry plaintext.** A CREATE writes the RESOLVED bag into
 * the in-memory `stateResources` map, and redaction happens only at the SAVE
 * choke point (`redactStateForPersist` builds a NEW record), so the map an
 * in-process rollback replays holds plaintext, and its delete arms hand it to
 * `delete()`. A physical id can also BE a secret-derived name on every path.
 * So the deploy engine's replacement deletes pass a masker over the bag the
 * deploy resolved for that resource, and the rollback replay's pass one over the op's
 * own re-resolution AND the failed deploy's bag (`RollbackExecutorContext
 * .logOnlyNeedlesFor`): the plaintext a rollback deletes was resolved by the
 * DEPLOY, while the op's re-resolution is of the PREVIOUS generation, and a
 * masker over only one of them misses a rotated secret. `cdkd destroy` and a
 * deploy's delete of a resource the template dropped resolve nothing for it,
 * but its persisted record can still be NAMED from a secret: they pass a
 * masker over the printing bag the delete runs under (the record's
 * secret-derived name spellings, go-to-k/cdkd#3869). Every cdkd delete site
 * passes one; absent means a direct caller.
 */
export interface SecretMaskingContext {
  /**
   * Mask any secret THIS deploy resolved out of `text`, for a message the
   * provider is about to log.
   *
   * **When a provider must use it.** Whenever a log / warn / info line
   * interpolates a value that came out of the `properties` bag. Those values
   * arrive RESOLVED — a `{{resolve:secretsmanager:...}}` scalar is already
   * plaintext by the time a provider sees it — and cdkd's masking otherwise
   * lives only at the deploy engine's error/reason text and the resolver's own
   * debug line, so a provider's own line is outside all of it. The unhappy
   * path is usually the one that prints, because a warning about a mis-shaped
   * value exists precisely to name that value.
   *
   * **Absent means unmasked, and that is the back-compatible default.** A
   * provider that never reads this behaves exactly as before, which is what
   * lets the field ship without editing the ~130 registered providers. Read it
   * defensively — `const mask = context?.maskSecrets ?? ((t: string) => t)` —
   * rather than making it required: `create()` / `update()` are also called by
   * `cdkd drift --revert`, by the import path, and by tests, and a provider
   * must not care which caller it got.
   *
   * **Mask the VALUE when you have it in hand; mask the finished message only
   * as a fallback. These are NOT equivalent.** `maskSecretsInText` has two
   * arms, and which one a call can reach depends on what you hand it:
   *
   * - Given a string that IS a recorded secret exactly, it takes the
   *   WHOLE-VALUE arm and masks it at ANY length.
   * - Given a longer string that merely CONTAINS one, it takes the substring
   *   arm, which only considers needles of at least `MIN_NEEDLE_LENGTH` (4)
   *   characters — short needles are excluded deliberately, because a 1-3
   *   character plaintext would match incidental text everywhere.
   *
   * A finished message is always longer than the value inside it, so masking
   * the message can only ever reach the SUBSTRING arm: a 1-3 character secret
   * (a short token, a PIN, a single-character flag value someone put in
   * Secrets Manager) survives it, while masking the raw value would have
   * caught it. An earlier version of this paragraph said "applying it to the
   * whole line is never worse than applying it to the parts" — that is exactly
   * backwards below the floor, and it is this paragraph that every future
   * provider copies.
   *
   * Doing BOTH is the belt-and-braces shape and is what the reference
   * implementation uses: mask each string leaf before interpolating it (so
   * short secrets are caught), and route the assembled message through the
   * masker too (so a value embedded in a structure, or an interpolation added
   * later, is still caught at the substring arm). The mask is idempotent and
   * matches by value rather than position, so the two layers compose.
   *
   * **It is per-CALL. Never cache it on `this`.** Providers are registered as
   * singletons and serve concurrent resources, so a masker stashed on the
   * instance would be the wrong deploy's within one stack.
   *
   * **Scope.** It covers cdkd's dynamic-reference secret model only
   * (`{{resolve:secretsmanager:...}}`, `SecureString` ssm). A `NoEcho: true`
   * template parameter is outside that model and is NOT masked by this — see
   * `SecretMasker` in `src/deployment/secret-redaction.ts` for why, and why
   * fixing that is a change to the caller rather than to any provider.
   */
  maskSecrets?: SecretMasker;
}

/**
 * Where the DESIRED bag handed to `update()` came from (issue #1732).
 *
 * The `update()` sibling of {@link CreateContext}, and it exists for the same
 * structural reason: a provider cannot otherwise tell WHO constructed the
 * properties it is being asked to apply, and for some shapes the answer
 * inverts the correct behavior. Optional, so none of the 77 providers that
 * implement `update()` need to change; only a provider with such a shape reads
 * it.
 *
 * **The motivating case.** `S3BucketProvider` receives a desired
 * `OwnershipControls: { Rules: [] }` from two callers that mean OPPOSITE things
 * by it. From a template it is a condition-pruned / intrinsic-collapsed array —
 * CloudFormation rejects that template outright and leaves the live
 * configuration alone (measured, issue #1713) — so the provider must SKIP.
 * From `cdkd drift --revert` it is the baseline `readCurrentState` emits for an
 * UNSET feature, so it means "restore the state where this was unset" and the
 * provider must DELETE. Byte-identical bags, opposite arms.
 *
 * **Read the flag as narrowly as it is named.** It says the desired bag is an
 * AWS READBACK, not merely that it is "state-borne". The rollback executor's
 * revert arms are state-borne too, but their desired bag is
 * `previousState.properties` — a TEMPLATE recorded earlier — so a `{Rules: []}`
 * there means what the template meant and the template answer (SKIP) is the
 * right one. Those arms therefore never set THIS FLAG. (They do pass a
 * context — since issue #1932 all three EXTERNAL callers (`deploy-engine.ts`,
 * `rollback-executor.ts` and `drift --revert`) pass one carrying the inherited
 * `maskSecrets` capability — so read the invariant as "the flag is unset",
 * not as "the context is absent", which is how this paragraph used to read.
 * The five providers that re-create inside their own `update()` pass either
 * nothing or a context carrying ONLY the masker (IAM role / IAM managed policy /
 * Lambda permission, issue #2177), so "every provider call" would be too strong.)
 * Widening this to `stateBorne` would silently sweep them in and delete a
 * configuration on a rollback. Since issue
 * [#3141](https://github.com/go-to-k/cdkd/issues/3141) those arms DO announce
 * themselves — through the SEPARATE {@link UpdateContext.replayingState} field,
 * which says "this bag is a state record" and licenses only the
 * refuse-on-template / replay-what-the-record-certifies asymmetry, never the
 * readback reading this paragraph is about.
 *
 * **One bounded caveat on "a TEMPLATE recorded earlier"** (found in review):
 * `cdkd drift --accept` writes the AWS readback into `properties` for a
 * resource that has no `observedProperties` baseline (`drift.ts`), so a later
 * rollback revert of that resource DOES hand `update()` a readback-derived bag
 * with no flag, and the provider takes the SKIP arm. The direction is the safe
 * one — the live configuration is left alone, nothing is destroyed — and it
 * predates this type, but the sentence above is a strong generalization rather
 * than an invariant, so do not build a data-destroying decision on it.
 */
export interface UpdateContext extends SecretMaskingContext {
  /**
   * `true` when the desired properties are an AWS-current snapshot produced by
   * `readCurrentState` rather than by a template or a state record — today
   * that is `cdkd drift --revert` alone (`src/cli/commands/drift.ts`).
   *
   * **What a provider MAY conclude from it.** That every value in the desired
   * bag describes what AWS held at capture time, so a shape that a provider
   * would otherwise treat as unusable-or-collapsed is instead an accurate
   * report of the resource's state — including "this feature was not set",
   * which several `readCurrentState` implementations spell as an EMPTY
   * collection rather than an absent key. Reverting to that baseline therefore
   * legitimately means REMOVING the live configuration.
   *
   * Also that the call restores the RECORDED resource, never renames it: a
   * provider deriving a physical name from the bag keeps the physical id
   * instead of replacing on a mismatch (issue #4023). The name is derived
   * outside the deploy's stack-name / prefix scope, and a bag with no observed
   * baseline carries the template's name.
   *
   * **What it does NOT license.** It says nothing about whether the user has a
   * remedy (they do — the baseline is cdkd's own record, editable via
   * `cdkd drift --accept`), so it is not a reason to relax a data-safety guard
   * or a validation that protects the AWS call itself.
   */
  desiredFromAwsReadback?: boolean;

  /**
   * With {@link desiredFromAwsReadback}: the top-level properties the state
   * record's TEMPLATE side declares EMPTY (`''`, `[]`, `{}`, or a JSON string
   * of one), set by `cdkd drift --revert` only. A readback baseline cannot say
   * whether an empty collection was read or stands in for a read that failed
   * at capture; the template can (go-to-k/cdkd#4884: an SSM parameter's
   * `Policies` placeholder). Names only: no recorded value reaches the
   * provider. Absent on every other caller.
   */
  declaredEmptyProperties?: ReadonlySet<string> | undefined;

  /**
   * With {@link desiredFromAwsReadback}: the top-level properties the state
   * record's TEMPLATE side declares as the boolean `true` (`true` or the
   * string `'true'`), set by `cdkd drift --revert` only. A readback baseline
   * records a flag as AWS held it at capture, which can be `true` for a
   * feature turned on outside the template; the template says whether it
   * asked for it (go-to-k/cdkd#5707: a DBCluster's Data API, which a revert
   * turns back on only when the template declares `EnableHttpEndpoint: true`).
   * Names only, like {@link declaredEmptyProperties}: no recorded value
   * reaches the provider. Absent on every other caller.
   *
   * "Template side" is the record's `properties`. On a record with no
   * `observedProperties`, `cdkd drift --accept` writes an accepted readback
   * value there, so a flag the user accepted counts as declared; and the
   * revert's desired bag is that same `properties`, so the set adds a
   * constraint only on a record that has an observed baseline.
   */
  declaredTrueProperties?: ReadonlySet<string> | undefined;

  /**
   * `true` when the desired properties handed to `update()` come from a cdkd
   * STATE record rather than from the synthesized template — today that is the
   * rollback executor's two REVERT arms (`revert` and `revert-failed-update`),
   * which hand over `previousState.properties` (issue
   * [#3141](https://github.com/go-to-k/cdkd/issues/3141)).
   *
   * The UPDATE twin of {@link CreateContext.replayingState}, and it carries the
   * SAME licence, unchanged: the user has no template-side remedy for whatever
   * the properties contain, because the only way to edit a state record is by
   * hand-editing `state.json`. So a refusal that exists to stop a bad TEMPLATE
   * must downgrade here to the arm the record's own writer took — otherwise the
   * rollback fails and the resource is stranded at the failed deploy's
   * configuration, which is the case the downgrade exists for.
   *
   * **It is NOT {@link desiredFromAwsReadback}, and the two must not be
   * conflated.** That flag says every value in the bag is an AWS READBACK, so a
   * shape a provider would read as collapsed is instead an accurate report of
   * what AWS held — which licenses REMOVING a live configuration. This one says
   * only that the bag is a TEMPLATE RECORDED EARLIER: it licenses nothing about
   * the values' provenance and must never be read as permission to delete a
   * live configuration. `AWS::S3::Bucket`'s `{Rules: []}` arms turn on exactly
   * that difference (see this interface's own doc), and they read
   * `desiredFromAwsReadback`, so they are untouched by this field.
   *
   * **What a provider MUST NOT conclude from it.** Nothing about the
   * properties' CONTENT, and nothing about data safety: like its create-side
   * twin, it is not a dry-run signal and must not relax a data-loss guard or a
   * validation that protects the AWS call itself.
   *
   * Absent / `false` = an ordinary template-path update (`cdkd deploy`), OR a
   * `cdkd drift --revert`, which sets `desiredFromAwsReadback` instead.
   */
  replayingState?: boolean;

  /**
   * Region recorded in the stack state for the resource being updated
   * (`StackState.region`), issue #2301 item 1.
   *
   * The UPDATE twin of `DeleteContext.expectedRegion`
   * (`src/provisioning/region-check.ts`), and it is a twin in shape only —
   * the hazard is the same one, arriving on a path whose consequence is
   * recoverable where the delete's is not. A provider is handed a
   * `physicalId` read out of a state record, and most physical ids are NAMES:
   * if the client's region disagrees with the record's, the call does not
   * fail, it succeeds against a same-named resource in the client's region.
   * On delete that is unrecoverable; on update it is a misapplied
   * configuration on a resource cdkd does not manage.
   *
   * Optional, and ABSENT means "do not check" — the guard
   * (`assertRegionMatch`) is a no-op without it, so a caller that has no
   * trustworthy region (a pre-v2 state record whose key layout carried none)
   * keeps the historical behavior rather than being refused. An EMPTY string
   * is treated the same as absent, because callers typed `region: string`
   * can produce one.
   *
   * The field lives here rather than on a shared base with `DeleteContext`
   * for the same reason `DeleteContext` itself lives in `region-check.ts`:
   * that module owns the check, this module owns the interface the
   * `ResourceProvider` contract hands to `update()`. Threaded today by
   * `deploy-engine/update-in-place.ts` (the in-place UPDATE), `rollback-executor.ts` /
   * `rollback-executor/replay-revert.ts` (both revert arms) and `drift.ts` (`--revert`); `CloudControlProvider.update`
   * is the only consumer so far, and the SDK providers' own twin is issue
   * #2245.
   */
  expectedRegion?: string | undefined;

  /**
   * The `attributes` cdkd RECORDED for the resource `physicalId` names
   * (`ResourceState.attributes`), issue #4051: the identity evidence a
   * provider needs to confirm that a resource it finds is the one this record
   * describes. A name-addressed resource can be replaced out of band by a
   * DIFFERENT resource under the same name, and a provider that adopts it
   * overwrites, records and later deletes something the stack never created
   * (`AWS::CodeCommit::Repository`'s rename-retry probe compares the recorded
   * `RepositoryId`, go-to-k/cdkd#4042).
   *
   * Threaded by every `update()` caller, each from the record whose
   * `physicalId` it passes: `deploy-engine/update-in-place.ts` (the in-place UPDATE),
   * `rollback-executor.ts` / `rollback-executor/replay-revert.ts` (both revert arms) and `drift.ts` (`--revert`).
   *
   * Read-only evidence. ABSENT, or a key missing from it, means "no recorded
   * identity" — a record from before the attribute existed — and a provider
   * must then REFUSE to adopt an unverifiable resource under a name the record
   * does not hold rather than assume it is its own; the recorded name itself
   * keeps the historical by-name update. Present, the holder of the recorded
   * name is compared before any write to it (go-to-k/cdkd#4157), and
   * `DeleteContext.recordedAttributes` is the delete twin. Values are as
   * recorded: a secret-derived one is redacted, so
   * compare only non-secret identities (ids AWS generates).
   */
  recordedAttributes?: Readonly<Record<string, unknown>> | undefined;

  /**
   * The same record's `ResourceState.acceptedCreateOnlyDrops`
   * (go-to-k/cdkd#6104): create-only keys its `properties` hold that the SDK
   * route was told to drop, so never sent. Threaded beside
   * `recordedAttributes` by every `update()` caller, verbatim; a provider
   * reads it as `acceptedCreateOnlyDropsOf` reads the field (malformed =
   * none). Evidence about the record's CREATE: an `AWS::RDS::DBCluster`
   * record holding a restore source key only as a drop was created plainly,
   * not restored. ABSENT keeps the pre-#6104 reading of every key.
   */
  recordedCreateOnlyDrops?: readonly string[] | undefined;

  /**
   * go-to-k/cdkd#4156: answers, at the moment of each removal, whether ANOTHER
   * resource of this deploy has already written the inline policy
   * `policyName` onto `principal` (`src/deployment/inline-policy-claims.ts`).
   * `IAMPolicyProvider` then keeps that name rather than strip the other
   * resource's live grant. Only a COMPLETED write counts, read from what that
   * resource recorded, so any doubt answers `false` and the removal proceeds.
   * Set by the deploy's in-place UPDATE of an `AWS::IAM::Policy`, and by both
   * rollback revert arms, where "this deploy" is the rollback and its writers
   * are the reverts that completed before this one (go-to-k/cdkd#4225,
   * `RollbackInlinePolicyWriters`). A rollback also sets it on an
   * `AWS::IAM::Role` / `Group` / `User` revert, whose provider asks it before
   * removing a name its own `Policies` drops. Absent on `drift --revert`,
   * where every removal proceeds.
   */
  inlinePolicyClaimed?: InlinePolicyClaimed | undefined;

  /**
   * Issue #1160: the top-level properties the previous TEMPLATE declared and
   * the desired one omits, computed once by the caller
   * (`prepareRemovalForUpdate`, `src/provisioning/update-removal.ts`), which
   * has ALREADY injected each one `ResourceProvider.removalDefaults`
   * declares into the desired bag. Set by every `update()` caller: the deploy's
   * in-place UPDATE, both rollback revert arms (state record vs state record),
   * and `drift --revert`, where it is EMPTY: its previous side is an AWS
   * readback, which never counts as a template declaration, and its desired
   * bag starts from that readback, so no top-level key is absent from it.
   * ABSENT means a direct call, where `withRemovalDefaults` injects instead.
   */
  removedProperties?: ReadonlySet<string> | undefined;

  /**
   * go-to-k/cdkd#5112: the top-level properties this update CHANGES, decided
   * as CloudFormation decides it, template to template. The state record is
   * REDACTED (a dynamic reference stays its `{{resolve:...}}` token, a `NoEcho`
   * value is `***`) while the desired bag is resolved, so a provider comparing
   * the two cannot tell an unchanged secret from a changed one. The engine
   * compares the AS-WRITTEN bags, and also counts as changed a key whose
   * as-written form hides a move: a masked property whose template text or
   * inputs moved, a secret read at a newer version than recorded, a fresh
   * `NoEcho` value AWS did not confirm holding, and a key whose previous side
   * the engine rewrote for the provider to act on (a re-attachment, a dropped
   * secret principal list). An update the engine forces with nothing changed
   * (a `reput` child of a re-created parent) names EVERY key. Names only: no
   * value reaches the provider.
   *
   * A fresh `NoEcho` parameter value is confirmed only by reading the resource
   * back. That read is taken for it only on a type in
   * `CHANGED_PROPERTIES_CONSUMER_TYPES`
   * (`src/provisioning/changed-properties-consumers.ts`), the opt-in a provider
   * that reads this set joins; on any other type an unconfirmed key stays in
   * the set (wider than CloudFormation, never narrower) and no AWS call is
   * added. One deliberate exception to CloudFormation parity: a create-only
   * path a `NoEcho` parameter feeds that cdkd decided not to replace (warned on
   * every deploy) is left out, since it cannot be updated in place either.
   *
   * Set ONLY by the deploy's in-place UPDATE
   * (`deploy-engine/update-in-place.ts`). ABSENT on the rollback revert arms
   * (both bags are state records, compared alike), on `cdkd drift --revert`
   * (both bags are AWS readbacks with the drifted keys overlaid) and on a direct
   * call: a provider must then fall back to its own comparison of the two bags.
   */
  changedProperties?: ReadonlySet<string> | undefined;

  /**
   * go-to-k/cdkd#6140: the keys of {@link changedProperties} named ONLY because
   * they carry a fresh `NoEcho` parameter value AWS did not confirm holding:
   * the key's as-written form (`***` at the `NoEcho` positions, a dynamic
   * reference as its `{{resolve:...}}` token) equals the record, nothing
   * else marks it, and its previous side was not rewritten. Such a key may be
   * unchanged; cdkd cannot tell, since the record keeps only the mask. A
   * provider for which re-sending it is destructive (an `overwrite` OpenAPI
   * put) may leave it alone and warn. Set alongside `changedProperties`, and
   * empty when the engine forces every key.
   */
  noEchoOnlyChangedProperties?: ReadonlySet<string> | undefined;

  /**
   * go-to-k/cdkd#5380: declare, IMMEDIATELY BEFORE an irreversible call that
   * starts changing a top-level property (a Start / Stop that AWS finishes
   * asynchronously, a second write after a first one landed), that the change
   * is in flight. If this `update()` then fails for any reason — the wait
   * reports `*_FAILED`, the per-resource deadline, Ctrl-C, a later write —
   * the engine records the name as `ResourceState.unsettledProperties`, and the
   * next deploy hands it back in {@link unsettledProperties}. Not for a
   * refusal or a failed read before the call: nothing was sent, so the
   * recorded value still describes AWS.
   *
   * Names only: no value reaches the record. The mark lives on the engine,
   * outside this call's promise, so it survives a deadline that abandoned the
   * call. Set ONLY by the deploy's in-place UPDATE; absent elsewhere, so a
   * provider calls it as `context?.markUnsettled?.(key)`.
   */
  markUnsettled?: ((propertyName: string) => void) | undefined;

  /**
   * go-to-k/cdkd#5498: declare, IMMEDIATELY AFTER a call that adds items to a
   * collection RESOLVED (never before it: a call that throws added nothing),
   * the identity names it added under `path` — a member path of a key already
   * marked with {@link markUnsettled} (`GlobalSecondaryIndexes`, `Tags`,
   * `Replicas[eu-west-1].GlobalSecondaryIndexes`; closed-vocabulary segments
   * only). Only names AWS did not hold before the call (a GSI Create, a
   * metric the response did not list as current, a tag key the record
   * lacked). If the update then fails, the record keeps them as
   * `ResourceState.unsettledItems`, and the next convergence may remove an
   * item it names that neither the record nor the template declares. A
   * provider whose own `readUnsettled` reads the names as "touched by cdkd"
   * may also name the items it REMOVED (`AssociatedRoles`,
   * `db-associated-roles.ts`).
   */
  markAttempted?: ((path: string, items: readonly string[]) => void) | undefined;

  /**
   * go-to-k/cdkd#5498: the record's attempted names per member path (see
   * {@link markAttempted}), for a provider's projection of a collection:
   * a live item named here (exactly, and not redacted) that neither the record
   * nor the template declares goes on the previous side, so it is removed.
   * Set only with {@link unsettledProperties}. No provider reads it today
   * (they receive the same names through `readUnsettled`); the rollback
   * retry replay reads it back to hand them to its own convergence step.
   */
  unsettledItems?: ReadonlyMap<string, ReadonlySet<string>> | undefined;

  /**
   * go-to-k/cdkd#5380: the top-level properties an EARLIER failed update
   * left unsettled (see {@link markUnsettled}): AWS may hold the recorded
   * value, the attempted one, or neither. Each is also in
   * {@link changedProperties}. A provider that marks a key must, when it
   * finds that key here, compare the desired value with what AWS holds (not
   * with the previous bag, which may equal the desired one) and converge it.
   * Set ONLY by the deploy's in-place UPDATE, and only when non-empty.
   */
  unsettledProperties?: ReadonlySet<string> | undefined;
}

/** A principal kind an inline policy is written onto. */
export type InlinePolicyPrincipalKind = 'role' | 'group' | 'user';

/** See {@link UpdateContext.inlinePolicyClaimed}. */
export type InlinePolicyClaimed = (
  kind: InlinePolicyPrincipalKind,
  principal: string,
  policyName: string
) => boolean;

/**
 * Context passed to a provider's `create` method (issue #1463).
 *
 * The sibling of `DeleteContext`: optional, so a provider that does not
 * care about it needs no change, and absent means "assume the historical
 * behavior". Unlike `DeleteContext` — which lives in
 * `src/provisioning/region-check.ts` because its `expectedRegion` feeds that
 * module's `assertRegionMatch` helper — this type has no region-checking role,
 * so it is defined here next to the `ResourceProvider` interface that consumes
 * it.
 *
 * It exists for ONE question a provider's `create()` could not previously
 * answer: is this call provisioning from the user's TEMPLATE, or replaying a
 * historical cdkd STATE record?
 */
export interface CreateContext extends SecretMaskingContext {
  /**
   * `true` when the properties handed to `create()` come from a cdkd STATE
   * record rather than from the synthesized template — today that is the
   * rollback executor's REVERSE-REPLACEMENT arm, which revives the OLD
   * physical resource from `previousState.properties` (issue #1199).
   *
   * **What a provider MAY conclude from it.** That the user has no
   * template-side remedy for whatever the properties contain. A state record
   * was written by some earlier cdkd build against some earlier AWS API, and
   * the only way a user could edit it is by hand-editing `state.json`. So a
   * PRE-FLIGHT REFUSAL (see `docs/provider-rules.md#pre-flight-refusal-when-a-provider-may-reject-what-cloudformation-forwards`) must downgrade
   * to a WARNING here: refusing would leave the old resource unrestorable with
   * no action the user can take. This is the create-side twin of the
   * refuse-on-template / warn-on-replay asymmetry `update()` has — decided
   * there on {@link UpdateContext.replayingState} and
   * {@link UpdateContext.desiredFromAwsReadback} (issue #3728), and here on
   * this flag alone, since `create()` has no readback caller.
   *
   * **What a provider MUST NOT conclude from it.** Nothing about the
   * properties' CONTENT: they are neither more nor less trustworthy than
   * template properties, are NOT pre-resolved differently, and carry no
   * guarantee of being a superset or subset of what the template would say.
   * It is also not a "best effort" or "dry run" signal — the create must still
   * either produce a real resource or throw. Validation that protects the AWS
   * call itself (a required field is missing, a physical id is malformed)
   * stays a hard error: warning past it would just move the failure later.
   * And it says nothing about WHY the rollback is happening, so it must not be
   * used to relax data-safety guards.
   *
   * Absent / `false` = an ordinary template-path create (`cdkd deploy`, the
   * replacement create, the `--replace` / `--recreate-via-*` re-creates), where
   * a refusal IS the right behavior because the user can edit the template.
   *
   * **Constraint this places on providers.** A provider that re-creates inside
   * its own `update()` (`this.create(logicalId, resourceType, properties)` —
   * ACM certificate, IAM managed policy, IAM role, Lambda permission, SNS
   * subscription today) receives no replay signal: none forwards
   * `replayingState` to its own `create()` (IAM role, IAM managed policy and
   * Lambda permission pass a `CreateContext` carrying ONLY `maskSecrets`,
   * issue #2177, and ACM certificate does too, go-to-k/cdkd#2319; SNS
   * subscription passes none) — and during a rollback replay the
   * `properties` it forwards ARE a state record. The INFORMATION does reach `update()`: its context is
   * an {@link UpdateContext}, which since issue #3141 carries its own
   * {@link UpdateContext.replayingState}, set by both rollback revert arms. None
   * of the five forwards it. (This sentence has been
   * wrong twice: it once said `update()` takes "no context parameter" —
   * false since issue #1732 — and then that `UpdateContext` "carries no
   * `replayingState`" — false since #3141; issue #1999.) So a provider with a
   * create-side pre-flight refusal MUST NOT re-create inside `update()` unless
   * it forwards a replay signal into that `create()` — `context.replayingState`
   * on the rollback path — and decides separately what the refusal means for
   * the `desiredFromAwsReadback` bag `cdkd drift --revert` hands it (that path
   * sets no `replayingState`). Otherwise the refusal would fire on a replay or
   * a revert. None of the five listed above has such a
   * refusal (they validate required fields only, which stays a hard error by
   * the rule above).
   *
   * `EC2Provider` DOES have both since issue #1566, via the private
   * `createRoute` rather than `this.create`, and shows the shape that satisfies
   * the constraint: the refusal sits behind a CALLBACK parameter which
   * `updateRoute` passes UNCONDITIONALLY, so the re-create can never fire it.
   * Note the callback covers only that one guard — `createRoute`'s
   * required-field check is still a hard error on the post-delete path — so the
   * safe pattern is "downgrade the refusal", never "assume `update()` is
   * throw-free". See `.claude/rules/providers.md` for the full write-up.
   */
  replayingState?: boolean;
}
