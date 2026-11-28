import { isMaskLeaf, holdsMaskLeaf } from '../secret-redaction/recorded-secrecy.js';
import type { DeployEngine } from '../deploy-engine.js';
import type { SecretsRunState } from './masking.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import type { NoEchoCompareFn } from '../../analyzer/diff-calculator.js';
import {
  MIN_NEEDLE_LENGTH,
  noEchoComparison,
  canonicalCoordinates,
  maskAtCoordinates,
  maskReadbackAtCoordinates,
  maskWholeValue,
  noEchoCoordinatesOf,
  noEchoLeavesOf,
  noEchoParameterPlaintextsOf,
  valueAtCoordinate,
  type NoEchoCoordinate,
  type NoEchoPositionSources,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { isWrittenFromDeployedTemplate } from '../masked-property-fingerprints.js';
import { readRecordAttributes } from '../read-only-attribute-healer.js';
import { type FreshNoEchoReadback, keyOrderFreeJson } from '../deploy-value-equality.js';
import { safeMsg } from '../../utils/display-safe.js';
import { declaresNoEcho } from '../noecho-declared.js';
import type { NoEchoValueMacs, PassedSecretMacsMember } from '../noecho-value-macs.js';
import { noEchoExactEchoLeavesOf } from './noecho/echo-fidelity.js';

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
  /**
   * go-to-k/cdkd#6146: this deploy's KMS MACs of its `NoEcho` parameter
   * values, made on the first resource that reads one (`undefined` until the
   * parameters are bound). Read by the UPDATE comparison and the save.
   */
  noEchoMacs: NoEchoValueMacs | undefined = undefined;
  /**
   * go-to-k/cdkd#6146: per logical id, the properties an update's provider
   * left UNSENT though the engine named them changed for an unconfirmed
   * `NoEcho` value (`UpdateContext.keptNoEchoOnlyProperty`, the
   * go-to-k/cdkd#6140 stop-gap). The save keeps their previous MAC entries.
   */
  noEchoMacKept = new Map<string, Set<string>>();
  /**
   * go-to-k/cdkd#6146: per logical id, the keys an in-flight update was handed.
   * A failed update leaves AWS holding either value there, so the failure
   * save drops their MAC entries (`dropFailedUpdateMacs`); a finished one
   * clears its entry.
   */
  noEchoMacSent = new Map<string, Set<string>>();
  /**
   * go-to-k/cdkd#6209: per logical id, each property's fully resolved input
   * fingerprint from its latest resolution (`noEchoMacInputBindingsFor`): the
   * UPDATE matches the record's binding against it, the save stamps it.
   */
  noEchoMacInputBindings = new Map<string, ReadonlyMap<string, string>>();
  /**
   * go-to-k/cdkd#7050: a nested child's parameters the parent passed as
   * `secret` (`passedSecretParametersOf`), MACed with the `NoEcho` ones.
   */
  passedSecretParameters: ReadonlySet<string> = new Set();
  /**
   * go-to-k/cdkd#7050: per logical id, the passed-secret MAC member of each
   * masked key from its latest resolution (`passedSecretMacEntriesFor`): what
   * the save stamps (`cdkd:passed`).
   */
  passedSecretMacEntries = new Map<string, ReadonlyMap<string, PassedSecretMacsMember>>();
  /** go-to-k/cdkd#6146: this deploy's schema write-only lookups (`macWriteOnlyKeys`). */
  macWriteOnlyLookups = new Map<string, Promise<ReadonlySet<string> | undefined>>();
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
  /**
   * `--pin-cc-api` for this resource (go-to-k/cdkd#5654): the read then stays
   * on Cloud Control, as the pinned update does. Absent: never pinned.
   */
  pinnedToCcApi?: (stackName: string, logicalId: string) => boolean;
}

/** {@link noEchoPositionSources} with its {@link NoEchoRunState} bound. */
export type NoEchoPositionSourcesFn = (
  resources?: Record<string, ResourceState>,
  template?: CloudFormationTemplate,
  conditions?: Record<string, boolean>
) => NoEchoPositionSources | undefined;

