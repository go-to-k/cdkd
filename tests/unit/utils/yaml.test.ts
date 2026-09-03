import { describe, it, expect } from 'vite-plus/test';
import { parse as parseYaml } from 'yaml';
import { toYaml } from '../../../src/utils/yaml.js';

/**
 * yaml.ts is shared by `cdkd synth` (CloudFormation template render) and
 * `cdkd list --long` (stack metadata render).
 *
 * Issue [#2421](https://github.com/go-to-k/cdkd/issues/2421): the emitter
 * used to decide quoting with a hand-rolled predicate covering four cases, so
 * every other YAML indicator went out bare and `AllowedOrigins: ['*']` became
 * a `- *` alias node that a parser rejects.
 *
 * The load-bearing fence here is therefore the ROUND-TRIP table below, not a
 * list of expected literals: a literal table can only ever pin the spellings
 * somebody thought of, which is the failure mode that produced the bug. The
 * table asserts that what we EMIT parses back to what we were GIVEN, so a
 * spelling nobody enumerated still fails.
 *
 * A short literal table is kept as well, because round-tripping does not pin
 * indentation, key order or sequence style — a change there would be a silent
 * break of `cdkd synth`'s output shape while every round-trip stayed green.
 */

/**
 * Scalars that a YAML emitter has to quote, one per hazard class. Each of
 * these round-trips ONLY if the emitter quotes it: emitted bare, YAML either
 * rejects the document or hands back a different value / type.
 */
const HOSTILE_SCALARS: readonly string[] = [
  // Leading indicator characters. `*` is the one the issue was filed for
  // (every wildcard IAM statement, every CORS `AllowedOrigins`); the rest are
  // the same defect reachable from a different first character.
  '*',
  '&anchor',
  '!Ref',
  '|block',
  '>fold',
  '%directive',
  '@reserved',
  '`backtick',
  '[bracket',
  ']bracket',
  '{brace',
  '}brace',
  ',comma',
  '#hash',
  "'single",
  '"double',
  // Indicators that only bite with a following space, plus the in-value
  // forms: `: ` terminates a key, ` #` starts a comment.
  '- dash',
  '? question',
  ': colon',
  'key: value',
  'value #comment',
  // Whitespace the parser would strip off a plain scalar.
  '',
  ' leading',
  'trailing ',
  '  ',
  // Strings that resolve implicitly to a non-string. The all-digit case is
  // the one `cdkd list --long` hits for real: an AWS account id.
  'true',
  'false',
  'null',
  '~',
  '42',
  '-1',
  '+5',
  '3.14',
  '1e5',
  '0x1f',
  '012',
  '111111111111',
  '.inf',
  '.nan',
  // YAML 1.1 resolves these too, which is what `yq` reads. A 1.2-only
  // emitter leaves them bare and `yq` hands back a boolean / a Date.
  'yes',
  'no',
  'on',
  'off',
  '2026-09-03',
  '12:30:00',
  // Resolves under YAML 1.2 core but NOT under 1.1, which is the schema we
  // emit under -- so this one goes out bare unless the emitter asks BOTH
  // readers. Found by review; the reason the emitter delegates the question
  // to the library rather than carrying a list like this one.
  '0o17',
  // The 1.1 MERGE key. Ordinary in value position, special as a KEY, which
  // is why the emitter asks a different question for each position.
  '<<',
  // Multi-line content: a plain scalar cannot hold a line break at all.
  'line1\nline2',
  'line1\n\nline3',
  'trailing-newline\n',
];

/**
 * Scalars a correct emitter leaves alone. Present so the fence watches the
 * OTHER direction too: an emitter that quotes everything would pass the
 * round-trip table while making every template unreadable.
 */
const PLAIN_SCALARS: readonly string[] = [
  'hello',
  'AWS::S3::Bucket',
  'arn:aws:iam::123456789012:role/cdkd',
  'us-east-1',
  'a#b',
  'echo "hello"',
  "it's",
];

