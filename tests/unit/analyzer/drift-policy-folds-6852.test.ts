/**
 * go-to-k/cdkd#6852 cross-check: inside a verbatim-echo policy document's
 * `Statement`, the comparator reads as one value the spellings the services
 * return for what a template sent (measured 2026-11-23, us-east-1, plain
 * APIs), and nothing else. Each fold has a positive case (both directions)
 * and the boundary pairs that must stay different; the preserved-as-sent
 * behaviors (order, `"Sid": ""`, no Sid added) are pinned as negatives; a
 * seeded property test runs random statement pairs against an independent
 * oracle that knows only these folds.
 */
import { describe, it, expect } from 'vite-plus/test';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { verbatimEchoDriftKeys } from '../../../src/analyzer/drift-verbatim-paths.js';

type Bag = Record<string, unknown>;

const BUCKET_POLICY = 'AWS::S3::BucketPolicy';
const ROLE = 'AWS::IAM::Role';
const ACCOUNT = '111111111111';
const OTHER_ACCOUNT = '222222222222';

function drifts(type: string, state: Bag, aws: Bag) {
  return calculateResourceDrift(state, aws, {
    unionWalkPaths: verbatimEchoDriftKeys(type),
    resourceType: type,
  });
}

/** No drift, in both directions. */
function sameBothWays(type: string, a: Bag, b: Bag): boolean {
  return drifts(type, a, b).length === 0 && drifts(type, b, a).length === 0;
}

/** Drift, in both directions. */
function differsBothWays(type: string, a: Bag, b: Bag): boolean {
  return drifts(type, a, b).length > 0 && drifts(type, b, a).length > 0;
}

const policy = (statement: unknown): Bag => ({
  PolicyDocument: { Version: '2012-10-17', Statement: statement },
});
const trust = (statement: unknown): Bag => ({
  AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: statement },
});

const base = {
  Effect: 'Allow',
  Principal: { AWS: `arn:aws:iam::${ACCOUNT}:role/r` },
  Action: 's3:GetObject',
  Resource: 'arn:aws:s3:::b/*',
};

/** Both statement spellings: one object, and a one-element list. */
const SHAPES: readonly [string, (s: Bag) => unknown][] = [
  ['object statement', (s) => s],
  ['list statement', (s) => [s]],
];

describe.each(SHAPES)('M1 one-element list vs scalar (%s)', (_label, shape) => {
  it.each(['Action', 'NotAction', 'Resource', 'NotResource'])('equates %s', (key) => {
    const scalar = { ...base, [key]: 'x:Y' };
    const list = { ...base, [key]: ['x:Y'] };
    expect(sameBothWays(BUCKET_POLICY, policy(shape(scalar)), policy(shape(list)))).toBe(true);
  });
  it.each(['AWS', 'Service', 'Federated', 'CanonicalUser'])(
    'equates a Principal.%s and a NotPrincipal one',
    (key) => {
      for (const p of ['Principal', 'NotPrincipal']) {
        const scalar = { ...base, Principal: undefined, [p]: { [key]: 'v' } };
        const list = { ...base, Principal: undefined, [p]: { [key]: ['v'] } };
        expect(sameBothWays(BUCKET_POLICY, policy(shape(scalar)), policy(shape(list)))).toBe(true);
      }
    }
  );
  it.each([
    ['a two-element list vs a scalar', 'x:Y', ['x:Y', 'x:Z']],
    ['a two-element list reordered', ['x:Y', 'x:Z'], ['x:Z', 'x:Y']],
    ['an empty list vs a scalar', 'x:Y', []],
    ['a one-element list of another value', 'x:Y', ['x:Z']],
  ])('reports %s', (_l, a, b) => {
    expect(
      differsBothWays(
        BUCKET_POLICY,
        policy(shape({ ...base, Action: a })),
        policy(shape({ ...base, Action: b }))
      )
    ).toBe(true);
  });
  it('keeps a Condition value one-element list vs scalar strict (#6842)', () => {
    const cond = (v: unknown) => ({ ...base, Condition: { StringEquals: { 'aws:x': v } } });
    expect(differsBothWays(BUCKET_POLICY, policy(shape(cond('a'))), policy(shape(cond(['a']))))).toBe(
      true
    );
  });
});

