import type { RecordedSecretValues } from './pairs.js';
import type { ReferenceProvenance } from '../../types/state.js';

/**
 * PASS-LOCAL reference provenance (state schema v12, go-to-k/cdkd#4847 /
 * go-to-k/cdkd#4852): for each `{{resolve:...}}` token a pass resolved, the
 * region that answered and the secret's own version ids (a Secrets Manager
 * `VersionId`, an SSM parameter `Version`), split by ROUTE.
 *
 * Keyed by the pass's {@link RecordedSecretValues} instance, like
 * `physicalNameCopiesOf`, so the evidence is exactly as pass-local as the map:
 * a map the resolver populated carries what THAT resolution saw, and a copy
 * starts with nothing (`mergeResolvedPairs` is the one carrier between maps).
 * Holds no value and no hash: a version id is metadata AWS returns without the
 * value, and the key is the token the record already holds.
 *
 * Read at the persist choke point only (`reference-provenance-record.ts`),
 * which writes `ResourceState.referenceProvenance` for a record this pass
 * WROTE. Nothing here decides a send.
 */
export type ReferenceRoute = 'literal' | 'read';

/** One resolution of a token, as the resolver's recording seam saw it. */
export interface ReferenceResolution {
  /** The region of the resolver that answered; `undefined` when not known. */
  region: string | undefined;
  /** The version id the lookup response carried; `undefined` when absent. */
  version: string | undefined;
  /** `read` inside a re-resolution of a recorded value, a cross-stack walk or a nested parameter. */
  route: ReferenceRoute;
}

/** Everything one pass learned about one token, before it is finalized. */
interface PassEntry {
  regions: Set<string>;
  /** Some resolution answered from a region nobody recorded. */
  regionUnknown: boolean;
  versions: Set<string>;
  /** Some resolution's response carried no version: the set is incomplete. */
  versionUnknown: boolean;
  readVersions: Set<string>;
}

const passProvenanceOf = new WeakMap<RecordedSecretValues, Map<string, PassEntry>>();

/**
 * The cap on one token's versions. A record holding more generations than this
 * (an in-place update unioning create-only generations) drops its version arm.
 */
export const MAX_REFERENCE_VERSIONS = 8;

function entryFor(secrets: RecordedSecretValues, token: string): PassEntry {
  let table = passProvenanceOf.get(secrets);
  if (table === undefined) {
    table = new Map();
    passProvenanceOf.set(secrets, table);
  }
  let entry = table.get(token);
  if (entry === undefined) {
    entry = {
      regions: new Set(),
      regionUnknown: false,
      versions: new Set(),
      versionUnknown: false,
      readVersions: new Set(),
    };
    table.set(token, entry);
  }
  return entry;
}

/**
 * Record one resolution of `token` into the pass that owns `secrets`. Called
 * beside `recordResolvedPair` at the resolver's two seams (a fresh lookup and
 * a cache hit), so the provenance and the pair never disagree about which
 * pass they belong to.
 */
export function recordReferenceResolution(
  secrets: RecordedSecretValues,
  token: string,
  resolution: ReferenceResolution
): void {
  const entry = entryFor(secrets, token);
  if (resolution.region === undefined) entry.regionUnknown = true;
  else entry.regions.add(resolution.region);
  if (resolution.version === undefined) {
    entry.versionUnknown = true;
    return;
  }
  entry.versions.add(resolution.version);
  if (resolution.route === 'read') entry.readVersions.add(resolution.version);
}

/**
 * Record a RECORDED entry (a carrier's: a nested row's inherited snapshot, a
 * child output's persisted entry, a producer's pass entry) as one more
 * resolution of `token` in `secrets`, on `route`. A missing region or version
 * arm is carried as UNKNOWN, never as "nothing", so the union it joins drops
 * that arm rather than claiming what it did not see.
 */
