/**
 * UNVERIFIABLE INPUTS for `cdkd import`'s observed-baseline refusal (issue
 * [#2854](https://github.com/go-to-k/cdkd/issues/2854)).
 *
 * `cdkd import` accepts no parameter values, so every template parameter is
 * bound to its `Default`. When the resources were deployed by a CloudFormation
 * stack, the value CloudFormation actually used can differ — and the ordinary
 * secret-carrying shape is a placeholder `Default` (`CHANGEME`) over a DEPLOYED
 * value of `{{resolve:secretsmanager:...}}`. The persisted `properties` then
 * spell no reference anywhere, the position-based redaction of the observed
 * capture has no evidence, and the decrypted readback would be persisted.
 *
 * The remedy here is deliberately PREMISE-INDEPENDENT. It never looks for a
 * `{{resolve:` opener in what `DescribeStacks` returns (AWS documents
 * `ParameterValue` as "the input value", which says the reference comes back
 * literally, but nothing in this module relies on it). It asks one question —
 * "is the deployed value PROVABLY the value this import bound?" — and treats
 * every other answer as divergent: a literal reference, the `****` a `NoEcho`
 * parameter is masked to, a value AWS resolved, a parameter missing from the
 * response, a `DescribeStacks` that failed. All of those differ from the bound
 * placeholder, so all of them refuse.
 *
 * THE DEPLOYED VALUES ARE COMPARISON-ONLY. They are never bound into the
 * resolve, never logged, never put in an error message, and never persisted:
 * binding them is the one design that would leak if AWS ever returned a
 * resolved value. {@link DeployedParameters} holds them in a `#private` field so
 * that a stray `JSON.stringify` / `util.inspect` / template literal of the
 * object renders nothing, and an SDK failure is reported by its error NAME
 * alone, because an SDK message can echo request input.
 *
 * TAINT THROUGH ANOTHER RESOURCE'S ATTRIBUTES IS FOLLOWED within one stack: the
 * walk records the target of every `Fn::GetAtt` / `${A.Attr}`, and the caller
 * closes the refused set over those targets, so a resource reading an attribute
 * of a refused resource (`{Fn::GetAtt: [SsmParam, Value]}` into a Lambda
 * environment — what CDK's `param.stringValue` emits) is refused with it. A
 * plain `Ref` of a resource is NOT followed: it yields the physical id, and a
 * secret used as a resource NAME is already disclosed by the identifier itself.
 *
 * KNOWN RESIDUAL, not followed: taint ACROSS the nested-stack boundary. A
 * parent property reading `Fn::GetAtt: [Child, Outputs.X]`, where the child's
 * output derives from a divergent CHILD parameter, is judged on the parent's
 * own parameters only — the root is resolved before any child is read.
 */

