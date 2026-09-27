/**
 * `cdkd import`'s pseudo-parameter pre-pass (issue
 * [#1897](https://github.com/go-to-k/cdkd/issues/1897)).
 *
 * A name built from the account or region on an env-agnostic stack
 * (`cdkd-test-${AWS::AccountId}.internal`) reached `provider.import()` as the
 * `Fn::Join` that spells it, so every provider's `typeof name === 'string'`
 * guard declined and the documented name route answered `skipped-not-found`.
 * `resolvePseudoParameterIntrinsics` evaluates such an intrinsic WHOLE, and
 * leaves everything else exactly as written.
 *
 * `getAccountInfo` is REAL; only its STS client is faked, through
 * `getAwsClients`, which is where it reads it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

const stsSend = vi.hoisted(() =>
  vi.fn<() => Promise<{ Account?: string }>>(async () => ({ Account: '111122223333' }))
);
// SSM and Secrets Manager ANSWER, so the `{{resolve:...}}` cases below are
// discriminating: an evaluation that resolved references (as
// `IntrinsicFunctionResolver.resolve` does, even for one ASSEMBLED from two
// literals) would come back replaced rather than surviving because a lookup
// happened to fail -- and each case asserts neither client was asked.
const ssmSend = vi.hoisted(() => vi.fn(async () => ({ Parameter: { Value: 'ssm-value', Type: 'String' } })));
const smSend = vi.hoisted(() => vi.fn(async () => ({ SecretString: 'secret-value' })));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: vi.fn(() => ({
    sts: { send: stsSend },
    ssm: { send: ssmSend },
    secretsManager: { send: smSend },
  })),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

import { resolvePseudoParameterIntrinsics } from '../../../src/cli/commands/import.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

const ACCOUNT_JOIN = {
  'Fn::Join': ['', ['cdkd-test-', { Ref: 'AWS::AccountId' }, '.internal.']],
};

beforeEach(() => {
  resetAccountInfoCache();
  stsSend.mockReset();
  stsSend.mockImplementation(async () => ({ Account: '111122223333' }));
  ssmSend.mockClear();
  smSend.mockClear();
});

describe('resolvePseudoParameterIntrinsics (issue #1897)', () => {
  it('resolves the route53 fixture shape: a Fn::Join over AWS::AccountId', async () => {
    const out = await resolvePseudoParameterIntrinsics({ Name: ACCOUNT_JOIN }, 'us-east-1');
    expect(out).toEqual({ Name: 'cdkd-test-111122223333.internal.' });
  });

  it('resolves AWS::Region / AWS::Partition / AWS::URLSuffix for the region it was handed', async () => {
    const out = await resolvePseudoParameterIntrinsics(
      {
        A: { Ref: 'AWS::Region' },
        B: { Ref: 'AWS::Partition' },
        C: { Ref: 'AWS::URLSuffix' },
      },
      'cn-north-1'
    );
    expect(out).toEqual({ A: 'cn-north-1', B: 'aws-cn', C: 'amazonaws.com.cn' });
  });

  it('folds a mis-cased region the way the deploy resolver does', async () => {
    const out = await resolvePseudoParameterIntrinsics(
      { A: { Ref: 'AWS::Region' }, B: { Ref: 'AWS::Partition' } },
      'CN-North-1'
    );
    expect(out).toEqual({ A: 'cn-north-1', B: 'aws-cn' });
  });

  it('resolves both Fn::Sub forms, including a variable-map value and a ${!Literal} escape', async () => {
    const out = await resolvePseudoParameterIntrinsics(
      {
        One: { 'Fn::Sub': 'app-${AWS::AccountId}-${AWS::Region}' },
        Two: {
          'Fn::Sub': [
            '${Prefix}-${AWS::Region}-${!Keep}',
            { Prefix: { 'Fn::Join': ['-', ['x', { Ref: 'AWS::AccountId' }]] } },
          ],
        },
      },
      'eu-west-1'
    );
    expect(out).toEqual({
      One: 'app-111122223333-eu-west-1',
      Two: 'x-111122223333-eu-west-1-${Keep}',
    });
  });

  it('walks plain objects and arrays, resolving nested closed intrinsics', async () => {
    const out = await resolvePseudoParameterIntrinsics(
      { Outer: { List: ['lit', { Ref: 'AWS::Region' }], Keep: 7 } },
      'us-west-2'
    );
    expect(out).toEqual({ Outer: { List: ['lit', 'us-west-2'], Keep: 7 } });
  });

  // Every shape below must come back BYTE-FOR-BYTE as written: a partial
  // resolution would hand the provider a half-resolved object or a string
  // with a `${...}` left in.
  it.each([
    [
      'a Join mixing a pseudo-parameter with a resource Ref',
      { 'Fn::Join': ['-', [{ Ref: 'AWS::AccountId' }, { Ref: 'MyBucket' }]] },
    ],
    [
      'a Join over a nested Join that is not closed',
      { 'Fn::Join': ['', ['a', { 'Fn::Join': ['', [{ Ref: 'AWS::Region' }, { Ref: 'P' }]] }]] },
    ],
    ['a Sub naming a resource', { 'Fn::Sub': '${MyBucket}-${AWS::Region}' }],
    ['a Sub naming a resource attribute', { 'Fn::Sub': '${MyBucket.Arn}' }],
    ['a Sub with an empty ${}', { 'Fn::Sub': 'x-${}-${AWS::Region}' }],
    ['a Sub whose map value is not closed', { 'Fn::Sub': ['${V}', { V: { Ref: 'MyBucket' } }] }],
    ['a Ref to AWS::StackName', { Ref: 'AWS::StackName' }],
    ['a Ref to AWS::NoValue', { Ref: 'AWS::NoValue' }],
    ['a Ref to a parameter', { Ref: 'Stage' }],
    ['Fn::GetAtt', { 'Fn::GetAtt': ['MyBucket', 'Arn'] }],
    ['Fn::Select over pseudo-parameters', { 'Fn::Select': [0, [{ Ref: 'AWS::Region' }]] }],
    ['a Join with a non-string operand', { 'Fn::Join': ['', ['a', 1]] }],
    ['a Join with a non-string delimiter', { 'Fn::Join': [1, ['a', { Ref: 'AWS::Region' }]] }],
    ['a Join with a non-list operand', { 'Fn::Join': ['', { Ref: 'AWS::Region' }] }],
    ['a Join with three arguments', { 'Fn::Join': ['', ['a'], 'extra'] }],
    ['a Sub whose body is not a string', { 'Fn::Sub': [1, {}] }],
    ['a Sub whose map is not an object', { 'Fn::Sub': ['${AWS::Region}', null] }],
    ['a Sub with a one-element list', { 'Fn::Sub': ['${AWS::Region}'] }],
    ['a Sub with three arguments', { 'Fn::Sub': ['${AWS::Region}', {}, 'extra'] }],
    ['a Sub whose map is a list', { 'Fn::Sub': ['${AWS::Region}', []] }],
    [
      'a Join carrying a {{resolve:}} literal',
      { 'Fn::Join': ['', ['{{resolve:secretsmanager:s}}-', { Ref: 'AWS::Region' }]] },
    ],
    [
      'a Join whose delimiter carries a {{resolve:}} opener',
      { 'Fn::Join': ['{{resolve:ssm:p}}', ['a', { Ref: 'AWS::Region' }]] },
    ],
    [
      'a Sub body carrying a {{resolve:}} opener',
      { 'Fn::Sub': '{{resolve:ssm:p}}-${AWS::Region}' },
    ],
    [
      'a Join that ASSEMBLES a {{resolve:}} opener from pieces',
      { 'Fn::Join': ['', ['{{resol', 've:ssm:p}}', { Ref: 'AWS::Region' }]] },
    ],
    [
      'a Sub whose ${!...} escape ASSEMBLES a {{resolve:}} opener',
      { 'Fn::Sub': '${!{resolve:ssm:p}}-${AWS::Region}' },
    ],
    ['an intrinsic with a sibling key', { Ref: 'AWS::Region', Extra: 1 }],
  ])('leaves %s untouched', async (_label, intrinsic) => {
    const out = await resolvePseudoParameterIntrinsics({ Name: intrinsic }, 'us-east-1');
    expect(out).toEqual({ Name: intrinsic });
    expect(ssmSend).not.toHaveBeenCalled();
    expect(smSend).not.toHaveBeenCalled();
  });

  it('leaves an AWS::AccountId intrinsic untouched when STS could not answer (fabricated account)', async () => {
    stsSend.mockImplementation(async () => {
      throw new Error('ExpiredToken');
    });
    const saved = process.env['AWS_ACCOUNT_ID'];
    delete process.env['AWS_ACCOUNT_ID'];
    try {
      const out = await resolvePseudoParameterIntrinsics(
        { Name: ACCOUNT_JOIN, Region: { Ref: 'AWS::Region' } },
        'us-east-1'
      );
      // The account-free sibling still resolves: only the lookup named after
      // a placeholder account is withheld.
      expect(out).toEqual({ Name: ACCOUNT_JOIN, Region: 'us-east-1' });
    } finally {
      if (saved !== undefined) process.env['AWS_ACCOUNT_ID'] = saved;
    }
  });

  it('asks STS nothing when no intrinsic needs the account', async () => {
    await resolvePseudoParameterIntrinsics(
      { A: { Ref: 'AWS::URLSuffix' }, B: { Ref: 'MyBucket' }, C: 'plain' },
      'us-east-1'
    );
    expect(stsSend).not.toHaveBeenCalled();
  });

  it('keeps a template key named __proto__ as an own key and does not mutate its input', async () => {
    const input = JSON.parse('{"__proto__": {"Ref": "AWS::Region"}, "Name": "n"}') as Record<
      string,
      unknown
    >;
    const snapshot = JSON.stringify(input);
    const out = (await resolvePseudoParameterIntrinsics(input, 'us-east-1')) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toBe('us-east-1');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
