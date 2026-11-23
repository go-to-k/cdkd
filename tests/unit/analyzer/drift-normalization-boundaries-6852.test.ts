/**
 * go-to-k/cdkd#6852: every normalization rule `cdkd drift` compares through
 * and `cdkd diff` decides "no change" through equates ONLY the spellings AWS
 * treats as one value. Each `describe` below is one rule of the inventory in
 * `docs/design/6852-drift-normalization-rules.md`: the positive cases pin the
 * documented equivalence, the negative cases pin its boundary — pairs that
 * must NOT compare equal.
 *
 * The last block is property-style: seeded random value pairs go through the
 * whole comparator, and "no drift" must imply equality under an independent
 * oracle that knows only the documented equivalences.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  calculateResourceDrift,
  equalModuloMask,
  undeclaredEmptyObservedKeys,
} from '../../../src/analyzer/drift-calculator.js';
import { verbatimEchoDriftKeys } from '../../../src/analyzer/drift-verbatim-paths.js';
import { orderSignificantIdArrayPaths } from '../../../src/analyzer/drift-normalize.js';
import { canonicalizePrincipalUniqueIds } from '../../../src/analyzer/drift-principal-normalize.js';
import { canonicalizeIpProtocols } from '../../../src/analyzer/drift-protocol-normalize.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';

type Bag = Record<string, unknown>;

/** True when the comparator reports NO drift between the two bags. */
function same(
  state: Bag,
  aws: Bag,
  options: Parameters<typeof calculateResourceDrift>[2] = {}
): boolean {
  return calculateResourceDrift(state, aws, options).length === 0;
}

const ARN_A = 'arn:aws:sns:us-east-1:123456789012:a';
const ARN_B = 'arn:aws:sns:us-east-1:123456789012:b';
const ARN_C = 'arn:aws:sns:us-east-1:123456789012:c';

describe('tag lists ({Key,...}[]): a reorder is one value, any other change is not', () => {
  const tags = (...pairs: Array<[string, string]>) => ({
    Tags: pairs.map(([Key, Value]) => ({ Key, Value })),
  });
  it('equates two orders of the same tags', () => {
    expect(same(tags(['a', '1'], ['b', '2']), tags(['b', '2'], ['a', '1']))).toBe(true);
  });
  it.each([
    ['a changed value', tags(['a', '1'], ['b', '2']), tags(['a', '1'], ['b', '3'])],
    ['an added tag', tags(['a', '1']), tags(['a', '1'], ['b', '2'])],
    ['a removed tag', tags(['a', '1'], ['b', '2']), tags(['a', '1'])],
    ['a renamed key', tags(['a', '1']), tags(['A', '1'])],
    ['a duplicated key', tags(['a', '1'], ['a', '1']), tags(['a', '1'])],
  ])('reports %s', (_label, state, aws) => {
    expect(same(state, aws)).toBe(false);
  });
});

