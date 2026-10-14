import { IntrinsicFunctionResolver } from '../deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../deployment/intrinsic-function-resolver.js';
import {
  classifyRecordedSecretRegion,
  producerRegionsFromState,
  regionLessSecretName,
  type RecordedSecretRegionVerdict,
} from '../deployment/secret-region-classification.js';
import type { ProducerRegionEvidence } from '../deployment/producer-regions-scope.js';
import { recordedReferenceRegions } from '../deployment/reference-provenance-record.js';
import {
  createSecretMasker,
  dynamicReferenceTokens,
  maskSecretsInError,
  SECRET_MASK,
  type RecordedSecretValues,
  type SecretMasker,
} from '../deployment/secret-redaction.js';
import { isThrottlingError, isTransientServerError } from '../deployment/retryable-errors.js';
import { readRecordedPrincipals, RESOLVED_PREVIOUS_PRINCIPAL_KEYS } from './iam-policy-targets.js';

/**
 * The fixed message a TRANSIENT resolution failure is thrown with (the AWS
 * error is its `cause`), for the destroy runner to retry. Fixed so no AWS text
 * reaches the runner's "already deleted" substring test.
 */
export const TRANSIENT_RESOLUTION_MESSAGE =
  'Resolving a secret-derived IAM principal list was throttled or hit a server error';

/** What {@link resolveSecretDerivedPrincipals} hands a delete. */
export interface ResolvedSecretPrincipals<K extends string> {
  lists: Record<K, string[]>;
  mask: SecretMasker;
  maskError: <T>(error: T) => T;
  /** Per kind, the names a secret supplied (not the plain sibling entries). */
  resolvedNames: Record<K, ReadonlySet<string>>;
}

/**
 * The per-resource scratch a destroy runner keeps across its retries of ONE
 * delete (`DeleteContext.resolveSecretDerivedPrincipals.retryMemo`,
 * go-to-k/cdkd#4150). A delete that detached one principal and then failed on
 * the next is retried; without this, the retry finds the first principal
 * without the grant (`NoSuchEntity`, or no longer a group member) and reads
 * that as a rotated secret and skips.
 */
export interface SecretPrincipalRetryMemo {
  /** The first successful resolution, reused by every retry: one resolution (and one warning) per resource per run, and a rotation between attempts cannot move the targets. */
  resolved?: ResolvedSecretPrincipals<string>;
  /** `injectiveKey(kind, name)` of each resolved principal an earlier attempt already detached. */
  readonly detached: Set<string>;
}

/**
 * The resolver {@link resolveSecretDerivedPrincipals} resolves through: the
 * stack region's own, and its producer-region guest for a recorded region.
 */
export type SecretPrincipalResolver = Pick<
  IntrinsicFunctionResolver,
  'resolveDynamicReferences'
> & {
  resolverForRecordedRegion(
    region: string
  ): Pick<IntrinsicFunctionResolver, 'resolveDynamicReferences'>;
};

/** Whether {@link resolveSecretDerivedPrincipals} may resolve a token with this verdict. */
function resolvableVerdict(verdict: RecordedSecretRegionVerdict): boolean {
  return verdict.kind === 'local' || verdict.kind === 'recorded-region';
}

/**
 * A region-less secret token no record places in a region
 * (go-to-k/cdkd#4887): with a nested child's parent regions unknown, its
 * `local` verdict may be the parent's region, so it is never resolved. The
 * twin of the replay's `refuseUnprovenReplaySecret`.
 */
function unprovenRegionLessToken(
  token: string,
  recordedRegions: ReadonlyMap<string, string> | undefined
): boolean {
  return regionLessSecretName(token) !== undefined && recordedRegions?.get(token) === undefined;
}