import { DescribeStacksCommand, type CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { coerceParameterTypedValue } from '../../deployment/intrinsic-function-resolver.js';
import { ssmResolvedValueType } from '../../utils/parameter-types.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import type { CloudFormationTemplate } from '../../types/resource.js';

/** Minimal logger surface this module needs. */
interface WarnLogger {
  warn(message: string): void;
}

interface DeployedParameterEntry {
  readonly value: string | undefined;
  readonly resolvedValue: string | undefined;
}

/**
 * What CloudFormation reports a stack was deployed with. Opaque on purpose:
 * the only question it answers is {@link DeployedParameters.provablyEquals}.
 */
export class DeployedParameters {
  readonly #entries: ReadonlyMap<string, DeployedParameterEntry> | undefined;

  private constructor(entries: ReadonlyMap<string, DeployedParameterEntry> | undefined) {
    this.#entries = entries;
  }

  /** `DescribeStacks` answered; `entries` is its `Parameters` list. */
  static fromDescribeStacks(
    parameters: readonly {
      ParameterKey?: string | undefined;
      ParameterValue?: string | undefined;
      ResolvedValue?: string | undefined;
    }[]
  ): DeployedParameters {
    const entries = new Map<string, DeployedParameterEntry>();
    for (const parameter of parameters) {
      if (typeof parameter.ParameterKey !== 'string') continue;
      entries.set(parameter.ParameterKey, {
        value: parameter.ParameterValue,
        resolvedValue: parameter.ResolvedValue,
      });
    }
    return new DeployedParameters(entries);
  }

  /** The deployed values could not be read: NOTHING is provable. */
  static unavailable(): DeployedParameters {
    return new DeployedParameters(undefined);
  }

  /**
   * Whether the deployed value of `name` is provably the value the import
   * BOUND. The deployed string goes through the SAME coercion the resolver
   * applied to the bound one (`Number`, `CommaDelimitedList`, `List<...>`), so
   * `'1'` equals a bound `1` and `'a, b'` equals a bound `['a', 'b']`. For an
   * SSM-typed parameter the resolver binds the RESOLVED value, so that is the
   * side compared — `ParameterValue` is only the key there.
   */
  provablyEquals(name: string, type: unknown, bound: unknown): boolean {
    const entry = this.#entries?.get(name);
    if (entry === undefined || typeof type !== 'string') return false;
    const ssmType = type.startsWith('AWS::SSM::Parameter::Value');
    const deployed = ssmType ? entry.resolvedValue : entry.value;
    if (typeof deployed !== 'string') return false;
    const comparedType = ssmType ? ssmResolvedValueType(type) : type;
    const coerced =
      comparedType === undefined ? deployed : coerceParameterTypedValue(deployed, comparedType);
    return stableEquals(coerced, bound);
  }
}

/** Structural equality for the scalar / scalar-array values a parameter binds to. */
function stableEquals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((element, index) => stableEquals(element, b[index]));
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return Number.isFinite(b) && a === String(b);
  }
  if (typeof a === 'number' || typeof b === 'number') {
    // `NaN` never proves anything: `Number('****')` is `NaN` on both sides of a
    // masked `Number` parameter whose `Default` is also unparseable.
    return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && a === b;
  }
  // A non-string scalar `Default` on a string-typed parameter (`Default: 42`
  // from YAML) is bound as-is by the resolver, while CloudFormation reports the
  // deployed value as its string form.
  if (typeof a === 'string' && typeof b === 'boolean') return a === String(b);
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

/**
 * Read the parameters a CloudFormation stack was deployed with. NEVER throws:
 * a failure returns {@link DeployedParameters.unavailable}, which makes every
 * declared parameter divergent, and warns ONCE with the error's NAME only.
 */
export async function readDeployedParameters(
  cfnStackName: string,
  cfnClient: CloudFormationClient,
  logger: WarnLogger,
  displayName: string
): Promise<DeployedParameters>;
/**
 * `absentStackIsNoSource`: the caller does not KNOW a CloudFormation stack of
 * that name exists (a plain `cdkd import`, any mode). CloudFormation's
 * "does not exist" answer then means there are no deployed values at all —
 * `undefined`, silently — rather than an unreadable stack.
 */
export async function readDeployedParameters(
  cfnStackName: string,
  cfnClient: CloudFormationClient,
  logger: WarnLogger,
  displayName: string,
  options: { absentStackIsNoSource: true }
): Promise<DeployedParameters | undefined>;
export async function readDeployedParameters(
  cfnStackName: string,
  cfnClient: CloudFormationClient,
  logger: WarnLogger,
  displayName: string,
  options?: { absentStackIsNoSource: true }
): Promise<DeployedParameters | undefined> {
  try {
    const response = await cfnClient.send(new DescribeStacksCommand({ StackName: cfnStackName }));
    const stack = response.Stacks?.[0];
    if (!stack) {
      logger.warn(unavailableWarning(displayName, 'the stack was not returned'));
      return DeployedParameters.unavailable();
    }
    return DeployedParameters.fromDescribeStacks(stack.Parameters ?? []);
  } catch (err) {
    // The message is READ here to classify, never rendered. `DescribeStacks`
    // reports a missing stack as `ValidationError: Stack with id <name> does
    // not exist`; any other `ValidationError` stays a failure.
    if (
      options?.absentStackIsNoSource === true &&
      err instanceof Error &&
      err.name === 'ValidationError' &&
      /does not exist/i.test(err.message)
    ) {
      return undefined;
    }
    // NAME ONLY. An SDK message can echo request input, and this module's
    // contract is that nothing read from — or sent to — DescribeStacks reaches
    // a log line.
    const name =
      err instanceof Error && /^[A-Za-z0-9_.]{1,80}$/.test(err.name) ? err.name : 'error';
    logger.warn(unavailableWarning(displayName, name));
    return DeployedParameters.unavailable();
  }
}