describe('id / ARN lists: a set, except where the type acts on the order', () => {
  it('equates two orders of the same subnet ids', () => {
    const vpc = (ids: string[]) => ({ VpcConfig: { SubnetIds: ids } });
    expect(
      same(vpc(['subnet-aaa111', 'subnet-bbb222']), vpc(['subnet-bbb222', 'subnet-aaa111']), {
        resourceType: 'AWS::Lambda::Function',
      })
    ).toBe(true);
  });
  it.each([
    ['a replaced member', [ARN_A, ARN_B], [ARN_A, ARN_C]],
    ['an added member', [ARN_A, ARN_B], [ARN_A, ARN_B, ARN_C]],
    ['a duplicated member', [ARN_A, ARN_B], [ARN_A, ARN_A, ARN_B]],
    ['an id against an ARN', [ARN_A, 'sg-0123456'], [ARN_A, 'sg-0123457']],
  ])('reports %s', (_label, state, aws) => {
    expect(same({ AlarmActions: state }, { AlarmActions: aws })).toBe(false);
  });

  // A container's argument vector is passed to the process in list order.
  // Every declared path, so an entry deleted from the table goes red here.
  const ORDERED_TYPES = [
    'AWS::Lambda::Function',
    'AWS::ECS::TaskDefinition',
    'AWS::Batch::JobDefinition',
    'AWS::EMR::Step',
    'AWS::EMR::Cluster',
  ];
  const EXPECTED_ORDERED_PATH_COUNT = 22;
  const ordered = ORDERED_TYPES.flatMap((type) =>
    orderSignificantIdArrayPaths(type).map((path) => [type, path] as const)
  );
  it('covers every declared order-significant path', () => {
    expect(ordered).toHaveLength(EXPECTED_ORDERED_PATH_COUNT);
  });
  it.each(ordered)('%s %s: an out-of-band reorder of two ARN arguments is drift', (type, path) => {
    const at = (list: string[]): Bag => {
      // Build the bag along `path`; a segment that is a list in CFn holds one
      // element.
      const LISTS = new Set([
        'ContainerDefinitions',
        'Containers',
        'InitContainers',
        'NodeRangeProperties',
        'Steps',
        'BootstrapActions',
        'Applications',
      ]);
      const segments = path.split('.');
      let value: unknown = list;
      for (let i = segments.length - 1; i > 0; i--) {
        value = { [segments[i]!]: value };
        if (LISTS.has(segments[i - 1]!)) value = [value];
      }
      return { [segments[0]!]: value };
    };
    expect(same(at([ARN_A, ARN_B]), at([ARN_B, ARN_A]), { resourceType: type })).toBe(false);
    expect(same(at([ARN_A, ARN_B]), at([ARN_A, ARN_B]), { resourceType: type })).toBe(true);
  });

  it('keeps sorting an id list beside an ordered one in the same container', () => {
    const def = (cmd: string[], links: string[]) => ({
      ContainerDefinitions: [{ Command: cmd, Links: links }],
    });
    const options = { resourceType: 'AWS::ECS::TaskDefinition' };
    expect(
      same(
        def([ARN_A, ARN_B], ['web-abcdef1', 'db-abcdef2']),
        def([ARN_A, ARN_B], ['db-abcdef2', 'web-abcdef1']),
        options
      )
    ).toBe(true);
  });
});

describe('declared unordered paths: sorted only where the provider declares them', () => {
  it('equates a reorder at a declared path', () => {
    expect(
      same({ Aliases: ['b', 'a'] }, { Aliases: ['a', 'b'] }, { unorderedPaths: ['Aliases'] })
    ).toBe(true);
  });
  it('reports a reorder of the same strings at an undeclared path', () => {
    expect(same({ Aliases: ['b', 'a'] }, { Aliases: ['a', 'b'] })).toBe(false);
  });
  it('reports a changed member at a declared path', () => {
    expect(
      same({ Aliases: ['b', 'a'] }, { Aliases: ['a', 'c'] }, { unorderedPaths: ['Aliases'] })
    ).toBe(false);
  });
  it('a leaf-only declaration does not reach a list inside an element', () => {
    const gsi = (keys: string[]) => ({
      GlobalSecondaryIndexes: [{ IndexName: 'i', KeySchema: keys }],
    });
    expect(
      same(gsi(['hash', 'range']), gsi(['range', 'hash']), {
        unorderedPaths: ['GlobalSecondaryIndexes[]'],
      })
    ).toBe(false);
  });
});

describe('leaf equality: JSON round-trip, nothing looser', () => {
  it('equates an undefined-valued key with an absent one (JSON drops both)', () => {
    expect(same({ A: { B: 1, C: undefined } }, { A: { B: 1 } })).toBe(true);
  });
  it('equates a Date with its ISO string (the persisted form)', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(same({ T: d.toISOString() }, { T: d })).toBe(true);
    expect(same({ T: '2026-01-02T03:04:06.000Z' }, { T: d })).toBe(false);
  });
  it.each([
    ['null against absent', { A: null }, {}],
    ["'' against absent", { A: '' }, {}],
    ["'' against null", { A: '' }, { A: null }],
    ['a number against its string', { A: 1 }, { A: '1' }],
    ['a boolean against its string', { A: true }, { A: 'true' }],
    ['0 against false', { A: 0 }, { A: false }],
    ['[] against {}', { A: [] }, { A: {} }],
    ['a scalar against a one-element list', { A: 'x' }, { A: ['x'] }],
    ['a reordered plain-string list', { A: ['x', 'y'] }, { A: ['y', 'x'] }],
    ['a case change', { A: 'Enabled' }, { A: 'enabled' }],
    ['trailing whitespace', { A: 'x' }, { A: 'x ' }],
  ])('reports %s', (_label, state, aws) => {
    expect(same(state as Bag, aws as Bag, { unionWalkObjects: true })).toBe(false);
  });
});

