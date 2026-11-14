/**
 * `cdkd drift`: secret dynamic-reference handling: recorded-secret paths, per-region resolvers and the baseline re-resolution.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { getLogger } from '../../../utils/logger.js';
import { CdkdError, IntrinsicResolutionRefusalError } from '../../../utils/error-handler.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg, displayIdent } from '../../../utils/display-safe.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import {
  classifyReplaySecretRegion,
  producerRegionsFromState,
} from '../../../deployment/rollback-executor.js';
import {
  regionLessSecretName,
  classifyRecordedSecretRegion,
} from '../../../deployment/secret-region-classification.js';
import { recordedReferenceRegions } from '../../../deployment/reference-provenance-record.js';
import {
  type ProducerRegionEvidence,
  inheritProducerRegions,
} from '../../../deployment/producer-regions-scope.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../deployment/intrinsic-function-resolver.js';
import { resolveDynamicReferences } from '../../../deployment/intrinsic-resolver/dynamic-refs.js';
import {
  MIN_NEEDLE_LENGTH,
  type RecordedSecretValues,
  dynamicReferenceTokens,
  SECRET_MASK,
} from '../../../deployment/secret-redaction.js';
import type { StackState } from '../../../types/state.js';

/**
 * Does any string anywhere in `value` carry a `{{resolve:...}}` dynamic
 * reference?
 *
 * Cheap pre-check so the overwhelming majority of resources — which reference
 * no secret at all — never build a resolver context and never pay a deep clone
 * of their property bag.
 */
function containsDynamicReference(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{resolve:');
  if (Array.isArray(value)) return value.some(containsDynamicReference);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsDynamicReference);
  }
  return false;
}

/**
 * The dotted property paths at which a resource is KNOWN to carry a secret,
 * learned while re-resolving its state bags (issue #1914).
 *
 * Recorded at the leaf's OWN dotted path. That is a finer coordinate space than
 * the one `calculateResourceDrift` reports in — it never descends an array, so
 * a secret at `Tags.0.Value` surfaces as a drift on `Tags` — which is what
 * {@link isSecretBearingPath}'s prefix test exists to bridge, in both
 * directions at once.
 */
export type SecretPathSet = Set<string>;

/**
 * The threshold `secret-redaction.ts` applies when it builds its substring
 * needles. IMPORTED rather than copied since issue #2005 exported it (`cdkd
 * scrub` needed the same constant to bound its cross-resource union), so the
 * two can no longer disagree — and they must not, or this function would call a
 * leaf secret-bearing that `redactSecretsForState` will not redact. The local
 * alias is kept so the call sites below read unchanged.
 */
const MIN_SECRET_NEEDLE_LENGTH = MIN_NEEDLE_LENGTH;

/**
 * Does `value` hold a plaintext this pass has recorded as a secret?
 *
 * Two branches with deliberately different strictness, and the asymmetry is the
 * point. A WHOLE-value match is exact evidence at any length, so it is accepted
 * unconditionally. A SUBSTRING match is only evidence when the plaintext is
 * long enough to be distinctive: a 1-3 character secret (a JSON key holding
 * `"0"`) occurs inside unrelated values constantly, and accepting it would mark
 * half the resource's paths secret-bearing — masking values that are not
 * secrets and, worse, making `--accept` refuse them.
 *
 * So this errs toward NOT marking on the substring branch, and that direction
 * is chosen rather than inherited: `redactSecretsForState` applies the same
 * threshold when it builds needles, so a sub-threshold plaintext is not
 * substituted there either. Marking a path this function's caller cannot
 * actually redact would produce a `***` with no mechanism behind it.
 */
function carriesRecordedSecret(value: string, secrets: RecordedSecretValues): boolean {
  if (value === '') return false;
  if (secrets.has(value)) return true;
  for (const plaintext of secrets.keys()) {
    if (plaintext.length >= MIN_SECRET_NEEDLE_LENGTH && value.includes(plaintext)) return true;
  }
  return false;
}

/**
 * Every `{{resolve:...}}` token still present in `value`.
 *
 * Used to NAME an unresolvable reference without quoting the string it sits in.
 * That string is a partially substituted leaf: `resolveDynamicReferences`
 * substitutes token by token, so a leaf holding two references comes back with
 * the resolvable one already replaced by its PLAINTEXT. Interpolating it into a
 * log line prints the secret — from the command whose purpose is not to. A
 * token is a reference NAME and carries no value, so it is always safe to show.
 */
