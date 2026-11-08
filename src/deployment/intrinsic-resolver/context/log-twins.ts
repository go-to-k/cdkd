import {
  dynamicReferenceTokens,
  type DynamicReferenceSubstitution,
  type RecordedSecretValues,
} from '../../secret-redaction.js';
import type { AbandonedResolution } from './refusals.js';

/**
 * A resolved string beside its LOG TWIN (issue
 * [#3100](https://github.com/go-to-k/cdkd/issues/3100)): the same string with
 * every span a recorded secret was WRITTEN into replaced by
 * `SECRET_MASK`. `resolveJoin` / `resolveSub` build it alongside the
 * value and log the twin, never the value.
 *
 * It exists because the NEEDLE mask (`maskNeedlesForLog`) masks a 1-3
 * character secret only as the WHOLE text (`MIN_NEEDLE_LENGTH`), so
 * `port:` + a two-character secret printed in the clear. The floor is right for
 * a needle — a short needle would rewrite unrelated text in every line — and
 * what the needle lacks is POSITION, which only the writer holds. The twin is
 * therefore built at the writes, and the needle mask still runs over it for
 * everything a write did not see.
 */
export interface LogTwin {
  readonly result: string;
  readonly twin: string;
}

/**
 * A dynamic-reference pass over one string: its {@link LogTwin}, every token
 * it REPLACED with the verdict that replacement took, and whether it replaced
 * every token it met (issue [#3156](https://github.com/go-to-k/cdkd/issues/3156)).
 * `resolveJoin` / `resolveSub` assemble these into the object's
 * `IntrinsicLeafResolution`.
 */
export interface DynamicReferencePass extends LogTwin {
  readonly substitutions: readonly DynamicReferenceSubstitution[];
  readonly complete: boolean;
}

/**
 * Masked log twins registered this pass, per pass bag (issue #3100;
 * `rememberLogTwin` / `logTwinOfProduct`). Nothing that RESOLVES a value reads
 * it. One persistence decision does: `resolveBase64` registers its encoding
 * mask-only when the input's position mask fires (issue #3119), which a nested
 * child also reaches through the inherited-bag lookup (issue #3114).
 *
 * MODULE scope, not instance scope: a region-pinned sibling resolver
 * (`resolverForProducerRegion`) resolves on behalf of the consumer with the
 * consumer's bag, so an instance-local registry left the sibling's twin where
 * the consumer's `Fn::Join` / `Fn::Sub` never looked. The key is still the
 * pass's own bag object, so scope does not widen to unrelated passes: a pass
 * reaches only the entries under its own bag and under the bag it was handed
 * as `inheritedSecrets` (a nested-stack child reading its parent's, issue
 * #3114), and the entries die with the bag.
 */
export const LOG_TWINS_BY_PASS = new WeakMap<RecordedSecretValues, Map<string, string>>();

/**
 * Does `value` carry a CloudFormation dynamic reference anywhere inside it?
 *
 * Used as the identity fast path of `reresolveCrossStackValue`
 * (`cross-stack.ts`): a cross-stack value that
 * carries none is returned untouched, so every ordinary import keeps its
 * pre-#1934 behaviour with no walk, no AWS call and no allocation.
 *
 * The walk descends arrays and objects because `state.outputs` is typed
 * `Record<string, unknown>` and deliberately NOT coerced to string — a
 * list-valued `Fn::GetAtt` persists a JSON array — so a secret-bearing output
 * is not always a bare string.
 *
 * EXPORTED for `cdkd scrub` (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)), which asks the inverse
 * question of the same value: a cross-stack read that comes back carrying NO
 * dynamic reference is one scrub could not turn into a needle, because a needle
 * is only ever recorded by resolving a `{{resolve:...}}` expression.
 */
export function carriesDynamicReference(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{resolve:');
  if (Array.isArray(value)) return value.some(carriesDynamicReference);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(carriesDynamicReference);
  }
  return false;
}

/**
 * The dynamic-reference services the resolver RESOLVES on the deploy path. A
 * token of any other service is left as written on BOTH paths (the resolver
 * warns and substitutes nothing), so it is never a sign of a secret.
 */
const DEPLOY_RESOLVED_REFERENCE_SERVICES: ReadonlySet<string> = new Set([
  'secretsmanager',
  'ssm',
  'ssm-secure',
]);

