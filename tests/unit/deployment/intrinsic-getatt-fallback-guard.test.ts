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

/**
 * Helper for typed per-resource-type contexts (issue #1111 tests below).
 */
const mkTypedContext = (
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown> = {}
): ResolverContext => {
  const template: CloudFormationTemplate = {
    Resources: { Res: { Type: resourceType, Properties: {} } },
  };
  return {
    template,
    resources: {
      Res: {
        physicalId,
        resourceType,
        properties: {},
        attributes,
        dependencies: [],
      },
    },
  };
};

/**
 * Issue #1111 item 1: per-type handlers whose `default:` meant "unknown
 * attribute for this type" now route through the SAME shape guard as the
 * final unknown-type fallback — `*Arn` with a name-shaped physicalId
 * hard-fails, everything else warns and returns the physicalId. Explicit
 * `case`s whose correct value IS the physicalId (KMS KeyId, SNS TopicName,
 * Cognito UserPoolId, EC2 InstanceId, LaunchTemplate LaunchTemplateId, ...)
 * are NOT guarded and NOT warned.
 */
describe('IntrinsicFunctionResolver - per-type default branches route through the guard (issue #1111)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    warnSpy.mockClear();
  });

  it('DynamoDB Table: unknown Arn-suffixed attribute hard-fails on a name-shaped physicalId', async () => {
    const context = mkTypedContext('AWS::DynamoDB::Table', 'my-table');
    await expect(resolver.resolve({ 'Fn::GetAtt': ['Res', 'FooArn'] }, context)).rejects.toThrow(
      /Cannot resolve Fn::GetAtt \[Res, FooArn\] for AWS::DynamoDB::Table/
    );
  });

  it('DynamoDB Table: the known Arn mapping still constructs the table ARN', async () => {
    const context = mkTypedContext('AWS::DynamoDB::Table', 'my-table');
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'Arn'] }, context);
    expect(result).toBe('arn:aws:dynamodb:us-east-1:123456789012:table/my-table');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('DynamoDB Table: unknown non-Arn attribute keeps warn-and-return', async () => {
    const context = mkTypedContext('AWS::DynamoDB::Table', 'my-table');
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'FooBar'] }, context);
    expect(result).toBe('my-table');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown attribute FooBar'));
  });

  it('EC2 Instance: unknown Arn-suffixed attribute hard-fails', async () => {
    const context = mkTypedContext('AWS::EC2::Instance', 'i-0123456789abcdef0');
    await expect(resolver.resolve({ 'Fn::GetAtt': ['Res', 'FooArn'] }, context)).rejects.toThrow(
      /Cannot resolve Fn::GetAtt \[Res, FooArn\] for AWS::EC2::Instance/
    );
  });

  it('EC2 LaunchTemplate: unknown Arn-suffixed attribute hard-fails', async () => {
    const context = mkTypedContext('AWS::EC2::LaunchTemplate', 'lt-0123456789abcdef0');
    await expect(resolver.resolve({ 'Fn::GetAtt': ['Res', 'FooArn'] }, context)).rejects.toThrow(
      /Cannot resolve Fn::GetAtt \[Res, FooArn\] for AWS::EC2::LaunchTemplate/
    );
  });

  it.each([
    ['AWS::KMS::Key', 'KeyId', 'mrk-1234'],
    ['AWS::SNS::Topic', 'TopicName', 'my-topic'],
    ['AWS::Cognito::UserPool', 'UserPoolId', 'us-east-1_AbCdEf'],
    ['AWS::EC2::Instance', 'InstanceId', 'i-0123456789abcdef0'],
    ['AWS::EC2::LaunchTemplate', 'LaunchTemplateId', 'lt-0123456789abcdef0'],
    ['AWS::EC2::Subnet', 'SubnetId', 'subnet-0123'],
    ['AWS::EFS::FileSystem', 'FileSystemId', 'fs-0123'],
  ])(
    '%s.%s is a KNOWN physicalId-valued attribute — returned without warn',
    async (resourceType, attributeName, physicalId) => {
      const context = mkTypedContext(resourceType, physicalId);
      const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', attributeName] }, context);
      expect(result).toBe(physicalId);
      expect(warnSpy).not.toHaveBeenCalled();
    }
  );

  it('IAM Role: unknown Arn-suffixed attribute hard-fails (default branch guarded)', async () => {
    const context = mkTypedContext('AWS::IAM::Role', 'my-role');
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Res', 'ServiceRoleArn'] }, context)
    ).rejects.toThrow(/Cannot resolve Fn::GetAtt \[Res, ServiceRoleArn\] for AWS::IAM::Role/);
  });

  // Review of issue #1111: ECS Service.ServiceArn is a documented GetAtt
  // whose correct value IS the physicalId (the SDK provider stores the
  // service ARN as the physical ID). It must have an explicit case — routed
  // through the guard, --strict-getatt would reject a CORRECT fallback on
  // imported/legacy state without cached attributes.
  it('ECS Service: ServiceArn returns the ARN physicalId without warn', async () => {
    const arn = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
    const context = mkTypedContext('AWS::ECS::Service', arn);
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'ServiceArn'] }, context);
    expect(result).toBe(arn);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ECS Service: ServiceArn extracts the ARN side of a <serviceArn>|<clusterName> compound id', async () => {
    const arn = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
    const context = mkTypedContext('AWS::ECS::Service', `${arn}|my-cluster`);
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'ServiceArn'] }, context);
    expect(result).toBe(arn);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('ECS Service: ServiceArn derives the ARN from a <clusterArn>|<serviceName> compound id', async () => {
    const clusterArn = 'arn:aws:ecs:us-east-1:123456789012:cluster/my-cluster';
    const context = mkTypedContext('AWS::ECS::Service', `${clusterArn}|my-service`);
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'ServiceArn'] }, context);
    expect(result).toBe('arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/**
 * Issue #1111 item 2 (resolver side): `--strict-getatt` promotes EVERY
 * unknown-attribute physicalId fallback (any suffix) to a hard error.
 */
describe('IntrinsicFunctionResolver - strictGetAtt mode (issue #1111)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver(undefined, { strictGetAtt: true });
    resetAccountInfoCache();
    warnSpy.mockClear();
  });

  it('promotes a warn-path fallback (non-Arn suffix) to a hard error', async () => {
    const context = mkTypedContext('AWS::Example::Widget', 'my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Res', 'WidgetAlias'] }, context)
    ).rejects.toThrow(/--strict-getatt/);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('rejects even an ARN-shaped physicalId fallback for an Arn-suffixed attribute', async () => {
    // Default mode warn-passes this (shape check satisfied); strict mode
    // rejects every unknown-attribute fallback regardless of shape.
    const arn = 'arn:aws:example:us-east-1:123456789012:widget/my-widget';
    const context = mkTypedContext('AWS::Example::Widget', arn);
    await expect(resolver.resolve({ 'Fn::GetAtt': ['Res', 'WidgetArn'] }, context)).rejects.toThrow(
      /--strict-getatt/
    );
  });

  it('per-type default branches are strict too (DynamoDB unknown non-Arn attribute)', async () => {
    const context = mkTypedContext('AWS::DynamoDB::Table', 'my-table');
    await expect(resolver.resolve({ 'Fn::GetAtt': ['Res', 'FooBar'] }, context)).rejects.toThrow(
      /--strict-getatt/
    );
  });

  it('known per-type mappings are unaffected under strict (S3 Bucket Arn)', async () => {
    const context = mkTypedContext('AWS::S3::Bucket', 'my-bucket');
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'Arn'] }, context);
    expect(result).toBe('arn:aws:s3:::my-bucket');
  });

  it('known physicalId-valued attributes are unaffected under strict (SNS TopicName)', async () => {
    const context = mkTypedContext('AWS::SNS::Topic', 'my-topic');
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'TopicName'] }, context);
    expect(result).toBe('my-topic');
  });

  it('ECS Service.ServiceArn is unaffected under strict (physicalId IS the documented value)', async () => {
    const arn = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
    const context = mkTypedContext('AWS::ECS::Service', arn);
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'ServiceArn'] }, context);
    expect(result).toBe(arn);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('enriched attributes are unaffected under strict', async () => {
    const arn = 'arn:aws:example:us-east-1:123456789012:widget/my-widget';
    const context = mkTypedContext('AWS::Example::Widget', 'my-widget-name', { WidgetArn: arn });
    const result = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'WidgetArn'] }, context);
    expect(result).toBe(arn);
  });
});