function survivingDynamicReferences(value: string): string[] {
  // Built from `secret-redaction.ts`'s `DYNAMIC_REFERENCE_INNER`, which is
  // byte-identical to `intrinsic-resolver/dynamic-refs.ts`'s own
  // `/\{\{resolve:([^}]+)\}\}/` scan capture — the AUTHORITY on what cdkd will
  // try to resolve. The two MUST agree or a token the resolver tried and left
  // behind is reported by neither; a `{` inside a token
  // (`{{resolve:ssm:/a{b}}`) is the shape that separates them.
  //
  // This predicate and `isWholeDynamicReference` answer different questions,
  // but they must share ONE character class: where they disagreed, a token the
  // resolver tried and left behind was classified as not-a-token by the strict
  // sibling and its plaintext was persisted (issue #1936).
  //
  // Calls `secret-redaction.ts`'s exported scan rather than re-spelling it
  // (issue #2088): sharing the character class while re-assembling the PATTERN
  // here is how a later flag or anchor change re-forks the two.
  return dynamicReferenceTokens(value);
}

/**
 * Record the dotted path of every leaf holding a `{{resolve:...}}` string.
 *
 * The OFFLINE seed for {@link SecretPathSet}: it needs no AWS call, so it is
 * what remains when resolution fails. Issue #1900's mechanism applied to
 * positions instead of values — the record's own bags already say WHERE the
 * references are, and that is the half of the answer a failed lookup does not
 * take away.
 *
 * Necessarily coarser than the resolved answer, because a `{{resolve:ssm:...}}`
 * naming a plain `String` parameter is PUBLIC config and only the resolver's
 * TYPE verdict can say so. Marking such a path secret-bearing over-masks it,
 * which is why the seed is used ONLY on the failure path, where the alternative
 * is not masking at all.
 */
export function collectDynamicReferencePaths(value: unknown, into: SecretPathSet, path = ''): void {
  if (typeof value === 'string') {
    if (value.includes('{{resolve:')) into.add(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      collectDynamicReferencePaths(item, into, path === '' ? String(i) : `${path}.${i}`)
    );
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectDynamicReferencePaths(v, into, path === '' ? k : `${path}.${k}`);
    }
  }
}

/**
 * Record the dotted path of every leaf that IS {@link SECRET_MASK} — the
 * mask-only twin of {@link collectDynamicReferencePaths} (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * WITHOUT IT A NESTED MASK IS INVISIBLE, and that is a live disclosure rather
 * than a tidiness gap. `calculateResourceDrift` deliberately does not descend
 * arrays, so a masked leaf at `ContainerDefinitions.0.Environment.0.Value`
 * surfaces as ONE change at path `ContainerDefinitions` whose `stateValue` is
 * the WHOLE ARRAY — never equal to the mask. A whole-value equality test
 * therefore answers `false`, `secretBearing` stays false, the LIVE plaintext is
 * printed by the report, and `--accept` writes it into `state.json`, undoing
 * exactly the redaction this feature exists to perform.
 *
 * The expression class already answers this, and answers it this way: paths go
 * in at the LEAF's own coordinate and {@link isSecretBearingPath} bridges to the
 * comparator's coarser one by matching ANCESTORS. Seeded off the state bags,
 * exactly like the offline dynamic-reference seed, because a mask is a fact
 * about the RECORD and needs no AWS call to see.
 */
export function collectSecretMaskPaths(value: unknown, into: SecretPathSet, path = ''): void {
  if (typeof value === 'string') {
    if (value === SECRET_MASK) into.add(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      collectSecretMaskPaths(item, into, path === '' ? String(i) : `${path}.${i}`)
    );
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectSecretMaskPaths(v, into, path === '' ? k : `${path}.${k}`);
    }
  }
}