function unavailableWarning(displayName: string, reason: string): string {
  return (
    `Could not read the deployed parameter values of CloudFormation stack '${displayName}' ` +
    `(${reason}). 'cdkd import' needs the cloudformation:DescribeStacks permission to prove that ` +
    `a template parameter was deployed with its 'Default'; without it every resource that ` +
    `depends on a template parameter is imported WITHOUT an observed drift baseline. Review ` +
    `'cdkd diff' before the next 'cdkd deploy'.`
  );
}

/**
 * The declared parameters whose deployed value is NOT provably the bound one.
 * A parameter the import could not bind at all (no `Default`, an unreferenced
 * or failed SSM default, the empty fallback bag) is divergent by definition.
 */
export function divergentParameterNames(
  template: CloudFormationTemplate,
  bound: Record<string, unknown>,
  deployed: DeployedParameters
): Set<string> {
  const divergent = new Set<string>();
  const declared = template.Parameters;
  if (declared === undefined || declared === null || typeof declared !== 'object') {
    return divergent;
  }
  for (const [name, definition] of Object.entries(declared as Record<string, unknown>)) {
    const record =
      definition !== null && typeof definition === 'object'
        ? (definition as Record<string, unknown>)
        : undefined;
    const type = record?.['Type'];
    // A `NoEcho` parameter is NEVER provable: `DescribeStacks` answers `****`
    // whatever was deployed, so a `Default` that is literally `****` would
    // otherwise compare equal. The mask is the unverifiable-input signal itself.
    const noEcho = record?.['NoEcho'];
    if (noEcho === true || (typeof noEcho === 'string' && noEcho.toLowerCase() === 'true')) {
      divergent.add(name);
      continue;
    }
    // The `hasOwn` clause states the rule rather than carrying it: an unbound
    // name reads `undefined`, which `provablyEquals` never proves equal either.
    if (!Object.hasOwn(bound, name) || !deployed.provablyEquals(name, type, bound[name])) {
      divergent.add(name);
    }
  }
  return divergent;
}

/**
 * Every intrinsic the dependence walk knows how to read. An `Fn::`-prefixed
 * key OUTSIDE this list is unclassifiable: it may name a parameter in a way
 * the generic recursion cannot see, so the walk fails closed on it.
 */
const KNOWN_INTRINSICS: ReadonlySet<string> = new Set([
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Sub',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
  'Fn::ImportValue',
  'Fn::GetStackOutput',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Cidr',
]);

/** `${Name}` / `${Name.Attr}` in an `Fn::Sub` string; `${!Literal}` is an escape. */
const SUB_VARIABLE = /\$\{([^!}][^}]*)\}/g;

/** Names a raw subtree depends on, or `unclassifiable` when it cannot be read. */
export interface ParameterDependencies {
  readonly names: ReadonlySet<string>;
  /**
   * Logical ids whose ATTRIBUTES the bag reads (`Fn::GetAtt`, `${A.Attr}`). A
   * plain `Ref` of a resource is deliberately absent: it yields the physical
   * id, and following it would carry a refusal to everything that merely
   * points at a tainted resource.
   */
  readonly attributeTargets: ReadonlySet<string>;
  readonly unclassifiable: boolean;
}

/**
 * Which names (parameters, but also resources and pseudo parameters — the
 * caller intersects with the divergent set) the RAW `Properties` of a resource
 * depend on, plus its resource-level `Condition`.
 *
 * Generic by design: instead of modelling each intrinsic's argument grammar it
 * recurses into EVERY value, so a `Ref` nested in an `Fn::Join` / `Fn::Select`
 * / `Fn::Split` operand, an `Fn::FindInMap` key, or an `Fn::Sub` variable-map
 * value is found without being named. Only the three forms that name something
 * by BARE STRING need their own arm: `Ref`, `Fn::Sub`'s template text, and a
 * condition name (`Fn::If`'s first argument, and `Condition` inside the
 * `Conditions` section), which is followed transitively through
 * `template.Conditions`.
 *
 * May throw `RangeError` on a bag deeper than the call stack; the caller wraps
 * it fail-closed, like the discard walk beside it.
 */