export {
  noEchoExactEchoLeavesOf,
  echoFidelityCandidates,
  echoesExactlyAt,
  provesEchoChangeAt,
  noteNoEchoExactEchoes,
  establishNoEchoEchoFidelity,
  withNoEchoExactEchoes,
} from './noecho/echo-fidelity.js';
export type { EchoFidelityCandidate } from './noecho/echo-fidelity.js';
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
 *
 * `persisted` (the bag as saved, go-to-k/cdkd#7189) also positions a leaf
 * that EMBEDS a declared `NoEcho` attribute where the containment rule
 * masked it whole; every branch reads it, so a record an older binary wrote
 * gains the coordinate on its next save.
 */
export function noEchoLeavesFor(
  run: NoEchoRunState,
  deps: NoEchoDeps,
  logicalId: string,
  record: ResourceState,
  templateProps: Record<string, unknown> | undefined,
  sources: NoEchoPositionSources,
  persisted?: unknown
): (string | number)[][] | undefined {
  const positionsOf = (template: unknown, only = false): NoEchoCoordinate[] =>
    noEchoCoordinatesOf(
      template,
      record.properties,
      sources,
      undefined,
      persisted === undefined ? undefined : { maskedAt: persisted, only }
    );
  if (templateProps !== undefined && isWrittenFromDeployedTemplate(record.properties)) {
    return canonicalCoordinates(positionsOf(templateProps));
  }
  const existing = noEchoLeavesOf(record);
  if (existing !== undefined) {
    // Plus every leaf the migration witness confirmed this deploy (#4831),
    // and every embedded leaf today's template positions where the record
    // holds the mask (#7189).
    const confirmed = run.witnessConfirmedLeaves.get(logicalId) ?? [];
    const template = templatePropertiesFor(run, logicalId, record.resourceType);
    // The walk reads the saved bag beside the template, so a leaf that is
    // not wholly the mask stops it there.
    const embedded =
      template === undefined || persisted === undefined ? [] : positionsOf(template, true);
    return canonicalCoordinates([...existing, ...confirmed, ...embedded]);
  }
  // The bag THIS deploy resolved describes the record only when it was
  // resolved as the record's own type (a failed Type change did not write it).
  const resolvedAsSame = deps.perResourceResolvedType().get(logicalId) === record.resourceType;
  const source =
    (templateProps !== undefined && resolvedAsSame ? templateProps : undefined) ??
    templatePropertiesFor(run, logicalId, record.resourceType);
  if (source === undefined) return undefined;
  return canonicalCoordinates(positionsOf(source));
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
    if (value === undefined || holdsMaskLeaf(value)) continue;
    for (const [name, attribute] of Object.entries(attributes)) {
      if (holdsMaskLeaf(attribute)) continue;
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
    if (Object.hasOwn(attributes, name) && holdsMaskLeaf(attributes[name])) names.add(name);
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
  // A positioned value is matched as a substring too, whatever its length: a
  // value under the needle floor is no needle, and over-masking only keeps an
  // item (a `***` name never matches a live one).
  const positioned = new Set<string>();
  for (const json of run.noEchoPositionedValues.get(logicalId) ?? []) {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      continue;
    }
    if (typeof value === 'string' && value !== '') positioned.add(value);
  }
  if (plaintexts.length === 0 && positioned.size === 0) return record;
  return withAttemptedItemsMasked(record, [...positioned, ...plaintexts]);
}

/**
 * go-to-k/cdkd#5498: `record` with every attempted item name
 * (`unsettledItems`) that contains one of `needles` replaced by `***`, or
 * `record` itself when none does. Shared by the deploy's persist arm and
 * `cdkd scrub`'s `NoEcho` arm.
 */
export function withAttemptedItemsMasked<R extends ResourceState>(
  record: R,
  needles: readonly string[]
): R {
  const items = (record as { unsettledItems?: unknown }).unsettledItems;
  if (typeof items !== 'object' || items === null || Array.isArray(items)) return record;
  const usable = needles.filter((needle) => needle !== '' && !isMaskLeaf(needle));
  if (usable.length === 0) return record;
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
          const served = usable.some((needle) => entry.includes(needle));
          if (served) changed = true;
          return served ? '***' : entry;
        })
      ),
    ];
  }
  return changed ? { ...record, unsettledItems: masked } : record;
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
  const leaves = noEchoLeavesFor(
    run,
    deps,
    logicalId,
    record,
    templateProps,
    sources,
    scrubbed.properties
  );
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
        !holdsMaskLeaf(outputs[key]) &&
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
    if (!holdsMaskLeaf(record.attributes?.[attribute])) continue;
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
            ...(deps.pinnedToCcApi?.(stackName, logicalId) === true && { forceCcApi: true }),
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
