/**
 * Issue [#3156](https://github.com/go-to-k/cdkd/issues/3156): the sub-floor
 * nested-stack carry (`recordNestedStackParameterExpressions`) refused two
 * intrinsic spellings of a framed secret -- a token spelling `ssm:` (or leaving
 * its service to an intrinsic part), and a frame whose non-literal part sits
 * OUTSIDE the token -- so a 1-3 character secret in either persisted in
 * plaintext in the child, the parent's row (for the second), and a grandchild's
 * log lines. Issue [#3306](https://github.com/go-to-k/cdkd/issues/3306) carries
 * the three shapes that fix still refused: a token inside a nested part, in a
 * used `Fn::Sub` variable, or inside an `Fn::If` around the frame.
 *
 * Every case here but the hand-built records drives the REAL
 * resolver: the fix certifies on what the
 * resolver recorded while resolving the parameter's own `Fn::Join` / `Fn::Sub`
 * object (its substitution, and the verdict that substitution took), so a
 * hand-built bag would be building the thing under test. The deploy engine's
 * sequence is mirrored: resolve the row into the resource's bag, run the carry
 * over the SAME source object, then persist the row through
 * `redactSecretsForState` on a marked copy. A child mirrors the child engine:
 * its resource bag inherits the parent row's associations, and a `{ Ref }` to
 * the parameter resolves with the parent row's bag as `inheritedSecrets`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  inheritNestedStackParameterAssociations,
  markSameGenerationBag,
  MIN_NEEDLE_LENGTH,
  recordIntrinsicLeafResolution,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  redactSecretsForState,
  type IntrinsicLeafResolution,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/** The sub-floor secret every reference below resolves to. */
const PIN = 'q7';

const SECRET_ID = 'cdkd-refused-frame-carry-probe';

/**
 * How many times `/app/flip` (unclassifiable first, then public) and
 * `/app/flop` (public first, then unclassifiable) have been read.
 */
