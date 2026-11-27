import { AsyncLocalStorage } from 'node:async_hooks';
import type { CloudFormationTemplate } from '../../types/resource.js';
import { MIN_NEEDLE_LENGTH, type RecordedSecretValues } from '../secret-redaction.js';
import { logOnlyValuesOf, recordLogOnlyValue } from '../secret-redaction/log-only.js';
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
 * - the value EMBEDS a parent-resolved secret at or above the floor beside
 *   other text (an inherited pair): the child holds it as plain text, with
 *   no substitution span, so a `Fn::Split` / `Fn::Select` piece of it
 *   matches no needle.
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

/**
 * Does `text` EMBED an inherited secret's plaintext (at or above the floor)
 * beside other text? A text that IS the plaintext is masked piece by piece
 * already (the whole-source arm of `Fn::Split`, go-to-k/cdkd#3100).
 */
function embedsInheritedSecret(text: string, inherited: RecordedSecretValues): boolean {
  for (const plaintext of inherited.keys()) {
    if (plaintext.length < MIN_NEEDLE_LENGTH || text === plaintext) continue;
    if (text.includes(plaintext)) return true;
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
  // Memoized per resolution context, since `resolveValue` asks at every
  // intrinsic call. The bags it reads are not fixed for the context's life:
  // the log sink's bound bags follow the async chain, and a bag grows as a
  // pass records. So the memo holds only while the parameter bag, the
  // bound-bag array and every visible bag's size are what they were
  // (go-to-k/cdkd#7077 review).
  const bound = boundPrintingBags();
  const signature = bagsSignature(context);
  const memo = namesByContext.get(context);
  if (
    memo !== undefined &&
    memo.parameters === context.parameters &&
    memo.bound === bound &&
    memo.signature === signature
  ) {
    return memo.names;
  }
  const names = computeTaintedNames(context, template);
  namesByContext.set(context, { parameters: context.parameters, bound, signature, names });
  return names;
}

const namesByContext = new WeakMap<
  ResolverContext,
  {
    parameters: ResolverContext['parameters'];
    bound: readonly RecordedSecretValues[];
    signature: string;
    names: ReadonlySet<string>;
  }
>();

/** Each visible bag's pair and log-only counts: what can change a verdict between calls. */
function bagsSignature(context: ResolverContext): string {
  return visibleBags(context)
    .map((bag) => `${bag.size}.${logOnlyValuesOf.get(bag)?.size ?? 0}`)
    .join(',');
}

function computeTaintedNames(
  context: ResolverContext,
  template: CloudFormationTemplate
): ReadonlySet<string> {
  const passed: string[] = [];
  for (const [name, value] of Object.entries(context.parameters ?? {})) {
    if (parameterDisplayTainted(name, value, context)) passed.push(name);
  }
  // go-to-k/cdkd#7077 review: a resource whose template READS a tainted
  // export or output holds its value in state, so a reader of it printed
  // before the read is marked (template order) is tainted too.
  passed.push(...resourcesReadingTaintedCrossStack(template, crossStackTaintOf(context)));
  const key = JSON.stringify(passed.sort());
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

/**
 * The resources whose properties read an export or output `taint` marks: a
 * literal `Fn::ImportValue` name `exportTainted` answers, a literal
 * `Fn::GetStackOutput` pair `stackOutputTainted` answers, and (fail closed)
 * either with a computed argument whenever the run holds any taint.
 */
function resourcesReadingTaintedCrossStack(
  template: CloudFormationTemplate,
  taint: ReturnType<typeof crossStackTaintOf>
): string[] {
  if (taint === undefined || !taint.holdsAnyTaint()) return [];
  const reads = (node: unknown, depth: number): boolean => {
    if (node === null || typeof node !== 'object') return false;
    // Too deep to read: fail closed, as the docstring says.
    if (depth > 64) return true;
    if (Array.isArray(node)) return node.some((item) => reads(item, depth + 1));
    const record = node as Record<string, unknown>;
    if (Object.hasOwn(record, 'Fn::ImportValue')) {
      const name = record['Fn::ImportValue'];
      return typeof name !== 'string' || taint.exportTainted('', name);
    }
    if (Object.hasOwn(record, 'Fn::GetStackOutput')) {
      const args = record['Fn::GetStackOutput'] as Record<string, unknown> | undefined;
      const stack = args?.['StackName'];
      const output = args?.['OutputName'];
      return (
        typeof stack !== 'string' ||
        typeof output !== 'string' ||
        taint.stackOutputTainted('', stack, output)
      );
    }
    return Object.values(record).some((value) => reads(value, depth + 1));
  };
  const resources = (template.Resources ?? {}) as Record<string, unknown>;
  return Object.entries(resources)
    .filter(([, resource]) => reads((resource as { Properties?: unknown } | null)?.Properties, 0))
    .map(([logicalId]) => logicalId);
}

/**
 * The innermost intrinsic call being resolved, whether it is tainted, and the
 * call enclosing it. `tainted` is set from the template when the scope opens
 * ({@link withDisplayScope}) and can be raised later by a tainted cross-stack
 * read ({@link markCrossStackReadTainted}), for the call and every call
 * enclosing it.
 */
interface DisplayFrame {
  readonly node: object;
  tainted: boolean;
  /** The call itself READ a tainted export or output (not only an enclosing one). */
  crossStackRead?: true;
  readonly parent: DisplayFrame | undefined;
}
const scope = new AsyncLocalStorage<DisplayFrame>();

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
  // A diff whose preview holds a tainted export or output opens the scope
  // too, so a consumer's read of one can taint the calls enclosing it.
  if (names.size === 0 && crossStackTaintOf(context)?.holdsAnyTaint() !== true) return undefined;
  const tainted =
    names.size > 0 &&
    readsNoEchoSource(node, {
      parameters: names,
      attributeIsNoEcho: (logicalId) => names.has(logicalId),
    });
  return scope.run({ node, tainted, parent: scope.getStore() }, resolve);
}

/**
 * go-to-k/cdkd#7077 (the go-to-k/cdkd#7090 sibling): the call being resolved
 * READ an export or stack output the run's preview marks as derived from a
 * secret (`CrossStackPreview.exportTainted` / `stackOutputTainted`). Taint
 * it and every call enclosing it, so a `Fn::Join` over the read prints `***`
 * at any length. The read's value is recorded as a log-only needle of the
 * pass too ({@link recordTaintedCrossStackValue}), for a line outside the
 * resolver. A consumer diffed without its producer holds no previewed value
 * to mask with, only these marks.
 */
export function markCrossStackReadTainted(): void {
  const own = scope.getStore();
  if (own !== undefined) own.crossStackRead = true;
  for (let frame = own; frame !== undefined; frame = frame.parent) {
    frame.tainted = true;
  }
}

/** The run's cross-stack taint marks: the preview's, or a fingerprint pass's taint-only view. */
export function crossStackTaintOf(
  context: ResolverContext
): NonNullable<ResolverContext['crossStackTaint']> | undefined {
  return context.crossStackPreview ?? context.crossStackTaint;
}

/**
 * Did the innermost call itself read an export or output the preview marks
 * tainted ({@link markCrossStackReadTainted})? A frame tainted by template
 * names only answers no: its read is no secret-fed producer value.
 */
export function innermostCrossStackReadTainted(): boolean {
  return scope.getStore()?.crossStackRead === true;
}

/**
 * Record a tainted cross-stack read's string value as a log-only needle of
 * the pass (`recordLogOnlyValue`): masked whole at any length, and embedded
 * at or above the floor, on any line the pass prints.
 *
 * `cdkd diff` only (a context carrying the preview's marks), and never into
 * the pass bag: a log-only needle there is read by deciders (the
 * masked-property fingerprint's `templateCarriesNeedle`, a nested row's
 * `holdsRecordedSecret` tag settle), so it goes to a display-only bag beside
 * it ({@link displayOnlyBagOf}).
 */
export function recordTaintedCrossStackValue(context: ResolverContext, value: unknown): void {
  if (crossStackTaintOf(context) === undefined) return;
  const pass = context.recordedSecretValues;
  if (pass === undefined || typeof value !== 'string' || value === '') return;
  let display = displayOnlyBags.get(pass);
  if (display === undefined) {
    display = new Map();
    displayOnlyBags.set(pass, display);
  }
  recordLogOnlyValue(display, value);
}

/**
 * The DISPLAY-ONLY bag beside each pass bag (go-to-k/cdkd#7077 review): the
 * needles {@link recordTaintedCrossStackValue} records. Read by the
 * resolver's render mask alone (`maskRenderedNeedlesForLog`), never handed to
 * a decider: a needle in the pass bag itself made `cdkd diff`'s nested-row
 * tag settle (`holdsRecordedSecret`) and fingerprint pass read the import as
 * secret and plan a phantom UPDATE.
 */
const displayOnlyBags = new WeakMap<RecordedSecretValues, RecordedSecretValues>();

/** The display-only bag of `context`'s pass, when one was recorded. */
export function displayOnlyBagOf(
  context: ResolverContext | undefined
): RecordedSecretValues | undefined {
  const pass = context?.recordedSecretValues;
  return pass === undefined ? undefined : displayOnlyBags.get(pass);
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
