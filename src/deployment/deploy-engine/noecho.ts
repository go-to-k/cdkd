import type { DeployEngine } from '../deploy-engine.js';
import type { SecretsRunState } from './masking.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import type { NoEchoCompareFn } from '../../analyzer/diff-calculator.js';
import {
  MIN_NEEDLE_LENGTH,
  noEchoComparison,
  canonicalCoordinates,
  carriesSecretMask,
  maskAtCoordinates,
  maskReadbackAtCoordinates,
  maskWholeValue,
  noEchoCoordinatesOf,
  noEchoLeavesOf,
  noEchoParameterPlaintextsOf,
  SECRET_MASK,
  valueAtCoordinate,
  type NoEchoCoordinate,
  type NoEchoPositionSources,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { isWrittenFromDeployedTemplate } from '../masked-property-fingerprints.js';
import { readRecordAttributes } from '../read-only-attribute-healer.js';
import { type FreshNoEchoReadback, keyOrderFreeJson } from '../deploy-value-equality.js';
import { getCreateOnlyPropertyPaths } from '../../provisioning/create-only-properties.js';
import { safeMsg } from '../../utils/display-safe.js';
import { declaresNoEcho } from '../noecho-declared.js';

/**
 * One deploy's `NoEcho` positional-arm state (go-to-k/cdkd#4043, #2449,
 * #4656, #4831): what the plain functions of this module, the masking arms
 * (`masking.ts`), the resolver context and the provisioning arms read and
 * write across one deploy.
 *
 * Replaced, not cleared in place, by `deploy()`'s per-run reset — like
 * `OutputsRunState` / `AttributeHealer` / `ProvenanceCapture`. ENGINE-instance
 * state, never module-global: one engine deploys one stack, and
 * `--stack-concurrency` runs several at once.
 */
export class NoEchoRunState {
  /**
   * Logical ids whose provider declared THIS RUN's `attributes` sensitive
   * (`ResourceCreateResult.noEchoAttributes` — issue
   * [#2274](https://github.com/go-to-k/cdkd/issues/2274)). One producer today:
   * `CustomResourceProvider`, relaying the handler's `NoEcho: true`.
   *
   * IN-RUN ONLY, and that is the whole shape of the feature rather than a
   * shortcut. `NoEcho` arrives on a RESPONSE, so cdkd knows it exactly when the
   * handler answered — this deploy — and `ResourceState` carries no durable
   * per-attribute flag to remember it by (a v9 -> v10 schema bump, issue
   * [#2449](https://github.com/go-to-k/cdkd/issues/2449)). Within the run that
   * is enough: the DAG provisions the custom resource before anything that
   * depends on it, so every dependent's resolution sees the entry. Across runs
   * the persisted `***` is the signal instead — see
   * `ResolverContext.redactedAttributeReads`.
   *
   * Reset per `deploy()`, like `perResourceSecrets`.
   *
   * `true` means the WHOLE attributes bag is sensitive (a custom resource's
   * `NoEcho` response); a SET names the sensitive members only (a nested
   * stack's `Outputs.<Key>` entries — see `NoEchoAttributesResult`).
   */
  noEchoAttributeResources = new Map<string, true | ReadonlySet<string>>();
  /**
   * go-to-k/cdkd#2449: the attributes each record of the PREVIOUS state
   * declared `NoEcho` (`ResourceState.noEchoAttributeNames`), seeded at deploy
   * start. Read-only evidence for the positional arm and the refusal's
   * wording; never a source of needles (its values are the mask).
   */
  persistedNoEchoAttributes = new Map<string, ReadonlySet<string>>();
  /**
   * go-to-k/cdkd#4043: the condition verdicts of the deploy in progress, so the
   * positional arm opens only the `Fn::If` branch the deploy selected.
   */
  noEchoConditions: Record<string, boolean> | undefined = undefined;
  /**
   * go-to-k/cdkd#4043 (review round 9): a NESTED child's parameters whose value
   * carries a `NoEcho` value its parent supplied. The child template declares
   * them plain, so they are positioned as `NoEcho` parameters here: every
   * surface the top level masks by position (records, `noEchoLeaves`,
   * outputs, the journal, the custom-resource delete skip) covers the child.
   */
  inheritedNoEchoParameters: ReadonlySet<string> = new Set();
  noEchoPhysicalIdWarned = new Set<string>();
  /**
   * go-to-k/cdkd#4043 §3.3: per resource resolved this deploy, the canonical
   * JSON of each leaf a `NoEcho` PARAMETER served it, so a HELD producer's
   * echoed attribute can be matched against a value it was given without a
   * needle (a `Number`, a value under the floor). Never persisted.
   */
  noEchoPositionedValues = new Map<string, Set<string>>();
  /**
   * go-to-k/cdkd#4656: per resource, the `NoEcho` parameter coordinates a
   * readback of THIS deploy proved its provider echoes exactly, bound to the
   * physical id that readback judged, unioned into
   * `noEchoExactEchoLeaves` at the save (`withNoEchoExactEchoes`). Coordinates
   * only, never a value.
   */
  noEchoExactEchoes = new Map<string, { physicalId: string; coordinates: string[][] }>();
  noEchoAttributeReads = new Map<string, Promise<Record<string, unknown> | undefined>>();
  /**
   * go-to-k/cdkd#4831: per logical id, the coordinates where the migration
   * witness CONFIRMED a MARKED record's stored plaintext equal to today's
   * `NoEcho` value. `noEchoLeavesFor` adds them to the record's own field on
   * its save, so the leaf persisted as `***` is also named there.
   */
  witnessConfirmedLeaves = new Map<string, (string | number)[][]>();
  /**
   * The condition-pruned template of the deploy in progress, read by
   * `redactStateForPersist` to stamp each record's `constructPath` on every
   * save. `undefined` until the template is pruned; reset per deploy.
   */
  constructPathTemplate: CloudFormationTemplate | undefined = undefined;
}

/**
 * What this module's plain functions read from the engine beyond
 * {@link NoEchoRunState}, built at each call site as `DeployEngine.noEchoDeps()`.
 * `perResourceSecrets` / `perResourceTemplateProps` /
 * `perResourceResolvedType` / `outputsRun` are REASSIGNED by every `deploy()`,
 * so they are live getters; a forwarded METHOD stays bound to the calling
 * engine.
 */
export interface NoEchoDeps {
  stackRegion: DeployEngine['stackRegion'];
  logger: Pick<DeployEngine['logger'], 'warn'>;
  providerRegistry: Pick<DeployEngine['providerRegistry'], 'getProviderFor'>;
  perResourceSecrets: () => SecretsRunState['perResourceSecrets'];
  perResourceTemplateProps: () => SecretsRunState['perResourceTemplateProps'];
  perResourceResolvedType: () => SecretsRunState['perResourceResolvedType'];
  outputsRun: () => DeployEngine['outputsRun'];
  /** `masking.ts`'s `readReaderForFreshNoEchoCeiling` with its deps bound. */
  readReaderForFreshNoEchoCeiling: (
    logicalId: string,
    currentResource: ResourceState,
    secrets: RecordedSecretValues
  ) => Promise<FreshNoEchoReadback>;
  /** `masking.ts`'s `maskForResource` with its {@link SecretsRunState} bound. */
  maskForResource: (logicalId: string, text: string) => string;
}

/** {@link noEchoPositionSources} with its {@link NoEchoRunState} bound. */
export type NoEchoPositionSourcesFn = (
  resources?: Record<string, ResourceState>,
  template?: CloudFormationTemplate,
  conditions?: Record<string, boolean>
) => NoEchoPositionSources | undefined;

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

/**
 * The `NoEcho: true` parameter names a template declares. CloudFormation
 * accepts the string `'true'` as well as the boolean.
 */
export function noEchoParameterNamesOf(
  template: Pick<CloudFormationTemplate, 'Parameters'> | undefined
): Set<string> {
  const names = new Set<string>();
  const declared = template?.Parameters;
  if (declared === null || typeof declared !== 'object') return names;
  for (const [name, definition] of Object.entries(declared)) {
    if (declaresNoEcho(definition)) names.add(name);
  }
  return names;
}

/**
 * The declared `NoEcho` attribute names of `record` (go-to-k/cdkd#2449), read
 * tolerantly: a malformed field reads as absent.
 */
export function noEchoAttributeNamesOf(record: ResourceState | undefined): string[] | undefined {
  const field = record?.noEchoAttributeNames as unknown;
  if (!Array.isArray(field) || !field.every((name) => typeof name === 'string')) return undefined;
  return field as string[];
}

/**
 * What the positional arm reads for THIS deploy (go-to-k/cdkd#4043): the
 * template's `NoEcho` parameters, its condition verdicts, and which
 * attributes serve a declared `NoEcho` value: one a provider declared in this
 * run, or one a record carries in `noEchoAttributeNames`. `undefined` before
 * the deploy has a template.
 */
export function noEchoPositionSources(
  run: NoEchoRunState,
  resources: Record<string, ResourceState> = {},
  template: CloudFormationTemplate | undefined = run.constructPathTemplate,
  conditions: Record<string, boolean> | undefined = run.noEchoConditions
): NoEchoPositionSources | undefined {
  if (template === undefined) return undefined;
  const declared = run.noEchoAttributeResources;
  return {
    parameters: new Set([...noEchoParameterNamesOf(template), ...run.inheritedNoEchoParameters]),
    attributeIsNoEcho: (logicalId, attribute) => {
      const live = declared.get(logicalId);
      if (live === true || (live !== undefined && live.has(attribute))) return true;
      const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
      if (noEchoAttributeNamesOf(record)?.includes(attribute) === true) return true;
      return run.persistedNoEchoAttributes.get(logicalId)?.has(attribute) === true;
    },
    ...(conditions !== undefined && { conditions }),
  };
}

/**
 * The `noEchoLeaves` a save writes for `record` (go-to-k/cdkd#4043), or
 * `undefined` when nothing is known about it.
 *
 * - A record this deploy WROTE from its template is recomputed from that
 *   template bag, so a property that stopped reading a `NoEcho` source loses
 *   its coordinate.
 * - A record it did not write keeps its own field: the coordinates describe
 *   the bag it holds, which today's template may not.
 * - A record with no field (a pre-v11 one) takes today's template positions,
 *   for the same logical id and type: the migration of a record this deploy
 *   did not reach. Over-masking a leaf that no longer reads one only costs
 *   the next deploy a re-send; leaving one unmasked would keep the plaintext.
 */
export function noEchoLeavesFor(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  logicalId: string,
  record: ResourceState,
  templateProps: Record<string, unknown> | undefined,
  sources: NoEchoPositionSources
): (string | number)[][] | undefined {
  if (templateProps !== undefined && isWrittenFromDeployedTemplate(record.properties)) {
    return canonicalCoordinates(noEchoCoordinatesOf(templateProps, record.properties, sources));
  }
  const existing = noEchoLeavesOf(record);
  if (existing !== undefined) {
    // Plus every leaf the migration witness confirmed this deploy (#4831).
    const confirmed = run.witnessConfirmedLeaves.get(logicalId) ?? [];
    return canonicalCoordinates([...existing, ...confirmed]);
  }
  // The bag THIS deploy resolved describes the record only when it was
  // resolved as the record's own type (a failed Type change did not write it).
  const resolvedAsSame = deps.perResourceResolvedType().get(logicalId) === record.resourceType;
  const source =
    (templateProps !== undefined && resolvedAsSame ? templateProps : undefined) ??
    templatePropertiesFor(run, logicalId, record.resourceType);
  if (source === undefined) return undefined;
  return canonicalCoordinates(noEchoCoordinatesOf(source, record.properties, sources));
}

function templatePropertiesFor(
  run: NoEchoRunState,
  logicalId: string,
  resourceType: string
): Record<string, unknown> | undefined {
  const resources = run.constructPathTemplate?.Resources;
  if (resources === undefined || !Object.hasOwn(resources, logicalId)) return undefined;
  const definition = resources[logicalId];
  if (definition?.Type !== resourceType) return undefined;
  const properties = definition.Properties as unknown;
  return properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : undefined;
}

/**
 * The `noEchoAttributeNames` a save writes for `record` (go-to-k/cdkd#2449):
 * the provider's declaration of THIS run (a whole-bag `NoEcho` names every
 * attribute it returned), unioned with every earlier name whose attribute
 * still holds the mask. `undefined` when there is neither.
 */
function noEchoAttributeNamesFor(
  run: NoEchoRunState,
  logicalId: string,
  record: ResourceState,
  carried: boolean,
  leaves: readonly NoEchoCoordinate[] | undefined
): string[] | undefined {
  const attributes = record.attributes ?? {};
  const names = new Set<string>();
  // An attribute that ECHOES the value the record holds at one of its own
  // `NoEcho` positions (a pre-v11 record still holds it in `properties`): a
  // record no provider call re-declared this deploy (held, untouched)
  // otherwise keeps the echo in the clear. Same rule as the producer-site
  // declaration: a positioned value counts for the attribute of the same
  // name, a string of needle length wherever it is embedded.
  let echoed = false;
  for (const coordinate of leaves ?? []) {
    const value = valueAtCoordinate(record.properties, coordinate);
    if (value === undefined || carriesSecretMask(value)) continue;
    for (const [name, attribute] of Object.entries(attributes)) {
      if (carriesSecretMask(attribute)) continue;
      // The physical id only names the resource (kept in the clear); an ARN
      // that merely CONTAINS the value names it too, but one EQUAL to the
      // value is the value.
      if (typeof attribute === 'string' && attribute === record.physicalId) continue;
      const sameName =
        coordinate[0] === name && keyOrderFreeJson(attribute) === keyOrderFreeJson(value);
      const embeds =
        typeof value === 'string' &&
        typeof attribute === 'string' &&
        !attribute.startsWith('arn:') &&
        value.length >= MIN_NEEDLE_LENGTH &&
        typeof attribute === 'string' &&
        attribute.includes(value);
      if (sameName || embeds) {
        names.add(name);
        echoed = true;
      }
    }
  }
  // A CARRIED record (a journal's previous state) predates this run's
  // declaration, which describes the record the run wrote.
  const declared = carried ? undefined : run.noEchoAttributeResources.get(logicalId);
  if (declared === true) {
    for (const name of Object.keys(attributes)) names.add(name);
  } else if (declared !== undefined) {
    for (const name of declared) if (Object.hasOwn(attributes, name)) names.add(name);
  }
  const prior = noEchoAttributeNamesOf(record);
  for (const name of prior ?? []) {
    if (Object.hasOwn(attributes, name) && carriesSecretMask(attributes[name])) names.add(name);
  }
  if (declared === undefined && prior === undefined && !echoed) return undefined;
  return [...names].sort();
}

/**
 * go-to-k/cdkd#5498: an attempted item name (`unsettledItems`, an index name or
 * a tag key) a `NoEcho` parameter served is `***` in the persisted record, by
 * VALUE: the names sit in no template position, and a mask-only plaintext (or
 * one under the needle floor) is not value-scanned by `scrubResourceRecord`.
 * A masked name never matches a live item (`isUsableAttemptedName`), so the
 * item it named is kept, never removed.
 */
function withNoEchoItemsMasked(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  logicalId: string,
  record: ResourceState
): ResourceState {
  const items = (record as { unsettledItems?: unknown }).unsettledItems;
  if (typeof items !== 'object' || items === null || Array.isArray(items)) return record;
  const secrets = deps.perResourceSecrets().get(logicalId);
  const plaintexts =
    secrets === undefined
      ? []
      : noEchoParameterPlaintextsOf(secrets).filter((plaintext) => plaintext !== '');
  const positioned = run.noEchoPositionedValues.get(logicalId) ?? new Set<string>();
  if (plaintexts.length === 0 && positioned.size === 0) return record;
  let changed = false;
  const masked: Record<string, unknown> = {};
  for (const [path, entries] of Object.entries(items as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      masked[path] = entries;
      continue;
    }
    masked[path] = [
      ...new Set(
        entries.map((entry) => {
          if (typeof entry !== 'string') return entry;
          const served =
            positioned.has(keyOrderFreeJson(entry)) ||
            plaintexts.some((plaintext) => entry.includes(plaintext));
          if (served) changed = true;
          return served ? '***' : entry;
        })
      ),
    ];
  }
  return changed ? ({ ...record, unsettledItems: masked } as ResourceState) : record;
}

/**
 * The `NoEcho` half of a save (go-to-k/cdkd#4043, #2449), applied to a record
 * the dynamic-reference scrub already redacted (`scrubbed`) from its
 * in-memory form (`record`, whose `properties` still hold what was resolved):
 *
 * - `properties` is masked at every {@link noEchoLeavesFor} coordinate;
 * - `observedProperties` at the same coordinates, through each list's
 *   identity field, or the whole list where none pairs them (review B4);
 * - `attributes` at every declared name, whatever the value's type or length;
 * - both fields are written, an empty set omitted.
 */
export function applyNoEchoPersist(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  logicalId: string,
  record: ResourceState,
  scrubbed: ResourceState,
  templateProps: Record<string, unknown> | undefined,
  resources: Record<string, ResourceState>,
  secrets?: RecordedSecretValues,
  carried = false
): ResourceState {
  scrubbed = withNoEchoItemsMasked(run, deps, logicalId, scrubbed);
  const sources = noEchoPositionSources(run, resources);
  if (sources === undefined) return scrubbed;
  const leaves = noEchoLeavesFor(run, deps, logicalId, record, templateProps, sources);
  const names = noEchoAttributeNamesFor(run, logicalId, record, carried, leaves);
  if (leaves === undefined && names === undefined) return scrubbed;
  const next: ResourceState = { ...scrubbed };
  if (leaves !== undefined) {
    next.properties = maskAtCoordinates(scrubbed.properties, leaves);
    if (scrubbed.observedProperties !== undefined && leaves.length > 0) {
      // Over the bag `scrubResourceRecord` already redacted (`scrubbed`).
      Object.assign(next, {
        observedProperties: maskReadbackAtCoordinates(
          scrubbed.observedProperties,
          record.properties,
          leaves
        ),
      });
    }
    if (leaves.length > 0) next.noEchoLeaves = leaves;
    else delete next.noEchoLeaves;
    // go-to-k/cdkd#4656: an echo-fidelity entry describes a coordinate the
    // record still marks, or nothing.
    const marked = new Set(leaves.map((coordinate) => JSON.stringify(coordinate)));
    const exact = (noEchoExactEchoLeavesOf(scrubbed) ?? []).filter((coordinate) =>
      marked.has(JSON.stringify(coordinate))
    );
    if (exact.length > 0) next.noEchoExactEchoLeaves = exact;
    else delete next.noEchoExactEchoLeaves;
  }
  if (names !== undefined) {
    if (scrubbed.attributes !== undefined && names.length > 0) {
      const attributes = { ...scrubbed.attributes };
      for (const name of names) {
        if (Object.hasOwn(attributes, name)) attributes[name] = maskWholeValue(attributes[name]);
      }
      next.attributes = attributes;
    }
    if (names.length > 0) next.noEchoAttributeNames = names;
    else delete next.noEchoAttributeNames;
  }
  warnNoEchoPhysicalId(run, deps, logicalId, record, secrets);
  return next;
}

/**
 * The persisted physical id stays in the clear: it is the handle every later
 * call addresses the resource by, and AWS publishes it. A value used to NAME a
 * resource is disclosed by AWS itself, so the deploy says so, once per
 * resource, naming no value.
 */
export function warnNoEchoPhysicalId(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  logicalId: string,
  record: ResourceState,
  secrets: RecordedSecretValues | undefined
): void {
  if (secrets === undefined || run.noEchoPhysicalIdWarned.has(logicalId)) return;
  const values = noEchoParameterPlaintextsOf(secrets);
  if (values.length === 0 || typeof record.physicalId !== 'string') return;
  if (!values.some((value) => record.physicalId.includes(value))) return;
  run.noEchoPhysicalIdWarned.add(logicalId);
  deps.logger.warn(
    deps.maskForResource(
      logicalId,
      safeMsg`${logicalId}: its physical id contains a NoEcho parameter value. AWS publishes a resource's name, so cdkd keeps the physical id in state as AWS returns it.`
    )
  );
}

/**
 * Remember, at deploy start, which attributes each record of the previous
 * state declared `NoEcho` (go-to-k/cdkd#2449), so a reader positioned while
 * the record is not in hand (the outputs pass) still sees the declaration.
 */
export function seedPersistedNoEchoAttributes(
  run: NoEchoRunState,
  resources: Record<string, ResourceState>
): void {
  run.persistedNoEchoAttributes = new Map();
  for (const [logicalId, record] of Object.entries(resources)) {
    const names = noEchoAttributeNamesOf(record);
    if (names !== undefined && names.length > 0) {
      run.persistedNoEchoAttributes.set(logicalId, new Set(names));
    }
  }
}

/**
 * The positional arm over a stack's OUTPUTS bag (go-to-k/cdkd#4043): an output
 * whose template value reads a `NoEcho` source persists `***`, whatever its
 * type, positioned by the same unresolved `Outputs` source the dynamic-
 * reference redaction uses. Skipped while that source is not usable.
 */
export function maskOutputsByPosition(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  outputs: Record<string, unknown>
): Record<string, unknown> {
  const sources = noEchoPositionSources(run);
  if (sources === undefined) return outputs;
  // The template's own `Outputs` values position every save, the partial
  // saves BEFORE the outputs pass included: those carry the PREVIOUS
  // record's bag, which a pre-v11 binary wrote in the clear. The outputs
  // pass's source (aliases included) refines it once usable.
  const templateValues: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, definition] of Object.entries(run.constructPathTemplate?.Outputs ?? {})) {
    templateValues[name] = (definition as { Value?: unknown } | undefined)?.Value;
  }
  if (deps.outputsRun().outputsSourceUsable) {
    for (const [name, value] of Object.entries(deps.outputsRun().outputsTemplateSource)) {
      templateValues[name] = value;
    }
  }
  const coordinates: NoEchoCoordinate[] = noEchoCoordinatesOf(templateValues, outputs, sources);
  if (coordinates.length === 0) return outputs;
  // An export ALIAS key the source does not name holds the same value as its
  // output: masked with it.
  const maskedValues = new Set(
    coordinates
      .filter((coordinate) => coordinate.length === 1 && typeof coordinate[0] === 'string')
      .map((coordinate) => keyOrderFreeJson(outputs[coordinate[0] as string]))
  );
  const aliasCoordinates: NoEchoCoordinate[] = Object.keys(outputs)
    .filter(
      (key) =>
        !Object.hasOwn(templateValues, key) &&
        outputs[key] !== undefined &&
        !carriesSecretMask(outputs[key]) &&
        maskedValues.has(keyOrderFreeJson(outputs[key]))
    )
    .map((key) => [key]);
  return maskAtCoordinates(outputs, [...coordinates, ...aliasCoordinates]);
}