export function collectParameterDependencies(
  properties: unknown,
  resourceCondition: unknown,
  template: CloudFormationTemplate
): ParameterDependencies {
  const names = new Set<string>();
  const attributeTargets = new Set<string>();
  const visitedConditions = new Set<string>();
  let unclassifiable = false;

  const conditions =
    template.Conditions !== null && typeof template.Conditions === 'object'
      ? (template.Conditions as Record<string, unknown>)
      : {};

  const followCondition = (name: unknown): void => {
    if (typeof name !== 'string') {
      unclassifiable = true;
      return;
    }
    if (visitedConditions.has(name)) return;
    visitedConditions.add(name);
    if (!Object.hasOwn(conditions, name)) {
      unclassifiable = true;
      return;
    }
    walk(conditions[name], true);
  };

  const walk = (node: unknown, inConditions: boolean): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const element of node) walk(element, inConditions);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'Ref') {
        if (typeof value === 'string') names.add(value);
        else unclassifiable = true;
        continue;
      }
      if (key === 'Fn::Sub') {
        const text = Array.isArray(value) ? (value as unknown[])[0] : value;
        if (typeof text !== 'string' || (Array.isArray(value) && value.length !== 2)) {
          unclassifiable = true;
        } else {
          for (const match of text.matchAll(SUB_VARIABLE)) {
            const variable = (match[1] ?? '').trim();
            names.add(variable);
            const dot = variable.indexOf('.');
            if (dot > 0) {
              names.add(variable.slice(0, dot));
              attributeTargets.add(variable.slice(0, dot));
            }
          }
        }
        if (Array.isArray(value)) walk(value[1], inConditions);
        continue;
      }
      if (key === 'Fn::GetAtt') {
        // Names the TARGET RESOURCE, so the caller can carry a refusal from a
        // parameter-tainted resource to the resources that read its attributes.
        const target = Array.isArray(value) ? (value as unknown[])[0] : value;
        if (typeof target === 'string') {
          const dot = target.indexOf('.');
          const logicalId = Array.isArray(value) || dot <= 0 ? target : target.slice(0, dot);
          names.add(logicalId);
          attributeTargets.add(logicalId);
        } else {
          unclassifiable = true;
        }
        walk(value, inConditions);
        continue;
      }
      if (key === 'Fn::If') {
        if (Array.isArray(value) && value.length === 3) {
          followCondition(value[0]);
          walk(value[1], inConditions);
          walk(value[2], inConditions);
        } else {
          unclassifiable = true;
        }
        continue;
      }
      if (key === 'Condition' && inConditions) {
        followCondition(value);
        continue;
      }
      if (key.startsWith('Fn::') && !KNOWN_INTRINSICS.has(key)) {
        unclassifiable = true;
      }
      walk(value, inConditions);
    }
  };

  walk(properties, false);
  if (resourceCondition !== undefined) followCondition(resourceCondition);
  return { names, attributeTargets, unclassifiable };
}

/**
 * The divergent parameters that ANYTHING in the template names. A declared
 * parameter nothing names cannot have shaped a resource — and CDK's
 * `BootstrapVersion` is exactly that on every default-synthesized stack: SSM
 * typed, never bound by the resolver because nothing references it, hence
 * always "divergent". Left in, it would arm the unclassifiable-shape refusal on
 * stacks whose every real parameter is proven.
 *
 * "Names" is the UNION of this module's walk and `TemplateParser`'s reference
 * scan — the same scan the resolver uses to decide an SSM-typed parameter is
 * unreferenced — so the two cannot disagree about `BootstrapVersion`. An
 * unclassifiable shape does NOT keep the whole set here: CloudFormation names a
 * parameter only through `Ref`, `Fn::Sub` text or a condition, and the generic
 * recursion reads those inside any intrinsic, known or not. A walk that THROWS
 * keeps the whole set (fail closed).
 */