/**
 * Resolve a secret-derived principal list a DELETE has to address
 * (go-to-k/cdkd#4150). State keeps a principal name that came from a secret as
 * its `{{resolve:...}}` expression, which names no principal, and a delete has
 * no desired side to take the name from, so the inline policy / group
 * membership was skipped on every delete, forever.
 *
 * Each expression is resolved the way a rollback replay re-resolves a
 * journaled one (`rollback-executor/replay-props.ts`'s `resolveReplayProps`): the SAME
 * resolver seam (`IntrinsicFunctionResolver.resolveDynamicReferences`), after
 * the SAME region classification (`classifyRecordedSecretRegion`) armed with the
 * SAME producer-region evidence (`producerRegionsFromState`, passed by the
 * caller). Only a token classified `local` is resolved, or a region-less one
 * the record's v12 provenance places in a region (`recordedRegions`,
 * go-to-k/cdkd#4879), which resolves there through the stack resolver's
 * producer-region guest, as the rollback replay and `cdkd drift` do. Without
 * a recorded region, a region-less spelling beside a cross-region import is
 * `ambiguous` and is not guessed. With INCOMPLETE evidence (a nested child
 * destroyed on its own, go-to-k/cdkd#4887), a region-less token without a
 * recorded region is not resolved at all: it may be the parent's. The
 * plaintext is recorded into a map of this call's own, and the returned masker
 * masks it; the caller masks every printed NAME on its own (the whole-value
 * arm, which a name under `MIN_NEEDLE_LENGTH` needs). An AWS error message
 * that embeds a resolved name reaches only the substring arm, so a name under
 * that bound still prints there: the repo-wide masking floor. `maskError`
 * gives a thrown error's `cause` chain the same treatment (an SDK error body
 * can quote `role/<name>`), and `resolvedNames` lets the caller tell a
 * principal the secret named from a plain sibling entry, per kind.
 *
 * Fail-safe: `undefined`, and the caller keeps its skip, when the region is
 * unknown, a value holds cdkd's mask (it names nothing), a token is not
 * `local`, a resolution fails, or a resolved value is not an IAM name. A
 * TRANSIENT resolution failure (a throttle, a 5xx) is thrown instead, as
 * {@link TRANSIENT_RESOLUTION_MESSAGE} with the masked AWS error as its cause,
 * so the caller's retry applies rather than a skip that says "fix that". This
 * helper logs nothing (the resolver's own debug line names the reference, not
 * its value).
 *
 * The residual is a ROTATED secret, both ways: the value resolves to the
 * principals the CURRENT secret names, so a principal only the old value named
 * keeps the policy or membership, and a principal only the current value names
 * loses a same-named policy or membership it holds from elsewhere.
 */
