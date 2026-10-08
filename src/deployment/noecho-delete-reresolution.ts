import * as fs from 'node:fs';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import {
  type NoEchoCoordinate,
  type RecordedSecretValues,
  carriesSecretMask,
  carryLogOnlyValues,
  createSecretMasker,
  noEchoCoordinatesOf,
  noEchoLeavesOf,
  recordLogOnlyParameterValue,
  replaceAtCoordinates,
  valueAtCoordinate,
} from './secret-redaction.js';
import { canonicalJson } from './secret-redaction/noecho-leaves.js';
import { getLogger } from '../utils/logger.js';

/**
 * Re-resolving a record's `NoEcho` coordinates into a custom resource's
 * `Delete` payload (go-to-k/cdkd#4682).
 *
 * Schema v11 persists `***` wherever a `NoEcho` parameter served a property
 * (`ResourceState.noEchoLeaves`), so the record no longer holds what the
 * handler was created with, and a custom resource's delete is skipped rather
 * than sending the mask (`CR_NOECHO_PROPERTIES_SKIP_REASON`). A command that
 * HOLDS the template re-resolves each marked coordinate from TODAY's template
 * and the parameters it binds, as the deploy would, and the provider sends
 * that payload instead. Nothing here is persisted: the values live in this
 * object for one delete, and every text the delete prints or throws is masked
 * with {@link NoEchoDeleteValues.maskSecrets}.
 *
 * Fail-closed: a coordinate is re-resolved only when today's template still
 * reads a `NoEcho` PARAMETER at it, for a resource of the same type. A
 * coordinate an attribute fills (a producer that DECLARED it `NoEcho`) has no
 * template value and is never re-resolved; the provider keeps the skip for
 * any coordinate left without a value.
 */
export interface NoEchoDeleteValues {
  /** Today's value per re-resolved coordinate. In memory only. */
  readonly leaves: readonly { readonly coordinate: NoEchoCoordinate; readonly value: unknown }[];
  /** Masks every re-resolved value, and the `NoEcho` values read, in a text about to be printed. */
  readonly maskSecrets: (text: string) => string;
}

/** The record's `noEchoLeaves` coordinates whose value holds the mask. */
export function maskedNoEchoCoordinates(
  properties: unknown,
  recordedLeaves: readonly NoEchoCoordinate[] | undefined
): NoEchoCoordinate[] {
  return (recordedLeaves ?? []).filter((coordinate) =>
    carriesSecretMask(valueAtCoordinate(properties, coordinate))
  );
}

/**
 * The payload a delete sends: `properties` with each masked recorded
 * coordinate replaced by its re-resolved value, and the coordinates left
 * without one. `properties` itself is never mutated.
 */
export function applyNoEchoDeleteValues<T>(
  properties: T,
  recordedLeaves: readonly NoEchoCoordinate[] | undefined,
  values: NoEchoDeleteValues | undefined
): { payload: T; unresolved: NoEchoCoordinate[] } {
  const masked = maskedNoEchoCoordinates(properties, recordedLeaves);
  if (masked.length === 0) return { payload: properties, unresolved: [] };
  const byKey = new Map((values?.leaves ?? []).map((leaf) => [canonicalJson(leaf.coordinate), leaf]));
  const entries: { coordinate: NoEchoCoordinate; value: unknown }[] = [];
  const unresolved: NoEchoCoordinate[] = [];
  for (const coordinate of masked) {
    const leaf = byKey.get(canonicalJson(coordinate));
    if (leaf === undefined) unresolved.push(coordinate);
    else entries.push({ coordinate, value: leaf.value });
  }
  if (unresolved.length > 0) return { payload: properties, unresolved };
  return { payload: replaceAtCoordinates(properties, entries), unresolved };
}

/** Every scalar leaf of `value` recorded as a log-only needle of `bag`. */
function recordLeaves(bag: RecordedSecretValues, value: unknown): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const child of Object.values(value)) recordLeaves(bag, child);
    return;
  }
  recordLogOnlyParameterValue(bag, value);
}

