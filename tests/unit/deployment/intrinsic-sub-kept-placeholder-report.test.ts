/**
 * `resolveSub` REPORTS a placeholder it kept inside a `{{resolve:...}}`
 * reference (issue [#2166](https://github.com/go-to-k/cdkd/issues/2166)).
 *
 * Warn-and-keep is the one way a reference goes unresolved without anything
 * THROWING: `{{resolve:secretsmanager:${Typo}-db:...}}` forms no whole token,
 * so the dynamic-reference pass never sees a reference and records nothing. A
 * caller that collects abandoned units (`cdkd scrub`) needs to hear about it,
 * or it prints the stack clean over a reference it never looked up.
 *
 * The resolver is SHARED with `cdkd deploy`, which passes no
 * `abandonedResolutions` bag. The last block pins that the deploy path is
 * byte-for-byte what it was: same value, same warning, no throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type AbandonedResolution,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { sitsInsideResolvableReference } from '../../../src/deployment/intrinsic-resolver/context.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() }),
  }),
}));

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
    secretsManager: { send: sendMock },
    ssm: { send: sendMock },
  }),
}));

const template: CloudFormationTemplate = {
  Parameters: { Env: { Type: 'String', Default: 'prod' } },
  Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
} as unknown as CloudFormationTemplate;

/** A reference whose secret NAME carries an undeclared placeholder MID-string. */
const MID = { 'Fn::Sub': '{{resolve:secretsmanager:${Typo}-db:SecretString:password}}' };

