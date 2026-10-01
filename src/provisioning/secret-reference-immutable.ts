/**
 * Is a provider's immutable-property "change" only a secret reference the
 * record keeps and the desired side resolved (go-to-k/cdkd#4275)?
 *
 * State keeps a secret-derived leaf as its `{{resolve:...}}` expression (or,
 * for a `NoEcho` value, the mask `***`), while `update()` is handed the
 * RESOLVED plaintext as its desired side. A provider refusing an immutable
 * property change by comparing the two sides therefore refused EVERY in-place
 * update of a resource whose name came from a secret, although the template
 * never changed it: the engine's own diff compares the template spelling with
 * the recorded spelling and saw nothing move.
 *
 * Two arms, strongest evidence first:
 *
 *  - **The physical id carries the name** (`physicalName`): compare the
 *    desired value with it. This is AWS's own answer, so it also REFUSES a
 *    rotated secret whose new value would rename the resource.
 *  - **It does not**: the recorded side must hold a `{{resolve:` reference
 *    exactly where the desired side holds a value the caller's masker
 *    recognises as a secret it resolved, with every other leaf and the literal
 *    text around each reference equal. That proves the desired value is still
 *    secret-derived, not that it is the SAME reference, so the arm is limited
 *    to a key the ENGINE replaces on any change: an explicit replacement rule
 *    (`ReplacementRulesRegistry`), or, where the registry has no opinion, a
 *    whole-key create-only path from the same lookup the diff uses
 *    (`getCreateOnlyPropertyPaths`: the live schema, the committed snapshot
 *    when that fails). A re-pointed reference there is a template change the
 *    engine routes to a REPLACEMENT before any `update()` runs. A recorded
 *    `***` is never enough here, since a mask says nothing about the value it
 *    hides.
 *
 * Not proved by the second arm: a secret ROTATED under an unchanged reference,
 * whose new value is what the desired side now holds. That is harmless only
 * where the provider's writes address the resource by its PHYSICAL ID and never
 * send the key: the live name then stays as it was, which is also what
 * CloudFormation does for a create-only property whose template did not change.
 * A caller whose writes are addressed by the DESIRED value of the key (a parent
 * name, a cluster id) must not use this arm for it, or must confirm with AWS
 * that the desired value still addresses the recorded resource.
 *
 * Absent masker means identity, so the second arm never matches and the
 * caller's refusal stands.
 */

import { getCreateOnlyPropertyPaths } from './create-only-properties.js';
import { ReplacementRulesRegistry } from '../analyzer/replacement-rules.js';
import { dynamicReferenceTokens } from '../deployment/secret-redaction.js';
import { isSecretDerivedValue, maskerOrIdentity, type MaskerFn } from './masked-retry-logger.js';

const IDENTITY: MaskerFn = maskerOrIdentity(undefined);

/** The evidence one immutable key's comparison has in hand. */
export interface SecretReferenceEvidence {
  /** The resource type, for the create-only gate of the masker arm. */
  readonly resourceType: string;
  /** The top-level property name. */
  readonly key: string;
  /** The desired (resolved) value. */
  readonly desired: unknown;
  /** The recorded value. */
  readonly previous: unknown;
  /**
   * The value the physical id carries for THIS key (the name a
   * name-addressed resource is known by), when it carries one.
   */
  readonly physicalName?: string | undefined;
  /** The caller's `context?.maskSecrets`; absent means identity. */
  readonly maskSecrets?: MaskerFn | undefined;
}

/**
 * `true` when the recorded side of an immutable key is secret-derived and the
 * evidence shows the desired value is the one the resource already has, so
 * the caller's immutability refusal must not fire. `false` in every other
 * case, including an ordinary recorded value: the caller then keeps its own
 * comparison.
 */
export async function unchangedBehindSecretReference(
  evidence: SecretReferenceEvidence
): Promise<boolean> {
  const { resourceType, key, desired, previous, physicalName, maskSecrets } = evidence;
  if (physicalName !== undefined && physicalName !== '') {
    return isSecretDerivedValue(previous, IDENTITY) && desired === physicalName;
  }
  // The cheap comparison first: the schema lookup below is paid only when
  // the difference really is a resolved reference.
  if (!onlySecretReferencesDiffer(desired, previous, maskSecrets)) return false;
  return await engineReplacesOnAnyChange(resourceType, key);
}