/** The template nodes at the record's coordinates TODAY, keyed by `canonicalJson(coordinate)`. */
function templateNodesAt(
  templateProperties: unknown,
  shape: unknown,
  noEchoParameters: ReadonlySet<string>,
  conditions: Readonly<Record<string, boolean>> | undefined
): Map<string, unknown> {
  const nodes = new Map<string, unknown>();
  // PARAMETERS only: a coordinate an attribute fills has no template value.
  noEchoCoordinatesOf(
    templateProperties ?? {},
    shape,
    { parameters: noEchoParameters, ...(conditions !== undefined && { conditions }) },
    (coordinate, node) => nodes.set(canonicalJson(coordinate), node)
  );
  return nodes;
}

/**
 * The deploy's twin (a replacement deleting the resource it replaced): the
 * resource is still in the template, so the values are today's RESOLVED bag
 * at each coordinate the template still serves from a `NoEcho` parameter.
 * `secrets` is the resolution pass's bag; it is copied, never written.
 */
export function noEchoDeleteValuesFromResolved(options: {
  record: ResourceState;
  templateResource: { Type?: unknown; Properties?: unknown } | undefined;
  resolvedProperties: Record<string, unknown> | undefined;
  noEchoParameters: ReadonlySet<string>;
  conditions?: Readonly<Record<string, boolean>> | undefined;
  secrets: RecordedSecretValues;
}): NoEchoDeleteValues | undefined {
  const { record, templateResource, resolvedProperties } = options;
  const masked = maskedNoEchoCoordinates(record.properties, noEchoLeavesOf(record));
  if (masked.length === 0 || templateResource === undefined || resolvedProperties === undefined) {
    return undefined;
  }
  if (templateResource.Type !== record.resourceType) return undefined;
  const nodes = templateNodesAt(
    templateResource.Properties,
    resolvedProperties,
    options.noEchoParameters,
    options.conditions
  );
  const bag: RecordedSecretValues = new Map(options.secrets);
  carryLogOnlyValues(options.secrets, bag);
  const leaves: { coordinate: NoEchoCoordinate; value: unknown }[] = [];
  for (const coordinate of masked) {
    if (!nodes.has(canonicalJson(coordinate))) continue;
    const value = valueAtCoordinate(resolvedProperties, coordinate);
    if (value === undefined || carriesSecretMask(value)) continue;
    recordLeaves(bag, value);
    leaves.push({ coordinate, value });
  }
  if (leaves.length === 0) return undefined;
  return { leaves, maskSecrets: createSecretMasker(bag) };
}

/** Pseudo parameters a template-only resolution can answer without the stack's resources. */
const PSEUDO_PARAMETERS = new Set([
  'AWS::Region',
  'AWS::Partition',
  'AWS::URLSuffix',
  'AWS::AccountId',
  'AWS::StackName',
]);
const SUB_VARIABLE = /\$\{([^}!][^}]*)\}/g;
const PARAMETER_ONLY_INTRINSICS = new Set([
  'Ref',
  'Fn::Join',
  'Fn::Sub',
  'Fn::Select',
  'Fn::Split',
  'Fn::Base64',
]);

/**
 * Whether `node` is built from parameters, the pseudo parameters above and
 * literals alone. A destroy resolves with no resource records, so anything
 * reading a resource, a condition, another stack or a dynamic reference is
 * refused rather than guessed.
 */
