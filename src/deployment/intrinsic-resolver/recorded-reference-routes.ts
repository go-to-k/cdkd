/**
 * go-to-k/cdkd#4847: re-resolving a value served out of a PERSISTED record by
 * the record's own `referenceProvenance` (state schema v12). Two INDEPENDENT
 * arms, per token:
 *
 * - **region**: the region the record says resolved the token, shape-checked
 *   by the validator; otherwise the caller's default (today's proofs);
 * - **generation**: the record's single version, read by a PINNED lookup;
 *   otherwise today's physical-id proof, run in the chosen region.
 *
 * A record with no field, or no usable arm for any token, takes today's path
 * unchanged: the caller asks {@link recordedTokenRoutes} first.
 */
import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  hasReferenceProvenanceField,
  recordedProvenanceOf,
} from '../reference-provenance-record.js';
import {
  MIN_NEEDLE_LENGTH,
  dynamicReferenceTokens,
  wholeStringLeavesOf,
} from '../secret-redaction.js';
import { injectiveKey } from '../../state/record-keys.js';
import { isThrottlingError } from '../retryable-errors.js';
import {
  type ResolverContext,
  isDeliberateResolutionRefusal,
  withoutProducerRegions,
} from './context.js';

/** What a record's provenance says about one token of a served value. */
export interface RecordedTokenRoute {
  /** The recorded region; `undefined` takes the caller's default region. */
  region: string | undefined;
  /** The recorded version when it is exactly one; `undefined` takes today's generation rule. */
  pin: string | undefined;
}

/** The distinct tokens of `value`'s string leaves, in order. */
function tokensOf(value: unknown): string[] {
  const out = new Set<string>();
  for (const leaf of wholeStringLeavesOf(value)) {
    for (const token of dynamicReferenceTokens(leaf)) out.add(token);
  }
  return [...out];
}

/**
 * The route of each token of `value` by `record`'s provenance, or `undefined`
 * when no token has a recorded region or a single recorded version (no field,
 * `{}`, a malformed entry): the caller then takes today's path. O(1) for a
 * record without the field.
 */
export function recordedTokenRoutes(
  value: unknown,
  record: unknown
): Map<string, RecordedTokenRoute> | undefined {
  if (!hasReferenceProvenanceField(record)) return undefined;
  const routes = new Map<string, RecordedTokenRoute>();
  let recorded = false;
  for (const token of tokensOf(value)) {
    const entry = recordedProvenanceOf(record, token);
    const region = entry?.region;
    const pin = entry?.versions?.length === 1 ? entry.versions[0] : undefined;
    if (region !== undefined || pin !== undefined) recorded = true;
    routes.set(token, { region, pin });
  }
  return recorded ? routes : undefined;
}

/** How the caller treats a token the record gives no arm for. */
export interface RecordedRouteDefaults {
  /**
   * The region a token without a recorded one resolves in: a nested child's
   * region, or `undefined` for this resolver (its producer-region evidence
   * kept).
   */
  region: string | undefined;
  /**
   * Today's proofs for the tokens without a recorded region / version, or
   * `undefined` when the site has none (a nested `Outputs.<Key>`, re-resolved
   * at the current version in the child's region).
   */
  proofs?: {
    /** Is every listed token's region proven by today's rules? */
    regionProven: (tokens: string[]) => boolean;
    /** Logged, then the value is served as recorded. */
    onRegionUnproven: () => void;
    /** Does every listed token still resolve to text the physical id holds? */
    generationProven: (
      tokens: string[],
      routeOf: (token: string) => TokenResolution
    ) => Promise<boolean>;
    /** Logged, then the value is served as recorded. */
    onGenerationUnproven: () => void;
  };
}

/** The resolver that answers for a token, and the context it resolves in. */
export interface TokenResolution {
  resolver: IntrinsicFunctionResolver;
  context: ResolverContext;
}