describe('policy Statement: an object equals a ONE-element list, at a verbatim path only', () => {
  const ROLE = 'AWS::IAM::Role';
  const opts = { unionWalkPaths: verbatimEchoDriftKeys(ROLE), resourceType: ROLE };
  const stmt = { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 's' } };
  const doc = (statement: unknown) => ({
    AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: statement },
  });
  it('equates an object with a one-element list holding it', () => {
    expect(same(doc(stmt), doc([stmt]), opts)).toBe(true);
    expect(same(doc([stmt]), doc(stmt), opts)).toBe(true);
  });
  it.each([
    ['a second statement', doc(stmt), doc([stmt, { ...stmt, Effect: 'Deny' }])],
    ['no statement', doc(stmt), doc([])],
    ['a changed statement', doc(stmt), doc([{ ...stmt, Action: 'sts:TagSession' }])],
    ['a key added inside the statement', doc(stmt), doc([{ ...stmt, Condition: { X: {} } }])],
  ])('reports %s', (_label, state, aws) => {
    expect(same(state, aws, opts)).toBe(false);
  });
  it('does not fold a Statement outside a verbatim-echo property', () => {
    const other = (s: unknown) => ({ Other: { Statement: s } });
    expect(same(other(stmt), other([stmt]), opts)).toBe(false);
  });
});

describe('an omitted policy Version means 2008-10-17, on the template baseline only', () => {
  const BP = 'AWS::S3::BucketPolicy';
  const paths = verbatimEchoDriftKeys(BP);
  const doc = (version?: string) => ({
    PolicyDocument: {
      ...(version === undefined ? {} : { Version: version }),
      Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*', Principal: '*' }],
    },
  });
  it('equates an omitted Version with the 2008-10-17 the service writes', () => {
    expect(same(doc(), doc('2008-10-17'), { unionWalkPaths: paths })).toBe(true);
  });
  it.each([
    ['2012-10-17 against an omitted Version', doc(), doc('2012-10-17'), false],
    ['a declared Version changed', doc('2012-10-17'), doc('2008-10-17'), false],
    ['the default on the observed baseline', doc(), doc('2008-10-17'), true],
  ])('reports %s', (_label, state, aws, observed) => {
    expect(same(state, aws, { unionWalkPaths: paths, unionWalkObjects: observed })).toBe(false);
  });
});

describe('an unresolved {{resolve:...}} skip is keyed on the BASELINE leaf only', () => {
  it('a token in the live value is compared like any string', () => {
    expect(same({ A: 'plain' }, { A: '{{resolve:ssm:/p}}' })).toBe(false);
  });
});

describe('undeclared captured-empty keys: skipped only when empty AND undeclared', () => {
  it.each([
    ['a declared empty key', { A: [] }, { A: [] }, []],
    ['an undeclared non-empty key', { A: ['x'] }, {}, []],
    ["an undeclared '' (a value, not an empty container)", { A: '' }, {}, []],
    ['an undeclared false', { A: false }, {}, []],
    ['an undeclared 0', { A: 0 }, {}, []],
  ])('compares %s', (_label, observed, declared, expected) => {
    expect(undeclaredEmptyObservedKeys(observed, declared)).toEqual(expected);
  });
  it('skips an undeclared empty list, object or null', () => {
    expect(undeclaredEmptyObservedKeys({ A: [], B: {}, C: null }, {})).toEqual(['A', 'B', 'C']);
  });
});