const flipReads = vi.hoisted(() => ({ count: 0, flop: 0 }));

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: logSpies.debug,
    info: logSpies.info,
    warn: logSpies.warn,
    error: logSpies.error,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        const name = command.input?.Name;
        // SecureStrings holding the pin under several names, so two leaves can
        // share a value through different tokens.
        if (name === '/app/pin' || name === '/app/dev' || name === '/app/a' || name === '/app/b') {
          return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        }
        if (name === '/other') return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        // A parameter NAMED by an inherited secret (the #4130 review's M0): its
        // name reaches the token only after that secret is substituted in.
        if (name === '/app/pinname-long') return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        // A SecureString whose value is itself reference text (issue #3306's
        // two-stage shape): the object's final pass resolves it again.
        if (name === '/app/ref') {
          return { Parameter: { Value: '{{resolve:ssm:/app/pin}}', Type: 'SecureString' } };
        }
        // A PUBLIC parameter holding the same two characters.
        if (name === '/app/prod') return { Parameter: { Value: 'q7', Type: 'String' } };
        // No `Type` first (unclassifiable: secret for that read, never cached),
        // then a definitive public answer with the same value.
        if (name === '/app/flip') {
          flipReads.count += 1;
          return flipReads.count === 1
            ? { Parameter: { Value: 'q7' } }
            : { Parameter: { Value: 'q7', Type: 'String' } };
        }
        if (name === '/app/flop') {
          flipReads.flop += 1;
          return flipReads.flop === 1
            ? { Parameter: { Value: 'q7', Type: 'String' } }
            : { Parameter: { Value: 'q7' } };
        }
        const notFound = new Error(`ParameterNotFound: ${String(name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        if (command.input?.SecretId === SECRET_ID) return { SecretString: JSON.stringify({ pin: 'q7' }) };
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const NESTED = 'AWS::CloudFormation::Stack';
const TEMPLATE_URL = 'https://s3.amazonaws.com/bucket/child.json';

beforeEach(() => {
  logSpies.debug.mockClear();
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  flipReads.count = 0;
  flipReads.flop = 0;
  resetAccountInfoCache();
});

/**
 * A template declaring `values`' keys as String parameters, the values bound,
 * and two conditions.
 */
function contextFor(
  values: Record<string, string>,
  bag: RecordedSecretValues,
  inheritedSecrets?: RecordedSecretValues
) {
  return {
    template: {
      Parameters: Object.fromEntries(Object.keys(values).map((k) => [k, { Type: 'String' }])),
      Resources: {},
    } as CloudFormationTemplate,
    resources: {},
    parameters: values,
    // For the `Fn::If` cases (issue #3306); no other case names a condition.
    conditions: { On: true, Off: false },
    recordedSecretValues: bag,
    ...(inheritedSecrets ? { inheritedSecrets } : {}),
  };
}

/**
 * One `AWS::CloudFormation::Stack` row through the engine's sequence: resolve
 * `parameters` into a fresh bag, run the carry over the same source object,
 * and persist the row. `inheritedSecrets` makes it a nested engine's row.
 */
async function deployRow(
  parameters: Record<string, unknown>,
  bound: Record<string, string> = {},
  inheritedSecrets?: RecordedSecretValues,
  // A resolver and a bag to reuse, and resolutions of the same row source to
  // run into that bag first (the cache and conflict cases).
  reuse: {
    resolver?: InstanceType<typeof IntrinsicFunctionResolver>;
    earlier?: ReadonlyArray<InstanceType<typeof IntrinsicFunctionResolver>>;
  } = {}
) {
  const bag: RecordedSecretValues = new Map();
  if (inheritedSecrets) inheritNestedStackParameterAssociations(bag, inheritedSecrets);
  const source = { TemplateURL: TEMPLATE_URL, Parameters: parameters };
  for (const earlier of reuse.earlier ?? []) {
    await earlier.resolve(source, contextFor(bound, bag, inheritedSecrets) as never);
  }
  const resolver = reuse.resolver ?? new IntrinsicFunctionResolver('us-east-1');
  const resolved = (await resolver.resolve(source, contextFor(bound, bag, inheritedSecrets) as never)) as {
    Parameters: Record<string, unknown>;
  };
  recordNestedStackParameterExpressions(bag, NESTED, resolved, source);
  const record = redactSecretsForState(markSameGenerationBag(structuredClone(resolved)), bag, source) as {
    Parameters: Record<string, unknown>;
  };
  return { bag, resolved, record };
}

/** A child resource consuming `name` through `{ Ref }`, persisted by the child engine's walk. */
async function childPersist(parentRowBag: RecordedSecretValues, name: string, value: string): Promise<unknown> {
  const bag: RecordedSecretValues = new Map();
  inheritNestedStackParameterAssociations(bag, parentRowBag);
  const source = { Value: { Ref: name } };
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const resolved = (await resolver.resolve(
    source,
    contextFor({ [name]: value }, bag, parentRowBag) as never
  )) as Record<string, unknown>;
  const record = redactSecretsForState(markSameGenerationBag(structuredClone(resolved)), bag, source) as {
    Value: unknown;
  };
  return record.Value;
}

describe('issue #3156 point 1: the carry certifies a refused spelling on the leaf\'s own resolution', () => {
  const SPELLINGS: ReadonlyArray<
    readonly [label: string, source: unknown, bound: Record<string, string>, expected: string]
  > = [
    [
      'an ssm SecureString token as a literal Join part',
      { 'Fn::Join': ['', ['port:', '{{resolve:ssm:/app/pin}}']] },
      {},
      'port:{{resolve:ssm:/app/pin}}',
    ],
    [
      'an ssm token with a Ref inside it',
      { 'Fn::Join': ['', ['port:{{resolve:ssm:/app/', { Ref: 'Env' }, '}}']] },
      { Env: 'pin' },
      'port:{{resolve:ssm:/app/pin}}',
    ],
    [
      'a service left to a Ref',
      { 'Fn::Join': ['', ['port:{{resolve:', { Ref: 'Svc' }, ':/app/pin}}']] },
      { Svc: 'ssm' },
      'port:{{resolve:ssm:/app/pin}}',
    ],
    [
      'an Fn::Sub with an ssm token around a placeholder',
      { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Env}}}' },
      { Env: 'pin' },
      'port:{{resolve:ssm:/app/pin}}',
    ],
    [
      'a secretsmanager token with a Ref OUTSIDE it (the non-literal frame)',
      { 'Fn::Join': ['', [`port:{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin}}`, { Ref: 'Tail' }]] },
      { Tail: '-tail' },
      `port:{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin}}-tail`,
    ],
    [
      'an Fn::Sub whose ssm-secure token is followed by a pseudo parameter',
      { 'Fn::Sub': 'port:{{resolve:ssm-secure:/app/pin}}@${AWS::Region}' },
      {},
      'port:{{resolve:ssm-secure:/app/pin}}@us-east-1',
    ],
  ];

  for (const [label, source, bound, expected] of SPELLINGS) {
    it(`records ${label}, and the parent row and the child persist the expression`, async () => {
      const { bag, resolved, record } = await deployRow({ Pin: source }, bound);
      const value = resolved.Parameters['Pin'] as string;
      // Premises: the value frames the sub-floor pin, and the scan alone is
      // silent on it -- why the pre-fix row and child kept it in plaintext.
      expect(value.replace(PIN, '')).not.toContain(PIN);
      expect(PIN.length).toBeLessThan(MIN_NEEDLE_LENGTH);
      expect(redactSecretsForState(value, new Map([[PIN, 'x']]))).toBe(value);

      expect(bag.get(value)).toBe(expected);
      expect(record.Parameters['Pin']).toBe(expected);
      expect(await childPersist(bag, 'Pin', value)).toBe(expected);
    });
  }
});

describe('issue #3156: what the provenance arm refuses', () => {
  it("a PUBLIC ssm leaf the frame arm wrote as a SecureString sibling's reference", async () => {
    const { bag, record } = await deployRow(
      {
        Pub: { 'Fn::Join': ['', ['port:{{resolve:ssm:/app/', { Ref: 'Env' }, '}}']] },
        // The sibling resolves `/app/dev` (SecureString, same two characters)
        // into the same bag, inside a different value.
        Dev: 'dev-{{resolve:ssm:/app/dev}}',
      },
      { Env: 'prod' }
    );
    // Premise: the frame arm's residual -- it wrote the sibling's reference.
    expect(record.Parameters['Pub']).toBe('port:{{resolve:ssm:/app/dev}}');
    expect(bag.has(`port:${PIN}`)).toBe(false);
    expect(await childPersist(bag, 'Pub', `port:${PIN}`)).toBe(`port:${PIN}`);
  });

  it('a token whose own substitution was PUBLIC, though an unused variable resolved it as a secret first', async () => {
    const { bag, resolved } = await deployRow({
      Pin: { 'Fn::Sub': ['port:{{resolve:ssm:/app/flip}}', { Unused: '{{resolve:ssm:/app/flip}}' }] },
    });
    // Premises: both reads happened, and the unclassifiable one left a pair
    // for the token with the value -- the evidence a pair-only check borrows.
    expect(flipReads.count).toBe(2);
    expect(resolved.Parameters['Pin']).toBe(`port:${PIN}`);
    expect(bag.get(PIN)).toBe('{{resolve:ssm:/app/flip}}');
    expect(bag.has(`port:${PIN}`)).toBe(false);
  });

  it('two non-literal frames of one value through DIFFERENT tokens, which the parent row could not keep apart', async () => {
    const { bag, record } = await deployRow(
      {
        A: { 'Fn::Join': ['', ['port:{{resolve:ssm-secure:/app/a}}', { Ref: 'Tail' }]] },
        B: { 'Fn::Join': ['', ['port:{{resolve:ssm-secure:/app/b}}', { Ref: 'Tail' }]] },
      },
      { Tail: '' }
    );
    expect(bag.has(`port:${PIN}`)).toBe(false);
    // Neither parent leaf takes the other's reference.
    expect(record.Parameters).toEqual({ A: `port:${PIN}`, B: `port:${PIN}` });
  });

  it('carries two non-literal frames of one value through the SAME token', async () => {
    const join = (): unknown => ({ 'Fn::Join': ['', ['port:{{resolve:ssm-secure:/app/a}}', { Ref: 'Tail' }]] });
    const { bag, record } = await deployRow({ A: join(), B: join() }, { Tail: '' });
    expect(bag.get(`port:${PIN}`)).toBe('port:{{resolve:ssm-secure:/app/a}}');
    expect(record.Parameters).toEqual({
      A: 'port:{{resolve:ssm-secure:/app/a}}',
      B: 'port:{{resolve:ssm-secure:/app/a}}',
    });
  });

  it('does not let an UNUSED variable resolving to the same framed value refuse the carry', async () => {
    const { bag } = await deployRow(
      {
        Pin: {
          'Fn::Sub': ['port:{{resolve:ssm:/app/${Env}}}', { Env: 'pin', Unused: 'port:{{resolve:ssm:/other}}' }],
        },
      },
      {}
    );
    expect(bag.get(`port:${PIN}`)).toBe('port:{{resolve:ssm:/app/pin}}');
  });

  describe('the verdict each substitution took, on the cache arm and across resolutions', () => {
    const PIN_JOIN = (): unknown => ({ 'Fn::Join': ['', ['port:', '{{resolve:ssm:/app/pin}}']] });

    it('certifies a leaf whose token this resolver served from its CACHE, into a second bag', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      await deployRow({ Pin: PIN_JOIN() }, {}, undefined, { resolver });
      const second = await deployRow({ Pin: PIN_JOIN() }, {}, undefined, { resolver });
      expect(second.bag.get(`port:${PIN}`)).toBe('port:{{resolve:ssm:/app/pin}}');
    });

    it('refuses a leaf whose own substitution was a PUBLIC cache hit, beside an unclassifiable pair for its token', async () => {
      // U1 reads `/app/flip` unclassifiable (a pair, never cached), U2 reads it
      // public (cached), and the template's own token is served from the cache.
      const { bag } = await deployRow({
        Pin: {
          'Fn::Sub': [
            'port:{{resolve:ssm:/app/flip}}',
            { U1: '{{resolve:ssm:/app/flip}}', U2: '{{resolve:ssm:/app/flip}}' },
          ],
        },
      });
      expect(flipReads.count).toBe(2);
      expect(bag.get(PIN)).toBe('{{resolve:ssm:/app/flip}}');
      expect(bag.has(`port:${PIN}`)).toBe(false);
    });

    it('keeps certifying a leaf resolved twice, identically, into one bag', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const { bag } = await deployRow({ Pin: PIN_JOIN() }, {}, undefined, { resolver, earlier: [resolver] });
      expect(bag.get(`port:${PIN}`)).toBe('port:{{resolve:ssm:/app/pin}}');
    });

    for (const [order, parameter, reads] of [
      ['secret, then public', '/app/flip', () => flipReads.count],
      ['public, then secret', '/app/flop', () => flipReads.flop],
    ] as const) {
      it(`refuses a leaf one bag saw resolve two ways (${order}), whichever came last`, async () => {
        const join = { 'Fn::Join': ['', ['port:', `{{resolve:ssm:${parameter}}}`]] };
        // Two resolver instances, so the second read is not a cache hit.
        const { bag } = await deployRow({ Pin: join }, {}, undefined, {
          earlier: [new IntrinsicFunctionResolver('us-east-1')],
        });
        expect(reads()).toBe(2);
        // Premise: the unclassifiable read left the pair either way.
        expect(bag.get(PIN)).toBe(`{{resolve:ssm:${parameter}}}`);
        expect(bag.has(`port:${PIN}`)).toBe(false);
      });
    }
  });

  it('a leaf a USED variable also replaced a secret in, whose plaintext the spelling would keep', async () => {
    const { bag, resolved } = await deployRow({
      Pin: { 'Fn::Sub': ['port:{{resolve:ssm:/app/pin}}${V}', { V: '{{resolve:ssm:/other}}' }] },
    });
    expect(resolved.Parameters['Pin']).toBe(`port:${PIN}${PIN}`);
    expect(bag.has(`port:${PIN}${PIN}`)).toBe(false);
  });

  it('a leaf a used variable holding the SAME token replaced in too, whose first replacement names the frame token', async () => {
    const { bag, resolved } = await deployRow({
      Pin: { 'Fn::Sub': ['port:{{resolve:ssm:/app/pin}}${V}', { V: '{{resolve:ssm:/app/pin}}' }] },
    });
    expect(resolved.Parameters['Pin']).toBe(`port:${PIN}${PIN}`);
    expect(bag.has(`port:${PIN}${PIN}`)).toBe(false);
  });

  for (const [label, pin] of [
    [
      'a nested Fn::Join part',
      { 'Fn::Join': ['', [{ 'Fn::Join': ['', ['{{resolve:ssm-secure:/app/', 'a', '}}']] }, '/', '{{resolve:ssm-secure:/app/b}}']] },
    ],
    [
      'an intrinsic Fn::Sub variable',
      {
        'Fn::Sub': [
          '${X}/{{resolve:ssm-secure:/app/b}}',
          { X: { 'Fn::Join': ['', ['{{resolve:ssm-secure:/app/a}}']] } },
        ],
      },
    ],
  ] as const) {
    it(`a leaf whose affix holds ANOTHER secret ${label} resolved, which the spelling would carry verbatim`, async () => {
      const { bag, resolved, record } = await deployRow({ Pin: pin });
      expect(resolved.Parameters['Pin']).toBe(`${PIN}/${PIN}`);
      // Premise: both secrets resolved into the bag. The nested part's record
      // now reaches the outer one (issue #3306), so the outer record holds TWO
      // replacements and the count refuses it before the affix test is asked;
      // the affix cases below keep a part with no record of its own.
      expect(bag.get(PIN)).toMatch(/^\{\{resolve:ssm-secure:\/app\/[ab]\}\}$/);
      expect(bag.has(`${PIN}/${PIN}`)).toBe(false);
      expect(record.Parameters['Pin']).toBe(`${PIN}/${PIN}`);
    });
  }

});

describe('issue #3306: the carry certifies a token a nested part, a Sub variable or an Fn::If holds', () => {
  const EXPRESSION = 'port:{{resolve:ssm:/app/pin}}';
  const SHAPES: ReadonlyArray<readonly [label: string, source: unknown, bound: Record<string, string>]> = [
    ['a nested Fn::Sub part', { 'Fn::Join': ['', ['port:', { 'Fn::Sub': '{{resolve:ssm:/app/pin}}' }]] }, {}],
    [
      'a nested Fn::Join part with a Ref inside its token',
      { 'Fn::Join': ['', ['port:', { 'Fn::Join': ['', ['{{resolve:ssm:/app/', { Ref: 'Env' }, '}}']] }]] },
      { Env: 'pin' },
    ],
    ['a used string Fn::Sub variable', { 'Fn::Sub': ['port:${V}', { V: '{{resolve:ssm:/app/pin}}' }] }, {}],
    [
      'a used intrinsic Fn::Sub variable',
      { 'Fn::Sub': ['port:${V}', { V: { 'Fn::Sub': '{{resolve:ssm:/app/pin}}' } }] },
      {},
    ],
    [
      'an Fn::If around an Fn::Join, true branch',
      { 'Fn::If': ['On', { 'Fn::Join': ['', ['port:', '{{resolve:ssm:/app/pin}}']] }, 'none'] },
      {},
    ],
    [
      'an Fn::If around an Fn::Sub, false branch',
      { 'Fn::If': ['Off', 'none', { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Env}}}' }] },
      { Env: 'pin' },
    ],
    ['an Fn::If around a string branch', { 'Fn::If': ['On', EXPRESSION, 'none'] }, {}],
    [
      'an Fn::If whose condition is not in context (the false branch)',
      { 'Fn::If': ['Missing', 'none', { 'Fn::Join': ['', ['port:', '{{resolve:ssm:/app/pin}}']] }] },
      {},
    ],
    [
      'an Fn::If as a Join part',
      { 'Fn::Join': ['', ['port:', { 'Fn::If': ['On', { 'Fn::Sub': '{{resolve:ssm:/app/pin}}' }, 'x'] }]] },
      {},
    ],
  ];

  for (const [label, source, bound] of SHAPES) {
    it(`records ${label}, and the parent row and the child persist the expression`, async () => {
      const { bag, resolved, record } = await deployRow({ Pin: source }, bound);
      const value = resolved.Parameters['Pin'] as string;
      // Premises, as in the #3156 table: a sub-floor pin the scan is silent on.
      expect(value).toBe(`port:${PIN}`);
      expect(redactSecretsForState(value, new Map([[PIN, 'x']]))).toBe(value);

      expect(bag.get(value)).toBe(EXPRESSION);
      expect(record.Parameters['Pin']).toBe(EXPRESSION);
      expect(await childPersist(bag, 'Pin', value)).toBe(EXPRESSION);
    });
  }

  it('does not certify a used variable whose secret is itself reference text the final pass resolves again', async () => {
    const { bag, resolved } = await deployRow({
      Pin: { 'Fn::Sub': ['port:${V}', { V: '{{resolve:ssm:/app/ref}}' }] },
    });
    // Premises: two stages, both secret, one span in the record's input. The
    // record's count and token test refuse it, and so does the carry's own
    // pair gate (the span's token resolved to the second token, not the
    // middle); the hand-built count case below pins the count alone.
    expect(resolved.Parameters['Pin']).toBe(`port:${PIN}`);
    expect(bag.get('{{resolve:ssm:/app/pin}}')).toBe('{{resolve:ssm:/app/ref}}');
    expect(bag.get(PIN)).toBe('{{resolve:ssm:/app/pin}}');
    expect(bag.has(`port:${PIN}`)).toBe(false);
  });

  it('does not stringify an UNUSED intrinsic variable to build the record', async () => {
    const { resolved } = await deployRow({
      Pin: { 'Fn::Sub': ['port:{{resolve:ssm:/app/pin}}', { Unused: { toString: 'x' } }] },
    });
    expect(resolved.Parameters['Pin']).toBe(`port:${PIN}`);
  });

  // A POISONED part: an object this bag already saw resolve two different
  // ways reads as having no record, so it lends nothing -- to an outer Join,
  // or to an Fn::If that selected it.
  for (const [label, wrap] of [
    ['a nested Join part', (inner: object): unknown => ({ 'Fn::Join': ['', ['port:', inner]] })],
    ['an Fn::If branch', (inner: object): unknown => ({ 'Fn::If': ['On', inner, 'none'] })],
  ] as const) {
    it(`lends nothing from ${label} whose record is poisoned`, async () => {
      const inner = { 'Fn::Sub': label === 'an Fn::If branch' ? 'port:{{resolve:ssm:/app/pin}}' : '{{resolve:ssm:/app/pin}}' };
      const bag: RecordedSecretValues = new Map();
      // Two records that would EACH certify the frame on their own (the #4130
      // review's m5): the one the resolver itself writes for `inner`, and one
      // through `/app/a`, which the `Other` parameter below pairs to the same
      // pin. A poisoned record read as either one lends a certifying record.
      for (const token of ['{{resolve:ssm:/app/pin}}', '{{resolve:ssm:/app/a}}']) {
        const input = label === 'an Fn::If branch' ? `port:${token}` : token;
        recordIntrinsicLeafResolution(bag, inner, {
          input,
          output: label === 'an Fn::If branch' ? `port:${PIN}` : PIN,
          substitutions: [{ token, value: PIN, secret: true }],
          complete: true,
        });
      }
      const source = {
        TemplateURL: TEMPLATE_URL,
        Parameters: { Pin: wrap(inner), Other: '{{resolve:ssm:/app/a}}' },
      };
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const resolved = (await resolver.resolve(source, contextFor({}, bag) as never)) as {
        Parameters: Record<string, unknown>;
      };
      recordNestedStackParameterExpressions(bag, NESTED, resolved, source);
      // Premises: the same source with a fresh bag is carried (the table
      // above), and both seeded tokens hold a pair for the pin.
      expect(resolved.Parameters['Pin']).toBe(`port:${PIN}`);
      expect(resolved.Parameters['Other']).toBe(PIN);
      expect(bag.has(`port:${PIN}`)).toBe(false);
    });
  }

  it('does not certify an Fn::If whose selected branch has no record of its own', async () => {
    const { bag, resolved } = await deployRow({
      Pin: { 'Fn::If': ['On', { 'Fn::Select': [0, ['port:{{resolve:ssm:/app/pin}}']] }, 'none'] },
    });
    expect(resolved.Parameters['Pin']).toBe(`port:${PIN}`);
    // Premise: the token resolved into the bag.
    expect(bag.get(PIN)).toBe('{{resolve:ssm:/app/pin}}');
    expect(bag.has(`port:${PIN}`)).toBe(false);
  });

  for (const [label, otherBranch] of [
    ['a string branch spelling another token', 'port:{{resolve:ssm:/app/a}}'],
    ['a branch with no record of its own', { 'Fn::Select': [0, ['port:{{resolve:ssm:/app/a}}']] }],
  ] as const) {
    for (const [order, first] of [
      ['the certified branch first', true],
      ['the certified branch last', false],
    ] as const) {
      it(`refuses an Fn::If one bag saw select two different branches (${label}, ${order})`, async () => {
        const pin = { 'Fn::If': ['Flip', { 'Fn::Sub': 'port:{{resolve:ssm:/app/pin}}' }, otherBranch] };
        const bag: RecordedSecretValues = new Map();
        const source = { TemplateURL: TEMPLATE_URL, Parameters: { Pin: pin } };
        const resolver = new IntrinsicFunctionResolver('us-east-1');
        await resolver.resolve(source, { ...contextFor({}, bag), conditions: { Flip: first } } as never);
        const resolved = (await resolver.resolve(source, {
          ...contextFor({}, bag),
          conditions: { Flip: !first },
        } as never)) as { Parameters: Record<string, unknown> };
        recordNestedStackParameterExpressions(bag, NESTED, resolved, source);
        // Premise: the certified branch alone is carried (the `On` rows
        // above); the other resolution selected a branch that says otherwise.
        expect(resolved.Parameters['Pin']).toBe(`port:${PIN}`);
        expect(bag.has(`port:${PIN}`)).toBe(false);
      });
    }
  }

  for (const [label, pin] of [
    [
      'a nested Fn::Sub part',
      {
        'Fn::Join': [
          '',
          [{ 'Fn::Select': [0, ['{{resolve:ssm-secure:/app/a}}']] }, '/', { 'Fn::Sub': '{{resolve:ssm-secure:/app/b}}' }],
        ],
      },
    ],
    [
      'a used string Fn::Sub variable',
      {
        'Fn::Sub': [
          '${X}/${V}',
          { X: { 'Fn::Select': [0, ['{{resolve:ssm-secure:/app/a}}']] }, V: '{{resolve:ssm-secure:/app/b}}' },
        ],
      },
    ],
    [
      'an Fn::If',
      {
        'Fn::If': [
          'On',
          { 'Fn::Join': ['', [{ 'Fn::Select': [0, ['{{resolve:ssm-secure:/app/a}}']] }, '/{{resolve:ssm-secure:/app/b}}']] },
          'none',
        ],
      },
    ],
  ] as const) {
    it(`keeps the affix refusal for a token in ${label} beside another secret a part with no record resolved`, async () => {
      const { bag, resolved, record } = await deployRow({ Pin: pin });
      expect(resolved.Parameters['Pin']).toBe(`${PIN}/${PIN}`);
      // Premise: both secrets resolved into the bag.
      expect(bag.get(PIN)).toMatch(/^\{\{resolve:ssm-secure:\/app\/[ab]\}\}$/);
      expect(bag.has(`${PIN}/${PIN}`)).toBe(false);
      expect(record.Parameters['Pin']).toBe(`${PIN}/${PIN}`);
    });
  }
});

describe('issue #3306 review M0: a recorded secret INSIDE the carried token is refused', () => {
  // `Name` is a secret the row's bag holds (inherited, above the needle
  // floor). Substituted into the token's parameter name, it would be carried
  // verbatim in the spelling: the row, the child and a grandchild's entry
  // would hold it where the value scan leaves only the sub-floor `q7`.
  const NAME = 'pinname-long';
  const INHERITED: RecordedSecretValues = new Map([
    [NAME, '{{resolve:secretsmanager:cdkd-name-probe:SecretString:name}}'],
  ]);
  const INNER = (): unknown => ({ 'Fn::Sub': '{{resolve:ssm:/app/${Name}}}' });
  // `rowToo`: whether the PARENT's own row is this carry's to protect. For
  // the top-level Sub it is not: the position pass's frame arm writes that
  // row from the token the resolver recorded, carry or no carry -- a
  // different class, stated on the carry's residual (e) and asserted
  // neither way here.
  for (const [label, pin, rowToo] of [
    ['a top-level Fn::Sub', { 'Fn::Sub': 'port:{{resolve:ssm:/app/${Name}}}' }, false],
    ['a nested Fn::Sub part', { 'Fn::Join': ['', ['port:', INNER()]] }, true],
    ['an Fn::If around that Join', { 'Fn::If': ['On', { 'Fn::Join': ['', ['port:', INNER()]] }, 'x'] }, true],
    ['an intrinsic Fn::Sub variable', { 'Fn::Sub': ['port:${V}', { V: INNER() }] }, true],
  ] as const) {
    it(`does not carry ${label} whose token spells an inherited secret`, async () => {
      const { bag, resolved, record } = await deployRow({ Pin: pin }, { Name: NAME }, INHERITED);
      // Premises: the value frames the sub-floor pin, and the bag holds the
      // name as a secret.
      expect(resolved.Parameters['Pin']).toBe(`port:${PIN}`);
      expect(bag.has(NAME)).toBe(true);
      expect(bag.has(`port:${PIN}`)).toBe(false);
      expect(String(await childPersist(bag, 'Pin', `port:${PIN}`))).not.toContain(NAME);
      if (rowToo) expect(String(record.Parameters['Pin'])).not.toContain(NAME);
    });
  }
});

describe('issue #3156: a record the resolver would not write is refused, not certified', () => {
  // The resolver never writes these records (the source docstring says why the
  // `complete` and `output` tests are implied for every record it does write),
  // so they are hand-built: a bag with the pass's pair for the token and a
  // record that is faithful except in the one field under test.
  const TOKEN = '{{resolve:ssm:/app/pin}}';
  const FAITHFUL: IntrinsicLeafResolution = {
    input: `port:${TOKEN}`,
    output: `port:${PIN}`,
    substitutions: [{ token: TOKEN, value: PIN, secret: true }],
    complete: true,
  };

  function carryOver(resolution: IntrinsicLeafResolution): RecordedSecretValues {
    const bag: RecordedSecretValues = new Map([[PIN, TOKEN]]);
    recordResolvedPair(bag, TOKEN, PIN);
    const join = { 'Fn::Join': ['', ['port:', TOKEN]] };
    recordIntrinsicLeafResolution(bag, join, resolution);
    recordNestedStackParameterExpressions(
      bag,
      NESTED,
      { Parameters: { Pin: `port:${PIN}` } },
      { Parameters: { Pin: join } }
    );
    return bag;
  }

  it('control: the faithful record certifies', () => {
    expect(carryOver(FAITHFUL).get(`port:${PIN}`)).toBe(`port:${TOKEN}`);
  });

  it('refuses a record that says a token was left unreplaced', () => {
    expect(carryOver({ ...FAITHFUL, complete: false }).has(`port:${PIN}`)).toBe(false);
  });

  it('refuses a record whose output is not the resolved value', () => {
    expect(carryOver({ ...FAITHFUL, output: 'port:zz' }).has(`port:${PIN}`)).toBe(false);
  });

  it('refuses a record whose one replacement names another token', () => {
    const substitutions = [{ token: '{{resolve:ssm:/app/other}}', value: PIN, secret: true }];
    expect(carryOver({ ...FAITHFUL, substitutions }).has(`port:${PIN}`)).toBe(false);
  });

  it('refuses a record listing a second replacement its input does not spell', () => {
    const substitutions = [FAITHFUL.substitutions[0]!, FAITHFUL.substitutions[0]!];
    expect(carryOver({ ...FAITHFUL, substitutions }).has(`port:${PIN}`)).toBe(false);
  });

  it('refuses a record whose one replacement produced another value', () => {
    const substitutions = [{ token: TOKEN, value: 'zz', secret: true }];
    expect(carryOver({ ...FAITHFUL, substitutions }).has(`port:${PIN}`)).toBe(false);
  });
});

describe('issue #3156 point 2: a grandchild no longer prints the value', () => {
  /** The grandchild's three lines for parameter `Deep`, with the bag the middle hands down. */
  async function grandchildLines(middleRowBag: RecordedSecretValues, value: string): Promise<string[]> {
    // The hand-off gate `NestedStackProvider` and the engine apply.
    const handedDown = middleRowBag.size > 0 ? middleRowBag : undefined;
    logSpies.debug.mockClear();
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const context = contextFor({ Deep: value }, new Map(), handedDown);
    await resolver.resolveParameters(context.template, { Deep: value }, handedDown ? { inheritedSecrets: handedDown } : {});
    await resolver.resolve({ 'Fn::Join': ['', ['x-', { Ref: 'Deep' }]] }, context as never);
    return logSpies.debug.mock.calls
      .map((c) => String(c[0]))
      .filter(
        (l) =>
          l.startsWith('Parameter Deep: ') ||
          l.startsWith('Resolved Ref to parameter: ') ||
          l.startsWith('Resolved Fn::Join: ')
      );
  }

  const EXPRESSION = 'port:{{resolve:ssm:/app/pin}}';
  for (const [spelling, deep, middleRecord, topPin] of [
    [
      'PASS-THROUGH',
      { Ref: 'Pin' },
      EXPRESSION,
      { 'Fn::Join': ['', ['port:{{resolve:ssm:/app/', { Ref: 'Env' }, '}}']] },
    ],
    [
      'RE-WRAP',
      { 'Fn::Join': ['', ['m-', { Ref: 'Pin' }]] },
      `m-${EXPRESSION}`,
      { 'Fn::Join': ['', ['port:{{resolve:ssm:/app/', { Ref: 'Env' }, '}}']] },
    ],
    // Issue #3306: a token the top row's parameter holds in a used Fn::Sub
    // variable, and one it holds in a nested part.
    [
      'PASS-THROUGH (a used Fn::Sub variable at the top)',
      { Ref: 'Pin' },
      EXPRESSION,
      { 'Fn::Sub': ['port:${V}', { V: '{{resolve:ssm:/app/pin}}' }] },
    ],
    [
      'RE-WRAP (a nested Fn::Sub part at the top)',
      { 'Fn::Join': ['', ['m-', { Ref: 'Pin' }]] },
      `m-${EXPRESSION}`,
      { 'Fn::Join': ['', ['port:', { 'Fn::Sub': '{{resolve:ssm:/app/${Env}}}' }]] },
    ],
  ] as const) {
    it(`through the ${spelling} spelling of the middle stack`, async () => {
      const top = await deployRow({ Pin: topPin }, { Env: 'pin' });
      const pinValue = top.resolved.Parameters['Pin'] as string;
      expect(pinValue).toBe(`port:${PIN}`);

      const middle = await deployRow({ Deep: deep }, { Pin: pinValue }, top.bag);
      const deepValue = middle.resolved.Parameters['Deep'] as string;
      // The middle's own nested-stack row persists the expression.
      expect(middle.record.Parameters['Deep']).toBe(middleRecord);
      // The whole-value entry the middle's `{ Ref }` copied is what makes the
      // bag non-empty, so the gate hands it to the grandchild.
      expect(middle.bag.get(pinValue)).toBe(EXPRESSION);

      // A whole-value carried secret masks each line whole; the Join's twin
      // and needle masks overlap and collapse to one.
      expect(await grandchildLines(middle.bag, deepValue)).toEqual([
        'Parameter Deep: using user-provided value ***',
        'Resolved Ref to parameter: Deep -> ***',
        'Resolved Fn::Join: ***',
      ]);
    });
  }
});
