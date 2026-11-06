import { AccountIdUnavailableError } from '../../../utils/error-handler.js';
import { getAccountInfo } from '../../../deployment/intrinsic-function-resolver.js';
import { defineOwnKey } from '../../../utils/own-keys.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import { DYNAMIC_REFERENCE_OPENER } from './discarded-subtree.js';

/**
 * The pseudo-parameters {@link resolvePseudoParameterIntrinsics} resolves:
 * the ones whose value is fixed by the account and region cdkd imports into,
 * which is all a physical NAME can embed. `AWS::StackName` / `AWS::StackId`
 * are left out on purpose — cdkd's values for those are not what a
 * CloudFormation-deployed name embeds.
 */
const IMPORT_PREPASS_PSEUDO_PARAMETERS: ReadonlySet<string> = new Set([
  'AWS::AccountId',
  'AWS::Region',
  'AWS::Partition',
  'AWS::URLSuffix',
]);

/** The `Fn::Sub` placeholder grammar, spelled as `resolveSub` spells it. */
const SUB_PLACEHOLDER = /\$\{(!)?([^}]*)\}/g;

/** A string literal, or an intrinsic {@link collectPseudoParameterClosure} accepts. */
function isClosedOperand(value: unknown, needs: Set<string>): boolean {
  return typeof value === 'string' || collectPseudoParameterClosure(value, needs);
}

/**
 * Is `value` an intrinsic the import pre-pass can evaluate COMPLETELY — built
 * only from string literals, the pseudo-parameters in
 * {@link IMPORT_PREPASS_PSEUDO_PARAMETERS}, `Fn::Join` and `Fn::Sub`? Adds the
 * pseudo-parameters it needs to `needs` (whose contents are meaningless on a
 * `false` answer).
 *
 * Anything else answers `false`: a `Ref` to a resource or parameter, any other
 * intrinsic, a non-string operand, a malformed argument, an `Fn::Sub`
 * placeholder naming neither its own variable map nor an accepted
 * pseudo-parameter, or an empty `${}` (which `resolveSub` keeps verbatim).
 */
function collectPseudoParameterClosure(value: unknown, needs: Set<string>): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0] as string;
  const arg = (value as Record<string, unknown>)[key];
  if (key === 'Ref') {
    if (typeof arg !== 'string' || !IMPORT_PREPASS_PSEUDO_PARAMETERS.has(arg)) return false;
    needs.add(arg);
    return true;
  }
  if (key === 'Fn::Join') {
    if (!Array.isArray(arg) || arg.length !== 2) return false;
    const [delimiter, items] = arg as unknown[];
    if (typeof delimiter !== 'string' || !Array.isArray(items)) return false;
    return items.every((item) => isClosedOperand(item, needs));
  }
  if (key === 'Fn::Sub') {
    const parts = subParts(arg);
    if (parts === undefined) return false;
    const { body, variables } = parts;
    if (!Object.values(variables).every((v) => isClosedOperand(v, needs))) return false;
    for (const match of body.matchAll(SUB_PLACEHOLDER)) {
      if (match[1] === '!') continue; // `${!X}` renders the literal `${X}`
      const name = match[2] as string; // `''` for an empty `${}`, which no arm accepts
      if (Object.hasOwn(variables, name)) continue;
      if (!IMPORT_PREPASS_PSEUDO_PARAMETERS.has(name)) return false;
      needs.add(name);
    }
    return true;
  }
  return false;
}

/** An `Fn::Sub` argument's body and variable map, or `undefined` when malformed. */
function subParts(arg: unknown): { body: string; variables: Record<string, unknown> } | undefined {
  if (typeof arg === 'string') return { body: arg, variables: {} };
  if (!Array.isArray(arg) || arg.length !== 2) return undefined;
  const [body, variables] = arg as unknown[];
  if (typeof body !== 'string') return undefined;
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    return undefined;
  }
  return { body, variables: variables as Record<string, unknown> };
}

/**
 * Evaluate an intrinsic {@link collectPseudoParameterClosure} accepted, with
 * `values` holding every pseudo-parameter it named. `Fn::Sub` follows
 * `resolveSub`: a `${!X}` escape renders `${X}`, and the variable map is
 * consulted before the pseudo-parameters.
 */
