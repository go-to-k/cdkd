/**
 * The `NoEcho` echo-fidelity flag (go-to-k/cdkd#4656): which `NoEcho`
 * parameter coordinates a provider proved to echo exactly, read and written
 * per record (`noEchoExactEchoLeaves`); split out of `noecho.ts` (#5835 cap).
 */
import type { ResourceState } from '../../../types/state.js';
import {
  canonicalCoordinates,
  carriesSecretMask,
  maskAtCoordinates,
  noEchoCoordinatesOf,
  SECRET_MASK,
  valueAtCoordinate,
  type NoEchoCoordinate,
  type RecordedSecretValues,
} from '../../secret-redaction.js';
import type { FreshNoEchoReadback } from '../../deploy-value-equality.js';
import { getCreateOnlyPropertyPaths } from '../../../provisioning/create-only-properties.js';
import { noEchoPositionSources, type NoEchoDeps, type NoEchoRunState } from '../noecho.js';

/**
 * Read a persisted `noEchoExactEchoLeaves` field (go-to-k/cdkd#4656),
 * tolerating a malformed one as ABSENT: every entry a non-empty array of
 * object keys, since an array index never addresses an eligible leaf.
 */
export function noEchoExactEchoLeavesOf(
  record: { noEchoExactEchoLeaves?: unknown } | undefined
): string[][] | undefined {
  const field = record?.noEchoExactEchoLeaves;
  if (!Array.isArray(field)) return undefined;
  const out: string[][] = [];
  for (const entry of field) {
    if (!Array.isArray(entry) || entry.length === 0) return undefined;
    if (!entry.every((segment) => typeof segment === 'string')) return undefined;
    out.push([...(entry as string[])]);
  }
  return out;
}

/**
 * One coordinate the echo-fidelity readback may judge (go-to-k/cdkd#4656):
 * a `NoEcho` PARAMETER coordinate and the value this deploy sent there.
 */
export interface EchoFidelityCandidate {
  readonly coordinate: readonly string[];
  readonly plaintext: string;
}

/**
 * The coordinates of `coordinates` that may carry the echo-fidelity flag
 * (go-to-k/cdkd#4656), each with the value `resolved` holds there: a WHOLE
 * scalar string leaf (never a list, a number or an object, whose echo a
 * provider may reorder or retype), reached by object keys alone (an array
 * index names a position a provider may reorder), under a create-only path
 * of `createOnly` (the only properties the flag decides anything for).
 */
export function echoFidelityCandidates(
  coordinates: readonly NoEchoCoordinate[],
  resolved: Record<string, unknown>,
  createOnly: ReadonlyArray<readonly string[]>
): EchoFidelityCandidate[] {
  const out: EchoFidelityCandidate[] = [];
  for (const coordinate of coordinates) {
    if (!coordinate.every((segment): segment is string => typeof segment === 'string')) continue;
    const keys = coordinate as readonly string[];
    if (
      !createOnly.some((path) => path.length <= keys.length && path.every((s, i) => s === keys[i]))
    )
      continue;
    const plaintext = valueAtCoordinate(resolved, keys);
    if (typeof plaintext !== 'string' || carriesSecretMask(plaintext)) continue;
    out.push({ coordinate: keys, plaintext });
  }
  return out;
}

/**
 * The string a readback reports at `candidate`'s coordinate, or `undefined`
 * where it proves nothing about AWS (go-to-k/cdkd#4656). `handed` is the
 * `properties` the provider was given: only a readback handed the mask at
 * exactly that coordinate counts, so a provider that PROJECTS its read from
 * the record it was handed reports the mask there, which is no report. Nor is
 * a leaf that is missing or not a string.
 */
function reportedLeafAt(
  live: Record<string, unknown>,
  handed: Record<string, unknown>,
  candidate: EchoFidelityCandidate
): string | undefined {
  if (valueAtCoordinate(handed, candidate.coordinate) !== SECRET_MASK) return undefined;
  const leaf = valueAtCoordinate(live, candidate.coordinate);
  return typeof leaf === 'string' && !carriesSecretMask(leaf) ? leaf : undefined;
}

/**
 * Did a readback ECHO the value exactly at `candidate`'s coordinate
 * (go-to-k/cdkd#4656)? Strict string equality with what was sent, on a leaf
 * {@link reportedLeafAt} accepts as AWS's own report.
 */
export function echoesExactlyAt(
  live: Record<string, unknown>,
  handed: Record<string, unknown>,
  candidate: EchoFidelityCandidate
): boolean {
  return reportedLeafAt(live, handed, candidate) === candidate.plaintext;
}

/**
 * Does a readback PROVE the value at `candidate`'s coordinate changed
 * (go-to-k/cdkd#4656)? AWS reports a different string there, through a
 * provider already proven to echo the coordinate exactly (the caller's
 * `noEchoExactEchoLeaves` check). A projected, missing, non-string or masked
 * report proves nothing.
 */
