import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// Mock logger
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

// Mock AWS clients (STS for getAccountInfo at the top of constructAttribute)
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
 * Issue #1106: the unknown-attribute physicalId fallback in
 * `constructAttribute` must hard-fail (instead of warn) when the requested
 * attribute name ends with `Arn` / `Url` but the physicalId is not
 * ARN- / URL-shaped — a knowably-wrong value (the #1103 incident shipped
 * resource NAMES into Outputs where ARNs were requested, deploy green).
 */
describe('IntrinsicFunctionResolver - unknown-attribute fallback shape guard (issue #1106)', () => {
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

  it('throws on an Arn-suffixed attribute when the physicalId is name-shaped', async () => {
    const context = mkContext('my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Widget', 'WidgetArn'] }, context)
    ).rejects.toThrow(
      /Cannot resolve Fn::GetAtt \[Widget, WidgetArn\] for AWS::Example::Widget/
    );
  });

  it('the error message is actionable (physicalId, shape hint, issue pointer)', async () => {
    const context = mkContext('my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Widget', 'Arn'] }, context)
    ).rejects.toThrow(
      /"my-widget-name" is not an ARN \(arn:\.\.\.\).*file an issue at https:\/\/github\.com\/go-to-k\/cdkd\/issues/s
    );
  });

  it('throws on the exact attribute name "Arn" too', async () => {
    const context = mkContext('my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Widget', 'Arn'] }, context)
    ).rejects.toThrow(/Cannot resolve Fn::GetAtt \[Widget, Arn\]/);
  });

  it('keeps the fallback when the physicalId already IS an ARN', async () => {
    const arn = 'arn:aws:example:us-east-1:123456789012:widget/my-widget';
    const context = mkContext(arn);
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Widget', 'WidgetArn'] }, context);
    expect(result).toBe(arn);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown attribute WidgetArn')
    );
  });

  it('throws on a Url-suffixed attribute when the physicalId is not an http(s) URL', async () => {
    const context = mkContext('my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Widget', 'WidgetUrl'] }, context)
    ).rejects.toThrow(/"my-widget-name" is not a URL \(http\(s\):\/\/\.\.\.\)/);
  });

  it('keeps the fallback when the physicalId already IS a URL', async () => {
    const url = 'https://example.us-east-1.amazonaws.com/my-widget';
    const context = mkContext(url);
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Widget', 'WidgetUrl'] }, context);
    expect(result).toBe(url);
  });

  it('Alias-suffixed attributes keep the warn-and-return-physicalId behavior', async () => {
    const context = mkContext('my-widget-name');
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Widget', 'WidgetAlias'] }, context);
    expect(result).toBe('my-widget-name');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown attribute WidgetAlias')
    );
  });

  it('Endpoint-suffixed attributes keep the warn-and-return-physicalId behavior', async () => {
    const context = mkContext('my-widget-name');
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Widget', 'Endpoint'] }, context);
    expect(result).toBe('my-widget-name');
  });

  it('enriched attributes short-circuit before the guard (unknown type, Arn present)', async () => {
    const arn = 'arn:aws:example:us-east-1:123456789012:widget/my-widget';
    const context = mkContext('my-widget-name', { WidgetArn: arn });
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Widget', 'WidgetArn'] }, context);
    expect(result).toBe(arn);
  });

  it('known per-type mappings are unaffected (S3 Bucket Arn constructed from name)', async () => {
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Bucket: {
          physicalId: 'my-bucket',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Bucket', 'Arn'] }, context);
    expect(result).toBe('arn:aws:s3:::my-bucket');
  });
});