/**
 * Re-resolve `value` by `routes` (from {@link recordedTokenRoutes}). Returns
 * `value` unchanged where today's path would: a token whose region no arm
 * proves, or whose generation neither a pin nor the physical-id proof does.
 */
export async function reresolveByRecordedRoutes(
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  logicalId: string,
  context: ResolverContext,
  origin: string,
  sourceKey: string | undefined,
  routes: Map<string, RecordedTokenRoute>,
  defaults: RecordedRouteDefaults
): Promise<unknown> {
  const tokens = [...routes.keys()];
  const regionOf = (token: string): string | undefined =>
    routes.get(token)?.region ?? defaults.region;
  // The REGION arm. A token without a recorded region keeps today's proofs.
  const unrouted = tokens.filter((token) => routes.get(token)?.region === undefined);
  if (defaults.proofs !== undefined && unrouted.length > 0) {
    if (!defaults.proofs.regionProven(unrouted)) {
      defaults.proofs.onRegionUnproven();
      return value;
    }
  }
  // A known region is the origin, so the producer-region evidence can only
  // re-open what it answers (the `reresolveCrossStackValue` rule).
  const routeOf = (token: string): TokenResolution => {
    const region = regionOf(token);
    return region
      ? {
          resolver: resolver.resolverForProducerRegion(region, context),
          context: withoutProducerRegions(context)!,
        }
      : { resolver, context };
  };

  // The GENERATION arm: a pinned lookup, falling back to today's rule.
  const pins = new Map<string, string>();
  for (const token of tokens) {
    const pin = routes.get(token)?.pin;
    if (pin === undefined) continue;
    const route = routeOf(token);
    const read = await readsPinnedVersion(token, pin, route);
    if (read === 'read') {
      pins.set(token, pin);
    } else if (read === 'failed' && context.provenanceCapture !== true) {
      // Once per resolver, token and pin: a record read by many readers
      // makes one failing lookup and one line (the failure is memoized).
      resolver.logger.warn(
        safeMsg`Could not read the secret version ${resolver.displayMasked(logicalId, context)} was deployed with for ${resolver.displayMasked(origin, context)} (it may have been deprecated or deleted); ${defaults.proofs === undefined ? 'serving its current value instead' : 'checking its current value against the physical id instead'}.`
      );
    }
    if (read === 'short' && defaults.proofs === undefined && context.provenanceCapture !== true) {
      // No proof here to refuse it: the current value is served, as before.
      resolver.logger.warn(
        safeMsg`Not serving ${resolver.displayMasked(origin, context)} at the secret version ${resolver.displayMasked(logicalId, context)} was deployed with: that value is shorter than four characters, so cdkd could not keep it out of state; serving its current value instead.`
      );
    }
    // `short`: a pinned plaintext under the needle floor is NOT served. The
    // value scan cannot redact it from a leaf that embeds it, and this pass
    // records no pair for it (go-to-k/cdkd#4847 security review), so it would
    // persist in plaintext. Today's rule decides instead, whose physical-id
    // proof refuses a plaintext that short.
  }
  if (defaults.proofs !== undefined) {
    const unpinned = tokens.filter((token) => !pins.has(token));
    if (unpinned.length > 0 && !(await defaults.proofs.generationProven(unpinned, routeOf))) {
      defaults.proofs.onGenerationUnproven();
      return value;
    }
  }

  const walkContext: ResolverContext =
    pins.size > 0 ? { ...context, referencePins: pins } : context;
  const regions = new Set(tokens.map((token) => regionOf(token) ?? ''));
  if (regions.size <= 1) {
    const [only] = regions;
    return await resolver.reresolveCrossStackValue(
      value,
      only || undefined,
      walkContext,
      origin,
      sourceKey
    );
  }
  // Tokens answered by different regions: each is re-resolved ALONE by its
  // own, and spliced back in place (no resolved value is re-scanned).
  return await rebuildByToken(value, async (token) =>
    String(
      await resolver.reresolveCrossStackValue(
        token,
        regionOf(token),
        walkContext,
        origin,
        undefined
      )
    )
  );
}

