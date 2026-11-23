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
 * log-only (`NoEcho`) needle -- as the persist-side masker would match it?
 */
export function holdsRecordedSecret(text: string, secrets: RecordedSecretValues): boolean {
  for (const plaintext of secrets.keys()) if (holds(text, plaintext)) return true;
  for (const needle of logOnlyValuesOf.get(secrets) ?? []) if (holds(text, needle)) return true;
  return false;
}

export function childRowTags(
  rowTags: unknown,
  secrets: RecordedSecretValues | undefined
): ChildRowTags {
  const tags = literalRowTags(rowTags);
  if (tags === undefined || secrets === undefined) return { tags, withheld: [] };
  // Longest first, so a secret containing another is replaced whole.
  const pairs = [...secrets.entries()].sort(([a], [b]) => b.length - a.length);
  const logOnly = [...(logOnlyValuesOf.get(secrets) ?? [])];
  const out: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    // A KEY spelling a secret cannot be put back as an expression: withheld.
    if (holdsRecordedSecret(key, secrets)) {
      withheld.push('(a key cdkd does not print)');
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
    const literal = segments.filter((segment) => !segment.expression);
    if (logOnly.some((needle) => literal.some((segment) => holds(segment.text, needle)))) {
      withheld.push(key);
      continue;
    }
    defineOwnKey(out, key, segments.map((segment) => segment.text).join(''));
  }
  return { tags: out, withheld };
}
