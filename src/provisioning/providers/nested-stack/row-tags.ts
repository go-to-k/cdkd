/**
 * A nested-stack row's own `Tags`, as the child's stack tags (go-to-k/cdkd#6871).
 *
 * The provider receives the row's RESOLVED properties, so a tag value built
 * from a `{{resolve:secretsmanager:...}}` / SecureString reference is
 * PLAINTEXT here. Merged into the child's template as a literal, it would be
 * recorded in the child's state as plaintext: the child's redaction records a
 * pair only when ITS resolver resolves a reference (the #1903 class). So each
 * value is turned back into the expression the parent resolved, read from the
 * parent's bag for this row (`plaintext -> {{resolve:...}}`): the child then
 * resolves it itself and redacts it like any other reference. A value still
 * holding a secret with no expression (a `NoEcho` parameter's value, a
 * log-only needle) is dropped from the child's tags, with a warning naming
 * only its KEY: a plaintext secret is never written to state.
 *
 * Never enumerate or log the bag's KEYS: they are secret plaintext.
 */

import { literalRowTags } from '../../stack-tags.js';
import { logOnlyValuesOf } from '../../../deployment/secret-redaction/log-only.js';
import { MIN_NEEDLE_LENGTH } from '../../../deployment/secret-redaction/rules.js';
import { dynamicReferenceSpans } from '../../../deployment/secret-redaction/redact-path.js';
import { nestedStackRowTagSpellingOf } from '../../../deployment/secret-redaction/nested-stack/row-tag-spellings.js';
import type { RecordedSecretValues } from '../../../deployment/secret-redaction/pairs.js';
import { defineOwnKey } from '../../../utils/own-keys.js';

export interface ChildRowTags {
  /** The row's tags, secrets as their expressions; `undefined` when not a literal list. */
  readonly tags: Record<string, string> | undefined;
  /** Keys left out because their value holds a secret with no expression. */
  readonly withheld: string[];
}

/** Does `value` hold `needle` the way the persist-side masker would match it? */
function holds(value: string, needle: string): boolean {
  return value === needle || (needle.length >= MIN_NEEDLE_LENGTH && value.includes(needle));
}

/**
 * Does `text` hold any secret of `secrets` -- a recorded plaintext or a
 * log-only (`NoEcho`) needle -- ANYWHERE, at any length (go-to-k/cdkd#6893)?
 *
 * Floorless on purpose: it decides what is WRITTEN (a child's stack tag, the
 * parent's `nestedStackTags` record), not what is masked, and the persist-side
 * masker cannot find a 1-3 character secret embedded in a longer value. A
 * short secret coinciding with innocent text answers `true` too: the caller
 * then withholds the tag or leaves the row unrecorded, never a plaintext.
 */
export function holdsRecordedSecret(text: string, secrets: RecordedSecretValues): boolean {
  const contains = (needle: string): boolean => needle !== '' && text.includes(needle);
  for (const plaintext of secrets.keys()) if (contains(plaintext)) return true;
  for (const needle of logOnlyValuesOf.get(secrets) ?? []) if (contains(needle)) return true;
  return false;
}

/** The text of `spelling` outside its `{{resolve:...}}` tokens. */
function nonTokenText(spelling: string): string[] {
  const parts: string[] = [];
  let at = 0;
  for (const span of dynamicReferenceSpans(spelling)) {
    parts.push(spelling.slice(at, span.start));
    at = span.end;
  }
  parts.push(spelling.slice(at));
  return parts;
}

/**
 * The row's tags as the child's stack tags. Per value, in order:
 *
 * 1. The spelling the parent's recorder CERTIFIED for this key and value
 *    (go-to-k/cdkd#6893, `recordNestedStackRowTagSpellings`): the template's
 *    own text with its expressions, at any secret length. A spelling an
 *    `Fn::Join` / `Fn::Sub` produced still has its non-token text checked,
 *    since a non-literal part (a `NoEcho` parameter) can have resolved into it.
 * 2. Otherwise the substring carry through the plaintext-keyed bag, at or
 *    above `MIN_NEEDLE_LENGTH` (below it a plaintext is no safe needle).
 *
 * Whatever is left is checked FLOORLESS ({@link holdsRecordedSecret}); a value
 * still holding a secret, or carried as a mask rather than an expression, is
 * withheld with its key named (a key holding one is withheld unnamed).
 */
export function childRowTags(
  rowTags: unknown,
  secrets: RecordedSecretValues | undefined
): ChildRowTags {
  const tags = literalRowTags(rowTags);
  if (tags === undefined || secrets === undefined) return { tags, withheld: [] };
  // Longest first, so a secret containing another is replaced whole.
  const pairs = [...secrets.entries()].sort(([a], [b]) => b.length - a.length);
  const out: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    // A KEY spelling a secret cannot be put back as an expression: withheld.
    if (holdsRecordedSecret(key, secrets)) {
      withheld.push('(a key cdkd does not print)');
      continue;
    }
    const certified = nestedStackRowTagSpellingOf(secrets, key, value);
    if (certified !== undefined) {
      if (
        !certified.fromLiteral &&
        nonTokenText(certified.spelling).some((text) => holdsRecordedSecret(text, secrets))
      ) {
        withheld.push(key);
        continue;
      }
      defineOwnKey(out, key, certified.spelling);
      continue;
    }
    // Literal runs and the expressions already put in: a later, shorter
    // secret is never searched for INSIDE an inserted expression's text.
    let segments: Array<{ text: string; expression: boolean }> = [
      { text: value, expression: false },
    ];
    for (const [plaintext, expression] of pairs) {
      segments = segments.flatMap((segment) => {
        if (segment.expression || !holds(segment.text, plaintext)) return [segment];
        const parts = segment.text.split(plaintext);
        return parts.flatMap((text, i) => [
          ...(i > 0 ? [{ text: expression, expression: true }] : []),
          ...(text === '' ? [] : [{ text, expression: false }]),
        ]);
      });
    }
    // A mask (`***`, a mask-only entry) is no expression the child can
    // resolve: writing it would tag the child's resources with the mask.
    const unresolvable = segments.some(
      (segment) => segment.expression && dynamicReferenceSpans(segment.text).length === 0
    );
    const literal = segments.filter((segment) => !segment.expression);
    if (unresolvable || literal.some((segment) => holdsRecordedSecret(segment.text, secrets))) {
      withheld.push(key);
      continue;
    }
    defineOwnKey(out, key, segments.map((segment) => segment.text).join(''));
  }
  return { tags: out, withheld };
}