export async function resolveSecretDerivedPrincipals<K extends string>(
  values: Record<K, unknown>,
  region: string | undefined,
  producerRegions: readonly string[] | ProducerRegionEvidence,
  recordedRegions: ReadonlyMap<string, string> | undefined,
  makeResolver: (region: string) => SecretPrincipalResolver = (r) =>
    new IntrinsicFunctionResolver(r)
): Promise<ResolvedSecretPrincipals<K> | undefined> {
  if (!region) return undefined;
  const stackRegion = region;
  const evidence: ProducerRegionEvidence =
    'complete' in producerRegions
      ? producerRegions
      : { regions: producerRegions as readonly string[], complete: true };
  const verdictOf = (token: string): RecordedSecretRegionVerdict =>
    classifyRecordedSecretRegion(token, stackRegion, evidence.regions, recordedRegions);
  const resolvable = (token: string): boolean =>
    resolvableVerdict(verdictOf(token)) &&
    (evidence.complete || !unprovenRegionLessToken(token, recordedRegions));
  // Every entry checked BEFORE any resolution: a value that will be refused
  // anyway sends no request to Secrets Manager / SSM.
  const entries = {} as Record<K, string[]>;
  for (const key of Object.keys(values) as K[]) {
    const value = values[key];
    if (
      !Array.isArray(value) ||
      !value.every(
        (entry): entry is string =>
          typeof entry === 'string' &&
          !entry.includes(SECRET_MASK) &&
          (!entry.includes('{{resolve:') ||
            (dynamicReferenceTokens(entry).length > 0 &&
              dynamicReferenceTokens(entry).every(resolvable)))
      )
    ) {
      return undefined;
    }
    entries[key] = value;
  }
  const secrets: RecordedSecretValues = new Map();
  const context: ResolverContext = {
    template: { Resources: {} },
    resources: {},
    recordedSecretValues: secrets,
  };
  let resolver: SecretPrincipalResolver | undefined;
  const lists = {} as Record<K, string[]>;
  const resolvedNames = {} as Record<K, Set<string>>;
  for (const key of Object.keys(entries) as K[]) {
    const names: string[] = [];
    const fromSecret = new Set<string>();
    for (const entry of entries[key]) {
      if (!entry.includes('{{resolve:')) {
        names.push(entry);
        continue;
      }
      let resolved: string;
      try {
        resolver ??= makeResolver(region);
        resolved = await resolveEntry(entry, resolver, verdictOf, context);
      } catch (error) {
        // A throttle or a 5xx only (never a MESSAGE pattern: `does not exist`
        // is one, and the destroy runner reads that text in a thrown message
        // as "already deleted" and drops the record). The AWS text stays in
        // the cause, where both classifiers above still find it; the message
        // is fixed.
        if (isThrottlingError(error) || isTransientServerError(error)) {
          throw new Error(TRANSIENT_RESOLUTION_MESSAGE, {
            cause: maskSecretsInError(error, secrets),
          });
        }
        return undefined;
      }
      // Recorded here too: a public (non-secret) reference is not recorded
      // by the resolver, and every resolved name is masked either way.
      secrets.set(resolved, entry);
      fromSecret.add(resolved);
      names.push(resolved);
    }
    if (readRecordedPrincipals(names).kind !== 'names') return undefined;
    lists[key] = names;
    resolvedNames[key] = fromSecret;
  }
  return {
    lists,
    mask: createSecretMasker(secrets),
    // Own fields too (an awsQuery exception's `Error.Message` quotes
    // `role/<name>`): `maskSecretsInError` masks them (go-to-k/cdkd#4190).
    maskError: (error) => maskSecretsInError(error, secrets),
    resolvedNames,
  };
}

/**
 * One principal entry: whole, by the stack region's resolver, when no token in
 * it has a recorded foreign region (every entry before go-to-k/cdkd#4879);
 * otherwise token by token, each by its own region's resolver, the rest of the
 * entry kept as written (as `cdkd drift` splices a leaf).
 */
async function resolveEntry(
  entry: string,
  primary: SecretPrincipalResolver,
  verdictOf: (token: string) => RecordedSecretRegionVerdict,
  context: ResolverContext
): Promise<string> {
  const tokens = dynamicReferenceTokens(entry).map((t) => [t, verdictOf(t)] as const);
  if (!tokens.some(([, v]) => v.kind === 'recorded-region')) {
    return await primary.resolveDynamicReferences(entry, context);
  }
  let out = '';
  let cursor = 0;
  for (const [token, verdict] of tokens) {
    const at = entry.indexOf(token, cursor);
    // The tokens come from a scan of this string; fail closed if not.
    if (at < 0)
      throw new Error('A scanned dynamic reference is not in the entry it was scanned from');
    out += entry.slice(cursor, at);
    const resolver =
      verdict.kind === 'recorded-region'
        ? primary.resolverForRecordedRegion(verdict.region)
        : primary;
    out += await resolver.resolveDynamicReferences(token, context);
    cursor = at + token.length;
  }
  return out + entry.slice(cursor);
}

/**
 * Whether a recorded principal list is one {@link resolveSecretDerivedPrincipals}
 * can ever resolve (go-to-k/cdkd#4150): a list of strings holding at least one
 * `{{resolve:` reference, no cdkd mask, and IAM names in every other entry. A
 * mask or a bad plain entry never resolves, so a caller neither attempts it
 * nor tells the user to "fix and re-run" the reference.
 */