/**
 * Does the span `[start, end)` of `text` sit INSIDE a `{{resolve:...}}`
 * reference the deploy could resolve (issue
 * [#2166](https://github.com/go-to-k/cdkd/issues/2166))?
 *
 * Inside means: the nearest `{{resolve:` opening before the span is not closed
 * before it, a `}}` closes it after the span before any later opening, nothing
 * between the opening and that `}}` is a quote or a line break, and the
 * opening names a resolvable service — or the span IS the service, which no
 * one can classify. The closing and quote / line-break tests keep prose that
 * merely mentions the opening (`Use the {{resolve:secretsmanager: prefix`, or
 * the same followed by a JSON body that has a `}}` of its own) out.
 */
export function sitsInsideResolvableReference(text: string, start: number, end: number): boolean {
  const OPENING = '{{resolve:';
  const opening = text.lastIndexOf(OPENING, start);
  if (opening < 0) return false;
  const head = text.slice(opening + OPENING.length, start);
  if (head.includes('}}')) return false;
  // No `:` yet: the span is (part of) the SERVICE, so it is unknown, not public.
  const colon = head.indexOf(':');
  if (colon >= 0 && !DEPLOY_RESOLVED_REFERENCE_SERVICES.has(head.slice(0, colon))) return false;
  const close = text.indexOf('}}', end);
  if (close < 0) return false;
  const nextOpening = text.indexOf(OPENING, end);
  if (nextOpening >= 0 && nextOpening < close) return false;
  return !/["\r\n]/.test(text.slice(opening, close));
}

/**
 * Placeholders `resolveSub` KEPT, per abandoned-unit bag, with why each was
 * kept and whether it has been reported (issue
 * [#2166](https://github.com/go-to-k/cdkd/issues/2166)). Keyed by the bag
 * INSTANCE, which a caller opens per unit it resolves, so one unit's kept
 * placeholder is never reported against another's reference.
 */
const KEPT_PLACEHOLDERS = new WeakMap<
  AbandonedResolution[],
  Map<string, { because: unknown; reported: boolean }>
>();

/** Remember a kept placeholder against `bag`; the first reason wins. */
export function recordKeptPlaceholder(
  bag: AbandonedResolution[],
  placeholder: string,
  because: unknown
): void {
  let kept = KEPT_PLACEHOLDERS.get(bag);
  if (kept === undefined) {
    kept = new Map();
    KEPT_PLACEHOLDERS.set(bag, kept);
  }
  if (!kept.has(placeholder)) kept.set(placeholder, { because, reported: false });
}

/**
 * The kept placeholders of `bag` that sit inside a resolvable reference in
 * `text` and were not reported yet, each marked reported as it is returned —
 * so the nested passes over one assembled string report it once.
 */
export function takeKeptPlaceholdersInsideReferences(
  bag: AbandonedResolution[],
  text: string
): Array<{ placeholder: string; because: unknown }> {
  const kept = KEPT_PLACEHOLDERS.get(bag);
  if (kept === undefined) return [];
  const found: Array<{ placeholder: string; because: unknown }> = [];
  for (const [placeholder, entry] of kept) {
    if (entry.reported) continue;
    for (let at = text.indexOf(placeholder); at >= 0; at = text.indexOf(placeholder, at + 1)) {
      if (sitsInsideResolvableReference(text, at, at + placeholder.length)) {
        entry.reported = true;
        found.push({ placeholder, because: entry.because });
        break;
      }
    }
  }
  return found;
}

/**
 * True when text RESOLVED by a `skipDynamicReferences` pass
 * still carries a token of a service the deploy resolves (issue
 * [#4056](https://github.com/go-to-k/cdkd/issues/4056)).
 *
 * Only a SECRET keeps its token through that pass: `secretsmanager` and
 * `ssm-secure` by spelling, and a plain `ssm` one whose parameter the lookup
 * finds to be a `SecureString`; a `String` / `StringList` parameter resolves
 * to its value and leaves no token. So on RESOLVED text the token scan, not
 * the `isSecretBearingReferenceString` spelling test, is what says "the deploy
 * substitutes a secret here". The spelling test stays right for its other
 * readers, which read RAW template or STORED text, where a plain `ssm` token
 * says nothing about the parameter's type. Read by `outputs-diff.ts` (an
 * export name) and `resolveBase64` (go-to-k/cdkd#2909), which must agree.
 */
export function keepsSecretReferenceToken(resolvedName: string): boolean {
  // `inner.split(':')[0]`, the resolver's own reading of the service, with the
  // closing braces sliced off so a colon-less `{{resolve:ssm-secure}}` reads
  // `ssm-secure` there and here alike.
  return dynamicReferenceTokens(resolvedName).some((token) =>
    DEPLOY_RESOLVED_REFERENCE_SERVICES.has(
      token.slice('{{resolve:'.length, -'}}'.length).split(':')[0] ?? ''
    )
  );
}
