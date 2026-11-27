import { AsyncLocalStorage } from 'node:async_hooks';
import type { CloudFormationTemplate } from '../../types/resource.js';
import { MIN_NEEDLE_LENGTH, type RecordedSecretValues } from '../secret-redaction.js';
import { logOnlyValuesOf } from '../secret-redaction/log-only.js';
import { attributionRefusedParameters } from '../secret-redaction/nested-stack/parameter-tables.js';
import { literalTextHoldsSubFloorSecret } from '../secret-redaction/positions.js';
import { readsNoEchoSource } from '../secret-redaction/noecho-leaves.js';
import { boundPrintingBags } from '../resource-secrets-scope.js';
import {
  mixesDynamicReference,
  taintedNamesOf,
} from '../../cli/commands/diff-recursive/passed-secret-display.js';
import type { ResolverContext } from './support.js';

/**
 * go-to-k/cdkd#7077: which resolver log OPERANDS must print as `***` whatever
 * their length, decided by PROVENANCE, never by the value scan.
 *
 * The masker (`maskSecretsInText`) skips an embedded needle under
 * `MIN_NEEDLE_LENGTH`, so a 1-3 character piece of a parameter mixing a secret
 * (`q7` out of `q7/{{resolve:ssm-secure:/app/a}}`, where `q7` is also another
 * secret's plaintext) printed on every `Resolved Fn::Select` / `Fn::Join` /
 * `Fn::FindInMap` / `Fn::Base64` / `Parameter Y` line. Only the resolver knows,
 * per resolution, that an operand derives from such a parameter, so the
 * resolver's one operand render (`logOperand` in `masking-display.ts`) asks
 * {@link operandDisplayTainted} first.
 *
 * Display only. Nothing here changes a resolved value or a comparison: the
 * scope below carries one boolean per intrinsic call and is read by log
 * renders alone.
 */

/** A parameter value's string leaves (a list parameter is an array). */
function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((leaf): leaf is string => typeof leaf === 'string');
  return [];
}

/** Every bag a resolution can see: its own, the parent's, and the log sink's. */
function visibleBags(context: ResolverContext | undefined): RecordedSecretValues[] {
  const bags: RecordedSecretValues[] = [];
  if (context?.recordedSecretValues !== undefined) bags.push(context.recordedSecretValues);
  if (context?.inheritedSecrets !== undefined) bags.push(context.inheritedSecrets);
  if (context?.printingSecrets !== undefined) bags.push(context.printingSecrets);
  bags.push(...boundPrintingBags());
  return bags;
}

/** Is `text` WHOLE a sub-floor log-only needle one of `bags` recorded? */
function isRecordedSubFloorValue(text: string, bags: readonly RecordedSecretValues[]): boolean {
  if (text === '' || text.length >= MIN_NEEDLE_LENGTH) return false;
  return bags.some((bag) => logOnlyValuesOf.get(bag)?.has(text) === true);
}

/**
 * Is parameter `name`, bound to `value`, a source of display taint? Three
 * provenances, each recorded by an earlier stage, none inferred from the text
 * alone:
 *
 * - on a pass that leaves secret references unresolved (`cdkd diff`'s
 *   `skipDynamicReferences`), the value MIXES a dynamic reference with other
 *   text (go-to-k/cdkd#7068's `mixesDynamicReference`); a deploy resolves
 *   that reference and masks it by position;
 * - the parent marked it `sub-floor` (go-to-k/cdkd#7050's
 *   `attributionRefusedParameters`) and it holds a sub-floor secret's text;
 * - the value IS, whole, a sub-floor secret value a visible bag recorded: a
 *   grandchild's parameter fed the piece, which the parent recorded as a
 *   log-only needle of the child's subtree (go-to-k/cdkd#7068's
 *   `passedSecretNeedles`). A log-only needle has no position twins, so the
 *   value scan masks it only whole; a recorded PAIR keeps the positional mask
 *   it already has (`port:***`, go-to-k/cdkd#3100);
 * - the value EMBEDS a parent-resolved secret at or above the floor (an
 *   inherited pair): the child holds it as plain text, with no substitution
 *   span, so a `Fn::Split` / `Fn::Select` piece of it matches no needle.
 */
