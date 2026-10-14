/**
 * The deploy engine's READ-PROVENANCE skip term (state schema v12,
 * go-to-k/cdkd#4852): which top-level properties of an UPDATE row MOVED
 * although their redacted value equals the record.
 *
 * A `{{resolve:` token does not say which value it stood for, so a reader
 * served a NEWER generation of a value it reads (a queue replaced under a
 * rotated secret in an earlier, interrupted run) compares equal to its record
 * and would be skipped, keeping the deleted resource's id. A path is moved
 * when it holds a token at a READ-DERIVED leaf and this run's read-route
 * versions for that token are not a subset of the record's `readVersions`.
 *
 * - A literal-only leaf is exempt (a rotation alone sends nothing, as in
 *   CloudFormation): a path holds the token at a read-derived leaf when its
 *   redacted value holds it MORE often than its template spells it.
 * - A token served unresolved, or only on the literal route, has no read
 *   version this run: no verdict.
 * - A record with no field, or no `readVersions` for the token, gives no
 *   verdict: the go-to-k/cdkd#4851 rule decides alone.
 */
import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ResolverContext } from '../intrinsic-resolver/context.js';
import { isDeliberateResolutionRefusal } from '../intrinsic-resolver/context.js';
import type { ReferenceProvenance, ResourceState } from '../../types/state.js';
import {
  referenceProvenanceOf,
  validateReferenceProvenance,
  withReferenceProvenance,
} from '../reference-provenance-record.js';
import { MAX_REFERENCE_VERSIONS } from '../secret-redaction/reference-provenance.js';
import { passReadVersionsFor } from '../secret-redaction/reference-provenance.js';
import type { RecordedSecretValues } from '../secret-redaction/pairs.js';

/** How often `token` occurs across `value`'s string leaves. */
function occurrences(value: unknown, token: string): number {
  if (typeof value === 'string') {
    return value.includes(token) ? value.split(token).length - 1 : 0;
  }
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += occurrences(item, token);
    return n;
  }
  if (value !== null && typeof value === 'object') {
    let n = 0;
    for (const item of Object.values(value as Record<string, unknown>)) {
      n += occurrences(item, token);
    }
    return n;
  }
  return 0;
}

/** One token whose read-route versions moved, with the paths that hold it read-derived. */
export interface MovedToken {
  token: string;
  paths: Set<string>;
  /** The record's `readVersions` for the token. */
  recorded: readonly string[];
  /** This run's read-route versions for the token. */
  served: ReadonlySet<string>;
  /** The record's region for the token, when it names one. */
  region: string | undefined;
}

/** The moved paths, and the tokens that moved them. */
export interface ReadProvenanceMoved {
  paths: Set<string>;
  tokens: MovedToken[];
}

export function readProvenanceMovedPaths(args: {
  /** The record as loaded. */
  record: unknown;
  /** The template's (unresolved) properties. */
  templateProperties: Record<string, unknown>;
  /** The resolved bag, redacted the way the skip check compares it. */
  desiredRedacted: Record<string, unknown>;
  /** This resolution's bag, whose pass provenance holds the read-route versions. */
  secrets: RecordedSecretValues | undefined;
}): ReadProvenanceMoved {
  const paths = new Set<string>();
  const tokens: MovedToken[] = [];
  const field = referenceProvenanceOf(args.record);
  if (field === undefined) return { paths, tokens };
  for (const [token, entry] of Object.entries(field)) {
    const recorded = entry.readVersions;
    if (recorded === undefined || recorded.length === 0) continue;
    const served = passReadVersionsFor(args.secrets, token);
    if (served === undefined) continue;
    if ([...served].every((version) => recorded.includes(version))) continue;
    const held = new Set<string>();
    for (const key of Object.keys(args.desiredRedacted)) {
      const count = occurrences(args.desiredRedacted[key], token);
      if (count === 0) continue;
      const spelled = Object.hasOwn(args.templateProperties, key)
        ? occurrences(args.templateProperties[key], token)
        : 0;
      if (count > spelled) held.add(key);
    }
    if (held.size === 0) continue;
    for (const key of held) paths.add(key);
    tokens.push({ token, paths: held, recorded, served, region: entry.region });
  }
  return { paths, tokens };
}

