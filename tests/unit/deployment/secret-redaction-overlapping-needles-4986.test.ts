import { describe, it, expect } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  MIN_NEEDLE_LENGTH,
  SECRET_MASK,
  recordDerivedMaskOnlyValue,
  recordFreshNoEchoValuesIn,
  overlapRuleAnswered,
  withLegacyOverlapScan,
  legacyReferenceLeavesOnly,
  repairPhysicalNameCopyLeaves,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// go-to-k/cdkd#4986: two recorded plaintexts that OVERLAP inside one leaf.
// The substring arm's regex alternation is leftmost-first, so the first
// needle consumed the shared characters and the second needle's tail stayed
// in the persisted leaf in plaintext.
const A = 'us-east-1pw12';
const B = 'pw12-str4ddle-4973';
const A_EXPR = '{{resolve:secretsmanager:a:SecretString:a}}';
const B_EXPR = '{{resolve:secretsmanager:b:SecretString:b}}';

/** Every substring of `plaintext` at or above the needle floor. */
function substringsAtFloor(plaintext: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < plaintext.length; i++) {
    for (let j = i + MIN_NEEDLE_LENGTH; j <= plaintext.length; j++) out.push(plaintext.slice(i, j));
  }
  return out;
}

/** Asserts no substring of any plaintext at or above the floor survives in `leaf`. */
function expectNoPlaintextFragment(leaf: unknown, plaintexts: readonly string[]): void {
  expect(typeof leaf).toBe('string');
  for (const plaintext of plaintexts) {
    for (const fragment of substringsAtFloor(plaintext)) {
      expect(leaf as string, `fragment ${JSON.stringify(fragment)}`).not.toContain(fragment);
    }
  }
}

function redactLeaf(leaf: string, entries: ReadonlyArray<readonly [string, string]>): unknown {
  const secrets: RecordedSecretValues = new Map(entries);
  return (redactSecretsForState({ V: leaf }, secrets) as Record<string, unknown>)['V'];
}

function redactLeaf2(leaf: string, secrets: RecordedSecretValues): unknown {
  return (redactSecretsForState({ V: leaf }, secrets) as Record<string, unknown>)['V'];
}

/** Both insertion orders of a two-entry map, since the issue reproduced in either. */
const BOTH_ORDERS: ReadonlyArray<[string, ReadonlyArray<readonly [string, string]>]> = [
  [
    'A first',
    [
      [A, A_EXPR],
      [B, B_EXPR],
    ],
  ],
  [
    'B first',
    [
      [B, B_EXPR],
      [A, A_EXPR],
    ],
  ],
];