/**
 * Issue #1111 item 3 (resolver side): warn-path fallbacks are counted
 * per resolver instance and resettable per deploy run.
 */
describe('IntrinsicFunctionResolver - physicalId fallback counter (issue #1111)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    warnSpy.mockClear();
  });

  it('counts each warn-path fallback and resets per run', async () => {
    const context = mkTypedContext('AWS::Example::Widget', 'my-widget-name');
    expect(resolver.getPhysicalIdFallbackCount()).toBe(0);
    await resolver.resolve({ 'Fn::GetAtt': ['Res', 'WidgetAlias'] }, context);
    await resolver.resolve({ 'Fn::GetAtt': ['Res', 'Endpoint'] }, context);
    expect(resolver.getPhysicalIdFallbackCount()).toBe(2);
    resolver.resetPhysicalIdFallbackCount();
    expect(resolver.getPhysicalIdFallbackCount()).toBe(0);
  });

  it('counts per-type default-branch fallbacks too', async () => {
    const context = mkTypedContext('AWS::DynamoDB::Table', 'my-table');
    await resolver.resolve({ 'Fn::GetAtt': ['Res', 'FooBar'] }, context);
    expect(resolver.getPhysicalIdFallbackCount()).toBe(1);
  });

  it('does not count known mappings or enriched-attribute resolutions', async () => {
    const s3 = mkTypedContext('AWS::S3::Bucket', 'my-bucket');
    await resolver.resolve({ 'Fn::GetAtt': ['Res', 'Arn'] }, s3);
    const enriched = mkTypedContext('AWS::Example::Widget', 'name', { Foo: 'bar' });
    await resolver.resolve({ 'Fn::GetAtt': ['Res', 'Foo'] }, enriched);
    expect(resolver.getPhysicalIdFallbackCount()).toBe(0);
  });

  it('does not count hard-failed (Arn-shape) resolutions', async () => {
    const context = mkTypedContext('AWS::Example::Widget', 'my-widget-name');
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Res', 'WidgetArn'] }, context)
    ).rejects.toThrow();
    expect(resolver.getPhysicalIdFallbackCount()).toBe(0);
  });
});
