import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
    ec2: { send: vi.fn() },
  }),
}));

/**
 * Issue #1740: `Fn::Sub`'s variable resolution swallowed EVERY `resolveGetAtt`
 * error into warn-and-keep-the-placeholder, so a template that hard-fails when
 * the reference sits in a resource property silently shipped a literal
 * `${Resource.Attribute}` to AWS when the identical reference was written
 * inside an `Fn::Sub`.
 *
 * The two shapes are pinned together on purpose: a test that only asserts the
 * refusal cannot tell a precise guard from one that also broke the deliberate
 * warn-and-keep behavior for a genuinely unknown variable.
 */
describe('Fn::Sub GetAtt refusal propagation (issue #1740)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    warnSpy.mockClear();
  });

  const mkContext = (
    physicalId: string,
    attributes: Record<string, unknown> = {}
  ): ResolverContext => {
    const template: CloudFormationTemplate = {
      Resources: { Widget: { Type: 'AWS::Example::Widget', Properties: {} } },
    };
    return {
      template,
      resources: {
        Widget: {
          physicalId,
          resourceType: 'AWS::Example::Widget',
          properties: {},
          attributes,
          dependencies: [],
        },
      },
    };
  };

  it('re-throws the ARN-shape refusal instead of keeping a literal ${X.Y}', async () => {
    const context = mkContext('my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::Sub': 'x-${Widget.WidgetArn}-y' }, context)
    ).rejects.toThrow(IntrinsicResolutionRefusalError);
  });

  it('the re-thrown refusal carries the ORIGINAL message and remedy', async () => {
    const context = mkContext('my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::Sub': 'x-${Widget.WidgetArn}-y' }, context)
    ).rejects.toThrow(
      /Cannot resolve Fn::GetAtt \[Widget, WidgetArn\].*"my-widget-name" is not an ARN/s
    );
  });

  it('re-throws the Url-shape refusal too', async () => {
    const context = mkContext('my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::Sub': '${Widget.WidgetUrl}' }, context)
    ).rejects.toThrow(/is not a URL \(http\(s\):\/\/\.\.\.\)/);
  });

  it('re-throws the --strict-getatt refusal', async () => {
    const strict = new IntrinsicFunctionResolver(undefined, { strictGetAtt: true });
    const context = mkContext('my-widget-name');
    await expect(
      strict.resolve({ 'Fn::Sub': 'a/${Widget.SomeAttribute}' }, context)
    ).rejects.toThrow(/--strict-getatt rejects the physical ID fallback/);
  });

  it('a genuinely unknown variable still keeps the placeholder (counter-case)', async () => {
    const context = mkContext('my-widget-name');
    const result = await resolver.resolve(
      { 'Fn::Sub': 'x-${NoSuchResource.Attr}-y' },
      context
    );
    expect(result).toBe('x-${NoSuchResource.Attr}-y');
  });

  it('a resolvable GetAtt inside Fn::Sub still substitutes (counter-case)', async () => {
    const arn = 'arn:aws:example:us-east-1:123456789012:widget/w1';
    const context = mkContext('my-widget-name', { WidgetArn: arn });
    const result = await resolver.resolve({ 'Fn::Sub': 'x-${Widget.WidgetArn}-y' }, context);
    expect(result).toBe(`x-${arn}-y`);
  });

  it('a non-suffixed unknown attribute still falls back to the physical ID', async () => {
    const context = mkContext('my-widget-name');
    const result = await resolver.resolve({ 'Fn::Sub': 'id=${Widget.Endpoint}' }, context);
    expect(result).toBe('id=my-widget-name');
  });

  it('the kept-placeholder warning names the actual cause, not "not found"', async () => {
    const context = mkContext('my-widget-name');
    await resolver.resolve({ 'Fn::Sub': '${NoSuchResource}' }, context);
    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    const subWarning = messages.find((message) => message.includes('Fn::Sub variable'));
    expect(subWarning).toBeDefined();
    expect(subWarning).toContain('could not be resolved');
    expect(subWarning).toContain('keeping placeholder');
    // The reason is carried through rather than asserted as "not found".
    expect(subWarning).toMatch(/\(.+\)/);
  });

  it('a literal-escaped ${!X} is untouched by the refusal path', async () => {
    const context = mkContext('my-widget-name');
    const result = await resolver.resolve({ 'Fn::Sub': '${!Widget.WidgetArn}' }, context);
    expect(result).toBe('${Widget.WidgetArn}');
  });

  it('an explicit variable map wins before any GetAtt attempt', async () => {
    const context = mkContext('my-widget-name');
    const result = await resolver.resolve(
      { 'Fn::Sub': ['v=${Widget.WidgetArn}', { 'Widget.WidgetArn': 'literal' }] },
      context
    );
    expect(result).toBe('v=literal');
  });
});