/**
 * The drift command's resolvers for ONE stack: the stack's own, plus one pinned
 * sibling per FOREIGN region an ARN-named reference asks for (issue
 * [#2108](https://github.com/go-to-k/cdkd/issues/2108)).
 *
 * The structural twin of the rollback replay's `ReplayResolvers`
 * (`src/deployment/rollback-executor/replay-secrets.ts`), and deliberately a SEPARATE class
 * rather than an export of that one: the two are ~20 lines of caching around a
 * constructor, and exporting the replay's would put a rollback-internal name on
 * the drift command's contract for no behavioural gain. What is SHARED is the
 * part with a decision in it — `classifyReplaySecretRegion`, imported.
 *
 * One instance per STACK, not per resource and not per op — the resolved-value
 * cache lives on the resolver INSTANCE since issue
 * [#1933](https://github.com/go-to-k/cdkd/issues/1933), so a resolver per
 * resource would re-fetch every referenced secret once per resource. The pinned
 * siblings are cached for the same reason: a 50-resource stack sharing one
 * foreign ARN must pay one `GetSecretValue`, not fifty.
 *
 * A pinned sibling is a PLAIN resolver, deliberately NOT the resolver class's
 * own `producerRegionGuest`, and the argument is `ReplayResolvers`' verbatim:
 * {@link forRegion} is reached ONLY from a `named-region` verdict, which
 * `classifyReplaySecretRegion` returns only when the SECRET_ID / parameter name
 * starts with `arn:` and carries a region. So a pinned sibling only ever
 * resolves an expression whose KEY EMBEDS THE REGION IT IS BEING RESOLVED IN,
 * and the process-global `recordedSecretExpressions` store — keyed by the
 * expression string alone — cannot have two regions sharing that key. If a
 * future change ever routes a region-LESS expression here, the argument dies
 * with it and the sibling needs the guest flag.
 */
export class DriftSecretResolvers {
  /** The stack's own resolver — every `local` verdict resolves through this. */
  readonly primary: IntrinsicFunctionResolver;
  private readonly pinned = new Map<string, IntrinsicFunctionResolver>();
  private readonly stackRegion: string;

  constructor(stackRegion: string) {
    this.stackRegion = stackRegion;
    this.primary = new IntrinsicFunctionResolver(stackRegion);
  }

  /** The resolver that must answer for `region` — `primary` when it is the stack's own. */
  forRegion(region: string): IntrinsicFunctionResolver {
    const target = canonicalizeRegion(region);
    if (target === canonicalizeRegion(this.stackRegion)) return this.primary;
    const cached = this.pinned.get(target);
    if (cached) return cached;
    const scoped = new IntrinsicFunctionResolver(target);
    this.pinned.set(target, scoped);
    return scoped;
  }

  /**
   * The resolver for a region-LESS token a v12 record says `region` resolved
   * (go-to-k/cdkd#4847): the primary's producer-region GUEST, as in the
   * rollback replay's `ReplayResolvers.forRecordedRegion`.
   */
  forRecordedRegion(region: string): IntrinsicFunctionResolver {
    return this.primary.resolverForRecordedRegion(region);
  }
}

/**
 * A DELIBERATE refusal to resolve a state-recorded dynamic reference (issue
 * #2108) — as opposed to a failure to READ one.
 *
 * The distinction is load-bearing for what the user is told: "could not
 * resolve" sends a reader hunting for a missing `secretsmanager:GetSecretValue`
 * grant, while a refusal is cdkd declining to resolve a reference it CAN read
 * but cannot attribute to a region. Both call sites that catch
 * `resolveStateSecretExpressions` pick their wording from this class.
 *
 * DEFINED POSITIVELY, and that is the whole point of the class existing rather
 * than a second `err.code === ...` comparison at each site. Both sites used to
 * enumerate the one code they knew (`DRIFT_SECRET_REGION_AMBIGUOUS`) while
 * `DRIFT_SECRET_TOKEN_SCAN_MISMATCH` — whose own message says "Refusing rather
 * than resolving" — silently took the read-failure wording. Enumerating bad
 * shapes loses that race every time a third refusal is added; a refusal that
 * has to declare itself one cannot be added without answering the question.
 *
 * The `code` stays per-refusal: it is what the message and any future
 * programmatic consumer key on. What this class adds is the CATEGORY.
 */
class DriftSecretRefusalError extends CdkdError {
  /** Marker read by {@link isDriftSecretRefusal}; see the class note. */
  readonly driftSecretRefusal: boolean = true;

  constructor(message: string, code: string) {
    super(message, code);
    this.name = 'DriftSecretRefusalError';
    Object.setPrototypeOf(this, DriftSecretRefusalError.prototype);
  }
}

/**
 * Whether an error thrown out of `resolveStateSecretExpressions` is a
 * deliberate REFUSAL rather than a failed read. See
 * {@link DriftSecretRefusalError} — drift's own region refusal — and
 * `IntrinsicResolutionRefusalError`, the resolver's: since issue #2482 the
 * `ssm-secure` arm refuses a definitive `String` / `StringList` parameter with
 * the latter, and that is a decision, not an IAM problem to go hunting for.
 */