export function isResolvableSecretPrincipalList(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((e) => typeof e === 'string')) return false;
  const entries = value as string[];
  const plain = entries.filter((e) => !e.includes('{{resolve:'));
  return (
    plain.length < entries.length &&
    !entries.some((e) => e.includes(SECRET_MASK)) &&
    readRecordedPrincipals(plain).kind === 'names'
  );
}

/**
 * The producer regions a destroy classifies secret references against
 * (go-to-k/cdkd#4150): the stack's own `producerRegionsFromState`, read
 * DEFENSIVELY (a hand-edited `imports` / `outputReads` that is not a list of
 * entries with a string `sourceRegion` contributes nothing rather than
 * throwing), plus any regions a parent passed down to a nested child, whose
 * own state does not record the parent's cross-region reads.
 */
export function destroyProducerRegions(
  state: { imports?: unknown; outputReads?: unknown },
  inherited: readonly string[] = []
): string[] {
  const entries = (value: unknown): Array<{ sourceRegion: string }> =>
    Array.isArray(value)
      ? value.filter(
          (e): e is { sourceRegion: string } =>
            typeof e === 'object' &&
            e !== null &&
            typeof (e as { sourceRegion?: unknown }).sourceRegion === 'string'
        )
      : [];
  const own = producerRegionsFromState({
    imports: entries(state.imports) as never,
    outputReads: entries(state.outputReads) as never,
  });
  return [...new Set([...own, ...inherited])];
}

/**
 * Whether a state record is an `AWS::IAM::Policy` / `UserToGroupAddition`
 * whose principal list a destroy may resolve ({@link isResolvableSecretPrincipalList};
 * a mask-only list never resolves): such a record is classified against the
 * stack's producer-region evidence, so a persisted partial-destroy snapshot
 * must keep that evidence while any remain (a re-run would otherwise read
 * `local` where the first run read `ambiguous`).
 */
export function holdsSecretDerivedPrincipalRecord(resource: unknown): boolean {
  return resolvablePrincipalLists(resource).length > 0;
}

/**
 * Whether such a record holds a region-less secret reference its v12
 * provenance places in no region (go-to-k/cdkd#4887): the one a nested child
 * destroyed on its own cannot resolve, since its parent's regions are unknown.
 */
export function holdsUnprovenSecretPrincipalRecord(resource: unknown): boolean {
  const lists = resolvablePrincipalLists(resource);
  if (lists.length === 0) return false;
  const recorded = recordedReferenceRegions(resource);
  return lists.some((list) =>
    list.some((entry) =>
      dynamicReferenceTokens(entry).some((t) => unprovenRegionLessToken(t, recorded))
    )
  );
}

/**
 * Whether a recorded principal value holds a token
 * {@link holdsUnprovenSecretPrincipalRecord} counts, given the record's
 * recorded regions: what an IAM delete's skip names as its cause when the
 * evidence is incomplete, rather than an access or value failure.
 */
export function holdsUnprovenSecretPrincipalToken(
  value: unknown,
  recordedRegions: ReadonlyMap<string, string> | undefined
): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (entry) =>
        typeof entry === 'string' &&
        dynamicReferenceTokens(entry).some((t) => unprovenRegionLessToken(t, recordedRegions))
    )
  );
}

/** The principal lists of `resource` that {@link isResolvableSecretPrincipalList} accepts. */
function resolvablePrincipalLists(resource: unknown): string[][] {
  if (typeof resource !== 'object' || resource === null) return [];
  const { resourceType, properties } = resource as { resourceType?: unknown; properties?: unknown };
  const keys =
    typeof resourceType === 'string' &&
    Object.prototype.hasOwnProperty.call(RESOLVED_PREVIOUS_PRINCIPAL_KEYS, resourceType)
      ? RESOLVED_PREVIOUS_PRINCIPAL_KEYS[resourceType]!
      : [];
  const props =
    typeof properties === 'object' && properties !== null
      ? (properties as Record<string, unknown>)
      : {};
  return keys
    .map((key) => props[key])
    .filter((value): value is string[] => isResolvableSecretPrincipalList(value));
}