export function parameterDisplayTainted(
  name: string,
  value: unknown,
  context: ResolverContext | undefined
): boolean {
  const leaves = stringLeaves(value);
  if (leaves.length === 0) return false;
  if (
    context?.skipDynamicReferences === true &&
    leaves.some((leaf) => mixesDynamicReference(leaf))
  ) {
    return true;
  }
  const inherited = context?.inheritedSecrets;
  if (
    inherited !== undefined &&
    attributionRefusedParameters.get(inherited)?.get(name) === 'sub-floor' &&
    leaves.some((leaf) => literalTextHoldsSubFloorSecret(leaf, inherited))
  ) {
    return true;
  }
  if (inherited !== undefined && leaves.some((leaf) => embedsInheritedSecret(leaf, inherited))) {
    return true;
  }
  const bags = visibleBags(context);
  return leaves.some((leaf) => isRecordedSubFloorValue(leaf, bags));
}

/** Does `text` hold an inherited secret's plaintext at or above the floor? */
function embedsInheritedSecret(text: string, inherited: RecordedSecretValues): boolean {
  for (const plaintext of inherited.keys()) {
    if (plaintext.length >= MIN_NEEDLE_LENGTH && text.includes(plaintext)) return true;
  }
  return false;
}

/** `taintedNamesOf` per template, keyed by the tainted parameter set. */
const namesByTemplate = new WeakMap<CloudFormationTemplate, Map<string, ReadonlySet<string>>>();

/**
 * Every name of `context.template` an operand derives display taint from: the
 * tainted parameters, then go-to-k/cdkd#7068's fixed point over them
 * (`taintedNamesOf`: each nested row composing a reference with other text,
 * and each resource reading a tainted name). Empty when nothing qualifies,
 * which is every ordinary run.
 */
export function displayTaintedNames(context: ResolverContext | undefined): ReadonlySet<string> {
  const template = context?.template;
  if (context === undefined || template === undefined) return EMPTY;
  // Once per resolution context: `resolveValue` asks at every intrinsic call,
  // and every input below is fixed before the walk starts.
  const memo = namesByContext.get(context);
  if (memo !== undefined) return memo;
  const names = computeTaintedNames(context, template);
  namesByContext.set(context, names);
  return names;
}

const namesByContext = new WeakMap<ResolverContext, ReadonlySet<string>>();

function computeTaintedNames(
  context: ResolverContext,
  template: CloudFormationTemplate
): ReadonlySet<string> {
  const passed: string[] = [];
  for (const [name, value] of Object.entries(context.parameters ?? {})) {
    if (parameterDisplayTainted(name, value, context)) passed.push(name);
  }
  const key = passed.sort().join('\u0000');
  let byKey = namesByTemplate.get(template);
  if (byKey === undefined) {
    byKey = new Map();
    namesByTemplate.set(template, byKey);
  }
  let names = byKey.get(key);
  if (names === undefined) {
    names = taintedNamesOf(template, new Set(passed));
    byKey.set(key, names);
  }
  return names;
}

const EMPTY: ReadonlySet<string> = new Set();

/** The innermost intrinsic call being resolved, and whether it reads a tainted name. */
const scope = new AsyncLocalStorage<{ readonly node: object; readonly tainted: boolean }>();

/** Is `node` the innermost call on the display scope (already opened)? */
export function displayScopeOpenFor(node: object): boolean {
  return scope.getStore()?.node === node;
}

/**
 * Run `resolve` with `node` as the innermost display scope, flagged when the
 * node READS a tainted name (`Ref` / `${Name}` / `Fn::GetAtt`, through any
 * intrinsic beneath it). `undefined` when the template has no tainted name,
 * so an ordinary run opens no scope at all.
 */
export function withDisplayScope<T>(
  node: object,
  context: ResolverContext,
  resolve: () => Promise<T>
): Promise<T> | undefined {
  const names = displayTaintedNames(context);
  if (names.size === 0) return undefined;
  const tainted = readsNoEchoSource(node, {
    parameters: names,
    attributeIsNoEcho: (logicalId) => names.has(logicalId),
  });
  return scope.run({ node, tainted }, resolve);
}

/** What a log render knows about the operand it prints. */
export interface OperandProvenance {
  /** The template parameter the operand is the bound value of (the binding lines). */
  readonly parameter?: { readonly name: string; readonly value: unknown };
}

/**
 * Must the operand print as `***`? True when the innermost intrinsic call
 * being resolved reads a tainted name ({@link withDisplayScope}), or the
 * operand is a tainted parameter's bound value. A root value the resolver
 * itself built around a secret reference needs neither: the value scan
 * already masks it by the substitution's position (go-to-k/cdkd#3100).
 */
export function operandDisplayTainted(
  context: ResolverContext | undefined,
  provenance: OperandProvenance = {}
): boolean {
  if (scope.getStore()?.tainted === true) return true;
  const parameter = provenance.parameter;
  if (
    parameter !== undefined &&
    parameterDisplayTainted(parameter.name, parameter.value, context)
  ) {
    return true;
  }
  return false;
}