export function isDriftSecretRefusal(err: unknown): boolean {
  return err instanceof DriftSecretRefusalError || err instanceof IntrinsicResolutionRefusalError;
}

/**
 * The refusal a region-AMBIGUOUS drift reference throws (issue #2108).
 *
 * A plain throw: BOTH call sites already wrap `resolveStateSecretExpressions`
 * in a per-resource catch that degrades instead of aborting the command, and
 * the degradation each one performs is exactly the fail-closed behaviour this
 * refusal wants.
 *
 *  - DETECTION falls back to the UNRESOLVED baseline, whose `{{resolve:...}}`
 *    leaves `calculateResourceDrift` skips — so the secret-bearing property is
 *    NOT COMPARED rather than compared against a foreign region's plaintext.
 *    That is strictly better than the phantom drift this issue reports, and the
 *    offline `seededSecretPaths` still masks the position.
 *  - REVERT counts the resource as unresolvable and returns BEFORE
 *    `provider.update`, so nothing is written. Refusing is strictly better than
 *    the alternative it replaces: resolving a producer-region reference against
 *    the consumer's region does not fail, it succeeds with the WRONG credential
 *    and writes it to a live resource.
 *
 * Names the reference, the regions and the remedy. Never a resolved value:
 * nothing has been resolved when this is thrown (the refusal runs over the
 * WHOLE leaf before any reference in it is fetched), and the expression is the
 * same string `state.json` already stores in the clear.
 */
function regionAmbiguousDriftSecretError(
  logicalId: string,
  propertyPath: string,
  secretName: string,
  foreignProducerRegions: readonly string[],
  consumerRegion: string
): DriftSecretRefusalError {
  const where = propertyPath === '' ? '' : ` property '${propertyPath}'`;
  return new DriftSecretRefusalError(
    `${logicalId}${where}: the secret reference '${secretName}' carries no region of its own, ` +
      `and this stack read across a region boundary (producer region(s) on record: ` +
      `${foreignProducerRegions.join(', ')}), so it may have been resolved in one of those ` +
      `rather than in '${consumerRegion}'. A secret of the same name in two regions is two ` +
      `independent values, so cdkd would compare against — and with --revert WRITE — the WRONG ` +
      `secret. Refusing instead. Spell the reference as a full ARN, which names its region and ` +
      `is resolved there, then re-run ${proseQuoted(cdkdRemedy('cdkd drift'))}.`,
    'DRIFT_SECRET_REGION_AMBIGUOUS'
  );
}

/**
 * go-to-k/cdkd#4213: a nested child records its parent's region-less spelling
 * of a value the parent read across a region, and its own reads never name that
 * region. When the ancestors' regions could not be established, a region-less
 * reference that classifies `local` may still be the parent's, so the leaf is
 * refused before any reference is fetched. Kept out of
 * {@link resolveDriftLeafByRegion}, which mirrors the rollback replay's leaf
 * walk (`drift-leaf-region-walk-mirrors-replay.test.ts`). Exported for its unit
 * test only.
 */
export function refuseUnprovenDriftSecret(
  leaf: string,
  propertyPath: string,
  logicalId: string,
  consumerRegion: string,
  evidence: ProducerRegionEvidence,
  // go-to-k/cdkd#4847: a token the record names a region for is not unproven.
  recordedRegions?: ReadonlyMap<string, string>
): void {
  if (evidence.complete) return;
  for (const token of dynamicReferenceTokens(leaf)) {
    if (recordedRegions?.has(token) === true) continue;
    const verdict = classifyReplaySecretRegion(token, consumerRegion, evidence.regions);
    const name = verdict.kind === 'local' ? regionLessSecretName(token) : undefined;
    if (name === undefined) continue;
    const where = propertyPath === '' ? '' : ` property '${propertyPath}'`;
    throw new DriftSecretRefusalError(
      `${logicalId}${where}: the secret reference '${name}' carries no region of its own, and ` +
        `this is a nested stack whose parent stacks' cross-region reads could not be established, ` +
        `so a parent may have resolved it in another region than '${consumerRegion}'. A secret of ` +
        `the same name in two regions is two independent values, so cdkd would compare against — ` +
        `and with --revert WRITE — the WRONG secret. Refusing instead. Make the parent stacks' ` +
        `state readable (or repair a record whose parent link disagrees with its key), or spell ` +
        `the reference as a full ARN, then re-run ${proseQuoted(cdkdRemedy('cdkd drift'))}.`,
      'DRIFT_SECRET_REGION_UNKNOWN'
    );
  }
}