describe('toYaml', () => {
  describe('round-trips every scalar it emits (issue #2421)', () => {
    // The four positions are asserted separately because the emitter used to
    // reach them by different code paths — a map VALUE, a sequence
    // ITEM, and a map KEY (which had its own, also-incomplete, quoting rule:
    // `key.includes(' ') ? '"key"' : key`).
    for (const value of [...HOSTILE_SCALARS, ...PLAIN_SCALARS]) {
      it(`round-trips ${JSON.stringify(value)}`, () => {
        expect(parseYaml(toYaml(value))).toBe(value);
        expect(parseYaml(toYaml({ Key: value }))).toEqual({ Key: value });
        expect(parseYaml(toYaml([value]))).toEqual([value]);
        expect(parseYaml(toYaml({ [value]: 'v' }))).toEqual({ [value]: 'v' });
      });
    }

    // Emitted under the 1.1 schema precisely so a 1.1 reader — which is what
    // `yq` is — gets the same values back. Asserting only under the default
    // (1.2 core) parser would leave `yes` / `on` / `2026-09-03` unfenced,
    // since 1.2 does not resolve them implicitly in the first place.
    it('round-trips under a YAML 1.1 reader too (`yq` semantics)', () => {
      for (const value of [...HOSTILE_SCALARS, ...PLAIN_SCALARS]) {
        expect(parseYaml(toYaml({ Key: value }), { schema: 'yaml-1.1' })).toEqual({ Key: value });
      }
    });

    // The OTHER direction, at every position. An emitter that quotes
    // everything satisfies every round-trip assertion above while making each
    // template unreadable, and asserting only the top-level position leaves
    // that free in the two positions a template actually uses: measured, an
    // emitter quoting every SEQUENCE ITEM reddened 0 of these cases before
    // the item and key arms were added here.
    it('leaves plain scalars unquoted, at every position', () => {
      for (const value of PLAIN_SCALARS) {
        expect(toYaml(value)).toBe(`${value}\n`);
        expect(toYaml({ Key: value })).toBe(`Key: ${value}\n`);
        expect(toYaml([value])).toBe(`- ${value}\n`);
        expect(toYaml({ [value]: 'v' })).toBe(`${value}: v\n`);
      }
    });
  });

  it('preserves scalar TYPES, in both directions', () => {
    // The mirror of the quoting defect: the old emitter rendered a number as
    // `"42"`, so a template's `ExpirationInDays: 90` came back as a string
    // while its `schemaVersion: '2.2'` came back as a number. Both directions
    // now survive the round trip.
    expect(parseYaml(toYaml(42))).toBe(42);
    expect(parseYaml(toYaml('42'))).toBe('42');
    expect(parseYaml(toYaml(true))).toBe(true);
    expect(parseYaml(toYaml('true'))).toBe('true');
    expect(parseYaml(toYaml(null))).toBe(null);
    expect(parseYaml(toYaml('null'))).toBe('null');
    expect(toYaml(42)).toBe('42\n');
    expect(toYaml('42')).toBe('"42"\n');
  });

  it('renders a CloudFormation template so it parses back identically', () => {
    // The shape the issue was reproduced on: `tests/integration/basic` is one
    // S3 bucket, and its CORS rule alone made `cdkd synth | yq` fail.
    const template = {
      Resources: {
        Bucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {
            CorsConfiguration: {
              CorsRules: [{ AllowedHeaders: ['*'], AllowedMethods: ['GET'], AllowedOrigins: ['*'] }],
            },
            LifecycleConfiguration: { Rules: [{ ExpirationInDays: 90, Status: 'Enabled' }] },
          },
        },
      },
      Outputs: { BucketArn: { Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] } } },
    };

    const emitted = toYaml(template);

    expect(parseYaml(emitted)).toEqual(template);
    expect(emitted).toContain('- "*"');
    // Long form, like `cdk synth` — NOT the `!GetAtt` shorthand that
    // `src/cli/yaml-cfn.ts` emits for `cdkd export`.
    expect(emitted).toContain('Fn::GetAtt:');
    expect(emitted).not.toContain('!GetAtt');
  });

  it('never emits YAML anchors for a template holding one object twice', () => {
    // A shared reference would otherwise render as `&a1` / `*a1`, which CFn
    // does not understand — and which is the very alias syntax this issue is
    // about, arriving from the other side.
    const shared = { Ref: 'Bucket' };
    const emitted = toYaml({ Outputs: { A: { Value: shared }, B: { Value: shared } } });

    // NOT a regex over the default `anchorPrefix` ('a'): that binds the
    // assertion to a library default, and the same aliased output scores
    // clean under `anchorPrefix: 'x'`. The deep-equality below cannot carry
    // this either -- an aliased document parses back to an identical
    // structure -- so the character itself is the discriminator.
    expect(emitted).not.toContain('&');
    expect(emitted).not.toContain('*');
    expect(parseYaml(emitted)).toEqual({
      Outputs: { A: { Value: { Ref: 'Bucket' } }, B: { Value: { Ref: 'Bucket' } } },
    });
  });

  it('does not fold long values onto extra lines', () => {
    // A CDK `Analytics` blob / a long ARN must stay on one line: folding is
    // legal YAML but changes the string a naive line-based reader sees.
    // The value MUST contain whitespace: `yaml` folds only at a space, so a
    // single long token stays on one line at any `lineWidth` and a fixture
    // without one leaves the option unfenced (measured -- removing
    // `lineWidth: 0` reddened nothing before this line had its spaces).
    const long = `Deny every action on ${'the resource '.repeat(30)}always`;

    expect(toYaml({ Description: long })).toBe(`Description: ${long}\n`);
  });

  it('omits an undefined object VALUE, matching JSON.stringify', () => {
    // A silent contract change from the hand-rolled emitter, which wrote
    // `a: null`. Unreachable from either consumer today, but pinned so the
    // next reader finds it asserted rather than inferred: this is what makes
    // the YAML and `--json` spellings of `cdkd list` agree.
    expect(toYaml({ a: undefined, b: 1 })).toBe('b: 1\n');
    expect(JSON.parse(JSON.stringify({ a: undefined, b: 1 }))).toEqual({ b: 1 });
  });

  it('renders undefined as null', () => {
    // `yaml.stringify(undefined)` returns the JS value `undefined` rather
    // than a document; `toYaml` keeps the previous rendering for it.
    expect(toYaml(undefined)).toBe('null\n');
    expect(toYaml(null)).toBe('null\n');
  });

  /**
   * Literal pins. Round-tripping cannot see indentation, key order or
   * sequence style, so these guard the OUTPUT SHAPE that `cdkd synth` and
   * `cdkd list --long` consumers read.
   */
  describe('output shape', () => {
    it('starts the document at column 0 (issue #2421 leading-newline contract)', () => {
      // The emitter used to return a leading newline for a non-empty
      // container, and its two consumers disagreed about it: `list.ts`
      // stripped it, `synth.ts` did not, so `cdkd synth` opened with a blank
      // line. The contract now lives here — no leading newline, ever — and
      // `emitStructured` no longer patches the output.
      expect(toYaml({ Resources: { Bucket: { Type: 'AWS::S3::Bucket' } } })).toBe(
        'Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n'
      );
      expect(toYaml([{ id: 'StackA' }])).toBe('- id: StackA\n');
    });

    it('renders nested objects with two-space indentation', () => {
      expect(toYaml({ a: { b: { c: 'd' } } })).toBe('a:\n  b:\n    c: d\n');
    });

    it('renders arrays of records', () => {
      expect(
        toYaml([
          { id: 'StackA', name: 'StackA' },
          { id: 'StackB', name: 'StackB' },
        ])
      ).toBe('- id: StackA\n  name: StackA\n- id: StackB\n  name: StackB\n');
    });

    it('renders empty containers inline', () => {
      expect(toYaml([])).toBe('[]\n');
      expect(toYaml({})).toBe('{}\n');
      expect(toYaml({ id: 'StackA', dependencies: [] })).toBe('id: StackA\ndependencies: []\n');
      expect(toYaml({ name: 'X', tags: {} })).toBe('name: X\ntags: {}\n');
    });

    it('renders booleans and null unquoted', () => {
      expect(toYaml(true)).toBe('true\n');
      expect(toYaml(false)).toBe('false\n');
      expect(toYaml(null)).toBe('null\n');
    });
  });
});