describe('resolveSub reports a placeholder it KEPT inside a reference (issue #2166)', () => {
  let resolver: IntrinsicFunctionResolver;
  let abandoned: AbandonedResolution[];
  const ctx = (bag?: AbandonedResolution[]): ResolverContext =>
    ({
      template,
      resources: {},
      parameters: { Env: 'prod' },
      recordedSecretValues: new Map<string, string>(),
      ...(bag && { abandonedResolutions: bag }),
    }) as ResolverContext;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver('us-east-1');
    resetAccountInfoCache();
    warnSpy.mockClear();
    sendMock.mockReset();
    abandoned = [];
  });

  it('records ONE placeholder unit for an undeclared variable inside a secret reference', async () => {
    const out = await resolver.resolve(MID, ctx(abandoned));

    // Nothing threw and nothing was looked up -- which is exactly why the bag
    // is the only signal a caller gets.
    expect(out).toBe('{{resolve:secretsmanager:${Typo}-db:SecretString:password}}');
    expect(sendMock).not.toHaveBeenCalled();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({
      unit: 'placeholder',
      subject: '${Typo}',
      carriedDynamicReference: true,
    });
    expect(abandoned[0]!.message).toContain('${Typo}');
    expect(abandoned[0]!.message).toContain('never resolved');
  });

  it('records a TRAILING placeholder, the shape whose truncated token reaches the lookup', async () => {
    sendMock.mockRejectedValue(
      Object.assign(new Error('Parameter name is invalid'), { name: 'ValidationException' })
    );

    await resolver.resolve({ 'Fn::Sub': '{{resolve:ssm:${Typo}}}' }, ctx(abandoned));

    expect(abandoned.map((e) => e.unit)).toContain('placeholder');
  });

  it('records a placeholder that IS the service, which nothing can classify', async () => {
    await resolver.resolve({ 'Fn::Sub': '{{resolve:${Svc}:x:SecretString:pw}}' }, ctx(abandoned));

    expect(abandoned.map((e) => [e.unit, e.subject])).toEqual([['placeholder', '${Svc}']]);
  });

  it.each([
    ['prose that never closes the reference', 'Use the {{resolve:secretsmanager: prefix ${Typo}'],
    ['a placeholder BEFORE the reference opens', '${Typo} {{resolve:ssm:/app/x}}'],
    ['a placeholder AFTER the reference closed', '{{resolve:ssm:/app/x}} ${Typo}'],
    ['a service cdkd never resolves', '{{resolve:otherservice:${Typo}}}'],
    ['ordinary text with no reference at all', 'echo ${Typo}'],
  ])('records NOTHING for %s', async (_label, body) => {
    sendMock.mockResolvedValue({ Parameter: { Value: 'v', Type: 'String' } });

    await resolver.resolve({ 'Fn::Sub': body }, ctx(abandoned));

    expect(abandoned.filter((e) => e.unit === 'placeholder')).toEqual([]);
  });

  it('records NOTHING when every variable in the reference resolved', async () => {
    sendMock.mockResolvedValue({ SecretString: JSON.stringify({ password: 'resolved-pw-value' }) });

    await resolver.resolve(
      { 'Fn::Sub': '{{resolve:secretsmanager:${Env}-db:SecretString:password}}' },
      ctx(abandoned)
    );

    expect(abandoned).toEqual([]);
  });

  it('records each kept placeholder that sits inside, and only those', async () => {
    await resolver.resolve(
      {
        'Fn::Sub':
          '${Outside} {{resolve:secretsmanager:${One}-db:SecretString:${Two}}} ${After}',
      },
      ctx(abandoned)
    );

    expect(abandoned.map((e) => e.subject)).toEqual(['${One}', '${Two}']);
  });

  it('records an undeclared DOTTED placeholder, the GetAtt arm', async () => {
    await resolver.resolve(
      { 'Fn::Sub': '{{resolve:secretsmanager:${Missing.Arn}:SecretString:pw}}' },
      ctx(abandoned)
    );

    expect(abandoned.map((e) => [e.unit, e.subject])).toEqual([['placeholder', '${Missing.Arn}']]);
  });

  it.each([
    ['an inner Fn::Sub in an Fn::Join part', {
      'Fn::Join': [
        '',
        ['{{resolve:secretsmanager:', { 'Fn::Sub': '${Typo}-db' }, ':SecretString:password}}'],
      ],
    }],
    ['an inner Fn::Sub bound into the variable map', {
      'Fn::Sub': [
        '{{resolve:secretsmanager:${V}:SecretString:password}}',
        { V: { 'Fn::Sub': '${Typo}-db' } },
      ],
    }],
  ])('records it ONCE when the opening comes from %s', async (_label, value) => {
    await resolver.resolve(value, ctx(abandoned));

    expect(abandoned.map((e) => [e.unit, e.subject])).toEqual([['placeholder', '${Typo}']]);
  });

  it('records it ONCE when an enclosing Fn::Join passes over the same reference again', async () => {
    // The inner `Fn::Sub` result already holds the whole reference, so its own
    // pass reports it; the `Fn::Join` pass over the joined text meets it again.
    await resolver.resolve(
      {
        'Fn::Join': [
          '',
          [{ 'Fn::Sub': '{{resolve:secretsmanager:${Typo}-db:SecretString:pw}}' }, '-suffix'],
        ],
      },
      ctx(abandoned)
    );

    expect(abandoned.map((e) => [e.unit, e.subject])).toEqual([['placeholder', '${Typo}']]);
  });

  it('places a kept placeholder correctly after a bound variable that changed the length', async () => {
    // No position arithmetic is left to pin (the report searches the assembled
    // string); this guards its reintroduction. An empty value before it: the
    // kept span must not land past the `}}`.
    await resolver.resolve(
      { 'Fn::Sub': ['${Pre}{{resolve:ssm:${Typo}}}', { Pre: '' }] },
      ctx(abandoned)
    );
    expect(abandoned.filter((e) => e.unit === 'placeholder').map((e) => e.subject)).toEqual([
      '${Typo}',
    ]);

    // A long value before a reference that CLOSES before the kept placeholder.
    sendMock.mockResolvedValue({ Parameter: { Value: 'v', Type: 'String' } });
    const later: AbandonedResolution[] = [];
    await resolver.resolve(
      { 'Fn::Sub': ['${Long}{{resolve:ssm:/a}} ${Typo}', { Long: 'x'.repeat(40) }] },
      ctx(later)
    );
    expect(later).toEqual([]);
  });

  it.each([
    ['prose followed by a JSON body with its own }}', 'Use {{resolve:ssm:${Typo} in {"a":{"b":1}}'],
    ['prose continuing on the next line', 'Use {{resolve:ssm:${Typo}\nthen x}}'],
  ])('records NOTHING for %s', async (_label, body) => {
    await resolver.resolve({ 'Fn::Sub': body }, ctx(abandoned));

    expect(abandoned).toEqual([]);
  });

  /**
   * Under `bestEffort` (what `cdkd scrub` resolves with) a placeholder naming a
   * DECLARED resource or parameter is kept rather than refused, and scrub takes
   * no `--parameters`: reporting it would be a gate nothing clears.
   */
  it.each([
    ['a parameter with no Default', '${Stage}'],
    ['a parameter whose Default was not merged', '${Env}'],
    ['a declared resource', '${Bucket.Arn}'],
    ['a declared resource on the Ref arm', '${Bucket}'],
  ])('records NOTHING for %s, under bestEffort', async (_label, placeholder) => {
    const declaredTemplate = {
      Parameters: { Stage: { Type: 'String' }, Env: { Type: 'String', Default: 'prod' } },
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
    } as unknown as CloudFormationTemplate;

    await resolver.resolve(
      { 'Fn::Sub': `{{resolve:secretsmanager:${placeholder}-db:SecretString:password}}` },
      {
        template: declaredTemplate,
        resources: {},
        parameters: {},
        bestEffort: true,
        recordedSecretValues: new Map<string, string>(),
        abandonedResolutions: abandoned,
      } as unknown as ResolverContext
    );

    expect(abandoned).toEqual([]);
  });

  it('DEPLOY PATH: with no bag the result, the warning and the outcome are unchanged', async () => {
    // The deploy engine never opts in. Same input both ways: the only
    // difference the bag may make is the report itself.
    const withBag = await resolver.resolve(MID, ctx(abandoned));
    const warnsWithBag = warnSpy.mock.calls.map((c) => String(c[0]));
    warnSpy.mockClear();

    const deployResolver = new IntrinsicFunctionResolver('us-east-1');
    const withoutBag = await deployResolver.resolve(MID, ctx());

    expect(withoutBag).toBe(withBag);
    expect(warnSpy.mock.calls.map((c) => String(c[0]))).toEqual(warnsWithBag);
    expect(warnsWithBag.some((w) => w.includes('keeping placeholder'))).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('sitsInsideResolvableReference (issue #2166)', () => {
  const at = (text: string, span: string): [string, number, number] => {
    const start = text.indexOf(span);
    return [text, start, start + span.length];
  };

  it.each([
    ['{{resolve:secretsmanager:${X}-db:SecretString:pw}}', true],
    ['{{resolve:ssm:${X}}}', true],
    ['{{resolve:ssm-secure:/a/${X}/b}}', true],
    ['{{resolve:${X}:name}}', true],
    ['{{resolve:ssm:/a}} then {{resolve:ssm:${X}', false],
    ['{{resolve:ssm:${X} then {{resolve:ssm:/b}}', false],
    ['{{resolve:foo:${X}}}', false],
    ['{{resolve:secretsmanager: prose ${X}', false],
    ['${X} {{resolve:ssm:/a}}', false],
    ['{{resolve:ssm:/a}}${X}}}', false],
    ['{{resolve:ssm:${X} "q"}}', false],
    ['{{resolve:ssm:${X}\n}}', false],
  ])('%s -> %s', (text, expected) => {
    expect(sitsInsideResolvableReference(...at(text, '${X}'))).toBe(expected);
  });
});