/**
 * Why an ancestor's producer regions could not be established, at debug: the
 * refusal it causes names no cause, and an AWS error's text goes through
 * `safeMsg` like every other interpolated value this command logs.
 */
function noteUnreadableAncestor(stackName: string, region: string, why: string): void {
  getLogger().debug(
    safeMsg`Producer regions above a nested stack are incomplete: ${displayIdent(stackName)} (${region}): ${why}`
  );
}

/** The bound on {@link driftProducerRegionEvidence}'s walk up a nested chain. */
const MAX_ANCESTOR_DEPTH = 32;

/**
 * The producer-region evidence `cdkd drift` classifies a stack's recorded
 * `{{resolve:...}}` references with (go-to-k/cdkd#4213). A top-level stack's is
 * its own record's reads, complete. A NESTED child (a `<parent>~<id>` key, or a
 * record naming a `parentStack`) receives a parent's cross-region value only as
 * a Parameter and records the parent's region-less spelling, so its own reads
 * are unioned with every ANCESTOR's, read from their state records. Any
 * ancestor that cannot be read (missing, unreadable, a record whose region
 * disagrees with its key, malformed reads, a chain deeper than the bound) makes
 * the evidence INCOMPLETE, which refuses every region-less secret reference.
 */
export async function driftProducerRegionEvidence(
  state: StackState,
  stackName: string,
  region: string,
  stateBackend: Pick<S3StateBackend, 'getState'>,
  depth = 0
): Promise<ProducerRegionEvidence> {
  // A stack's OWN malformed reads throw, as they did before #4213: the stack's
  // run fails loudly naming its own record. Only an ANCESTOR's (below) makes
  // the evidence incomplete, since that record is not the one being checked.
  let own: string[];
  if (depth === 0) {
    own = producerRegionsFromState(state);
  } else {
    try {
      own = producerRegionsFromState(state);
    } catch {
      noteUnreadableAncestor(stackName, region, 'its cross-stack read records are malformed');
      return { regions: [], complete: false };
    }
  }
  // Nested iff the key carries `~` (CDK bars it in a stack name) or the record
  // names a parent -- the predicate `cdkd rollback` uses (#4174). The key and
  // the record must agree on WHICH parent: a record naming another stack than
  // its key is not evidence of the chain above it.
  const cut = stackName.lastIndexOf('~');
  const keyParent = cut >= 0 ? stackName.slice(0, cut) : undefined;
  const recordParent = state.parentStack;
  if (keyParent === undefined && recordParent === undefined) {
    return { regions: own, complete: true };
  }
  if (
    keyParent === '' ||
    (recordParent !== undefined && typeof recordParent !== 'string') ||
    (state.parentRegion !== undefined && typeof state.parentRegion !== 'string') ||
    (keyParent !== undefined && typeof recordParent === 'string' && recordParent !== keyParent)
  ) {
    noteUnreadableAncestor(
      stackName,
      region,
      'its key and its parent link disagree, or the link is malformed'
    );
    return inheritProducerRegions(own, undefined);
  }
  const parentName = (keyParent ?? recordParent) as string;
  if (depth >= MAX_ANCESTOR_DEPTH) {
    noteUnreadableAncestor(
      stackName,
      region,
      `the nesting is deeper than ${MAX_ANCESTOR_DEPTH} levels`
    );
    return inheritProducerRegions(own, undefined);
  }
  const parentRegion = typeof state.parentRegion === 'string' ? state.parentRegion : region;
  let parent: Awaited<ReturnType<S3StateBackend['getState']>>;
  try {
    parent = await stateBackend.getState(parentName, parentRegion);
  } catch (error) {
    noteUnreadableAncestor(
      parentName,
      parentRegion,
      `it could not be read (${describeAwsFailure(error).detail})`
    );
    return inheritProducerRegions(own, undefined);
  }
  if (
    !parent ||
    parent.divergentBodyRegion !== undefined ||
    typeof parent.state !== 'object' ||
    parent.state === null
  ) {
    noteUnreadableAncestor(parentName, parentRegion, 'it has no usable state record');
    return inheritProducerRegions(own, undefined);
  }
  const inherited = await driftProducerRegionEvidence(
    parent.state,
    parentName,
    parentRegion,
    stateBackend,
    depth + 1
  );
  return inheritProducerRegions(own, inherited);
}

