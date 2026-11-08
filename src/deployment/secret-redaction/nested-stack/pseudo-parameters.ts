import type { RecordedSecretValues } from '../pairs.js';
import { crossStackSourceKey } from '../cross-stack.js';
import { inheritedParameterReads } from './inherited-parameters.js';

/** A parameter's value as a re-read binds it, or `undefined` for no binding. */
export type ParameterBinding = (name: string) => { readonly value: unknown } | undefined;

/**
 * The pseudo parameters a re-read may bind (issue
 * [#4962](https://github.com/go-to-k/cdkd/issues/4962)): `AWS::Region`,
 * `AWS::Partition` and `AWS::URLSuffix`, each a pure function of the child
 * resolver's region, so every pass over one child -- this deploy, the next
 * one, `cdkd scrub` -- binds the same string and reaches the same
 * collision-walk verdict. `AWS::AccountId` (issue
 * [#4975](https://github.com/go-to-k/cdkd/issues/4975)) is recorded only
 * where {@link templateRereadsAccountId} finds a shape that needs it, and then
 * ALWAYS from `accountIdForReread`, which asks STS when the account is not yet
 * settled: binding only a settled account flipped the verdict between two
 * deploys of an unchanged tree. `AWS::StackName` and `AWS::StackId` follow the
 * pass's own stack name (and the id is absent on a first deploy),
 * `AWS::NotificationARNs` is a list and `AWS::NoValue` drops the value: none
 * is bound.
 */
const REREAD_PSEUDO_PARAMETERS: ReadonlySet<string> = new Set([
  'AWS::Region',
  'AWS::Partition',
  'AWS::URLSuffix',
  'AWS::AccountId',
]);

/**
 * Does any resource of `template`, or its `Outputs`, hold both a re-read
 * trigger ({@link REREAD_TRIGGERS}) and a read of `AWS::AccountId` (a
 * `{Ref}`, or `${AWS::AccountId}` in an `Fn::Sub` string)? The gate on the
 * account lookup a nested child's re-read makes (issue
 * [#4975](https://github.com/go-to-k/cdkd/issues/4975)): a child without such
 * a resource never asks STS for it. Per resource rather than per leaf, so it
 * may over-answer (one lookup the pass may make anyway), never under-answer.
 */
export function templateRereadsAccountId(
  template: { Resources?: unknown; Outputs?: unknown } | undefined
): boolean {
  if (template === undefined) return false;
  // Cached per `Resources` object, with the `Outputs` it was computed beside:
  // `cdkd diff --recursive` binds a child's parameters one at a time, each
  // call on a copy of the template sharing these two objects.
  const resources =
    template.Resources !== null && typeof template.Resources === 'object'
      ? (template.Resources as Record<string, unknown>)
      : undefined;
  const cached = resources && accountRereadVerdicts.get(resources);
  if (cached !== undefined && cached.outputs === template.Outputs) return cached.verdict;
  const parts: unknown[] = resources ? Object.values(resources) : [];
  if (template.Outputs !== undefined) parts.push(template.Outputs);
  const verdict = parts.some(partRereadsAccountId);
  if (resources) accountRereadVerdicts.set(resources, { outputs: template.Outputs, verdict });
  return verdict;
}

/** {@link templateRereadsAccountId}'s verdicts, keyed by a template's `Resources`. */
const accountRereadVerdicts = new WeakMap<object, { outputs: unknown; verdict: boolean }>();

/** {@link templateRereadsAccountId} over one resource (or `Outputs`), iteratively. */
function partRereadsAccountId(part: unknown): boolean {
  let trigger = false;
  let account = false;
  const pending: unknown[] = [part];
  while (pending.length > 0 && !(trigger && account)) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (REREAD_TRIGGERS.has(key)) trigger = true;
      if (key === 'Ref' && value === 'AWS::AccountId') account = true;
      if (key === 'Fn::Sub') {
        const text = Array.isArray(value) ? value[0] : value;
        if (typeof text === 'string' && text.includes('${AWS::AccountId}')) account = true;
      }
      pending.push(value);
    }
  }
  return trigger && account;
}

