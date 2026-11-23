/**
 * go-to-k/cdkd#6871 (security review M1): a nested row's resolved `Tags`
 * reach the child as stack tags, merged into its templates as literals. A
 * value resolved from a secret must go down as its `{{resolve:...}}`
 * expression, or the child records the plaintext in state (the #1903
 * class); a value holding a NoEcho needle with no expression is withheld.
 */
import { describe, it, expect } from 'vite-plus/test';
import { childRowTags } from '../../../src/provisioning/providers/nested-stack/row-tags.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction.js';

const SECRET = 'hunter2-plaintext-6871';
const EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password::}}';
const SHORT = 'prod';
const SHORT_EXPR = '{{resolve:secretsmanager:short:SecretString:v::}}';

describe('childRowTags (go-to-k/cdkd#6871)', () => {
  it('passes plain tags through, and none without a bag', () => {
    expect(childRowTags([{ Key: 'a', Value: 'b' }], undefined)).toEqual({
      tags: { a: 'b' },
      withheld: [],
    });
    expect(childRowTags([{ Key: 'a', Value: 'b' }], new Map())).toEqual({
      tags: { a: 'b' },
      withheld: [],
    });
  });

  it('turns a whole-value and an embedded secret back into the expression', () => {
    const bag = new Map([[SECRET, EXPR]]);
    const result = childRowTags(
      [
        { Key: 'whole', Value: SECRET },
        { Key: 'embedded', Value: `x-${SECRET}-y` },
      ],
      bag
    );
    expect(result.tags).toEqual({ whole: EXPR, embedded: `x-${EXPR}-y` });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('never rewrites inside an expression it put in', () => {
    // `prod` also occurs in EXPR's text; it must be replaced only where it
    // was a literal of the value.
    const bag = new Map([
      [SECRET, EXPR],
      [SHORT, SHORT_EXPR],
    ]);
    const result = childRowTags([{ Key: 'k', Value: `${SECRET}/prod` }], bag);
    expect(result.tags).toEqual({ k: `${EXPR}/${SHORT_EXPR}` });
  });

  it('withholds a tag holding a NoEcho needle that has no expression', () => {
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, 'noecho-value-6871');
    const result = childRowTags(
      [
        { Key: 'leak', Value: 'pre-noecho-value-6871' },
        { Key: 'ok', Value: 'fine' },
      ],
      bag
    );
    expect(result).toEqual({ tags: { ok: 'fine' }, withheld: ['leak'] });
  });

  it('answers undefined tags for a non-literal list', () => {
    expect(childRowTags({ Ref: 'X' }, new Map()).tags).toBeUndefined();
  });
});