/**
 * Re-resolve one LEAF string, sending each `{{resolve:...}}` reference in it to
 * the region {@link classifyReplaySecretRegion} says must answer (issue #2108).
 *
 * Mirrors the rollback replay's `resolveLeafByRegion` down to the ordering, and
 * for the same reasons:
 *
 *  - Refuses FIRST, over the whole leaf, before any reference is fetched. A leaf
 *    can splice several references together, and resolving the safe ones first
 *    would leave half a credential fetched — and CACHED, and recorded as a
 *    redaction needle — for a resource that is about to be refused anyway.
 *  - With no foreign-region reference (every leaf on every pre-#2108 code path)
 *    the leaf goes to `resolveDynamicReferences` WHOLE, byte-for-byte as before.
 *    That method collects its matches from the ORIGINAL string, so a resolved
 *    plaintext that is itself token-shaped is never re-resolved (issue #1917),
 *    and this change does not want to relitigate any of it.
 *  - With one, the leaf is rebuilt segment by segment so each reference can be
 *    resolved by its OWN region's resolver, since `resolveDynamicReferences`
 *    resolves every token in the string it is handed with the one resolver it
 *    is called on. Each token is resolved ALONE and concatenated, so no resolved
 *    value is re-scanned for tokens either.
 *
 * `dynamicReferenceTokens` returns the tokens in order and non-overlapping, so
 * walking the leaf with a moving `indexOf` cursor reproduces their positions
 * exactly, duplicates included.
 */
async function resolveDriftLeafByRegion(
  leaf: string,
  propertyPath: string,
  logicalId: string,
  consumerRegion: string,
  producerRegions: readonly string[] | undefined,
  resolvers: DriftSecretResolvers,
  ctx: ResolverContext,
  // go-to-k/cdkd#4847: the region the record's v12 provenance gives each token.
  recordedRegions?: ReadonlyMap<string, string>
): Promise<string> {
  // ONE spelling of the token scan, shared with `secret-redaction.ts` (issue
  // #1936): a private regex here would answer a different question from the one
  // the resolver is about to ask.
  const tokens = dynamicReferenceTokens(leaf);
  const verdicts = tokens.map(
    (token) =>
      [
        token,
        classifyRecordedSecretRegion(token, consumerRegion, producerRegions, recordedRegions),
      ] as const
  );

  for (const [, verdict] of verdicts) {
    if (verdict.kind === 'ambiguous') {
      throw regionAmbiguousDriftSecretError(
        logicalId,
        propertyPath,
        verdict.secretName,
        verdict.foreignProducerRegions,
        consumerRegion
      );
    }
  }

  if (
    !verdicts.some(
      ([, verdict]) => verdict.kind === 'named-region' || verdict.kind === 'recorded-region'
    )
  ) {
    return await resolveDynamicReferences(resolvers.primary, leaf, ctx);
  }

  let out = '';
  let cursor = 0;
  for (const [token, verdict] of verdicts) {
    const at = leaf.indexOf(token, cursor);
    // Unreachable while the tokens come from a scan of THIS string, so this is
    // a guard against a future scanner change — and the direction it fails in
    // is the point. Handing the leaf back to the primary resolver would send a
    // token whose foreign region is already KNOWN to the consumer's region:
    // issue #2108 verbatim, reintroduced by the guard meant to prevent a
    // regression. Fail closed instead.
    if (at < 0) {
      throw new DriftSecretRefusalError(
        `${logicalId}${propertyPath === '' ? '' : ` property '${propertyPath}'`}: could not ` +
          `locate a scanned dynamic reference in the value it was scanned from. Refusing rather ` +
          `than resolving it in '${consumerRegion}', which would be the wrong region for a ` +
          `reference that names another one. This is an internal invariant failure — please ` +
          `report it with the resource type and property path.`,
        'DRIFT_SECRET_TOKEN_SCAN_MISMATCH'
      );
    }
    out += leaf.slice(cursor, at);
    const resolver =
      verdict.kind === 'named-region'
        ? resolvers.forRegion(verdict.region)
        : verdict.kind === 'recorded-region'
          ? resolvers.forRecordedRegion(verdict.region)
          : resolvers.primary;
    // The verdict's region-pinned resolver chosen above, not the primary.
    out += await resolveDynamicReferences(resolver, token, ctx);
    cursor = at + token.length;
  }
  return out + leaf.slice(cursor);
}

