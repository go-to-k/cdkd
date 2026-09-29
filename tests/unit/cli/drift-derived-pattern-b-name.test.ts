import { describe, it, expect } from 'vite-plus/test';
import { canonicalizeDerivedPatternBName } from '../../../src/cli/commands/drift.js';
import {
  PATTERN_B_NAME_OPTIONS,
  PATTERN_B_NAME_PROPERTIES,
  PATTERN_B_RESOURCE_TYPES,
  derivesPatternBName,
  generateResourceNameWithFallback,
  withSkipPrefix,
  withStackName,
} from '../../../src/provisioning/resource-name.js';
import { reverseReplacementRewrittenNameTypes } from '../../../src/deployment/replacement-name-holder.js';

/**
 * Issue go-to-k/cdkd#4081: `cdkd drift` compared a Pattern B record's DECLARED
 * name (a template-only baseline) against the name AWS holds, which the
 * provider derived through `generateResourceNameWithFallback` — `MyStack-<name>`
 * on a stack deployed with the legacy `--prefix-user-supplied-names`. A
 * phantom name drift on every run. The name is canonicalized only when the
 * live one is what EITHER prefix setting derives, in the stack's scope.
 */

const STACK = 'MyStack';
const inStack = <T>(fn: () => T): T => withStackName(STACK, fn);

/** The expression each Pattern B provider evaluates for an explicit name. */
function generate(type: string, declared: string): string {
  return generateResourceNameWithFallback(declared, 'MyLogicalId', {
    maxLength: PATTERN_B_NAME_OPTIONS[type]!.maxLength,
  });
}

describe('derivesPatternBName (issue #4081)', () => {
  it('covers every Pattern B type with a name property and generator options', () => {
    expect(Object.keys(PATTERN_B_NAME_PROPERTIES).sort()).toEqual([...PATTERN_B_RESOURCE_TYPES].sort());
    expect(Object.keys(PATTERN_B_NAME_OPTIONS).sort()).toEqual([...PATTERN_B_RESOURCE_TYPES].sort());
  });

  // The options this helper derives with must be the ones the providers
  // pass. The rewritten-name table is fenced against the providers' own
  // generator calls, so agreeing with it ties the two.
  it.each([...PATTERN_B_RESOURCE_TYPES])('%s: derives with the providers\' name options', (type) => {
    const fenced = reverseReplacementRewrittenNameTypes()[type];
    expect(fenced).toBeDefined();
    expect(PATTERN_B_NAME_OPTIONS[type]).toEqual({ maxLength: fenced!.maxLength });
    expect(PATTERN_B_NAME_PROPERTIES[type]).toBe(fenced!.property);
  });

  describe.each([...PATTERN_B_RESOURCE_TYPES])('%s', (type) => {
    it('accepts the legacy prefixed name (prefix setting)', () => {
      expect(inStack(() => derivesPatternBName(type, 'my-name', 'MyStack-my-name'))).toBe(true);
    });

    it('accepts the sanitized bare name (no-prefix setting)', () => {
      expect(inStack(() => derivesPatternBName(type, 'my_name', 'my-name'))).toBe(true);
      // ...and the sanitized prefixed one.
      expect(inStack(() => derivesPatternBName(type, 'my_name', 'MyStack-my-name'))).toBe(true);
    });

    it('decides under both settings whatever the scope carries', () => {
      for (const skip of [true, false]) {
        expect(
          inStack(() => withSkipPrefix(skip, () => derivesPatternBName(type, 'my-name', 'MyStack-my-name')))
        ).toBe(true);
        expect(
          inStack(() => withSkipPrefix(skip, () => derivesPatternBName(type, 'my_name', 'my-name')))
        ).toBe(true);
      }
    });

    it.each([
      ['prefix', false],
      ['no-prefix', true],
    ])('accepts the truncated form past the type\'s maxLength (%s setting)', (_label, skip) => {
      const declared = `a-long-declared-name-${'x'.repeat(130)}`;
      // The name the provider sends under that setting: longer than any
      // Pattern B maxLength, so it is the `<cut>-<8 hex>` form.
      const live = inStack(() => withSkipPrefix(skip, () => generate(type, declared)));
      expect(live).toMatch(/-[0-9a-f]{8}$/);
      expect(live.startsWith('MyStack-')).toBe(!skip);
      expect(live.length).toBeLessThanOrEqual(PATTERN_B_NAME_OPTIONS[type]!.maxLength);
      expect(inStack(() => derivesPatternBName(type, declared, live))).toBe(true);
    });

    it.each([
      ['another stack\'s prefix', 'my-name', 'OtherStack-my-name'],
      ['a different name', 'my-name', 'MyStack-other-name'],
      ['a live name that drops the declared prefix', 'MyStack-my-name', 'my-name'],
      ['an empty declared name', '', 'MyStack-MyLogicalId'],
      ['an empty live name', 'my-name', ''],
      ['a non-string declared name', { 'Fn::Sub': 'my-name' }, 'MyStack-my-name'],
      ['a non-string live name', 'my-name', ['MyStack-my-name']],
      ['a case-only difference', 'my-name', 'mystack-my-name'],
    ])('rejects %s', (_label, declared, live) => {
      expect(inStack(() => derivesPatternBName(type, declared, live))).toBe(false);
    });
  });

  it('with no stack name in scope, recognizes only the sanitize rewrite', () => {
    expect(derivesPatternBName('AWS::IAM::Role', 'my_role', 'my-role')).toBe(true);
    expect(derivesPatternBName('AWS::IAM::Role', 'my-role', 'MyStack-my-role')).toBe(false);
  });

  it.each([
    ['a non-Pattern-B type', 'AWS::S3::Bucket'],
    ['an inherited key', 'constructor'],
    ['an inherited key', '__proto__'],
  ])('rejects %s', (_label, type) => {
    expect(inStack(() => derivesPatternBName(type, 'my-name', 'MyStack-my-name'))).toBe(false);
  });
});