describe.each(SHAPES)('M2 bare account id vs its root ARN, Principal.AWS only (%s)', (_l, shape) => {
  const withPrincipal = (key: string, p: string, v: unknown) =>
    trust(shape({ Effect: 'Allow', Action: 'sts:AssumeRole', [p]: { [key]: v } }));
  it.each(['Principal', 'NotPrincipal'])('equates them under %s.AWS', (p) => {
    for (const arn of [`arn:aws:iam::${ACCOUNT}:root`, `arn:aws-cn:iam::${ACCOUNT}:root`]) {
      expect(sameBothWays(ROLE, withPrincipal('AWS', p, ACCOUNT), withPrincipal('AWS', p, arn))).toBe(
        true
      );
      // In a list, and as a one-element list against the scalar ARN.
      expect(
        sameBothWays(
          ROLE,
          withPrincipal('AWS', p, [ACCOUNT, 'arn:aws:iam::333333333333:role/x']),
          withPrincipal('AWS', p, [arn, 'arn:aws:iam::333333333333:role/x'])
        )
      ).toBe(true);
      expect(sameBothWays(ROLE, withPrincipal('AWS', p, [ACCOUNT]), withPrincipal('AWS', p, arn))).toBe(
        true
      );
    }
  });
  it.each([
    ['another account root', 'AWS', ACCOUNT, `arn:aws:iam::${OTHER_ACCOUNT}:root`],
    ['a user of the account', 'AWS', ACCOUNT, `arn:aws:iam::${ACCOUNT}:user/root`],
    ['an 11-digit id', 'AWS', '11111111111', 'arn:aws:iam::11111111111:root'],
    ['a bare id under Service', 'Service', ACCOUNT, `arn:aws:iam::${ACCOUNT}:root`],
    ['a bare id under Federated', 'Federated', ACCOUNT, `arn:aws:iam::${ACCOUNT}:root`],
    ['a bare id under CanonicalUser', 'CanonicalUser', ACCOUNT, `arn:aws:iam::${ACCOUNT}:root`],
    ['two ids reordered', 'AWS', [ACCOUNT, OTHER_ACCOUNT], [OTHER_ACCOUNT, ACCOUNT]],
  ])('reports %s', (_label, key, a, b) => {
    expect(differsBothWays(ROLE, withPrincipal(key, 'Principal', a), withPrincipal(key, 'Principal', b))).toBe(
      true
    );
  });
  it('does not equate a bare id with a root ARN outside a Principal position', () => {
    const resource = (v: string) => trust(shape({ ...base, Resource: v }));
    expect(differsBothWays(ROLE, resource(ACCOUNT), resource(`arn:aws:iam::${ACCOUNT}:root`))).toBe(
      true
    );
  });
});

describe.each(SHAPES)('M3 Effect compared case-insensitively (%s)', (_l, shape) => {
  const effect = (e: string) => policy(shape({ ...base, Effect: e }));
  it('equates allow with Allow', () => {
    expect(sameBothWays(BUCKET_POLICY, effect('allow'), effect('Allow'))).toBe(true);
    expect(sameBothWays(BUCKET_POLICY, effect('DENY'), effect('Deny'))).toBe(true);
  });
  it('reports Deny vs allow', () => {
    expect(differsBothWays(BUCKET_POLICY, effect('Deny'), effect('allow'))).toBe(true);
  });
  it('compares the case of another statement key strictly', () => {
    const sid = (s: string) => policy(shape({ ...base, Sid: s }));
    expect(differsBothWays(BUCKET_POLICY, sid('Read'), sid('read'))).toBe(true);
    const action = (a: string) => policy(shape({ ...base, Action: a }));
    expect(differsBothWays(BUCKET_POLICY, action('s3:GetObject'), action('S3:GETOBJECT'))).toBe(
      true
    );
  });
});

describe.each(SHAPES)('M4 Condition number / boolean vs its String() form (%s)', (_l, shape) => {
  const cond = (v: unknown) =>
    policy(shape({ ...base, Condition: { NumericLessThan: { 's3:TlsVersion': v } } }));
  it.each([
    [1.2, '1.2'],
    [false, 'false'],
    [true, 'true'],
    [0, '0'],
    [[1.2, false], ['1.2', 'false']],
  ])('equates %j with %j', (a, b) => {
    expect(sameBothWays(BUCKET_POLICY, cond(a), cond(b))).toBe(true);
  });
  it.each([
    [1.2, '1.20'],
    [1.2, 1.3],
    [false, 'False'],
    [false, '0'],
    [1, 'true'],
    [1.2, ['1.2']],
    [[1.2, 2], ['2', '1.2']],
  ])('reports %j vs %j', (a, b) => {
    expect(differsBothWays(BUCKET_POLICY, cond(a), cond(b))).toBe(true);
  });
  it('does not stringify a number outside Condition', () => {
    const resource = (v: unknown) => policy(shape({ ...base, Resource: v }));
    expect(differsBothWays(BUCKET_POLICY, resource(1), resource('1'))).toBe(true);
  });
});