describe('IAM principal unique id ⇄ ARN: only a PROVEN pair is equal', () => {
  const ROLE_ARN = 'arn:aws:iam::123456789012:role/r';
  const policy = (principal: string, condition?: string) => ({
    PolicyDocument: {
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: principal },
          ...(condition === undefined
            ? {}
            : { Condition: { StringEquals: { 'aws:userid': condition } } }),
        },
      ],
    },
  });
  const run = async (
    baseline: Bag,
    aws: Bag,
    resolve: (arn: string) => Promise<string | undefined>
  ) => {
    const out = await canonicalizePrincipalUniqueIds(baseline, aws, resolve);
    return same(out.baseline, out.aws);
  };
  it('equates a unique id with the ARN the resolver proves it stands for', async () => {
    expect(await run(policy('AROAEXAMPLE1'), policy(ROLE_ARN), async () => 'AROAEXAMPLE1')).toBe(
      true
    );
  });
  it.each([
    ['the resolver cannot answer', async () => undefined],
    ['the role was re-created (another id)', async () => 'AROAEXAMPLE2'],
  ])('reports the pair when %s', async (_label, resolve) => {
    expect(await run(policy('AROAEXAMPLE1'), policy(ROLE_ARN), resolve)).toBe(false);
  });
  it('never rewrites a unique id outside a Principal position', async () => {
    expect(
      await run(
        policy(ROLE_ARN, 'AROAEXAMPLE1'),
        policy(ROLE_ARN, ROLE_ARN),
        async () => 'AROAEXAMPLE1'
      )
    ).toBe(false);
  });
});

describe('EC2 IpProtocol: the four measured renames and case, nothing else', () => {
  const T = 'AWS::EC2::SecurityGroupIngress';
  const eq = (a: unknown, b: unknown, type = T) => {
    const out = canonicalizeIpProtocols({ IpProtocol: a }, { IpProtocol: b }, type);
    return same(out.baseline, out.aws);
  };
  it.each([
    ['6', 'tcp'],
    [6, 'tcp'],
    ['17', 'udp'],
    ['1', 'icmp'],
    ['58', 'icmpv6'],
    ['TCP', 'tcp'],
    [-1, '-1'],
  ])('equates %s and %s', (a, b) => {
    expect(eq(a, b)).toBe(true);
  });
  it.each([
    ['6', 'udp'],
    ['47', 'gre'],
    ['-1', 'all'],
    ['06', 'tcp'],
    ['icmp', 'icmpv6'],
  ])('reports %s against %s', (a, b) => {
    expect(eq(a, b)).toBe(false);
  });
  it('does not rewrite outside the security-group types', () => {
    expect(eq('6', 'tcp', 'AWS::EC2::NetworkAclEntry')).toBe(false);
  });
});

describe('the mask comparator: a mask matches a present value only', () => {
  it.each([
    ['an absent live value', '***', undefined, false],
    ['a null live value', '***', null, false],
    ['a present live value', '***', 'anything', true],
    ['a non-mask difference beside the mask', { A: '***', B: 1 }, { A: 'x', B: 2 }, false],
    ['a list that grew', ['***'], ['x', 'y'], false],
  ])('%s', (_label, state, aws, expected) => {
    expect(equalModuloMask(state, aws, '***')).toBe(expected);
  });
});