/**
 * The moved tokens whose VALUE moved too (code review of go-to-k/cdkd#4892): a
 * Secrets Manager `VersionId` changes when ANY key of a JSON secret changes,
 * so a version move alone can leave the value a `SecretString:<key>` token
 * reads unchanged, and sending (or REPLACING, at a create-only path) the
 * reader would act on an equal value, which CloudFormation never does.
 *
 * `sameValue(token, recorded, served)` reads the token at both versions and
 * answers whether the plaintexts are equal, or `undefined` when it cannot
 * tell (a version no longer readable, more than one version on a side): the
 * token then counts as moved, the fail-safe direction. Called only for a
 * reader whose served versions already moved, so an ordinary deploy makes no
 * extra lookup. The plaintexts are compared, never kept or printed.
 */
export async function confirmValueMoves(
  moved: ReadProvenanceMoved,
  sameValue: (token: MovedToken, recorded: string, served: string) => Promise<boolean | undefined>
): Promise<{ moved: ReadProvenanceMoved; unchanged: MovedToken[] }> {
  const kept: MovedToken[] = [];
  const unchanged: MovedToken[] = [];
  for (const entry of moved.tokens) {
    // Equal only when the one recorded version's value equals the value at
    // EVERY served version (a create-only union serves two generations).
    let equal: boolean | undefined = entry.recorded.length === 1 ? true : undefined;
    for (const served of entry.served) {
      if (equal !== true) break;
      equal = await sameValue(entry, entry.recorded[0]!, served);
    }
    if (equal === true) unchanged.push(entry);
    else kept.push(entry);
  }
  const paths = new Set<string>();
  for (const entry of kept) for (const key of entry.paths) paths.add(key);
  return { moved: { paths, tokens: kept }, unchanged };
}

/**
 * Read `entry.token` at `recorded` and at `served` (in the record's region for
 * it, when it names one) and say whether the plaintexts are equal; `undefined`
 * when either read fails. A throwaway bag and no provenance: nothing read here
 * reaches state, a log or the pass. The served read is the resolver's cache.
 */
export async function sameValueAtVersions(
  resolver: IntrinsicFunctionResolver,
  entry: MovedToken,
  recorded: string,
  served: string,
  base: Pick<ResolverContext, 'template' | 'resources'>
): Promise<boolean | undefined> {
  const context = (pin: string): ResolverContext => ({
    template: base.template,
    resources: base.resources,
    recordedSecretValues: new Map(),
    provenanceSuppressed: true,
    referencePins: new Map([[entry.token, pin]]),
  });
  // No recorded region: the region that answered is not known, and a version
  // id (an SSM `Version`) names a different value in another region, so no
  // verdict (security review of go-to-k/cdkd#4892): the token counts as moved.
  if (entry.region === undefined) return undefined;
  const reader = resolver.resolverForRecordedRegion(entry.region);
  try {
    const now = await reader.resolveDynamicReferences(entry.token, context(served));
    const then = await reader.resolveDynamicReferences(entry.token, context(recorded));
    if (now.includes('{{resolve:') || then.includes('{{resolve:')) return undefined;
    return now === then;
  } catch (err) {
    if (isDeliberateResolutionRefusal(err)) throw err;
    return undefined;
  }
}

/**
 * `record` with each `unchanged` token's `readVersions` set to the versions
 * this run served (joined into `versions`, at most
 * {@link MAX_REFERENCE_VERSIONS}): the reader read an equal value at them, so
 * its record is current, and the next diff must not promote it again.
 */
export function withRefreshedReadVersions(
  record: ResourceState,
  unchanged: readonly MovedToken[]
): ResourceState {
  const field = referenceProvenanceOf(record);
  if (field === undefined) return record;
  const out: Record<string, ReferenceProvenance> = { ...field };
  for (const { token, served } of unchanged) {
    const before = Object.hasOwn(field, token) ? field[token] : undefined;
    // The old READ versions are REPLACED, not unioned: they are superseded by
    // the equal value served now, and a union would grow by one version per
    // rotation of another key until the cap stopped every refresh (a reader
    // promoted on every deploy). Literal-route versions are kept.
    const previousRead = new Set(before?.readVersions ?? []);
    const versions = [
      ...new Set([
        ...(before?.versions ?? []).filter((version) => !previousRead.has(version)),
        ...served,
      ]),
    ].sort();
    if (versions.length > MAX_REFERENCE_VERSIONS) continue;
    const next = validateReferenceProvenance(token, {
      ...(before?.region !== undefined && { region: before.region }),
      versions,
      readVersions: [...served].sort(),
    });
    if (next !== undefined) out[token] = next;
  }
  return withReferenceProvenance(record, out);
}
