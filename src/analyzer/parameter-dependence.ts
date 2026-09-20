/**
 * The PARAMETER-DEPENDENCE WALK: which resources of a raw template depend on
 * which template parameters (issues
 * [#2854](https://github.com/go-to-k/cdkd/issues/2854),
 * [#3468](https://github.com/go-to-k/cdkd/issues/3468)).
 *
 * Pure template analysis with two consumers that must agree: `cdkd import`'s
 * ARM 4 (`src/cli/commands/import-deployed-parameters.ts` supplies the
 * divergent parameter set from `DescribeStacks`) and `cdkd deploy`'s reading of
 * a REASON-LESS `observedBaselineRefused` marker, which has no deployed values
 * at all and therefore treats every declared parameter as divergent
 * ({@link resourcesNamingDeclaredParameter}). It lives in this layer because
 * `src/deployment` may not import from `src/cli`.
 *
 * TAINT THROUGH ANOTHER RESOURCE'S ATTRIBUTES IS FOLLOWED within one stack: the
 * walk records the target of every `Fn::GetAtt` / `${A.Attr}`, and the refused
 * set is closed over those targets. A plain `Ref` of a resource is NOT
 * followed: it yields the physical id, and a secret used as a resource NAME is
 * already disclosed by the identifier itself.
 */

import { TemplateParser } from './template-parser.js';
import type { CloudFormationTemplate } from '../types/resource.js';

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

/** {@link resourcesNamingDeclaredParameter}'s answer: a predicate, plus why it answered "yes" to everything when it did. */
export type ParameterNamingVerdict = ((logicalId: string) => boolean) & {
  readonly failedClosed: 'unreadable-template' | 'walk-threw' | undefined;
};

/**
 * The reading of a REASON-LESS `observedBaselineRefused` marker (issue
 * [#3468](https://github.com/go-to-k/cdkd/issues/3468)): which resources'
 * TEMPLATE definitions name a declared parameter, judged with NO deployed
 * values at hand — so every declared parameter anything names is divergent.
 * The answer is {@link computeParameterTaint}'s whole refused set: direct
 * dependents, unclassifiable bags, and attribute readers of either. Pseudo
 * parameters never count (the hit test intersects with DECLARED names) and
 * neither does a parameter nothing names, CDK's Rules-only `BootstrapVersion`
 * included.
 *
 * AN UNCLASSIFIABLE BAG COUNTS ONLY WHEN SOME DECLARED PARAMETER IS NAMED
 * SOMEWHERE in the template, exactly as in ARM 4, and deliberately: this set
 * has to cover what an older import's ARM 4 can have marked ON TEMPLATE
 * EVIDENCE (ARM 4 also read the state bags; a deploy's are resolved literals,
 * so they are not read here), and ARM 4 never ran on a template in which
 * nothing names a declared parameter. Counting the
 * bag regardless would make an old refusal of the other class sticky on every
 * CDK stack (each declares `BootstrapVersion`) and protect nothing.
 *
 * FAILS CLOSED, and never throws: a missing or unreadable template, a
 * `Resources` section that is not an object, or a walk that throws answers
 * `true` for every logical id, and says so in `failedClosed` — a cause CLASS,
 * never a template value or an error message. Absent from a readable
 * template's `Resources` answers `false` — that resource is being removed, and
 * a DELETE reads no baseline.
 */
export function resourcesNamingDeclaredParameter(
  template: CloudFormationTemplate | undefined
): ParameterNamingVerdict {
  const everything = (failedClosed: 'unreadable-template' | 'walk-threw'): ParameterNamingVerdict =>
    Object.assign(() => true, { failedClosed });
  try {
    if (template === undefined || template === null || typeof template !== 'object') {
      return everything('unreadable-template');
    }
    const resources: unknown = template.Resources;
    if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) {
      return everything('unreadable-template');
    }
    const parameters: unknown = template.Parameters;
    // An ABSENT section declares nothing; a present one that is not a map
    // cannot be read, which is not the same answer.
    if (
      parameters !== undefined &&
      (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters))
    ) {
      return everything('unreadable-template');
    }
    const declared = new Set(Object.keys(parameters ?? {}));
    const divergent = reachableDivergentParameters(template, declared, []);
    const refused = computeParameterTaint(template, new Map(), divergent).refused;
    return Object.assign((logicalId: string) => refused.has(logicalId), {
      failedClosed: undefined,
    });
  } catch {
    return everything('walk-threw');
  }
}