/** One instance: the registry is a static table built in its constructor. */
let registry: ReplacementRulesRegistry | undefined;

/**
 * Does the engine's diff turn ANY change of `key` into a replacement? The
 * diff's own order (`DiffCalculator`): an explicit registry classification
 * wins, and only an unconditional `replacementProperties` entry qualifies;
 * otherwise the schema's create-only paths, as a whole-key path only (a nested
 * one replaces only when the value AT that path moves).
 */
async function engineReplacesOnAnyChange(resourceType: string, key: string): Promise<boolean> {
  registry ??= new ReplacementRulesRegistry();
  if (registry.isClassified(resourceType, key)) {
    return (
      registry.conditionalReplacementVerdict(resourceType, key, undefined, undefined) ===
        undefined && registry.requiresReplacement(resourceType, key, undefined, undefined)
    );
  }
  const paths = await getCreateOnlyPropertyPaths(resourceType);
  return paths.some((path) => path.length === 1 && path[0] === key);
}

/**
 * The masker arm's comparison WITHOUT its engine gate, exported for the unit
 * tests only. A provider must call {@link unchangedBehindSecretReference}: on
 * its own this proves only that the desired value is still secret-derived,
 * not that it is the same reference or the same resource (a Scheduler
 * `GroupName` exemption built on it plus a live probe was withdrawn in
 * go-to-k/cdkd#4277: a rotated secret could address another environment's
 * schedule). `true` only when at least one position differs, and every
 * differing position is a recorded `{{resolve:` reference whose desired value
 * the masker recognises, with the reference's surrounding literal text intact.
 */
export function onlySecretReferencesDiffer(
  desired: unknown,
  previous: unknown,
  maskSecrets: MaskerFn | undefined
): boolean {
  return compare(desired, previous, maskerOrIdentity(maskSecrets)) === 'references-only';
}

type Verdict = 'equal' | 'references-only' | 'differs';

function compare(desired: unknown, previous: unknown, mask: MaskerFn): Verdict {
  if (typeof previous === 'string') {
    if (desired === previous) return 'equal';
    return resolvesReference(desired, previous, mask) ? 'references-only' : 'differs';
  }
  if (Array.isArray(previous)) {
    if (!Array.isArray(desired) || desired.length !== previous.length) return 'differs';
    return combine(previous.map((item, i) => compare(desired[i], item, mask)));
  }
  if (isPlainObject(previous)) {
    if (!isPlainObject(desired)) return 'differs';
    // A desired key the record lacks is a change; a recorded key the desired
    // side lacks compares as `undefined` below, which differs unless the
    // recorded value is `undefined` too (JSON's reading of an absent key).
    if (!Object.keys(desired).every((k) => Object.prototype.hasOwnProperty.call(previous, k))) {
      return 'differs';
    }
    return combine(Object.keys(previous).map((k) => compare(desired[k], previous[k], mask)));
  }
  return JSON.stringify(desired) === JSON.stringify(previous) ? 'equal' : 'differs';
}

function combine(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('differs')) return 'differs';
  return verdicts.includes('references-only') ? 'references-only' : 'equal';
}

/**
 * Does the resolved `desired` string stand where the recorded `previous`
 * spells one or more `{{resolve:...}}` references? The masker must recognise
 * it (it is a secret this call resolved), and the literal text between the
 * references must be unchanged.
 */
function resolvesReference(desired: unknown, previous: string, mask: MaskerFn): boolean {
  if (typeof desired !== 'string' || desired === '') return false;
  const tokens = dynamicReferenceTokens(previous);
  if (tokens.length === 0) return false;
  if (mask(desired) === desired) return false;
  const literals: string[] = [];
  let rest = previous;
  for (const token of tokens) {
    const at = rest.indexOf(token);
    literals.push(rest.slice(0, at));
    rest = rest.slice(at + token.length);
  }
  literals.push(rest);
  const pattern = literals.map(escapeRegExp).join('[\\s\\S]*');
  return new RegExp(`^${pattern}$`).test(desired);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