export function provesEchoChangeAt(
  live: Record<string, unknown>,
  handed: Record<string, unknown>,
  candidate: EchoFidelityCandidate
): boolean {
  const reported = reportedLeafAt(live, handed, candidate);
  return reported !== undefined && reported !== candidate.plaintext;
}

/**
 * Record what one NoEcho readback proved about the provider's echo
 * (go-to-k/cdkd#4656): each candidate it echoed exactly. `set` replaces what
 * this deploy noted before for the resource (a create or replacement: a new
 * resource), `add` unions (a later readback that holds the value). Each
 * verdict is bound to the physical id it judged (`physicalId`): one of
 * another resource is replaced, never unioned, and the save applies it only
 * to a record of that id (a rollback restoring the old record). A failed
 * or unreadable read proves nothing: `set` leaves the resource with none,
 * `add` changes nothing. A `differs` never removes an entry.
 */
export function noteNoEchoExactEchoes(
  run: NoEchoRunState,
  logicalId: string,
  physicalId: string,
  read: FreshNoEchoReadback,
  handed: Record<string, unknown>,
  candidates: readonly EchoFidelityCandidate[],
  mode: 'set' | 'add'
): void {
  const exact =
    'failure' in read
      ? []
      : candidates
          .filter((candidate) => echoesExactlyAt(read.live, handed, candidate))
          .map((candidate) => [...candidate.coordinate]);
  const noted = run.noEchoExactEchoes.get(logicalId);
  const previous = mode === 'add' && noted?.physicalId === physicalId ? noted.coordinates : [];
  run.noEchoExactEchoes.set(logicalId, {
    physicalId,
    coordinates: sortedCoordinates([...previous, ...exact]),
  });
}

function sortedCoordinates(coordinates: readonly (readonly string[])[]): string[][] {
  const keyed = new Map<string, string[]>();
  for (const coordinate of coordinates) keyed.set(JSON.stringify(coordinate), [...coordinate]);
  return [...keyed.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => c);
}

/**
 * The echo-fidelity readback of a resource this deploy just CREATED, or
 * created as a replacement (go-to-k/cdkd#4656): `record` is the new in-memory
 * record, `resolvedProps` what was sent. The provider is handed a copy of the
 * record with `***` at every `NoEcho` parameter coordinate, never the resolved
 * bag, so only what AWS reports can match. Its verdict REPLACES what this
 * deploy noted for the logical id before (a readback of the resource it
 * replaced): a failed read leaves the new record with no entry. A resource
 * with no candidate has nothing noted either, since this deploy's readbacks
 * judge the same candidates.
 */
export async function establishNoEchoEchoFidelity(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  logicalId: string,
  record: ResourceState,
  resolvedProps: Record<string, unknown>,
  stateResources: Record<string, ResourceState>,
  secrets: RecordedSecretValues
): Promise<void> {
  run.noEchoExactEchoes.delete(logicalId);
  const templateProps = deps.perResourceTemplateProps().get(logicalId);
  const sources = noEchoPositionSources(run, stateResources);
  if (templateProps === undefined || sources === undefined || sources.parameters.size === 0) {
    return;
  }
  const coordinates = canonicalCoordinates(
    noEchoCoordinatesOf(templateProps, resolvedProps, {
      parameters: sources.parameters,
      ...(sources.conditions !== undefined && { conditions: sources.conditions }),
    })
  );
  if (coordinates.length === 0) return;
  const createOnly = await getCreateOnlyPropertyPaths(record.resourceType).catch(
    () => [] as ReadonlyArray<readonly string[]>
  );
  const candidates = echoFidelityCandidates(coordinates, resolvedProps, createOnly);
  if (candidates.length === 0) return;
  const handed = { ...record, properties: maskAtCoordinates(record.properties, coordinates) };
  const read = await deps.readReaderForFreshNoEchoCeiling(logicalId, handed, secrets);
  noteNoEchoExactEchoes(
    run,
    logicalId,
    record.physicalId,
    read,
    handed.properties,
    candidates,
    'set'
  );
}

/**
 * `record` with this deploy's echo-fidelity verdicts for `logicalId` unioned
 * into its `noEchoExactEchoLeaves` (go-to-k/cdkd#4656), for the save. The
 * save then keeps only entries still in `noEchoLeaves` (`applyNoEchoPersist`).
 */
export function withNoEchoExactEchoes(
  run: NoEchoRunState,
  logicalId: string,
  record: ResourceState
): ResourceState {
  const noted = run.noEchoExactEchoes.get(logicalId);
  if (noted === undefined || noted.coordinates.length === 0) return record;
  // A verdict on another physical resource (a rollback restored the record a
  // replacement superseded) says nothing about this one.
  if (noted.physicalId !== record.physicalId) return record;
  const merged = sortedCoordinates([
    ...(noEchoExactEchoLeavesOf(record) ?? []),
    ...noted.coordinates,
  ]);
  return { ...record, noEchoExactEchoLeaves: merged };
}