describe('diff valuesEqual: key order aside, strict', () => {
  const calc = new DiffCalculator();
  it('equates two key orders of one object', () => {
    expect(calc.valuesEqual({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(
      true
    );
  });
  it.each([
    ['a number against its string', 1, '1'],
    ['null against undefined', null, undefined],
    ['a reordered list', [1, 2], [2, 1]],
    ['a nested key removed', { a: { b: 1, c: 2 } }, { a: { b: 1 } }],
    ['an intrinsic against a value', { Ref: 'X' }, 'x'],
    ['two different intrinsics', { Ref: 'X' }, { Ref: 'Y' }],
    ['a scalar against a one-element list', 'x', ['x']],
  ])('reports %s', (_label, a, b) => {
    expect(calc.valuesEqual(a, b)).toBe(false);
  });
});

/**
 * Property-style: random JSON-shaped values and random mutations of them. For
 * every pair the comparator calls equal, an independent oracle — which knows
 * only the documented equivalences (an undefined key is an absent one; a tag
 * list and an id / ARN list are multisets outside the type's ordered paths) —
 * must call them equal too. A seeded generator keeps a failure reproducible.
 */
describe('property: "no drift" implies equality under the documented equivalences', () => {
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
  const LEAVES = ['a', 'b', 'A', '', '1', 1, 0, true, false, null, ARN_A, ARN_B, 'sg-0abc123'];
  function gen(r: () => number, depth: number): unknown {
    const k = r();
    if (depth <= 0 || k < 0.4) return LEAVES[Math.floor(r() * LEAVES.length)];
    if (k < 0.55) {
      const n = 1 + Math.floor(r() * 3);
      return Array.from({ length: n }, (_, i) => ({ Key: `k${i}`, Value: gen(r, 0) }));
    }
    if (k < 0.7) return [ARN_A, ARN_B, ARN_C].slice(0, 1 + Math.floor(r() * 3));
    if (k < 0.85) return Array.from({ length: Math.floor(r() * 3) }, () => gen(r, depth - 1));
    const out: Bag = {};
    for (const key of ['X', 'Y', 'Z']) if (r() < 0.6) out[key] = gen(r, depth - 1);
    return out;
  }
  function mutate(r: () => number, v: unknown): unknown {
    const k = r();
    if (Array.isArray(v)) {
      if (v.length > 1 && k < 0.3) return [...v].reverse();
      if (k < 0.5) return v.slice(1);
      if (k < 0.7) return [...v, LEAVES[Math.floor(r() * LEAVES.length)]];
      return v.map((el) => (r() < 0.5 ? mutate(r, el) : el));
    }
    if (v && typeof v === 'object') {
      const out: Bag = { ...(v as Bag) };
      const keys = Object.keys(out);
      if (keys.length > 0 && k < 0.3) delete out[keys[Math.floor(r() * keys.length)]!];
      else if (k < 0.45) out['W'] = LEAVES[Math.floor(r() * LEAVES.length)];
      else for (const key of keys) if (r() < 0.5) out[key] = mutate(r, out[key]);
      return out;
    }
    return k < 0.5 ? v : LEAVES[Math.floor(r() * LEAVES.length)];
  }
  const isArn = (s: unknown) => typeof s === 'string' && /^(arn:|[a-z][a-z0-9]*-[0-9a-f]{6,}$)/.test(s);
  /** The oracle's canonical form: only the documented equivalences. */
  function canon(v: unknown): string {
    if (Array.isArray(v)) {
      const parts = v.map(canon);
      const tagList =
        v.length > 0 &&
        v.every((el) => el && typeof el === 'object' && typeof (el as Bag)['Key'] === 'string');
      const idList = v.length > 1 && v.every(isArn);
      if (tagList || idList) parts.sort();
      return `[${parts.join(',')}]`;
    }
    if (v && typeof v === 'object') {
      const bag = v as Bag;
      return `{${Object.keys(bag)
        .filter((key) => bag[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canon(bag[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(v);
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i: 400 random pairs', (seed) => {
    const r = rng(seed);
    let equalPairs = 0;
    let differingPairs = 0;
    for (let i = 0; i < 400; i++) {
      const state = { P: gen(r, 3) };
      const aws = r() < 0.3 ? { P: structuredClone(state.P) } : { P: mutate(r, state.P) };
      const noDrift = same(state, aws, { unionWalkObjects: true });
      const oracleEqual = canon(state) === canon(aws);
      if (noDrift) {
        expect(oracleEqual, JSON.stringify({ state, aws })).toBe(true);
        equalPairs++;
      } else {
        differingPairs++;
      }
      // diff's comparator: equal only for an equal value, key order aside.
      const calc = new DiffCalculator();
      if (calc.valuesEqual(state, aws)) {
        expect(JSON.stringify(sortKeys(state)), 'valuesEqual').toBe(
          JSON.stringify(sortKeys(aws))
        );
      }
    }
    // Both arms must be reached, or the property holds vacuously.
    expect(equalPairs).toBeGreaterThan(50);
    expect(differingPairs).toBeGreaterThan(50);
  });

  function sortKeys(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as Bag)
          .sort()
          .map((k) => [k, sortKeys((v as Bag)[k])])
      );
    return v;
  }
});
