import { type DeployEngine } from '../deploy-engine.js';
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
  noEchoParameterValuesOf,
  valueAtCoordinate,
  type NoEchoCoordinate,
  type NoEchoPositionSources,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { isWrittenFromDeployedTemplate } from '../masked-property-fingerprints.js';
import { readRecordAttributes } from '../read-only-attribute-healer.js';
import { keyOrderFreeJson } from '../deploy-value-equality.js';
import { safeMsg } from '../../utils/display-safe.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    noEchoPositionSources: OmitThisParameter<typeof noEchoPositionSources>;
    /** @internal */
    noEchoLeavesFor: OmitThisParameter<typeof noEchoLeavesFor>;
    /** @internal */
    applyNoEchoPersist: OmitThisParameter<typeof applyNoEchoPersist>;
    /** @internal */
    maskOutputsByPosition: OmitThisParameter<typeof maskOutputsByPosition>;
    /** @internal */
    warnNoEchoPhysicalId: OmitThisParameter<typeof warnNoEchoPhysicalId>;
    /** @internal */
    seedPersistedNoEchoAttributes: OmitThisParameter<typeof seedPersistedNoEchoAttributes>;
    /** @internal */
    noEchoAttributeOverridesFor: OmitThisParameter<typeof noEchoAttributeOverridesFor>;
    /** @internal */
    noEchoDiffComparison: OmitThisParameter<typeof noEchoDiffComparison>;
  }
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
    const noEcho = (definition as { NoEcho?: unknown } | undefined)?.NoEcho;
    if (noEcho === true || noEcho === 'true') names.add(name);
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
  this: DeployEngine,
  resources: Record<string, ResourceState> = {},
  template: CloudFormationTemplate | undefined = this.constructPathTemplate,
  conditions: Record<string, boolean> | undefined = this.noEchoConditions
): NoEchoPositionSources | undefined {
  if (template === undefined) return undefined;
  const declared = this.noEchoAttributeResources;
  return {
    parameters: noEchoParameterNamesOf(template),
    attributeIsNoEcho: (logicalId, attribute) => {
      const live = declared.get(logicalId);
      if (live === true || (live !== undefined && live.has(attribute))) return true;
      const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
      if (noEchoAttributeNamesOf(record)?.includes(attribute) === true) return true;
      return this.persistedNoEchoAttributes.get(logicalId)?.has(attribute) === true;
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
  this: DeployEngine,
  logicalId: string,
  record: ResourceState,
  templateProps: Record<string, unknown> | undefined,
  sources: NoEchoPositionSources
): (string | number)[][] | undefined {
  if (templateProps !== undefined && isWrittenFromDeployedTemplate(record.properties)) {
    return canonicalCoordinates(noEchoCoordinatesOf(templateProps, record.properties, sources));
  }
  const existing = noEchoLeavesOf(record);
  if (existing !== undefined) return canonicalCoordinates(existing);
  // The bag THIS deploy resolved describes the record only when it was
  // resolved as the record's own type (a failed Type change did not write it).
  const resolvedAsSame = this.perResourceResolvedType.get(logicalId) === record.resourceType;
  const source =
    (templateProps !== undefined && resolvedAsSame ? templateProps : undefined) ??
    templatePropertiesFor(this, logicalId, record.resourceType);
  if (source === undefined) return undefined;
  return canonicalCoordinates(noEchoCoordinatesOf(source, record.properties, sources));
}

function templatePropertiesFor(
  engine: DeployEngine,
  logicalId: string,
  resourceType: string
): Record<string, unknown> | undefined {
  const resources = engine.constructPathTemplate?.Resources;
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
  engine: DeployEngine,
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
      // An ARN or the physical id only names the resource (kept in the clear).
      if (
        typeof attribute === 'string' &&
        (attribute.startsWith('arn:') || attribute === record.physicalId)
      ) {
        continue;
      }
      const sameName =
        coordinate[0] === name && keyOrderFreeJson(attribute) === keyOrderFreeJson(value);
      const embeds =
        typeof value === 'string' &&
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
  const declared = carried ? undefined : engine.noEchoAttributeResources.get(logicalId);
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
  this: DeployEngine,
  logicalId: string,
  record: ResourceState,
  scrubbed: ResourceState,
  templateProps: Record<string, unknown> | undefined,
  resources: Record<string, ResourceState>,
  secrets?: RecordedSecretValues,
  carried = false
): ResourceState {
  const sources = this.noEchoPositionSources(resources);
  if (sources === undefined) return scrubbed;
  const leaves = this.noEchoLeavesFor(logicalId, record, templateProps, sources);
  const names = noEchoAttributeNamesFor(this, logicalId, record, carried, leaves);
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
  this.warnNoEchoPhysicalId(logicalId, record, secrets);
  return next;
}

/**
 * The persisted physical id stays in the clear: it is the handle every later
 * call addresses the resource by, and AWS publishes it. A value used to NAME a
 * resource is disclosed by AWS itself, so the deploy says so, once per
 * resource, naming no value.
 */
export function warnNoEchoPhysicalId(
  this: DeployEngine,
  logicalId: string,
  record: ResourceState,
  secrets: RecordedSecretValues | undefined
): void {
  if (secrets === undefined || this.noEchoPhysicalIdWarned.has(logicalId)) return;
  const values = noEchoParameterValuesOf.get(secrets);
  if (values === undefined || typeof record.physicalId !== 'string') return;
  if (![...values].some((value) => record.physicalId.includes(value))) return;
  this.noEchoPhysicalIdWarned.add(logicalId);
  this.logger.warn(
    this.maskForResource(
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
  this: DeployEngine,
  resources: Record<string, ResourceState>
): void {
  this.persistedNoEchoAttributes = new Map();
  for (const [logicalId, record] of Object.entries(resources)) {
    const names = noEchoAttributeNamesOf(record);
    if (names !== undefined && names.length > 0) {
      this.persistedNoEchoAttributes.set(logicalId, new Set(names));
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
  this: DeployEngine,
  outputs: Record<string, unknown>
): Record<string, unknown> {
  if (!this.outputsSourceUsable) return outputs;
  const sources = this.noEchoPositionSources();
  if (sources === undefined) return outputs;
  const coordinates: NoEchoCoordinate[] = noEchoCoordinatesOf(
    this.outputsTemplateSource,
    outputs,
    sources
  );
  return maskAtCoordinates(outputs, coordinates);
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
  this: DeployEngine,
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
    if (!this.perResourceSecrets.has(logicalId)) continue;
    const set = wanted.get(logicalId) ?? new Set<string>();
    set.add(attribute);
    wanted.set(logicalId, set);
  }
  if (wanted.size === 0) return undefined;
  const overrides = new Map<string, Record<string, unknown>>();
  for (const [logicalId, attributes] of wanted) {
    const record = stateResources[logicalId]!;
    let read = this.noEchoAttributeReads.get(logicalId);
    if (read === undefined) {
      read = (async () => {
        try {
          const { provider } = this.providerRegistry.getProviderFor({
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
            region: this.stackRegion,
          });
          return outcome.kind === 'read' ? outcome.attributes : undefined;
        } catch {
          return undefined;
        }
      })();
      this.noEchoAttributeReads.set(logicalId, read);
    }
    const live = await read;
    if (live === undefined) continue;
    const secrets = this.perResourceSecrets.get(logicalId)!;
    const fresh = [...(noEchoParameterValuesOf.get(secrets) ?? [])];
    const positioned = this.noEchoPositionedValues.get(logicalId) ?? new Set<string>();
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
  this: DeployEngine,
  resources: Record<string, ResourceState>,
  template: CloudFormationTemplate,
  conditions: Record<string, boolean>,
  parameterValues: Record<string, unknown>,
  stackName?: string
): NoEchoCompareFn | undefined {
  const sources = this.noEchoPositionSources(resources, template, conditions);
  if (sources === undefined) return undefined;
  const compare = noEchoComparison({
    sources,
    values: parameterValues,
    minNeedleLength: MIN_NEEDLE_LENGTH,
    publicTokens: new Set([this.stackRegion, ...(stackName === undefined ? [] : [stackName])]),
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
  publicTokens?: ReadonlySet<string>
): NoEchoCompareFn | undefined {
  const parameters = noEchoParameterNamesOf(template);
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