describe('canonicalizeDerivedPatternBName (issue #4081)', () => {
  describe.each([...PATTERN_B_RESOURCE_TYPES])('%s', (type) => {
    const property = PATTERN_B_NAME_PROPERTIES[type]!;

    it('rewrites the declared name to the live one it derives, and nothing else', () => {
      const baseline = { [property]: 'my-name', Other: 'kept' };
      const aws = { [property]: 'MyStack-my-name', Other: 'changed' };

      const out = inStack(() => canonicalizeDerivedPatternBName(type, baseline, aws));

      expect({ ...out }).toEqual({ [property]: 'MyStack-my-name', Other: 'kept' });
      // A comparison copy: the record's own bag is untouched.
      expect(baseline[property]).toBe('my-name');
    });

    it('returns the baseline by identity when the live name is not derived from it', () => {
      const baseline = { [property]: 'my-name' };
      const out = inStack(() =>
        canonicalizeDerivedPatternBName(type, baseline, { [property]: 'OtherStack-my-name' })
      );
      expect(out).toBe(baseline);
    });

    it('returns the baseline by identity when either side has no name', () => {
      const baseline = { [property]: 'my-name' };
      expect(inStack(() => canonicalizeDerivedPatternBName(type, baseline, {}))).toBe(baseline);
      const nameless = { Other: 1 };
      expect(
        inStack(() =>
          canonicalizeDerivedPatternBName(type, nameless, { [property]: 'MyStack-my-name' })
        )
      ).toBe(nameless);
    });
  });

  it('leaves another type\'s same-named property alone', () => {
    const baseline = { Name: 'my-name' };
    expect(
      inStack(() =>
        canonicalizeDerivedPatternBName('AWS::Events::Rule', baseline, { Name: 'MyStack-my-name' })
      )
    ).toBe(baseline);
  });

  it('keeps an own __proto__ key through the rewrite', () => {
    const baseline = JSON.parse('{"RoleName":"my-role","__proto__":{"a":1}}') as Record<
      string,
      unknown
    >;
    const out = inStack(() =>
      canonicalizeDerivedPatternBName('AWS::IAM::Role', baseline, { RoleName: 'MyStack-my-role' })
    );
    expect(Object.keys(out).sort()).toEqual(['RoleName', '__proto__']);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toEqual({ a: 1 });
    expect(out['RoleName']).toBe('MyStack-my-role');
  });
});