/** Per resolver: the `(token, pin)` reads that failed this run, so each is tried once. */
const failedPins = new WeakMap<IntrinsicFunctionResolver, Set<string>>();

/**
 * Can `token` be read at `pin` in its route? First the UNPINNED lookup the
 * generation proof would make (a cache hit when the token was resolved this
 * run), so a pin equal to the current version is answered by that one entry
 * and the token's literal route shares it; then the pinned read, a cache hit
 * in that case. Neither records provenance: the re-resolution that follows
 * does, for the value it serves. Both are THROWN, never collected into the
 * caller's abandoned units: a failed current read is no failure when the pin
 * answers, and a pin that cannot be read falls back.
 *
 * - `read`: served at the pin;
 * - `failed`: the pinned read failed (memoized per resolver; the caller warns
 *   on the first failure only), or it already failed this run (`known`);
 * - `short`: the plaintext is under {@link MIN_NEEDLE_LENGTH} (see the caller).
 *
 * A deliberate refusal still aborts.
 */
async function readsPinnedVersion(
  token: string,
  pin: string,
  { resolver, context }: TokenResolution
): Promise<'read' | 'failed' | 'known' | 'short'> {
  const key = injectiveKey(token, pin);
  let failed = failedPins.get(resolver);
  if (failed?.has(key) === true) return 'known';
  const { abandonedResolutions: _collected, ...throwing } = context;
  const quiet: ResolverContext = { ...throwing, provenanceSuppressed: true };
  try {
    await resolver.resolveDynamicReferences(token, quiet);
  } catch (err) {
    if (isDeliberateResolutionRefusal(err)) throw err;
    // The current version could not be read; the pinned read may still be.
  }
  try {
    const served = await resolver.resolveDynamicReferences(token, {
      ...quiet,
      referencePins: new Map([[token, pin]]),
    });
    return !served.includes('{{resolve:') && served.length < MIN_NEEDLE_LENGTH ? 'short' : 'read';
  } catch (err) {
    if (isDeliberateResolutionRefusal(err)) throw err;
    resolver.logger.debug(
      safeMsg`Pinned read of ${resolver.displayMasked(token, context)} failed: ${resolver.displayMasked(err instanceof Error ? err.message : String(err), context)}`
    );
    // Memoized only when DEFINITIVE: a throttle that outlived the retries may
    // answer on the next read.
    if (!isThrottlingError(err)) {
      if (failed === undefined) {
        failed = new Set();
        failedPins.set(resolver, failed);
      }
      failed.add(key);
    }
    return 'failed';
  }
}

/** `value` with every token of every string leaf replaced by `resolveToken`'s answer. */
async function rebuildByToken(
  value: unknown,
  resolveToken: (token: string) => Promise<string>
): Promise<unknown> {
  if (typeof value === 'string') {
    let out = '';
    let cursor = 0;
    for (const token of dynamicReferenceTokens(value)) {
      const at = value.indexOf(token, cursor);
      // Unreachable while the tokens come from a scan of THIS string; fail
      // closed rather than leave a token for the wrong region to answer.
      if (at < 0) {
        throw new Error(
          'Internal invariant: a scanned dynamic reference was not found in the value it was scanned from'
        );
      }
      out += value.slice(cursor, at) + (await resolveToken(token));
      cursor = at + token.length;
    }
    return out + value.slice(cursor);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length) as unknown[];
    for (let i = 0; i < value.length; i++) out[i] = await rebuildByToken(value[i], resolveToken);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    // `Object.create(null)`: a JSON-parsed record can hold an own `__proto__`
    // key (the `reresolveCrossStackValue` walk's rule).
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) out[k] = await rebuildByToken(v, resolveToken);
    return out;
  }
  return value;
}