/**
 * Every `Fn::GetAtt` target a template bag names: `[logicalId, attribute]`
 * pairs from `Fn::GetAtt` (both spellings) and `Fn::Sub` variables.
 */
function getAttTargetsOf(node: unknown): [string, string][] {
  const targets: [string, string][] = [];
  const seen = new Set<object>();
  const subVariable = /\$\{([^}!][^}]*)\}/g;
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const getAtt = record['Fn::GetAtt'];
    if (typeof getAtt === 'string' && getAtt.indexOf('.') > 0) {
      const dot = getAtt.indexOf('.');
      targets.push([getAtt.slice(0, dot), getAtt.slice(dot + 1)]);
    } else if (
      Array.isArray(getAtt) &&
      typeof getAtt[0] === 'string' &&
      typeof getAtt[1] === 'string'
    ) {
      targets.push([getAtt[0], getAtt[1]]);
    }
    const sub = record['Fn::Sub'];
    const text = typeof sub === 'string' ? sub : Array.isArray(sub) ? sub[0] : undefined;
    if (typeof text === 'string') {
      for (const match of text.matchAll(subVariable)) {
        const name = match[1]!.trim();
        const dot = name.indexOf('.');
        if (dot > 0) targets.push([name.slice(0, dot), name.slice(dot + 1)]);
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(node);
  return targets;
}

/**
 * The attributes a HELD producer serves its readers in this deploy
 * (go-to-k/cdkd#4043 §3.3). A producer whose record declares an attribute
 * `NoEcho` and holds `***` for it was not re-run, so a reader resolving the
 * attribute out of state gets the mask and is refused. When the producer was
 * resolved in this deploy (every reader of a `NoEcho` parameter is), its
 * attributes are read back from AWS once (the #1852 read, routed by the
 * record), and a declared attribute is served only when the value read
 * EQUALS, or embeds, a `NoEcho` value the producer was given in this deploy.
 * Anything else stays unserved, so the reader is refused as before.
 *
 * Nothing served here is written into any record: the reader's resolver
 * registers it as a fresh needle of the READER's bag, and the producer's
 * record keeps its mask.
 */
export async function noEchoAttributeOverridesFor(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  desiredProps: Record<string, unknown>,
  stateResources: Record<string, ResourceState>,
  stackName: string
): Promise<Map<string, Record<string, unknown>> | undefined> {
  const wanted = new Map<string, Set<string>>();
  for (const [logicalId, attribute] of getAttTargetsOf(desiredProps)) {
    const record = Object.hasOwn(stateResources, logicalId) ? stateResources[logicalId] : undefined;
    if (record === undefined) continue;
    if (noEchoAttributeNamesOf(record)?.includes(attribute) !== true) continue;
    if (!carriesSecretMask(record.attributes?.[attribute])) continue;
    if (!deps.perResourceSecrets().has(logicalId)) continue;
    const set = wanted.get(logicalId) ?? new Set<string>();
    set.add(attribute);
    wanted.set(logicalId, set);
  }
  if (wanted.size === 0) return undefined;
  const overrides = new Map<string, Record<string, unknown>>();
  for (const [logicalId, attributes] of wanted) {
    const record = stateResources[logicalId]!;
    let read = run.noEchoAttributeReads.get(logicalId);
    if (read === undefined) {
      read = (async () => {
        try {
          const { provider } = deps.providerRegistry.getProviderFor({
            resourceType: record.resourceType,
            properties: record.properties,
            provisionedBy: record.provisionedBy,
            previousProperties: record.properties,
          });
          const outcome = await readRecordAttributes({
            provider,
            logicalId,
            resource: record,
            stackName,
            region: deps.stackRegion,
          });
          return outcome.kind === 'read' ? outcome.attributes : undefined;
        } catch {
          return undefined;
        }
      })();
      run.noEchoAttributeReads.set(logicalId, read);
    }
    const live = await read;
    if (live === undefined) continue;
    const secrets = deps.perResourceSecrets().get(logicalId)!;
    const fresh = noEchoParameterPlaintextsOf(secrets);
    const positioned = run.noEchoPositionedValues.get(logicalId) ?? new Set<string>();
    const served: Record<string, unknown> = {};
    for (const attribute of attributes) {
      if (!Object.hasOwn(live, attribute)) continue;
      const value = live[attribute];
      const matches =
        (typeof value === 'string' &&
          fresh.some((needle) => value === needle || value.includes(needle))) ||
        (value !== undefined && positioned.has(keyOrderFreeJson(value)));
      if (matches) served[attribute] = value;
    }
    if (Object.keys(served).length > 0) overrides.set(logicalId, served);
  }
  return overrides.size > 0 ? overrides : undefined;
}

/**
 * The deploy diff's {@link NoEchoCompareFn} (go-to-k/cdkd#4043): the desired
 * side masked as the persist side writes it, positioned by THIS deploy's
 * template and verdicts, with the bound parameter values as the value arm.
 */
export function noEchoDiffComparison(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  resources: Record<string, ResourceState>,
  template: CloudFormationTemplate,
  conditions: Record<string, boolean>,
  parameterValues: Record<string, unknown>,
  stackName?: string
): NoEchoCompareFn | undefined {
  const sources = noEchoPositionSources(run, resources, template, conditions);
  if (sources === undefined) return undefined;
  const compare = noEchoComparison({
    sources,
    values: parameterValues,
    minNeedleLength: MIN_NEEDLE_LENGTH,
    publicTokens: new Set([deps.stackRegion, ...(stackName === undefined ? [] : [stackName])]),
  });
  return (input) => compare(input);
}

/**
 * The reader-promotion set of the deploy diff (go-to-k/cdkd#4043): the
 * nested-child parameters carrying a parent's fresh `NoEcho` value
 * (go-to-k/cdkd#3717), plus every parameter this template declares `NoEcho`.
 */
export function freshNoEchoParametersWithDeclared(
  inherited: ReadonlySet<string> | undefined,
  template: Pick<CloudFormationTemplate, 'Parameters'>
): ReadonlySet<string> | undefined {
  const all = new Set([...(inherited ?? []), ...noEchoParameterNamesOf(template)]);
  return all.size > 0 ? all : undefined;
}

/**
 * The {@link NoEchoCompareFn} `cdkd diff` passes (go-to-k/cdkd#4043), built
 * from the same pieces as the deploy's: the template's `NoEcho` parameters,
 * the records' declared `NoEcho` attributes, and the verdicts the diff KNOWS
 * (an `Fn::If` on an unknown one is masked as a whole, review B5).
 */
export function noEchoComparisonForTemplate(
  template: CloudFormationTemplate,
  knownConditions: Record<string, boolean> | undefined,
  values: Record<string, unknown> | undefined,
  resources: Record<string, ResourceState>,
  publicTokens?: ReadonlySet<string>,
  /** A nested child's parameters its parent fills from a `NoEcho` source. */
  inheritedNoEchoParameters?: ReadonlySet<string>
): NoEchoCompareFn | undefined {
  const parameters = new Set([
    ...noEchoParameterNamesOf(template),
    ...(inheritedNoEchoParameters ?? []),
  ]);
  const sources: NoEchoPositionSources = {
    parameters,
    attributeIsNoEcho: (logicalId, attribute) =>
      noEchoAttributeNamesOf(
        Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined
      )?.includes(attribute) === true,
    ...(knownConditions !== undefined && { conditions: knownConditions }),
  };
  const compare = noEchoComparison({
    sources,
    values: values ?? {},
    minNeedleLength: MIN_NEEDLE_LENGTH,
    ...(publicTokens !== undefined && { publicTokens }),
  });
  return (input) => compare(input);
}