describe('redactSecretsForState: overlapping recorded plaintexts in one leaf (#4986)', () => {
  describe.each(BOTH_ORDERS)('map order: %s', (_name, entries) => {
    it('the issue repro: no fragment of either plaintext survives, and the leaf is masked whole', () => {
      const out = redactLeaf(`${A}-str4ddle-4973`, entries);
      expectNoPlaintextFragment(out, [A, B]);
      expect(out).toBe(SECRET_MASK);
    });

    it('overlap at the START of a mixed leaf, with a non-secret literal after it', () => {
      const out = redactLeaf(`${A}-str4ddle-4973/suffix-literal`, entries);
      expectNoPlaintextFragment(out, [A, B]);
      expect(out).toBe(SECRET_MASK);
    });

    it('overlap at the END of a mixed leaf, with a non-secret literal before it', () => {
      const out = redactLeaf(`prefix-literal/${A}-str4ddle-4973`, entries);
      expectNoPlaintextFragment(out, [A, B]);
      expect(out).toBe(SECRET_MASK);
    });

    it('NEGATIVE CONTROL: the same two needles apart in one leaf are each replaced by their expression', () => {
      const out = redactLeaf(`x/${A}/mid/${B}/y`, entries);
      expect(out).toBe(`x/${A_EXPR}/mid/${B_EXPR}/y`);
    });

    it('NEGATIVE CONTROL: ADJACENT occurrences do not overlap, so each keeps its expression', () => {
      const out = redactLeaf(`${A}${B}`, entries);
      expect(out).toBe(`${A_EXPR}${B_EXPR}`);
    });
  });

  it('nested CONTAINMENT keeps the longer needle expression (a single occurrence spans the union)', () => {
    const outer = 'outer-secret-pw12-tail';
    const inner = 'secret-pw12';
    for (const entries of [
      [
        [outer, A_EXPR],
        [inner, B_EXPR],
      ],
      [
        [inner, B_EXPR],
        [outer, A_EXPR],
      ],
    ] as const) {
      expect(redactLeaf(`pre:${outer}:post`, entries)).toBe(`pre:${A_EXPR}:post`);
    }
  });

  it('splices EACH cluster at its own offset: a containment cluster, then a disjoint match', () => {
    // The overlap path rebuilds the leaf cluster by cluster; the text between
    // clusters must come from the right offsets, or a needle reappears whole.
    const outer = 'outer-secret-pw12-tail';
    const inner = 'secret-pw12';
    const other = 'other-secret-77';
    const Z_EXPR = '{{resolve:secretsmanager:z:SecretString:z}}';
    const out = redactLeaf(`pre:${outer}:mid:${other}:post`, [
      [outer, A_EXPR],
      [inner, B_EXPR],
      [other, Z_EXPR],
    ]);
    expect(out).toBe(`pre:${A_EXPR}:mid:${Z_EXPR}:post`);
    // ADJACENT clusters are two clusters, each spliced, not one masked run.
    expect(
      redactLeaf(`${outer}${other}`, [
        [outer, A_EXPR],
        [inner, B_EXPR],
        [other, Z_EXPR],
      ])
    ).toBe(`${A_EXPR}${Z_EXPR}`);
  });

  it('a cluster that matches TILE end to start keeps each tile expression', () => {
    // `CDEF` overlaps both, but `ABCD` + `EFGH` render the whole run exactly,
    // so nothing is left in the clear and no mask is needed.
    const E1 = '{{resolve:secretsmanager:e1:SecretString:e1}}';
    const E2 = '{{resolve:secretsmanager:e2:SecretString:e2}}';
    const E3 = '{{resolve:secretsmanager:e3:SecretString:e3}}';
    expect(
      redactLeaf('zzABCDEFGHzz', [
        ['ABCD', E1],
        ['CDEF', E2],
        ['EFGH', E3],
      ])
    ).toBe(`zz${E1}${E3}zz`);
    // A repeated plaintext tiles itself.
    expect(redactLeaf('x:0000000000000000:y', [['00000000', E1]])).toBe(`x:${E1}${E1}:y`);
    // No tiling (the run from `ABCD`'s end has no match starting there): masked.
    expect(
      redactLeaf('zzABCDEFGzz', [
        ['ABCD', E1],
        ['BCDEF', E2],
        ['DEFG', E3],
      ])
    ).toBe(SECRET_MASK);
  });

  it('a substring match that CUTS a containment needle (fresh NoEcho, derived) masks the leaf whole', () => {
    // A containment needle is no substring needle: the scan wrote an
    // expression over its tail and the post-pass, looking for it whole,
    // missed the `NOECHO` head left in the clear.
    const fresh: RecordedSecretValues = new Map([['ab12cdef', A_EXPR]]);
    recordFreshNoEchoValuesIn('NOECHOab12', fresh);
    expect(redactLeaf2('xNOECHOab12cdefx', fresh)).toBe(SECRET_MASK);
    const derived: RecordedSecretValues = new Map([['ab12cdef', A_EXPR]]);
    recordDerivedMaskOnlyValue(derived, 'QkFTRTY0ab12');
    expect(redactLeaf2('xQkFTRTY0ab12cdefx', derived)).toBe(SECRET_MASK);
    // A containment needle no match touches is left to the post-pass, which
    // masks the leaf whole anyway (not a discriminator for the cut check; it
    // pins that the two arms agree).
    const apart: RecordedSecretValues = new Map([['ab12cdef', A_EXPR]]);
    recordFreshNoEchoValuesIn('NOECHO-zz', apart);
    expect(redactLeaf2('x:ab12cdef:NOECHO-zz', apart)).toBe(SECRET_MASK);
    // NEGATIVE CONTROL: one a match CONTAINS goes with that match.
    const inside: RecordedSecretValues = new Map([['pre-NOECHO-zz-post', A_EXPR]]);
    recordFreshNoEchoValuesIn('NOECHO-zz', inside);
    expect(redactLeaf2('x:pre-NOECHO-zz-post', inside)).toBe(`x:${A_EXPR}`);
  });

  it('a THREE-WAY chain of overlaps is masked whole, in every insertion order', () => {
    const x = 'alpha-bravo1';
    const y = 'bravo1-charlie2';
    const z = 'charlie2-delta3';
    const leaf = 'k=alpha-bravo1-charlie2-delta3;';
    const pairs: Array<readonly [string, string]> = [
      [x, '{{resolve:secretsmanager:x:SecretString:x}}'],
      [y, '{{resolve:secretsmanager:y:SecretString:y}}'],
      [z, '{{resolve:secretsmanager:z:SecretString:z}}'],
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const out = redactLeaf(
        leaf,
        order.map((i) => pairs[i]!)
      );
      expectNoPlaintextFragment(out, [x, y, z]);
      expect(out).toBe(SECRET_MASK);
    }
  });

  it('an overlapping pair masks the WHOLE leaf even beside a disjoint, renderable occurrence', () => {
    // An inline mask is indistinguishable from a literal, so the leaf is masked
    // whole rather than spliced (the mask-only rule in mask-only.ts).
    const out = redactLeaf(`${B}|${A}-str4ddle-4973`, [
      [A, A_EXPR],
      [B, B_EXPR],
    ]);
    expect(out).toBe(SECRET_MASK);
  });

  it('a SELF-overlapping needle (a repeated plaintext) leaves no tail behind', () => {
    const p = 'abab-abab-';
    const out = redactLeaf('abab-abab-abab-', [[p, A_EXPR]]);
    expectNoPlaintextFragment(out, [p]);
    expect(out).toBe(SECRET_MASK);
  });

  it('a whole-token leaf is never rewritten even when needles overlap inside its text', () => {
    // Both occurrences are strictly inside a resolvable span, so both are KEPT
    // (#1935) and the token persists verbatim.
    const token = `{{resolve:secretsmanager:${A}-str4ddle-4973:SecretString:pw}}`;
    expect(
      redactLeaf(token, [
        [A, A_EXPR],
        [B, B_EXPR],
      ])
    ).toBe(token);
  });

  it.each([
    ['an Fn::Join with a region Ref', { 'Fn::Join': ['', [{ Ref: 'AWS::Region' }, B_EXPR]] }],
    ['an Fn::Sub with a region placeholder', { 'Fn::Sub': '${AWS::Region}' + B_EXPR }],
    ['a literal prefix + the B reference', 'us-east-1' + B_EXPR],
    ['the A reference + a literal suffix', A_EXPR + '-str4ddle-4973'],
  ])('with a template SOURCE (%s), the positioned walk masks the leaf too', (_name, source) => {
    // The deploy path hands the template bag; every positioner falls through
    // to the value scan for this leaf, which used to leave B's tail.
    const secrets: RecordedSecretValues = new Map([
      [A, A_EXPR],
      [B, B_EXPR],
    ]);
    const out = redactSecretsForState({ V: `${A}-str4ddle-4973`, W: B }, secrets, {
      V: source,
      W: B_EXPR,
    }) as Record<string, unknown>;
    expect(out['V']).toBe(SECRET_MASK);
    expect(out['W']).toBe(B_EXPR);
  });

  it('a match a KEPT one used to hide (it starts inside it and crosses the span edge) is redacted', () => {
    // `/abcd` is strictly inside the span and kept (#1935); `cd}}ef` starts
    // inside it and crosses the span's end, so it is not. The leftmost-first
    // replace consumed `/abcd` and never saw `cd}}ef`, persisting it whole.
    const K_EXPR = '{{resolve:secretsmanager:K:SecretString:k}}';
    const N_EXPR = '{{resolve:secretsmanager:N:SecretString:n}}';
    const leaf = 'x{{resolve:ssm:/abcd}}ef-y';
    expect(
      redactLeaf(leaf, [
        ['/abcd', K_EXPR],
        ['cd}}ef', N_EXPR],
      ])
    ).toBe(`x{{resolve:ssm:/ab${N_EXPR}-y`);
    // NEGATIVE CONTROL: the kept match alone leaves the leaf as it is.
    expect(redactLeaf(leaf, [['/abcd', K_EXPR]])).toBe(leaf);
  });

  it('withLegacyOverlapScan reproduces the pre-fix spelling, and only an overlap marks the map', () => {
    // The comparison key of the one-time legacy repair in update.ts.
    const secrets: RecordedSecretValues = new Map([
      [A, A_EXPR],
      [B, B_EXPR],
    ]);
    const leaf = { V: `${A}-str4ddle-4973` };
    expect(withLegacyOverlapScan(secrets, () => redactSecretsForState(leaf, secrets))).toEqual({
      V: `${A_EXPR}-str4ddle-4973`,
    });
    // The switch is cleared afterwards.
    expect(redactSecretsForState(leaf, secrets)).toEqual({ V: SECRET_MASK });
    expect(overlapRuleAnswered(secrets)).toBe(true);
    // A disjoint pass never marks its map, so no deploy pays for the second walk.
    const disjoint: RecordedSecretValues = new Map([
      [A, A_EXPR],
      [B, B_EXPR],
    ]);
    redactSecretsForState({ V: `x/${A}/${B}` }, disjoint);
    expect(overlapRuleAnswered(disjoint)).toBe(false);
  });

  it('the legacy repair key keeps only reference leaves, so a stored mask is never repaired', () => {
    // A stored `***` identifies no value; repairing it would hide a real edit
    // from the masked-property fingerprints (PR #4988 security review).
    const legacy = legacyReferenceLeavesOnly({
      V: SECRET_MASK,
      W: `${A_EXPR}-str4ddle-4973`,
      L: ['plain', `${A_EXPR}x`],
    }) as Record<string, unknown>;
    expect(repairPhysicalNameCopyLeaves(SECRET_MASK, legacy['V'], `x${B_EXPR}`)).toBe(SECRET_MASK);
    expect(repairPhysicalNameCopyLeaves(`${A_EXPR}-str4ddle-4973`, legacy['W'], SECRET_MASK)).toBe(
      SECRET_MASK
    );
    expect(legacy['L']).toEqual([undefined, `${A_EXPR}x`]);
  });

  it('scrubResourceRecord persists the masked leaf in properties, attributes and observedProperties', () => {
    const leaf = `${A}-str4ddle-4973`;
    const secrets: RecordedSecretValues = new Map([
      [A, A_EXPR],
      [B, B_EXPR],
    ]);
    const out = scrubResourceRecord(
      {
        properties: { V: leaf },
        attributes: { V: leaf },
        observedProperties: { V: leaf },
      },
      secrets
    );
    expect(out.properties['V']).toBe(SECRET_MASK);
    expect(out.attributes?.['V']).toBe(SECRET_MASK);
    expectNoPlaintextFragment(out.observedProperties?.['V'], [A, B]);
  });
});