/**
 * The pseudo-parameter values a nested child's resolver answers, keyed by the
 * INHERITED bag the child was handed (issue #4962), as
 * `withdrawRenderedParameterSpelling`'s table is: the collision walk,
 * which runs before any resource resolves, and the persist re-read
 * (`positionByParameterReread`, through the reads record's parent) both
 * reach that bag. A second recording with a different value for a name
 * poisons the table: no binding at all.
 */
const inheritedPseudoParameters = new WeakMap<
  RecordedSecretValues,
  Map<string, string> | typeof POISONED_PSEUDO_PARAMETERS
>();
const POISONED_PSEUDO_PARAMETERS: unique symbol = Symbol(
  'cdkd.inherited-pseudo-parameters.poisoned'
);

/**
 * Record the pseudo-parameter values the child resolver handed
 * `inheritedSecrets` resolves (issue #4962). Called by the child's
 * `resolveParameters`, before the collision walk; names outside
 * {@link REREAD_PSEUDO_PARAMETERS} and non-string values are ignored.
 */
export function recordInheritedPseudoParameters(
  inheritedSecrets: RecordedSecretValues,
  values: ReadonlyMap<string, unknown>
): void {
  let table = inheritedPseudoParameters.get(inheritedSecrets);
  if (table === POISONED_PSEUDO_PARAMETERS) return;
  if (table === undefined) {
    table = new Map();
    inheritedPseudoParameters.set(inheritedSecrets, table);
  }
  for (const [name, value] of values) {
    if (!REREAD_PSEUDO_PARAMETERS.has(name) || typeof value !== 'string') continue;
    const known = table.get(name);
    if (known !== undefined && known !== value) {
      inheritedPseudoParameters.set(inheritedSecrets, POISONED_PSEUDO_PARAMETERS);
      return;
    }
    table.set(name, value);
  }
}

/** The pseudo-parameter binding recorded for `parentSecrets` (issue #4962). */
export function pseudoBindingOf(parentSecrets: RecordedSecretValues): ParameterBinding {
  const table = inheritedPseudoParameters.get(parentSecrets);
  return (name) =>
    table instanceof Map && table.has(name) ? { value: table.get(name) } : undefined;
}

/**
 * The value an `Fn::Join` / `Fn::Sub` placeholder part reading pseudo
 * parameter `name` renders, as the table on `parentSecrets` records it (issue
 * [#4973](https://github.com/go-to-k/cdkd/issues/4973)), for the two readers
 * that must agree: the template parse of `positionByParameterPlaceholders`
 * (through {@link inheritedPseudoSpan}) and the collision walk's count of the
 * parts that parse cannot key. `undefined` for a name the table does not hold
 * (or a poisoned table): the part stays unknown on both sides. A value equal
 * to or overlapping a plaintext needs no test here: the parse renders it as
 * literal text, which its final re-scan refuses like any other.
 */
export function inheritedPseudoValue(
  parentSecrets: RecordedSecretValues,
  name: string
): string | undefined {
  const bound = pseudoBindingOf(parentSecrets)(name)?.value;
  return typeof bound === 'string' ? bound : undefined;
}

/**
 * {@link inheritedPseudoValue} for a placeholder part of a leaf persisted
 * through `childSecrets`, keyed as `positionByParameterPlaceholders` keys it
 * (`crossStackSourceKey({Ref: <name>})`), through the parent bag the child's
 * reads record names (issue #4973); `undefined` without such a record.
 */
export function inheritedPseudoSpan(
  childSecrets: RecordedSecretValues,
  key: string
): string | undefined {
  const reads = inheritedParameterReads.get(childSecrets);
  if (reads === undefined || typeof reads === 'symbol') return undefined;
  for (const name of REREAD_PSEUDO_PARAMETERS) {
    if (crossStackSourceKey({ Ref: name }) === key) return inheritedPseudoValue(reads.parent, name);
  }
  return undefined;
}

/**
 * The intrinsics a re-read (`rereadParameterExpression`) evaluates. Only
 * a source holding `Fn::Select`, `Fn::Split` or `Fn::If` (issue
 * [#4919](https://github.com/go-to-k/cdkd/issues/4919)) is re-read: a `{Ref}`
 * alone, an `Fn::Join` / `Fn::Sub` over `{Ref}`s, already has a per-parameter
 * arm.
 */
export const REREAD_TRIGGERS: ReadonlySet<string> = new Set(['Fn::Select', 'Fn::Split', 'Fn::If']);
