/**
 * `src/analyzer/skipped-outputs.ts` (issue #2740): the digest a deploy records
 * for an Output it skipped, and the diff-side reader that trusts the record
 * only while the digest holds.
 *
 * The digest cases are written as PAIRS — one input moved, digest must move;
 * one input moved, digest must NOT move — because the record's whole value is
 * in what it declines to see: a resource edit or a sibling output edit must
 * leave it binding, and every input an output's resolution reads must break
 * it. Most `resolveTemplateOutputs` cases drive the reader through
 * `computeOutputsDiff`, so the observable is the ROW; the one that composes a
 * GetAtt-shaped un-bind stops at `resolutionFailed` / `failedKeys`, because
 * for an output the diff cannot resolve there is no row to observe in either
 * reading and the verdict is the only difference.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  skippedOutputDigest,
  collectSkippedOutputs,
  skippedOutputsEqual,
  bindingSkippedOutputs,
  referencedLogicalIds,
} from '../../../src/analyzer/skipped-outputs.js';
import { resolveTemplateOutputs, computeOutputsDiff } from '../../../src/analyzer/outputs-diff.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const SECRET_REF = '{{resolve:secretsmanager:cdkd/db:SecretString:missing}}';

function base(): CloudFormationTemplate {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Parameters: { Env: { Type: 'String', Default: 'dev' } },
    Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
    Mappings: { Keys: { dev: { Field: 'missing' } } },
    Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    Outputs: {
      // No `Export` on purpose: a LITERAL export name on a secret-bearing
      // stack takes the issue #1942 arm (state must prove the alias was
      // published), which would mark the preview failed on its own and hide
      // what these cases measure. The digest's `Export` sensitivity is pinned
      // separately below.
      Leak: { Value: SECRET_REF },
      Other: { Value: 'plain' },
    },
  };
}

describe('skippedOutputDigest', () => {
  const reference = skippedOutputDigest(base(), 'Leak');

  it('is a 64-hex sha256, stable across calls and across object key order', () => {
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
    expect(skippedOutputDigest(base(), 'Leak')).toBe(reference);
    // Same template, every object re-keyed in reverse order.
    const reversed = JSON.parse(
      JSON.stringify(base(), (_k, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse())
          : v
      )
    ) as CloudFormationTemplate;
    expect(skippedOutputDigest(reversed, 'Leak')).toBe(reference);
  });

  it('does NOT move on a Resources edit or a sibling Output edit', () => {
    const resourceEdit = base();
    resourceEdit.Resources['A']!.Properties = { Value: 'y' };
    resourceEdit.Resources['B'] = { Type: 'AWS::SSM::Parameter', Properties: { Value: 'z' } };
    expect(skippedOutputDigest(resourceEdit, 'Leak')).toBe(reference);

    const siblingEdit = base();
    siblingEdit.Outputs!['Other'] = { Value: 'changed', Export: { Name: 'S:Other' } };
    siblingEdit.Outputs!['New'] = { Value: 'added' };
    expect(skippedOutputDigest(siblingEdit, 'Leak')).toBe(reference);
  });

  it.each<[string, (t: CloudFormationTemplate) => void]>([
    ['Value', (t) => (t.Outputs!['Leak']!.Value = SECRET_REF.replace('missing', 'password'))],
    ['Export added', (t) => (t.Outputs!['Leak']!.Export = { Name: 'S:Leak' })],
    ['Condition added', (t) => (t.Outputs!['Leak']!.Condition = 'IsProd')],
    ['Parameters default', (t) => (t.Parameters!['Env']!.Default = 'prod')],
    ['Conditions body', (t) => (t.Conditions!['IsProd'] = { 'Fn::Equals': ['a', 'a'] })],
    ['Mappings entry', (t) => (t.Mappings!['Keys'] = { dev: { Field: 'password' } })],
    ['Rules section added', (t) => (t.Rules = { R: { Assertions: [] } })],
  ])('moves when %s changes', (_label, mutate) => {
    const t = base();
    mutate(t);
    expect(skippedOutputDigest(t, 'Leak')).not.toBe(reference);
  });

  it('moves when an existing Export.Name is renamed or removed', () => {
    const exported = base();
    exported.Outputs!['Leak']!.Export = { Name: 'S:Leak' };
    const exportedDigest = skippedOutputDigest(exported, 'Leak');
    const renamed = base();
    renamed.Outputs!['Leak']!.Export = { Name: 'S:Renamed' };
    expect(skippedOutputDigest(renamed, 'Leak')).not.toBe(exportedDigest);
    expect(reference).not.toBe(exportedDigest); // removed
  });

  it('keeps a NoEcho parameter DEFAULT out of the digest, while still hashing the rest of it', () => {
    // The pre-resolution snapshot keeps RESOLVED secrets out; an authored
    // `Default` under `NoEcho: true` is template text and went in. A
    // low-entropy default would then have a confirm oracle in `state.json`:
    // guess, recompute, compare. This does NOT claim the value is otherwise
    // absent from state — a parameter a resource reads can persist its
    // resolved default in that resource's properties — only that this field
    // must not ADD an oracle where there was none.
    const withSecretDefault = (def: string): CloudFormationTemplate => {
      const t = base();
      t.Parameters = { ...t.Parameters, DbPassword: { Type: 'String', NoEcho: true, Default: def } };
      return t;
    };
    // Two different secret defaults, same digest: the value is not in it.
    expect(skippedOutputDigest(withSecretDefault('hunter2'), 'Leak')).toBe(
      skippedOutputDigest(withSecretDefault('correct-horse'), 'Leak')
    );
    // ...and the masking is scoped. Everything ELSE about the parameter still
    // moves the digest, so the parameter is not simply dropped:
    const other = withSecretDefault('hunter2');
    (other.Parameters as unknown as Record<string, Record<string, unknown>>)['DbPassword']!['Type'] =
      'Number';
    expect(skippedOutputDigest(other, 'Leak')).not.toBe(
      skippedOutputDigest(withSecretDefault('hunter2'), 'Leak')
    );
    const noEchoOff = withSecretDefault('hunter2');
    (noEchoOff.Parameters as unknown as Record<string, Record<string, unknown>>)['DbPassword']![
      'NoEcho'
    ] = false;
    expect(skippedOutputDigest(noEchoOff, 'Leak')).not.toBe(
      skippedOutputDigest(withSecretDefault('hunter2'), 'Leak')
    );
    // ...and a PLAIN parameter's default is still hashed, so the mask did not
    // widen to every `Default`.
    const plain = (def: string): CloudFormationTemplate => {
      const t = base();
      t.Parameters = { ...t.Parameters, Region: { Type: 'String', Default: def } };
      return t;
    };
    expect(skippedOutputDigest(plain('a'), 'Leak')).not.toBe(
      skippedOutputDigest(plain('b'), 'Leak')
    );
    // The mask is scoped to the `Parameters` SECTION: the same shape under
    // another section is ordinary template text and its default IS hashed.
    const elsewhere = (def: string): CloudFormationTemplate => {
      const t = base();
      (t as unknown as Record<string, unknown>)['Metadata'] = {
        Looks: { Type: 'String', NoEcho: true, Default: def },
      };
      return t;
    };
    expect(skippedOutputDigest(elsewhere('a'), 'Leak')).not.toBe(
      skippedOutputDigest(elsewhere('b'), 'Leak')
    );
    // The REST of a masked declaration is preserved, not just `Type` and the
    // flag: a change to any other member still moves the digest.
    const withAllowed = (allowed: string[]): CloudFormationTemplate => {
      const t = base();
      t.Parameters = {
        ...t.Parameters,
        DbPassword: { Type: 'String', NoEcho: true, Default: 'hunter2', AllowedValues: allowed },
      };
      return t;
    };
    expect(skippedOutputDigest(withAllowed(['a']), 'Leak')).not.toBe(
      skippedOutputDigest(withAllowed(['b']), 'Leak')
    );
    // Hash-only: the template handed in is not rewritten.
    const handedIn = withSecretDefault('hunter2');
    const pristine = structuredClone(handedIn);
    skippedOutputDigest(handedIn, 'Leak');
    expect(handedIn).toEqual(pristine);
  });

  it('masks on its BOUNDARIES only: strict boolean, a Default present, and the container guards each observable', () => {
    const withParam = (decl: unknown): CloudFormationTemplate => {
      const t = base();
      t.Parameters = { ...t.Parameters, P: decl as never };
      return t;
    };
    const withSection = (section: unknown): CloudFormationTemplate => {
      const t = base();
      (t as unknown as Record<string, unknown>)['Parameters'] = section;
      return t;
    };
    // STRICT boolean: a truthy string is not the flag, so its default IS hashed.
    expect(skippedOutputDigest(withParam({ Type: 'String', NoEcho: 'true', Default: 'a' }), 'Leak')).not.toBe(
      skippedOutputDigest(withParam({ Type: 'String', NoEcho: 'true', Default: 'b' }), 'Leak')
    );
    // No `Default` at all: nothing to mask, and adding one is observable.
    expect(skippedOutputDigest(withParam({ Type: 'String', NoEcho: true }), 'Leak')).not.toBe(
      skippedOutputDigest(withParam({ Type: 'String', NoEcho: true, Default: 'x' }), 'Leak')
    );
    // A `null` OR `undefined` declaration must not throw: bracket access on
    // either throws, and an in-memory template can carry an `undefined` member
    // (the shape `canonicalJson`'s own doc contemplates). Measured on the
    // previous head: `{ P: undefined }` threw `Cannot read properties of
    // undefined (reading 'NoEcho')` from inside a deploy's success path.
    expect(() => skippedOutputDigest(withParam(null), 'Leak')).not.toThrow();
    expect(() => skippedOutputDigest(withParam(undefined), 'Leak')).not.toThrow();
    // ...and the `undefined` declaration contributes nothing: the
    // canonicaliser drops it exactly as `JSON.stringify` drops it, so the
    // digest equals the one with the key absent.
    expect(skippedOutputDigest(withParam(undefined), 'Leak')).toBe(
      skippedOutputDigest(base(), 'Leak')
    );
    // The three CONTAINER guards, each pinned by what its absence would hash
    // instead. `null`: `Object.entries` would throw. A primitive: it would come
    // back as `{}`, so its digest must equal the section's own and differ from
    // an empty section's. An array: it would come back keyed by index, which
    // the canonicaliser distinguishes from the array itself (pinned above).
    expect(() => skippedOutputDigest(withSection(null), 'Leak')).not.toThrow();
    expect(skippedOutputDigest(withSection(7), 'Leak')).not.toBe(
      skippedOutputDigest(withSection({}), 'Leak')
    );
    const decl = { Type: 'String', Default: 'kept' };
    expect(skippedOutputDigest(withSection([decl]), 'Leak')).not.toBe(
      skippedOutputDigest(withSection({ '0': decl }), 'Leak')
    );
  });

  it('keeps a parameter literally named `__proto__` beside a masked one (the accumulator is null-prototype)', () => {
    // Injected as TEXT through the parser, since an object literal would set
    // the prototype instead of defining a key. With a plain `{}` accumulator
    // the `__proto__` parameter would hit the prototype setter and vanish from
    // the digest — so a repair through it could never un-bind.
    const withProto = (protoDefault: string): CloudFormationTemplate => {
      const t = base();
      const json = JSON.parse(
        `{"__proto__":{"Type":"String","Default":"${protoDefault}"},"Secret":{"Type":"String","NoEcho":true,"Default":"hunter2"}}`
      ) as Record<string, unknown>;
      expect(Object.keys(json)).toEqual(['__proto__', 'Secret']);
      t.Parameters = json as never;
      return t;
    };
    expect(skippedOutputDigest(withProto('a'), 'Leak')).not.toBe(
      skippedOutputDigest(withProto('b'), 'Leak')
    );
  });

  it('sees a template key spelled `__proto__` (a Mappings entry) like any other key', () => {
    // Parsed from JSON, so the key is DATA, not the prototype link. A plain
    // `{}` in the canonicaliser would route it to the prototype setter and
    // drop it, leaving a repair through that entry unable to unbind the record.
    const withProto = JSON.parse(
      JSON.stringify(base()).replace('"Keys":', '"__proto__":')
    ) as CloudFormationTemplate;
    expect(Object.keys(withProto.Mappings!)).toEqual(['__proto__']);
    const before = skippedOutputDigest(withProto, 'Leak');
    const repaired = JSON.parse(
      JSON.stringify(withProto).replace('"Field":"missing"', '"Field":"password"')
    ) as CloudFormationTemplate;
    expect(skippedOutputDigest(repaired, 'Leak')).not.toBe(before);
  });

  it('sees a TOP-LEVEL template section spelled `__proto__` like any other section', () => {
    // The sibling of the case above, one layer out and a SEPARATE object: the
    // digest collects the top-level sections into its own bag before handing
    // them to the canonicaliser, so a plain `{}` there swallows the section
    // even though the canonicaliser is null-prototype. Same consequence — a
    // repair through that section could never un-bind the record — and it is
    // reachable the same way, from a parsed template whose key is DATA.
    // Injected as TEXT: `{ __proto__: ... }` in an object literal sets the
    // prototype instead of defining a key, so the fixture has to arrive the
    // way a real template does — through the parser.
    const withProto = JSON.parse(
      JSON.stringify(base()).replace('{', '{"__proto__":{"Marker":"before"},')
    ) as CloudFormationTemplate;
    expect(Object.keys(withProto)).toContain('__proto__');
    const before = skippedOutputDigest(withProto, 'Leak');
    const changed = JSON.parse(
      JSON.stringify(withProto).replace('"Marker":"before"', '"Marker":"after"')
    ) as CloudFormationTemplate;
    expect(Object.keys(changed)).toContain('__proto__');
    expect(skippedOutputDigest(changed, 'Leak')).not.toBe(before);
  });

  it('keeps an array distinct from an object with the same index keys (arrays are positional, not re-keyed)', () => {
    const asArray = base();
    asArray.Outputs!['Leak']!.Value = { 'Fn::Join': ['', ['a', 'b']] };
    const asObject = base();
    asObject.Outputs!['Leak']!.Value = { 'Fn::Join': ['', { '0': 'a', '1': 'b' }] };
    expect(skippedOutputDigest(asArray, 'Leak')).not.toBe(skippedOutputDigest(asObject, 'Leak'));
    // ...and array ORDER matters.
    const reordered = base();
    reordered.Outputs!['Leak']!.Value = { 'Fn::Join': ['', ['b', 'a']] };
    expect(skippedOutputDigest(asArray, 'Leak')).not.toBe(skippedOutputDigest(reordered, 'Leak'));
  });

  it('is per key: two outputs of one template digest differently', () => {
    expect(skippedOutputDigest(base(), 'Other')).not.toBe(reference);
  });
});

describe('collectSkippedOutputs / skippedOutputsEqual', () => {
  it('records exactly the undefined-valued keys, with their digests; undefined when none', () => {
    const t = base();
    expect(collectSkippedOutputs(t, { Leak: 'v', Other: 'plain' })).toBeUndefined();
    expect(collectSkippedOutputs(t, {})).toBeUndefined();
    expect(collectSkippedOutputs(t, { Leak: undefined, Other: 'plain', 'S:Other': 'plain' })).toEqual(
      { Leak: skippedOutputDigest(t, 'Leak') }
    );
    // EVERY skipped key, not the last one seen.
    expect(collectSkippedOutputs(t, { Leak: undefined, Other: undefined })).toEqual({
      Leak: skippedOutputDigest(t, 'Leak'),
      Other: skippedOutputDigest(t, 'Other'),
    });
    // `null` is a VALUE the bag can legitimately hold (state does not coerce),
    // not a skip.
    expect(collectSkippedOutputs(t, { Leak: null, Other: 'plain' })).toBeUndefined();
  });

  it('digests a `null` leaf without throwing, and distinctly from the leaf being absent', () => {
    const withNull = base();
    (withNull.Outputs!['Leak'] as unknown as Record<string, unknown>)['Description'] = null;
    expect(() => skippedOutputDigest(withNull, 'Leak')).not.toThrow();
    expect(skippedOutputDigest(withNull, 'Leak')).not.toBe(skippedOutputDigest(base(), 'Leak'));
  });

  it('compares key sets and digests, treating an EMPTY record as an absent one', () => {
    expect(skippedOutputsEqual(undefined, undefined)).toBe(true);
    // Empty and absent describe the same thing — nothing was skipped — so
    // they compare EQUAL: a carried or hand-edited `{}` would otherwise buy
    // one spurious no-change save per deploy. A hand-edited `null` normalizes
    // with them instead of throwing out of `Object.keys`.
    expect(skippedOutputsEqual(undefined, {})).toBe(true);
    expect(skippedOutputsEqual({}, undefined)).toBe(true);
    expect(skippedOutputsEqual(null as unknown as Record<string, string>, {})).toBe(true);
    expect(skippedOutputsEqual({ Leak: 'a' }, null as unknown as Record<string, string>)).toBe(
      false
    );
    expect(skippedOutputsEqual({ Leak: 'a' }, { Leak: 'a' })).toBe(true);
    expect(skippedOutputsEqual({ Leak: 'a' }, { Leak: 'b' })).toBe(false);
    expect(skippedOutputsEqual({ Leak: 'a' }, { Leak: 'a', Other: 'c' })).toBe(false);
    expect(skippedOutputsEqual({ Leak: 'a', Other: 'c' }, { Leak: 'a' })).toBe(false);
    // OWN keys only: an inherited `Leak` on the other side is not a match.
    const inherited = Object.create({ Leak: 'a' }) as Record<string, string>;
    inherited['Other'] = 'z';
    expect(skippedOutputsEqual({ Leak: 'a' }, inherited)).toBe(false);
  });
});

describe('referencedLogicalIds', () => {
  it('collects Ref, both Fn::GetAtt spellings and Fn::Sub placeholders, at any depth', () => {
    expect([
      ...referencedLogicalIds({
        Value: {
          'Fn::Join': [
            '',
            [
              { Ref: 'ByRef' },
              { 'Fn::GetAtt': ['ByAttArray', 'Arn'] },
              { 'Fn::GetAtt': 'ByAttString.Arn' },
              { 'Fn::Sub': 'x${BySub}y${BySubAttr.Arn}z' },
            ],
          ],
        },
        Export: { Name: { 'Fn::Sub': ['${ByExportSub}', {}] } as unknown as string },
      }),
    ].sort()).toEqual([
      'ByAttArray',
      'ByAttString',
      'ByExportSub',
      'ByRef',
      'BySub',
      'BySubAttr',
    ]);
  });

  it('walks BOTH branches of an Fn::If, and does not read the condition NAME as a reference', () => {
    // `Fn::If` has no arm of its own in the walker — it falls through to the
    // generic object walk, which is deliberate: the two branches are ordinary
    // template fragments and both must be collected, because the record is
    // digested WITHOUT the conditions evaluated, so which branch is live is
    // unknown at binding time. The first element is a CONDITION name, a plain
    // string, and the walker only reads names out of an intrinsic — so it is
    // correctly absent even though a condition and a resource may share a
    // name. Nesting is exercised on the way in (`Fn::Join`) and on the way out
    // (an `Fn::Sub` inside the else branch).
    expect(
      [
        ...referencedLogicalIds({
          Value: {
            'Fn::Join': [
              '-',
              [
                {
                  'Fn::If': [
                    'IsProd',
                    { Ref: 'ThenRef' },
                    { 'Fn::If': ['IsDev', { 'Fn::GetAtt': ['ElseAtt', 'Arn'] }, { 'Fn::Sub': '${ElseSub}' }] },
                  ],
                },
              ],
            ],
          },
        }),
      ].sort()
    ).toEqual(['ElseAtt', 'ElseSub', 'ThenRef']);
  });

  it('drops pseudo parameters and the ${!Literal} escape, and answers empty for a literal', () => {
    expect([
      ...referencedLogicalIds({
        Value: { 'Fn::Sub': '${AWS::Region}-${!NotARef}-${Real}' },
      }),
    ]).toEqual(['Real']);
    expect([...referencedLogicalIds({ Value: { Ref: 'AWS::AccountId' } })]).toEqual([]);
    expect([...referencedLogicalIds({ Value: 'a literal' })]).toEqual([]);
    expect([...referencedLogicalIds(undefined)]).toEqual([]);
  });

  it("a two-argument Fn::Sub's OWN variables shadow the template, so they are not resource references", () => {
    // `${Secret}` here is the map's variable, never a resource — collecting it
    // would let an unrelated resource of the same name un-bind the record.
    expect([
      ...referencedLogicalIds({
        Value: {
          'Fn::Sub': [
            '{{resolve:secretsmanager:${Secret}:SecretString:missing}}-${Real}',
            { Secret: 'external-secret' },
          ],
        },
      }),
    ]).toEqual(['Real']);
    // ...while a `Ref` INSIDE the map is still collected, since the resolver
    // reads it.
    expect([
      ...referencedLogicalIds({
        Value: { 'Fn::Sub': ['${Secret}', { Secret: { Ref: 'RealSecret' } }] },
      }),
    ]).toEqual(['RealSecret']);
    // The match is on the COMPLETE placeholder, as `resolveSub`'s own
    // `varNameStr in variables` is. Both dotted directions:
    // a map declaring `A` does NOT shadow `${A.Arn}` (a real GetAtt on `A`)...
    expect([
      ...referencedLogicalIds({ Value: { 'Fn::Sub': ['${A.Arn}', { A: 'unused' }] } }),
    ]).toEqual(['A']);
    // ...and a map declaring `A.Arn` DOES shadow `${A.Arn}`.
    expect([
      ...referencedLogicalIds({ Value: { 'Fn::Sub': ['${A.Arn}', { 'A.Arn': 'external' }] } }),
    ]).toEqual([]);
    // An INHERITED variable name shadows nothing: the resolver builds its own
    // map (an `Object.create(null)` since go-to-k/cdkd#2764) and tests
    // `varNameStr in variables` against it, so nothing can arrive inherited
    // there — matching own keys only is what keeps a template's prototype
    // from shadowing a real reference.
    const inheritedVars = Object.create({ Shadowed: 'x' }) as Record<string, unknown>;
    expect([
      ...referencedLogicalIds({ Value: { 'Fn::Sub': ['${Shadowed}', inheritedVars] } }),
    ]).toEqual(['Shadowed']);
  });

  it('does NOT read a variable NAME as an intrinsic: a variable called `Ref` is a variable', () => {
    // The two-argument form's second element is a VARIABLE MAP, so its keys
    // are names. A generic walk over it would read `{ Ref: 'Unrelated' }` as a
    // `Ref` intrinsic and let an edit to `Unrelated` un-bind the record.
    expect([
      ...referencedLogicalIds({
        Value: {
          'Fn::Sub': [
            '{{resolve:secretsmanager:${Ref}:SecretString:missing}}',
            { Ref: 'Unrelated' },
          ],
        },
      }),
    ]).toEqual([]);
    // ...while a real intrinsic INSIDE a variable's VALUE is still collected.
    expect([
      ...referencedLogicalIds({
        Value: { 'Fn::Sub': ['${V}', { V: { 'Fn::GetAtt': ['RealRes', 'Arn'] } }] },
      }),
    ]).toEqual(['RealRes']);
  });


  it("walks a two-argument Fn::Sub's non-string template and any element past the map", () => {
    // CDK emits an `Fn::Join` as `sub[0]` whenever the template string
    // interpolates a token, so a string-only read would drop every reference
    // inside it. Elements past index 1 are undefined in CloudFormation and
    // walked anyway, since narrowing here is the one place this superset
    // walker could silently lose a reference.
    expect(
      [
        ...referencedLogicalIds({
          Value: {
            'Fn::Sub': [
              { 'Fn::Join': ['', ['x-', { Ref: 'InsideTheJoin' }]] },
              { V: 'literal' },
              { Ref: 'PastTheMap' },
            ],
          },
        }),
      ].sort()
    ).toEqual(['InsideTheJoin', 'PastTheMap']);
  });

  it('walks an Fn::Sub whose value is a plain OBJECT, the one shape that used to fall through', () => {
    // Neither spelling CloudFormation defines: `subTemplate` is `undefined`
    // for it and `isPair` is false, so before the `else` arm nothing walked it
    // and every reference inside was lost. Lost in the BINDING direction — the
    // record would keep binding through a resource change that should have
    // released it — which is the silent half this walker exists to refuse.
    expect([
      ...referencedLogicalIds({
        Value: { 'Fn::Sub': { Anything: { Ref: 'InsideTheObject' } } },
      } as unknown as Parameters<typeof referencedLogicalIds>[0]),
    ]).toEqual(['InsideTheObject']);
  });

  it('treats an empty name as no reference at all', () => {
    expect([...referencedLogicalIds({ Value: { Ref: '' } })]).toEqual([]);
    expect([...referencedLogicalIds({ Value: { 'Fn::Sub': '${}' } })]).toEqual([]);
  });

  it('walks a template whose leaves are null / malformed without throwing or inventing a name', () => {
    // Every boundary in one place: a `null` leaf (the walk must not read
    // properties off it), a string-form `Fn::GetAtt` with no dot (invalid
    // CloudFormation — collected whole, because dropping it would BIND a
    // record a resource change should have released, and this walker has no
    // narrowing arm), a non-string `Ref`, and a two-argument `Fn::Sub` whose
    // map is `null`.
    const entry = {
      Value: {
        'Fn::Join': [
          '',
          [
            null,
            { 'Fn::GetAtt': 'NoDotHere' },
            { Ref: { 'Fn::Sub': '${Nested}' } },
            { 'Fn::Sub': ['${Nested2}', null] },
          ],
        ],
      },
    } as unknown as Parameters<typeof referencedLogicalIds>[0];
    expect(() => referencedLogicalIds(entry)).not.toThrow();
    // `NoDotHere` is collected whole, the non-string `Ref` contributes nothing
    // by ITSELF (its nested `Fn::Sub` still does), and both `Fn::Sub`
    // templates yield their placeholders since a `null` map declares no
    // variable.
    expect([...referencedLogicalIds(entry)].sort()).toEqual([
      'Nested',
      'Nested2',
      'NoDotHere',
    ]);
  });

  it('is a deliberate SUPERSET: a Ref to a template PARAMETER is collected too', () => {
    // Telling a parameter from a resource needs the `Parameters` section, and
    // the consumer intersects with ids that actually have a resource change,
    // so widening here can only un-bind — the direction that previews a row
    // rather than hiding one.
    expect([...referencedLogicalIds({ Value: { Ref: 'Env' } })]).toEqual(['Env']);
  });
});

describe('bindingSkippedOutputs', () => {
  it('does not bind a key whose entry references a CHANGED logical id, and still binds the others', () => {
    const t = base();
    t.Outputs!['Leak'] = { Value: { 'Fn::GetAtt': ['MyRes', 'Arn'] } };
    const record = {
      Leak: skippedOutputDigest(t, 'Leak'),
      Other: skippedOutputDigest(t, 'Other'),
    };
    expect([...bindingSkippedOutputs(t, record, new Set(['MyRes']))]).toEqual(['Other']);
    // An UNRELATED resource change leaves both binding...
    expect([...bindingSkippedOutputs(t, record, new Set(['Unrelated']))].sort()).toEqual([
      'Leak',
      'Other',
    ]);
    // ...and so does an empty / omitted change set.
    expect([...bindingSkippedOutputs(t, record, new Set())].sort()).toEqual(['Leak', 'Other']);
    expect([...bindingSkippedOutputs(t, record)].sort()).toEqual(['Leak', 'Other']);
  });

  it('tolerates a hand-edited `null` record instead of throwing out of Object.entries', () => {
    // `state.json` is not validated, and this is the field an operator is most
    // likely to edit by hand — a throw here would crash `cdkd diff`.
    expect(
      bindingSkippedOutputs(base(), null as unknown as Record<string, string>).size
    ).toBe(0);
  });

  it('keeps the keys whose recorded digest equals today\x27s, drops the rest, and answers empty for no record', () => {
    const t = base();
    const record = {
      Leak: skippedOutputDigest(t, 'Leak'),
      Other: 'not-the-digest',
      Gone: skippedOutputDigest(t, 'Gone'), // a key the template does not declare
    };
    const repaired = base();
    repaired.Outputs!['Leak']!.Value = 'repaired';
    expect([...bindingSkippedOutputs(t, record)]).toEqual(['Leak']);
    expect([...bindingSkippedOutputs(repaired, record)]).toEqual([]);
    expect([...bindingSkippedOutputs(t, { Other: skippedOutputDigest(t, 'Other') })]).toEqual([
      'Other',
    ]);
    expect(bindingSkippedOutputs(t, undefined).size).toBe(0);
  });

  it('an INHERITED template output is not a declaration, and a template with no Outputs binds nothing', () => {
    const t = base();
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    const inheritedOutputs = base();
    inheritedOutputs.Outputs = Object.create({ Leak: t.Outputs!['Leak'] }) as NonNullable<
      CloudFormationTemplate['Outputs']
    >;
    expect([...bindingSkippedOutputs(inheritedOutputs, record)]).toEqual([]);
    const noOutputs = base();
    delete noOutputs.Outputs;
    expect([...bindingSkippedOutputs(noOutputs, record)]).toEqual([]);
  });

  it('a record for an undeclared key never binds, even against the template it was computed on', () => {
    // `Gone` digests over an `undefined` entry on both sides — equal digests —
    // so without the declaration check it would bind. It is inert either way
    // (the resolve loop never visits an undeclared key); this pins that the
    // set the resolver receives names only keys it can act on.
    const t = base();
    const record = { Gone: skippedOutputDigest(t, 'Gone') };
    expect([...bindingSkippedOutputs(t, record)]).toEqual([]);
  });
});

describe('resolveTemplateOutputs with binding skipped-output keys (issue #2740)', () => {
  // Stands in for the diff's `skipDynamicReferences` resolver: a secret
  // reference ASSEMBLES into its own token rather than throwing, which is the
  // whole reason the deploy's failure does not reproduce here.
  const assembling = async (v: unknown): Promise<unknown> => v;

  async function diffRows(
    template: CloudFormationTemplate,
    stored: Record<string, unknown>,
    record: Record<string, string> | undefined
  ) {
    // As `computeStackDiff` wires it: the digests are compared by the caller
    // over the pristine template, and the resolver receives the binding keys.
    const binding = bindingSkippedOutputs(structuredClone(template), record);
    const resolved = await resolveTemplateOutputs(template, assembling, undefined, stored, binding);
    const rows = computeOutputsDiff(stored, resolved.outputs, resolved.exportNames);
    return { resolved, rows };
  }

  it('CONTROL: without a record the never-resolved output previews as a phantom ADD', async () => {
    const { resolved, rows } = await diffRows(base(), { Other: 'plain' }, undefined);
    expect(resolved.resolutionFailed).toBe(false);
    expect(rows.map((r) => [r.name, r.changeType])).toEqual([['Leak', 'ADD']]);
  });

  it('a binding record (key absent from state, digest unchanged) previews the key as ABSENT: no row, no failure flag', async () => {
    const t = base();
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    const { resolved, rows } = await diffRows(t, { Other: 'plain' }, record);
    // Deliberately NOT a resolution failure: that would suppress the section.
    expect(resolved.resolutionFailed).toBe(false);
    expect(resolved.failedKeys.size).toBe(0);
    expect(resolved.outputs).not.toHaveProperty('Leak');
    expect(rows).toEqual([]);
  });

  it('a binding record on an exported output previews the literal alias as absent too', async () => {
    const t = base();
    t.Outputs!['Leak']!.Export = { Name: 'S:Leak' };
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    const { resolved, rows } = await diffRows(t, { Other: 'plain' }, record);
    expect(resolved.resolutionFailed).toBe(false);
    expect(resolved.outputs).not.toHaveProperty('S:Leak');
    expect(resolved.exportNames.has('S:Leak')).toBe(false);
    expect(rows).toEqual([]);
  });

  it('the record does NOT bind when the digest moved: the repaired output is an ordinary ADD again', async () => {
    const t = base();
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    const repaired = base();
    repaired.Outputs!['Leak']!.Value = SECRET_REF.replace('missing', 'password');
    const { resolved, rows } = await diffRows(repaired, { Other: 'plain' }, record);
    expect(resolved.resolutionFailed).toBe(false);
    expect(rows.map((r) => [r.name, r.changeType])).toEqual([['Leak', 'ADD']]);
  });

  it('an INHERITED key on the stored bag does not count as "state holds the key"', async () => {
    // A bag parsed from JSON inherits from `Object.prototype`, which holds no
    // output key, so this case builds the inheritance by hand; it pins the
    // reader's own-key check against a future `in`: an inherited `Leak` must
    // not end the suppression.
    const t = base();
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    const stored = Object.create({ Leak: 'inherited' }) as Record<string, unknown>;
    stored['Other'] = 'plain';
    const { resolved, rows } = await diffRows(t, stored, record);
    expect(resolved.outputs).not.toHaveProperty('Leak');
    expect(rows).toEqual([]);
  });

  it('the record does NOT bind when state holds the key: a later deploy resolved it', async () => {
    const t = base();
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    const stored = { Other: 'plain', Leak: 'was-resolved' };
    const { resolved, rows } = await diffRows(t, stored, record);
    expect(resolved.resolutionFailed).toBe(false);
    // The preview assembles the token; state holds a value — an honest MODIFY,
    // exactly what a stale record must not hide.
    expect(rows.map((r) => [r.name, r.changeType])).toEqual([['Leak', 'MODIFY']]);
  });

  it('a record for a key today\x27s template no longer declares is inert', async () => {
    const t = base();
    const record = { Gone: skippedOutputDigest(t, 'Gone') };
    const { resolved, rows } = await diffRows(t, { Other: 'plain' }, record);
    expect(resolved.resolutionFailed).toBe(false);
    expect(rows.map((r) => [r.name, r.changeType])).toEqual([['Leak', 'ADD']]);
  });

  it('co-exists with a resolutionFailed raised by a DIFFERENT output: no row of its own, no extra failed key', async () => {
    // Correct by construction — a suppressed key is in neither bag, so it can
    // add neither a row nor a `failedKeys` entry — but the caller filters its
    // warning by `failedKeys`, so "by construction" is worth one case.
    const t = base();
    t.Outputs!['Pending'] = { Value: { 'Fn::GetAtt': ['NotYet', 'Arn'] } };
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    // Models the QUIET skip arm: a provider that cannot construct the
    // attribute, where `resolve` RETURNS `undefined` without throwing. That is
    // the production shape for this case, and the reason the mock is not the
    // identity function: the diff's `bestEffort` flag does not make the
    // resolver hand back an unresolvable intrinsic — a missing-resource
    // `Fn::GetAtt` throws outright, and `bestEffort` only lowers the log level
    // of the sibling not-found `Ref` (`intrinsic-function-resolver.ts:3205`).
    // The throwing arm is caught in `outputs-diff.ts` and covered by
    // `outputs-diff.test.ts`, not here.
    const pending = async (v: unknown): Promise<unknown> =>
      v !== null && typeof v === 'object' && 'Fn::GetAtt' in (v as object) ? undefined : v;
    const binding = bindingSkippedOutputs(structuredClone(t), record);
    const resolved = await resolveTemplateOutputs(t, pending, undefined, { Other: 'plain' }, binding);
    expect(resolved.resolutionFailed).toBe(true);
    // ONLY the genuinely-unresolvable key is recorded as failed; the
    // suppressed one is simply absent.
    expect([...resolved.failedKeys]).toEqual(['Pending']);
    expect(resolved.outputs).not.toHaveProperty('Leak');
    expect(resolved.outputs).not.toHaveProperty('Pending');
  });

  it('un-binding a GetAtt-shaped record flips resolutionFailed and lands the key in failedKeys', async () => {
    // THE VERDICT-LEVEL DISCRIMINATOR, composed end to end for the arm where
    // the diff cannot resolve the output either: one reading an attribute of a
    // resource state does not hold. That is the SECOND skip arm this record
    // covers — issue #2740 itself was filed on the secret lookup, which the
    // diff resolves cleanly and which therefore discriminates on the row. The other two un-bind arms in this repo —
    // this suite's sibling wiring case and the fixture's `NeverResolvesViaRef`
    // — both use a reference the diff CAN resolve, so they discriminate on the
    // rendered ROW. Neither of them can see the arm that matters here, where
    // the row is unshowable in both readings and the only observable
    // difference is the verdict: bound, `cdkd diff` reports the outputs
    // settled while the next deploy publishes the key and its `Export.Name`.
    //
    // The pieces exist separately — the binding SET dropping a changed id, and
    // `resolutionFailed` for a GetAtt key that never had a record — but
    // nothing composed them, so a later "only un-bind when the output actually
    // resolves" tweak would ship green through all of them and re-introduce
    // exactly the harm round 1 of the review identified.
    const t = base();
    t.Outputs!['Leak'] = { Value: { 'Fn::GetAtt': ['MyRes', 'Arn'] } };
    t.Resources!['MyRes'] = { Type: 'AWS::SSM::Parameter', Properties: { Value: 'y' } };
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    // The QUIET skip arm, which is the production shape for an attribute the
    // provider cannot construct: `resolve` returns `undefined` without
    // throwing. No SDK, no fence.
    const pending = async (v: unknown): Promise<unknown> =>
      v !== null && typeof v === 'object' && 'Fn::GetAtt' in (v as object) ? undefined : v;

    // BOUND: no resource the output references is changing, so the record
    // speaks for the key. Nothing failed and nothing is offered to the warn.
    const bound = await resolveTemplateOutputs(
      t,
      pending,
      undefined,
      { Other: 'plain' },
      bindingSkippedOutputs(structuredClone(t), record, new Set())
    );
    expect(bound.resolutionFailed).toBe(false);
    expect([...bound.failedKeys]).toEqual([]);
    expect(bound.outputs).not.toHaveProperty('Leak');

    // UN-BOUND by the change map: the key is resolved like any other output,
    // that resolution fails, and BOTH signals flip. This case stops at the two
    // signals and does NOT assert a warn: `computeStackDiff` warns only when
    // some other output difference survives the `failedKeys` filter, and this
    // template has none. What is composed here is the part the row-shaped
    // cases cannot reach — that un-binding a key whose value is unresolvable
    // changes the verdict at all.
    const unbound = await resolveTemplateOutputs(
      t,
      pending,
      undefined,
      { Other: 'plain' },
      bindingSkippedOutputs(structuredClone(t), record, new Set(['MyRes']))
    );
    expect(unbound.resolutionFailed).toBe(true);
    expect([...unbound.failedKeys]).toEqual(['Leak']);
    expect(unbound.outputs).not.toHaveProperty('Leak');
  });

  it('a binding record on one key leaves a sibling\x27s genuine change VISIBLE (the section is not suppressed)', async () => {
    const t = base();
    const record = { Leak: skippedOutputDigest(t, 'Leak') };
    const { resolved, rows } = await diffRows(t, { Other: 'old' }, record);
    expect(resolved.resolutionFailed).toBe(false);
    expect(rows.map((r) => [r.name, r.changeType])).toEqual([['Other', 'MODIFY']]);
  });
});