/**
 * Re-resolve the SECRET dynamic references (`{{resolve:secretsmanager:...}}`,
 * and an `{{resolve:ssm:...}}` naming a `SecureString`) held by a bag read back
 * out of cdkd STATE (issue #1914).
 *
 * State stores the unresolved EXPRESSION — that is the GHSA-p5qg-v9gv-hc7w
 * redaction — while a provider's `readCurrentState` snapshot necessarily holds
 * the resolved PLAINTEXT, because that is what AWS was given at deploy time.
 * Nothing in `cdkd drift` reconciled the two, and all three of the command's
 * modes broke on it: the comparison reported permanent phantom drift and
 * printed the plaintext as the AWS-current side, `--accept` persisted that
 * plaintext back into `state.json`, and `--revert` shipped the literal
 * `{{resolve:...}}` string to the live resource.
 *
 * The counterpart of the rollback replay's `resolveReplayProps`
 * (`src/deployment/rollback-executor/replay-props.ts`), and for the same reason: both
 * commands are synth-free, so the expression string in the persisted record is
 * the only thing there is to resolve from. Every plaintext is recorded into
 * `secrets` so the caller can redact it back out of anything it PRINTS or
 * PERSISTS, and every path that produced one into `secretPaths` so the caller
 * can act on a value it does NOT recognise there — see {@link redactDriftChanges}.
 *
 * A `{{resolve:...}}` token that SURVIVES the pass is reported through
 * `onUnresolved` and left in place — it is not an error. The resolver's
 * unsupported-service arm warns and returns the literal (`ssm-secure:` was the
 * live example until issue #2482 gave it an arm; what reaches it now is text
 * that merely looks like a reference), and `cdkd deploy` resolves through the
 * very same code, so AWS is ALREADY holding that literal string and state
 * records it. Replaying it is therefore a correct no-op, and failing the
 * resource over it would take every other drifted property on that resource
 * down with it (plus exit 2). The report exists so the user learns cdkd is
 * shipping a token it cannot resolve, which is a real thing to know and not a
 * reason to stop.
 *
 * Only the TOKENS are reported, never the leaf that held them: the leaf is
 * partially substituted by this point, so a mixed `secretsmanager` +
 * look-alike string comes back carrying real plaintext.
 *
 * Returns the input by identity when it holds no dynamic reference, so the
 * non-secret path is unchanged down to object identity.
 *
 * Issue [#2108](https://github.com/go-to-k/cdkd/issues/2108): every reference
 * is now routed to the region that must ANSWER for it rather than to the
 * consumer's, through {@link DriftSecretResolvers} — see
 * {@link resolveDriftLeafByRegion}.
 */