function readsParametersOnly(
  node: unknown,
  declared: ReadonlySet<string>,
  refused: ReadonlySet<string>
): boolean {
  const isParameter = (name: unknown): boolean =>
    typeof name === 'string' &&
    ((declared.has(name) && !refused.has(name)) || PSEUDO_PARAMETERS.has(name));
  const walk = (value: unknown): boolean => {
    if (typeof value === 'string') return !value.includes('{{resolve:');
    if (value === null || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every(walk);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const intrinsic =
      keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::')) ? keys[0]! : undefined;
    if (keys.includes('Condition')) return false;
    if (intrinsic === undefined) return Object.values(record).every(walk);
    if (!PARAMETER_ONLY_INTRINSICS.has(intrinsic)) return false;
    const argument = record[intrinsic];
    if (intrinsic === 'Ref') return isParameter(argument);
    if (intrinsic === 'Fn::Sub') {
      const [text, variables] = Array.isArray(argument) ? argument : [argument, undefined];
      if (typeof text !== 'string' || text.includes('{{resolve:')) return false;
      const local =
        variables !== null && typeof variables === 'object' && !Array.isArray(variables)
          ? (variables as Record<string, unknown>)
          : undefined;
      if (Array.isArray(argument) && argument.length === 2 && local === undefined) return false;
      for (const match of text.matchAll(SUB_VARIABLE)) {
        const name = match[1]!;
        if (local !== undefined && Object.hasOwn(local, name)) continue;
        if (!isParameter(name)) return false;
      }
      return local === undefined || Object.values(local).every(walk);
    }
    return walk(argument);
  };
  return walk(node);
}

/** What a destroy re-resolves from: one stack's synthesized template and the values it binds. */
export interface TemplateNoEchoReresolverOptions {
  template: CloudFormationTemplate;
  stackName: string;
  region: string;
  /** Child template files one level below this stack, by logical id (`StackInfo.nestedTemplates`). */
  nestedTemplates?: Readonly<Record<string, string>> | undefined;
  /** A nested child's parameter values, from its parent's row. Absent at the top level. */
  parameters?: Record<string, string> | undefined;
  /** A child's parameters whose value carries a parent's `NoEcho` value. */
  inheritedNoEchoParameters?: ReadonlySet<string> | undefined;
  /** A child's parameters the parent could not re-resolve (still the mask): never read. */
  maskedParameters?: ReadonlySet<string> | undefined;
  /** The parent's log-only needles, so the child's masks cover what it was handed. */
  inheritedSecrets?: RecordedSecretValues | undefined;
}

/**
 * The template-holding source a `cdkd destroy` threads to its deletes
 * (go-to-k/cdkd#4682). `cdkd state destroy` holds no template and builds none,
 * so its deletes keep the skip. Every failure (an unbindable parameter, an
 * unreadable child template, a resolution error) answers "nothing re-resolved"
 * and is logged at debug WITHOUT the error text, which can carry a value.
 */
export class TemplateNoEchoReresolver {
  private readonly logger = getLogger().child('NoEchoDeleteReresolution');
  private readonly resolver: IntrinsicFunctionResolver;
  private parametersPromise: Promise<Record<string, unknown> | undefined> | undefined;
  private readonly noEchoParameters: ReadonlySet<string>;
  private readonly options: TemplateNoEchoReresolverOptions;

  constructor(options: TemplateNoEchoReresolverOptions) {
    this.options = options;
    this.resolver = new IntrinsicFunctionResolver(options.region);
    const declared = new Set<string>();
    const section = options.template.Parameters;
    if (section !== null && typeof section === 'object') {
      for (const [name, definition] of Object.entries(section)) {
        const noEcho = (definition as { NoEcho?: unknown } | undefined)?.NoEcho;
        if (noEcho === true || noEcho === 'true') declared.add(name);
      }
    }
    for (const name of options.inheritedNoEchoParameters ?? []) declared.add(name);
    this.noEchoParameters = declared;
  }

  /** A template a macro would rewrite is not what was deployed: never re-resolved from. */
  static usable(template: CloudFormationTemplate | undefined): template is CloudFormationTemplate {
    return (
      template !== undefined &&
      template !== null &&
      typeof template === 'object' &&
      (template as { Transform?: unknown }).Transform === undefined
    );
  }

  private newBag(): RecordedSecretValues {
    const bag: RecordedSecretValues = new Map(this.options.inheritedSecrets ?? []);
    if (this.options.inheritedSecrets !== undefined) {
      carryLogOnlyValues(this.options.inheritedSecrets, bag);
    }
    return bag;
  }

  private boundParameters(): Promise<Record<string, unknown> | undefined> {
    this.parametersPromise ??= this.resolver
      .resolveParameters(this.options.template, this.options.parameters, {
        inheritedSecrets: this.newBag(),
      })
      .catch(() => {
        this.logger.debug(
          `Could not bind the parameters of ${this.options.stackName}'s template; NoEcho ` +
            `coordinates are not re-resolved for its custom resources' deletes.`
        );
        return undefined;
      });
    return this.parametersPromise;
  }

  /**
   * Today's values at `record`'s masked `noEchoLeaves` coordinates, or
   * `undefined` when none could be re-resolved. A partial answer is returned
   * as such: the provider skips while any masked coordinate lacks a value.
   */
  async valuesFor(logicalId: string, record: ResourceState): Promise<NoEchoDeleteValues | undefined> {
    const masked = maskedNoEchoCoordinates(record.properties, noEchoLeavesOf(record));
    if (masked.length === 0) return undefined;
    const resources = this.options.template.Resources as Record<string, unknown> | undefined;
    const templateResource =
      resources !== undefined && Object.hasOwn(resources, logicalId)
        ? (resources[logicalId] as { Type?: unknown; Properties?: unknown } | undefined)
        : undefined;
    if (templateResource?.Type !== record.resourceType) return undefined;
    const parameters = await this.boundParameters();
    if (parameters === undefined) return undefined;

    const nodes = templateNodesAt(
      templateResource.Properties,
      record.properties,
      this.noEchoParameters,
      undefined
    );
    const declared = new Set(Object.keys(this.options.template.Parameters ?? {}));
    const refused = this.options.maskedParameters ?? new Set<string>();
    const bag = this.newBag();
    for (const name of this.noEchoParameters) {
      if (Object.hasOwn(parameters, name)) recordLogOnlyParameterValue(bag, parameters[name]);
    }
    const leaves: { coordinate: NoEchoCoordinate; value: unknown }[] = [];
    for (const coordinate of masked) {
      const key = canonicalJson(coordinate);
      if (!nodes.has(key)) continue;
      const node = nodes.get(key);
      if (!readsParametersOnly(node, declared, refused)) continue;
      let value: unknown;
      try {
        value = await this.resolver.resolve(structuredClone(node), {
          template: this.options.template,
          resources: {},
          parameters,
          stackName: this.options.stackName,
          recordedSecretValues: bag,
        });
      } catch {
        this.logger.debug(
          `Could not re-resolve a NoEcho coordinate of ${logicalId} from today's template.`
        );
        continue;
      }
      if (value === undefined || carriesSecretMask(value)) continue;
      recordLeaves(bag, value);
      leaves.push({ coordinate, value });
    }
    if (leaves.length === 0) return undefined;
    return { leaves, maskSecrets: createSecretMasker(bag) };
  }

  /**
   * The source a nested-stack row's CHILD destroy re-resolves from: its
   * template (this stack's `nestedTemplates` entry) and the parameters this
   * row hands it, with each masked `Parameters` coordinate re-resolved here.
   * `load` and `extractParameters` are the nested-stack provider's own, so the
   * child binds exactly what a deploy would hand it.
   */
  async forNestedChild(
    logicalId: string,
    row: {
      properties: Record<string, unknown> | undefined;
      noEchoLeaves: readonly NoEchoCoordinate[] | undefined;
      values: NoEchoDeleteValues | undefined;
    },
    childStackName: string,
    load: (templatePath: string) => {
      template: CloudFormationTemplate;
      nestedTemplates: Record<string, string>;
    },
    extractParameters: (properties: Record<string, unknown>) => Record<string, string>
  ): Promise<TemplateNoEchoReresolver | undefined> {
    const nested = this.options.nestedTemplates;
    const templatePath =
      nested !== undefined && Object.hasOwn(nested, logicalId) ? nested[logicalId] : undefined;
    if (templatePath === undefined || !fs.existsSync(templatePath)) return undefined;
    try {
      const child = load(templatePath);
      if (!TemplateNoEchoReresolver.usable(child.template)) return undefined;
      const leaves = row.noEchoLeaves ?? [];
      // A partial answer is used as such: the re-resolved coordinates go in,
      // the rest stay the mask and are refused to every child read below.
      const parameters = extractParameters(
        replaceAtCoordinates(row.properties ?? {}, row.values?.leaves ?? [])
      );
      const inherited = new Set<string>();
      const masked = new Set<string>();
      for (const coordinate of leaves) {
        if (coordinate.length >= 2 && coordinate[0] === 'Parameters') {
          inherited.add(String(coordinate[1]));
        }
      }
      for (const [name, value] of Object.entries(parameters)) {
        if (carriesSecretMask(value)) masked.add(name);
      }
      const inheritedSecrets = this.newBag();
      for (const name of inherited) {
        if (!masked.has(name) && Object.hasOwn(parameters, name)) {
          recordLogOnlyParameterValue(inheritedSecrets, parameters[name]);
        }
      }
      return new TemplateNoEchoReresolver({
        template: child.template,
        stackName: childStackName,
        region: this.options.region,
        nestedTemplates: child.nestedTemplates,
        parameters,
        inheritedNoEchoParameters: inherited,
        maskedParameters: masked,
        inheritedSecrets,
      });
    } catch {
      this.logger.debug(
        `Could not load nested stack ${logicalId}'s template to re-resolve its NoEcho values.`
      );
      return undefined;
    }
  }
}