export function reachableDivergentParameters(
  template: CloudFormationTemplate,
  divergent: ReadonlySet<string>,
  /** The raw property bags under judgement — the state's, which the template's mirror in production. */
  rawBags: readonly unknown[]
): Set<string> {
  if (divergent.size === 0) return new Set();
  try {
    const roots = [rawBags, template.Resources, template.Outputs, template.Conditions];
    const named = new Set(collectParameterDependencies(roots, undefined, template).names);
    const parser = new TemplateParser();
    for (const root of roots) {
      if (root === null || typeof root !== 'object') continue;
      for (const name of parser.extractReferences(root)) named.add(name);
    }
    return new Set([...divergent].filter((name) => named.has(name)));
  } catch {
    return new Set(divergent);
  }
}

/** Whether any DECLARED parameter is named by anything in the template. */
export function namesAnyDeclaredParameter(template: CloudFormationTemplate): boolean {
  const declared = template.Parameters;
  if (declared === null || typeof declared !== 'object') return false;
  const names = new Set(Object.keys(declared));
  return names.size > 0 && reachableDivergentParameters(template, names, []).size > 0;
}

/** What ARM 4 refuses in one stack, and why. */
export interface ParameterTaint {
  /** Every logical id refused: direct dependents, unclassifiable bags, and attribute readers of either. */
  readonly refused: ReadonlySet<string>;
  /** The subset refused ONLY because its bag could not be classified. */
  readonly unclassifiable: ReadonlySet<string>;
  /** The divergent parameters some refused resource names. */
  readonly parametersHit: ReadonlySet<string>;
}

/**
 * The per-stack ARM 4 verdict. Each resource is judged on its TEMPLATE
 * definition (`Properties` + `Condition`) AND on the raw bag the state record
 * carries, unioned: a record preserved by a selective merge holds a previous
 * run's RESOLVED literal (`Value: 'CHANGEME'`), which names no parameter, so
 * judging it on the state bag alone would leave nothing to carry to the
 * freshly imported resource that reads its attribute. Template resources that
 * are not in state at all are judged too, for the same reason.
 *
 * Seeds are direct dependents and unclassifiable bags (a bag that cannot be
 * read cannot be vouched for, and neither can what reads its attributes); the
 * refused set is then closed over ATTRIBUTE reads, to a fixpoint.
 */
export function computeParameterTaint(
  template: CloudFormationTemplate,
  stateBags: ReadonlyMap<string, unknown>,
  divergent: ReadonlySet<string>
): ParameterTaint {
  const refused = new Set<string>();
  const unclassifiable = new Set<string>();
  const parametersHit = new Set<string>();
  if (divergent.size === 0) return { refused, unclassifiable, parametersHit };

  const templateResources =
    template.Resources !== null && typeof template.Resources === 'object'
      ? (template.Resources as Record<string, unknown>)
      : {};
  const readers = new Map<string, Set<string>>();
  for (const logicalId of new Set([...Object.keys(templateResources), ...stateBags.keys()])) {
    const definition = Object.hasOwn(templateResources, logicalId)
      ? templateResources[logicalId]
      : undefined;
    const record =
      definition !== null && typeof definition === 'object'
        ? (definition as Record<string, unknown>)
        : {};
    try {
      const dependencies = collectParameterDependencies(
        [record['Properties'], stateBags.get(logicalId)],
        record['Condition'],
        template
      );
      readers.set(logicalId, new Set(dependencies.attributeTargets));
      const hits = [...dependencies.names].filter((name) => divergent.has(name));
      for (const name of hits) parametersHit.add(name);
      if (hits.length > 0) refused.add(logicalId);
      else if (dependencies.unclassifiable) {
        refused.add(logicalId);
        unclassifiable.add(logicalId);
      }
    } catch {
      // A bag deeper than the call stack: cannot be traversed, cannot be vouched for.
      refused.add(logicalId);
      unclassifiable.add(logicalId);
    }
  }
  for (let grew = refused.size > 0; grew;) {
    grew = false;
    for (const [logicalId, targets] of readers) {
      if (refused.has(logicalId)) continue;
      if (![...targets].some((target) => refused.has(target))) continue;
      refused.add(logicalId);
      grew = true;
    }
  }
  return { refused, unclassifiable, parametersHit };
}