export function recordReferenceProvenanceEntry(
  secrets: RecordedSecretValues,
  token: string,
  provenance: ReferenceProvenance,
  route: ReferenceRoute
): void {
  const entry = entryFor(secrets, token);
  if (provenance.region === undefined) entry.regionUnknown = true;
  else entry.regions.add(provenance.region);
  if (provenance.versions === undefined || provenance.versions.length === 0) {
    entry.versionUnknown = true;
    return;
  }
  for (const version of provenance.versions) {
    entry.versions.add(version);
    if (route === 'read') entry.readVersions.add(version);
  }
  if (route === 'literal') {
    for (const version of provenance.readVersions ?? []) entry.readVersions.add(version);
  }
}

/**
 * Carry every token `from` recorded into `to`, unioned per arm. The carrier
 * `mergeResolvedPairs` calls, so the outputs bag the engine accumulates entry
 * by entry keeps the provenance with the pairs.
 */
export function mergeReferenceProvenance(
  from: RecordedSecretValues,
  to: RecordedSecretValues
): void {
  const source = passProvenanceOf.get(from);
  if (source === undefined || from === to) return;
  for (const [token, entry] of source) {
    const target = entryFor(to, token);
    for (const region of entry.regions) target.regions.add(region);
    target.regionUnknown ||= entry.regionUnknown;
    for (const version of entry.versions) target.versions.add(version);
    target.versionUnknown ||= entry.versionUnknown;
    for (const version of entry.readVersions) target.readVersions.add(version);
  }
}

/** Does the pass that owns `secrets` hold any provenance at all? O(1). */
export function hasPassProvenance(secrets: RecordedSecretValues | undefined): boolean {
  if (secrets === undefined) return false;
  const table = passProvenanceOf.get(secrets);
  return table !== undefined && table.size > 0;
}

/**
 * The finalized entry for `token` in the pass that owns `secrets`, or
 * `undefined` when the pass recorded nothing for it.
 *
 * - `region`: kept only when every resolution named the same one (two regions
 *   are a CONFLICT and drop it, as does one unknown).
 * - `versions`: kept only when every resolution carried one, sorted and
 *   deduplicated, and at most {@link MAX_REFERENCE_VERSIONS}.
 * - `readVersions`: the read-route subset, kept only beside `versions`, so
 *   `readVersions ⊆ versions` holds by construction.
 *
 * Shapes are NOT checked here; the persist writer checks them.
 */
export function passProvenanceFor(
  secrets: RecordedSecretValues | undefined,
  token: string
): ReferenceProvenance | undefined {
  if (secrets === undefined) return undefined;
  const entry = passProvenanceOf.get(secrets)?.get(token);
  if (entry === undefined) return undefined;
  return finalize(entry);
}

function finalize(entry: PassEntry): ReferenceProvenance {
  const out: ReferenceProvenance = {};
  if (!entry.regionUnknown && entry.regions.size === 1) {
    out.region = [...entry.regions][0]!;
  }
  if (
    !entry.versionUnknown &&
    entry.versions.size > 0 &&
    entry.versions.size <= MAX_REFERENCE_VERSIONS
  ) {
    out.versions = [...entry.versions].sort();
    if (entry.readVersions.size > 0) out.readVersions = [...entry.readVersions].sort();
  }
  return out;
}

/**
 * A frozen copy of every finalized entry the pass that owns `secrets` holds,
 * or `undefined` when it holds none: what a nested-stack row hands its child
 * engine (go-to-k/cdkd#4852), like `inheritedPhysicalNameCopies`.
 */
export function snapshotPassProvenance(
  secrets: RecordedSecretValues | undefined
): ReadonlyMap<string, ReferenceProvenance> | undefined {
  if (secrets === undefined) return undefined;
  const table = passProvenanceOf.get(secrets);
  if (table === undefined || table.size === 0) return undefined;
  const out = new Map<string, ReferenceProvenance>();
  for (const [token, entry] of table) out.set(token, finalize(entry));
  return out;
}