export async function resolveStateSecretExpressions(
  props: Record<string, unknown>,
  resolvers: DriftSecretResolvers,
  secrets: RecordedSecretValues,
  options: {
    secretPaths?: SecretPathSet;
    onUnresolved?: (tokens: string[], path: string) => void;
    /**
     * Issue #2108: the stack's own region, and the FOREIGN producer regions its
     * persisted cross-stack reads name (`producerRegionsFromState`). Together
     * they are the whole input `classifyReplaySecretRegion` needs to decide
     * which region must answer for each reference — see
     * {@link resolveDriftLeafByRegion}. `logicalId` only names the resource in
     * the refusal.
     *
     * ALL THREE ARE REQUIRED, and the whole options bag with them — there is no
     * `= {}` default and no `??` fallback anywhere below. They used to be
     * optional with defaults, which made the pre-#2108 defect the QUIET one: a
     * caller that simply omits `producerRegions` gets `local` for every
     * name-form reference and re-resolves a producer's expression in the
     * consumer's region again, with nothing in the diff to see. An omitted
     * `consumerRegion` was worse than that — `''` matches no recorded region,
     * so EVERY producer region reads as foreign and every name-form reference
     * refuses. The rollback twin cannot be misused this way because its
     * evidence rides the required `RollbackExecutorContext`; requiring these
     * gives this side the same property, enforced by the compiler.
     */
    logicalId: string;
    consumerRegion: string;
    /**
     * A nested child's evidence includes its ANCESTORS' regions, and is
     * incomplete when they cannot be read (go-to-k/cdkd#4213) — see
     * {@link driftProducerRegionEvidence}.
     */
    producerRegions: ProducerRegionEvidence;
    /**
     * go-to-k/cdkd#4847: the record whose bag this is. A token its v12
     * provenance names a region for resolves in that region (decision 6: at
     * the current version).
     */
    record?: unknown;
  }
): Promise<Record<string, unknown>> {
  if (!containsDynamicReference(props)) return props;
  const { secretPaths, onUnresolved, producerRegions, logicalId, consumerRegion } = options;
  const recordedRegions = recordedReferenceRegions(options.record);
  const ctx: ResolverContext = {
    template: { Resources: {} },
    resources: {},
    recordedSecretValues: secrets,
  };
  const walk = async (v: unknown, path: string): Promise<unknown> => {
    if (typeof v === 'string') {
      if (!v.includes('{{resolve:')) return v;
      // Issue #2108: decide the REGION of every reference in this leaf before
      // any of them is fetched. See {@link classifyReplaySecretRegion}.
      refuseUnprovenDriftSecret(
        v,
        path,
        logicalId,
        consumerRegion,
        producerRegions,
        recordedRegions
      );
      const resolved = await resolveDriftLeafByRegion(
        v,
        path,
        logicalId,
        consumerRegion,
        producerRegions.regions,
        resolvers,
        ctx,
        recordedRegions
      );
      // Only tokens that were in the INPUT. The scan runs over the RESOLVED
      // string, so a secret whose plaintext happens to contain
      // `{{resolve:...}}`-shaped text would otherwise be reported verbatim by
      // the very warning that exists to avoid printing values.
      const survivors = survivingDynamicReferences(resolved).filter((t) => v.includes(t));
      if (survivors.length > 0) {
        // NOT marked secret-bearing. Since issue #2482 every CloudFormation
        // dynamic-reference service resolves (or throws), so a survivor is text
        // that merely LOOKS like a reference, and treating it as a secret is
        // not the safe direction it appears to be: the path would be masked to
        // `***`, refused by `--accept`, and pinned to the live value by
        // `preserveLiveValuesAtUnresolvedTokens` — permanently stuck drift with
        // no remedy the user can apply. (Before #2482 `ssm-secure` survived here
        // and WAS marked, because CloudFormation resolves it server-side and a
        // migrated record held the plaintext on AWS; that record now resolves,
        // and its position is marked by the ordinary recorded-pair route.)
        onUnresolved?.(survivors, path);
      }
      // A recorded plaintext at this leaf means the leaf is secret-bearing —
      // permanently, not only for the value it holds right now. That is the
      // fact `redactDriftChanges` needs when AWS answers with something the
      // secrets map does NOT contain (a rotated-away previous version, an
      // out-of-band edit): the value is unrecognisable but the POSITION is
      // still known to hold a secret.
      if (carriesRecordedSecret(resolved, secrets)) secretPaths?.add(path);
      return resolved;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length) as unknown[];
      // Indexed like any other segment — this is the plain walk, with no
      // array-specific rule at all. Bridging it to the coordinate space the
      // comparator reports in (which never descends an array, so a secret at
      // `Tags.0.Value` surfaces as a drift on `Tags`) is entirely
      // {@link isSecretBearingPath}'s prefix test, and that test is what a
      // mutation probe reds. Collapsing the index here would ALSO work, which
      // is exactly why nothing here argues for one over the other: the choice
      // is unobservable, so the code takes the form with no special case.
      for (let i = 0; i < v.length; i++) {
        out[i] = await walk(v[i], path === '' ? String(i) : `${path}.${i}`);
      }
      return out;
    }
    if (v !== null && typeof v === 'object') {
      // `Object.create(null)` (issue #2899): the input is the JSON-parsed
      // state baseline, exactly the producer of an OWN `__proto__` key, and
      // assigning that key onto a `{}` literal SETS the rebuilt node's
      // prototype and silently DROPS the key — the member vanishes from the
      // revert payload, and the node then fails `hasPlainPrototype` and
      // cascades into the non-plain refusal arms below. Same rule as the
      // preserve walks' and `mergeUntemplatedValue`'s rebuild targets. The
      // ARRAY arm above needs no twin: its keys are numeric indices.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, val] of Object.entries(v)) {
        out[k] = await walk(val, path === '' ? k : `${path}.${k}`);
      }
      return out;
    }
    return v;
  };
  return (await walk(props, '')) as Record<string, unknown>;
}