function evaluatePseudoParameterClosure(
  value: unknown,
  values: ReadonlyMap<string, string>
): string {
  if (typeof value === 'string') return value;
  const obj = value as Record<string, unknown>;
  if ('Ref' in obj) return values.get(obj['Ref'] as string) as string;
  if ('Fn::Join' in obj) {
    const [delimiter, items] = obj['Fn::Join'] as [string, unknown[]];
    return items.map((item) => evaluatePseudoParameterClosure(item, values)).join(delimiter);
  }
  const { body, variables } = subParts(obj['Fn::Sub']) as {
    body: string;
    variables: Record<string, unknown>;
  };
  return body.replace(SUB_PLACEHOLDER, (_match, bang: string | undefined, name: string) => {
    if (bang === '!') return `\${${name}}`;
    if (Object.hasOwn(variables, name)) {
      return evaluatePseudoParameterClosure(variables[name], values);
    }
    return values.get(name) as string;
  });
}

/** A single-key `Ref` / `Fn::*` object: an intrinsic, resolvable or not. */
function isIntrinsicShape(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || (keys[0] as string).startsWith('Fn::'));
}

/**
 * Resolve, in a resource's template Properties, every intrinsic that is built
 * only from literals and the account / region pseudo-parameters, so that
 * `provider.import()` sees the NAME the template describes rather than the
 * intrinsic that spells it (issue #1897). The common CDK shape is an
 * env-agnostic stack naming something after its account —
 * `{Fn::Join: ['', ['cdkd-test-', {Ref: 'AWS::AccountId'}, '.internal.']]}` —
 * which every provider's `typeof name === 'string'` guard declined, so a
 * documented auto-resolution route silently answered `skipped-not-found`.
 *
 * The pseudo-parameter VALUES are the resolver's: `getAccountInfo` for the
 * account, and the region folded and mapped to its partition / URL suffix
 * exactly as `resolvePseudoParameter` does, so a name comes out as a deploy
 * would build it. The `Fn::Join` / `Fn::Sub` evaluation is deliberately NOT
 * `IntrinsicFunctionResolver.resolve`: that resolves any `{{resolve:...}}`
 * reference the ASSEMBLED string spells, even one split across two literals,
 * so a name lookup would fetch a parameter or secret. Here nothing is fetched,
 * and a result spelling a reference is left unresolved instead.
 *
 *   - An intrinsic is replaced only when {@link collectPseudoParameterClosure}
 *     accepts it WHOLE. Anything else is left exactly as written and never
 *     descended into, so this pass never produces a half-resolved `Fn::Join`
 *     or an `Fn::Sub` with a `${...}` left in. (`substituteOverrideRefs`, which
 *     runs after it, still replaces an overridden `{Ref: <X>}` inside an
 *     intrinsic, as it did before; the provider then sees an intrinsic either
 *     way.)
 *   - `AWS::AccountId` is resolved only when the account is known: when
 *     `getAccountInfo` refuses (STS cannot name it and `AWS_ACCOUNT_ID` is
 *     unset, issue #1730) the intrinsic is left as written, so the name route
 *     declines it and stage 2 or `--resource` adopts the resource. STS is
 *     asked only when an accepted intrinsic names the account.
 *
 * Plain objects and arrays are walked. Only what the PROVIDER sees changes:
 * state's `properties` are still resolved from the raw template by
 * `resolveImportedProperties`.
 *
 * Pure-functional — does not mutate `value`. Exported for unit testing.
 */
export async function resolvePseudoParameterIntrinsics(
  value: unknown,
  region: string
): Promise<unknown> {
  const canonicalRegion = canonicalizeRegion(region);
  const { partition, urlSuffix } = derivePartitionAndUrlSuffix(canonicalRegion);
  const values = new Map<string, string>([
    ['AWS::Region', canonicalRegion],
    ['AWS::Partition', partition],
    ['AWS::URLSuffix', urlSuffix],
  ]);
  const walk = async (node: unknown): Promise<unknown> => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return Promise.all(node.map(walk));
    const obj = node as Record<string, unknown>;
    if (isIntrinsicShape(obj)) {
      const needs = new Set<string>();
      if (!collectPseudoParameterClosure(obj, needs)) return node;
      if (needs.has('AWS::AccountId')) {
        // Memoized per credential identity by `getAccountInfo` itself.
        let accountId: string;
        try {
          accountId = (await getAccountInfo()).accountId;
        } catch (error) {
          if (error instanceof AccountIdUnavailableError) return node;
          throw error;
        }
        values.set('AWS::AccountId', accountId);
      }
      const resolved = evaluatePseudoParameterClosure(obj, values);
      return resolved.includes(DYNAMIC_REFERENCE_OPENER) ? node : resolved;
    }
    // An ordinary `{}` written through `defineOwnKey`: the bag goes to a
    // PROVIDER, and a template key named `__proto__` must stay a key.
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      defineOwnKey(result, k, await walk(v));
    }
    return result;
  };
  return walk(value);
}