describe('the measured shape: object statement in the template, one-element list live', () => {
  it('folds M1 and M2 across the two statement shapes', () => {
    const tmpl = trust({ Effect: 'Allow', Action: ['sts:AssumeRole'], Principal: { AWS: ACCOUNT } });
    const live = trust([
      { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` } },
    ]);
    expect(sameBothWays(ROLE, tmpl, live)).toBe(true);
  });
  it('reports a real change across the two statement shapes', () => {
    const tmpl = trust({ Effect: 'Allow', Action: ['sts:AssumeRole'], Principal: { AWS: ACCOUNT } });
    const live = trust([
      { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: `arn:aws:iam::${OTHER_ACCOUNT}:root` } },
    ]);
    expect(differsBothWays(ROLE, tmpl, live)).toBe(true);
  });
});

describe('a Condition key holding dots', () => {
  const KEY = 'token.actions.githubusercontent.com:sub';
  const cond = (dotted: unknown, other: unknown) =>
    policy({ ...base, Condition: { NumericLessThan: { [KEY]: dotted, k2: other } } });
  it('folds M4 at the dotted key while a sibling key really changed', () => {
    expect(drifts(BUCKET_POLICY, cond(1.2, 'a'), cond('1.2', 'b'))).toEqual([
      { path: 'PolicyDocument.Statement.Condition.NumericLessThan.k2', stateValue: 'a', awsValue: 'b' },
    ]);
  });
  it('keeps a one-element list vs scalar strict at the dotted key', () => {
    expect(drifts(BUCKET_POLICY, cond('x', 'a'), cond(['x'], 'b')).map((d) => d.path)).toEqual([
      `PolicyDocument.Statement.Condition.NumericLessThan.${KEY}`,
      'PolicyDocument.Statement.Condition.NumericLessThan.k2',
    ]);
  });
});

describe('partition spelling of a root ARN', () => {
  const p = (v: unknown) => trust({ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: v } });
  it.each(['aws', 'aws-cn', 'aws-us-gov', 'aws-iso-b'])('folds the %s partition', (part) => {
    expect(sameBothWays(ROLE, p(ACCOUNT), p(`arn:${part}:iam::${ACCOUNT}:root`))).toBe(true);
  });
  it.each(['awsx', 'aws-', 'AWS', 'gcp'])('does not fold a made-up partition %s', (part) => {
    expect(differsBothWays(ROLE, p(ACCOUNT), p(`arn:${part}:iam::${ACCOUNT}:root`))).toBe(true);
  });
  it.each([
    ['aws', 'aws-cn'],
    ['aws', 'aws-us-gov'],
    ['aws-cn', 'aws-iso-b'],
  ])('reports two root ARNs of the %s and %s partitions', (a, b) => {
    const root = (part: string) => `arn:${part}:iam::${ACCOUNT}:root`;
    expect(differsBothWays(ROLE, p(root(a)), p(root(b)))).toBe(true);
    // In a list, and as a one-element list against the scalar.
    expect(differsBothWays(ROLE, p([root(a), ACCOUNT]), p([root(b), ACCOUNT]))).toBe(
      true
    );
    expect(differsBothWays(ROLE, p([root(a)]), p(root(b)))).toBe(true);
  });
  it('equates two bare ids only when they are the same id', () => {
    expect(sameBothWays(ROLE, p(ACCOUNT), p([ACCOUNT]))).toBe(true);
    expect(differsBothWays(ROLE, p(ACCOUNT), p(OTHER_ACCOUNT))).toBe(true);
  });
});

describe('preserved as sent: kept strict (measured 2026-11-23)', () => {
  it.each([
    ['Action order', { ...base, Action: ['a:A', 'a:B'] }, { ...base, Action: ['a:B', 'a:A'] }],
    ['Resource order', { ...base, Resource: ['r1', 'r2'] }, { ...base, Resource: ['r2', 'r1'] }],
    [
      'Condition value order',
      { ...base, Condition: { StringEquals: { k: ['a', 'b'] } } },
      { ...base, Condition: { StringEquals: { k: ['b', 'a'] } } },
    ],
    ['an empty Sid vs none', { ...base, Sid: '' }, base],
    ['a numeric Sid vs none', { ...base, Sid: '1' }, base],
  ])('reports %s', (_label, a, b) => {
    expect(differsBothWays(BUCKET_POLICY, policy([a]), policy([b]))).toBe(true);
  });
  it('reports a statement reorder', () => {
    const other = { ...base, Action: 's3:PutObject' };
    expect(differsBothWays(BUCKET_POLICY, policy([base, other]), policy([other, base]))).toBe(true);
  });
});

describe('scope: policy statements of verbatim-echo keys only', () => {
  it('does not fold outside a verbatim-echo property', () => {
    const other = (v: unknown) => ({ Other: { Statement: { ...base, Action: v } } });
    expect(differsBothWays(BUCKET_POLICY, other('a:A'), other(['a:A']))).toBe(true);
  });
  it('does not fold on a type without verbatim-echo keys', () => {
    const t = 'AWS::Lambda::Function';
    expect(differsBothWays(t, policy({ ...base, Action: 'a:A' }), policy({ ...base, Action: ['a:A'] }))).toBe(
      true
    );
  });
  it('does not fold beside Statement in the document', () => {
    const doc = (id: unknown) => ({ PolicyDocument: { Id: id, Statement: [base] } });
    expect(differsBothWays(BUCKET_POLICY, doc('x'), doc(['x']))).toBe(true);
  });
});

describe('a reported difference carries the original values', () => {
  it('reports the unfolded spellings when a folded statement still differs', () => {
    const a = { ...base, Action: ['s3:GetObject'], Condition: { NumericLessThan: { k: 1.2 } } };
    const b = { ...base, Action: 's3:GetObject', Condition: { NumericLessThan: { k: '1.3' } } };
    expect(drifts(BUCKET_POLICY, policy([a]), policy([b]))).toEqual([
      { path: 'PolicyDocument.Statement', stateValue: [a], awsValue: [b] },
    ]);
    // Object form: the walk reaches the differing leaf, and only that leaf.
    expect(drifts(BUCKET_POLICY, policy(a), policy(b))).toEqual([
      { path: 'PolicyDocument.Statement.Condition.NumericLessThan.k', stateValue: 1.2, awsValue: '1.3' },
    ]);
  });
});

/**
 * Property-style: a random statement and a random variant of it, made by a
 * mix of fold-preserving rewrites (the measured spellings) and real changes.
 * An independent oracle applies only the four folds. Both directions must
 * hold: "no drift" if and only if oracle-equal.
 */
describe('property: policy statements equal if and only if equal under the four folds', () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
  const VALUES = ['s3:GetObject', 's3:PutObject', ACCOUNT, OTHER_ACCOUNT, `arn:aws:iam::${ACCOUNT}:root`];
  const COND = [1.2, '1.2', '1.20', false, 'false', 'False', 0, '0', 'x'];
  const listOrScalar = (r: () => number): unknown => {
    const n = Math.floor(r() * 3);
    if (n === 0) return pick(r, VALUES);
    return Array.from({ length: n }, () => pick(r, VALUES));
  };
  function gen(r: () => number): Bag {
    const s: Bag = { Effect: pick(r, ['Allow', 'allow', 'Deny', 'DENY']) };
    if (r() < 0.4) s['Sid'] = pick(r, ['', 'S', '1']);
    s[pick(r, ['Action', 'NotAction'])] = listOrScalar(r);
    s[pick(r, ['Resource', 'NotResource'])] = listOrScalar(r);
    if (r() < 0.8) {
      s[pick(r, ['Principal', 'NotPrincipal'])] = { [pick(r, ['AWS', 'AWS', 'Service'])]: listOrScalar(r) };
    }
    if (r() < 0.6) {
      const v = r() < 0.7 ? pick(r, COND) : [pick(r, COND), pick(r, COND)];
      s['Condition'] = { NumericLessThan: { k: v } };
    }
    return s;
  }
  /** A fold-preserving rewrite of one value, or the value itself. */
  function respell(r: () => number, key: string, v: unknown): unknown {
    if (Array.isArray(v) && v.length === 1 && r() < 0.5) return respell(r, key, v[0]);
    if (!Array.isArray(v) && r() < 0.3 && key !== 'Condition') return [respell(r, key, v)];
    if (Array.isArray(v)) return v.map((el) => respell(r, key, el));
    if (key === 'AWS' && v === ACCOUNT && r() < 0.5) return `arn:aws:iam::${ACCOUNT}:root`;
    if (key === 'AWS' && v === `arn:aws:iam::${ACCOUNT}:root` && r() < 0.5) return ACCOUNT;
    if (key === 'Condition' && (typeof v === 'number' || typeof v === 'boolean') && r() < 0.5)
      return String(v);
    return v;
  }
  function variant(r: () => number, s: Bag): Bag {
    const out: Bag = structuredClone(s);
    for (const key of Object.keys(out)) {
      const v = out[key];
      if (key === 'Effect') {
        const k = r();
        if (k < 0.3) out[key] = (v as string).toLowerCase();
        else if (k < 0.4) out[key] = v === 'Deny' ? 'Allow' : 'Deny';
      } else if (key === 'Principal' || key === 'NotPrincipal') {
        const p = v as Bag;
        for (const k of Object.keys(p)) p[k] = r() < 0.15 ? listOrScalar(r) : respell(r, k, p[k]);
      } else if (key === 'Condition') {
        const inner = (v as Record<string, Bag>)['NumericLessThan']!;
        inner['k'] = r() < 0.15 ? pick(r, COND) : respell(r, 'Condition', inner['k']);
      } else if (key === 'Sid') {
        if (r() < 0.1) delete out[key];
      } else if (r() < 0.15) out[key] = listOrScalar(r);
      else out[key] = respell(r, key, v);
    }
    return out;
  }
  /** The oracle: the four folds, written independently of the comparator. */
  function canon(s: Bag): string {
    const one = (v: unknown) => (Array.isArray(v) && v.length === 1 ? v[0] : v);
    const out: Bag = {};
    for (const [key, v] of Object.entries(s)) {
      if (key === 'Effect') out[key] = (v as string).toLowerCase();
      else if (['Action', 'NotAction', 'Resource', 'NotResource'].includes(key)) out[key] = one(v);
      else if (key === 'Principal' || key === 'NotPrincipal') {
        const p: Bag = {};
        for (const [k, pv] of Object.entries(v as Bag)) {
          const acct = (x: unknown) =>
            k === 'AWS' && typeof x === 'string'
              ? x.replace(/^arn:aws:iam::(\d{12}):root$/, 'ACCT:$1').replace(/^(\d{12})$/, 'ACCT:$1')
              : x;
          const u = one(pv);
          p[k] = Array.isArray(u) ? u.map(acct) : acct(u);
        }
        out[key] = p;
      } else if (key === 'Condition') {
        const k = (v as Record<string, Bag>)['NumericLessThan']!['k'];
        const str = (x: unknown) => (typeof x === 'string' ? x : String(x));
        out[key] = { NumericLessThan: { k: Array.isArray(k) ? k.map(str) : str(k) } };
      } else out[key] = v;
    }
    return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
  }

  it.each([1, 2, 3, 4, 5, 6])('seed %i: 400 random statement pairs', (seed) => {
    const r = rng(seed);
    let equalPairs = 0;
    let foldedPairs = 0;
    let differingPairs = 0;
    for (let i = 0; i < 400; i++) {
      const a = gen(r);
      const b = variant(r, a);
      const asList = r() < 0.5;
      const state = policy(asList ? [a] : a);
      const aws = policy(asList ? [b] : b);
      const noDrift = drifts(BUCKET_POLICY, state, aws).length === 0;
      const oracleEqual = canon(a) === canon(b);
      expect(noDrift, `no drift <=> oracle-equal: ${JSON.stringify({ a, b })}`).toBe(oracleEqual);
      expect(drifts(BUCKET_POLICY, aws, state).length === 0, 'symmetric').toBe(noDrift);
      if (!noDrift) differingPairs++;
      else if (JSON.stringify(a) === JSON.stringify(b)) equalPairs++;
      else foldedPairs++;
    }
    // Every arm reached: identical pairs, pairs equal only through a fold,
    // and differing pairs.
    expect(equalPairs).toBeGreaterThan(5);
    expect(foldedPairs).toBeGreaterThan(25);
    expect(differingPairs).toBeGreaterThan(25);
  });
});
