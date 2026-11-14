import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) } }),
}));

/**
 * go-to-k/cdkd#6242: an attribute CloudFormation DEFINES (schema read-only)
 * that an SDK provider's record cannot answer is REFUSED, not served as the
 * physical id, which was the wrong value for every such attribute measured
 * except the `PHYSICAL_ID_ATTRIBUTES` allow-list.
 */
const resolve = (type: string, physicalId: string, attr: string, provisionedBy?: 'sdk' | 'cc-api') =>
  new IntrinsicFunctionResolver('us-east-1').resolve({ 'Fn::GetAtt': ['X', attr] }, {
    template: { Resources: { X: { Type: type, Properties: {} } } },
    resources: {
      X: {
        physicalId,
        resourceType: type,
        properties: {},
        attributes: {},
        dependencies: [],
        ...(provisionedBy && { provisionedBy }),
      },
    },
  } as ResolverContext);
const refusalOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

describe('structural GetAtt refusal (#6242)', () => {
  beforeEach(() => {
    resetAccountInfoCache();
    warnSpy.mockReset();
  });

  it.each([
    ['AWS::WAFv2::WebACL', 'Capacity'],
    ['AWS::IAM::ManagedPolicy', 'AttachmentCount'],
    ['AWS::RDS::DBInstance', 'DBInstanceStatus'],
  ])('refuses %s %s on an SDK record instead of serving the physical id', async (type, attr) => {
    const error = await refusalOf(resolve(type, 'the-physical-id', attr, 'sdk'));
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).message).toContain('is not the value CloudFormation returns');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses on a record that predates provisionedBy (absent counts as SDK)', async () => {
    expect(await refusalOf(resolve('AWS::WAFv2::WebACL', 'acl', 'Capacity'))).toBeInstanceOf(
      IntrinsicResolutionRefusalError
    );
  });

  it('keeps the warn + physical id for a Cloud Control record', async () => {
    await expect(resolve('AWS::WAFv2::WebACL', 'acl', 'Capacity', 'cc-api')).resolves.toBe('acl');
    expect(String(warnSpy.mock.calls[0]![0])).toContain('returning physical ID');
  });

  it.each([
    ['AWS::ApiGateway::Account', 'Id'],
    ['AWS::Budgets::Budget', 'Id'],
    ['AWS::EFS::MountTarget', 'Id'],
    ['AWS::SQS::QueuePolicy', 'Id'],
  ])('serves the physical id for the measured %s %s (it equals the Ref, as in CloudFormation)', async (type, attr) => {
    await expect(resolve(type, 'the-physical-id', attr, 'sdk')).resolves.toBe('the-physical-id');
  });

  it.each([
    ['AWS::CloudFormation::WaitConditionHandle', 'Id'],
    ['AWS::IAM::UserToGroupAddition', 'Id'],
  ])('refuses %s %s, which CloudFormation rejects at template validation', async (type, attr) => {
    expect(await refusalOf(resolve(type, 'the-physical-id', attr, 'sdk'))).toBeInstanceOf(
      IntrinsicResolutionRefusalError
    );
  });

  it.each([
    ['AWS::SecretsManager::Secret', 'Id', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:s-AbCdEf'],
    ['AWS::S3Tables::TableBucket', 'TableBucketARN', 'arn:aws:s3tables:us-east-1:123456789012:bucket/tb'],
  ])('keeps serving %s %s, the resource\'s own identifier the physical id holds', async (type, attr, id) => {
    // Code review, go-to-k/cdkd#6242: a record `import()` wrote holds no copy,
    // and the physical id IS the value (CloudFormation's Ref of the type).
    await expect(resolve(type, id, attr, 'sdk')).resolves.toBe(id);
  });

  it('refuses CodeCommit RepositoryId: its identifier, but cdkd\'s physical id is the repository NAME', async () => {
    expect(
      await refusalOf(resolve('AWS::CodeCommit::Repository', 'my-repo', 'RepositoryId', 'sdk'))
    ).toBeInstanceOf(IntrinsicResolutionRefusalError);
  });

  it.each([
    ['AWS::ApiGatewayV2::Integration', 'IntegrationId', 'int1'],
    ['AWS::ApiGateway::Resource', 'ResourceId', 'res1'],
  ])('keeps serving %s %s, a member of its identifier the physical id holds', async (type, attr, id) => {
    // Code review round 3, go-to-k/cdkd#6242: an identifier member behaves
    // exactly as before the guard, so an imported record (no copy of it) is
    // never refused what main served correctly.
    await expect(resolve(type, id, attr, 'sdk')).resolves.toBe(id);
  });

  it('keeps serving a type\'s own ARN when the physical id is that ARN', async () => {
    const arn = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    await expect(resolve('AWS::SNS::Topic', arn, 'TopicArn', 'sdk')).resolves.toBe(arn);
  });

  it('refuses another resource\'s ARN a type carries, even on an ARN physical id', async () => {
    const error = await refusalOf(
      resolve('AWS::CloudTrail::Trail', 'arn:aws:cloudtrail:us-east-1:123456789012:trail/t', 'SnsTopicArn', 'sdk')
    );
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
  });

  it('keeps the warn arm for an attribute outside the read-only set', async () => {
    await expect(resolve('AWS::WAFv2::WebACL', 'acl', 'NotAnAttribute', 'sdk')).resolves.toBe('acl');
    expect(String(warnSpy.mock.calls[0]![0])).toContain('returning physical ID');
  });
});
