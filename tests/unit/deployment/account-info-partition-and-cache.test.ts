import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  getAccountInfo,
  resetAccountInfoCache,
  IntrinsicFunctionResolver,
  type ResolverContext,
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

const stsSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: stsSend }, ec2: { send: vi.fn() } }),
}));

/**
 * Issue #1730. Two independent defects in `getAccountInfo`:
 *
 * 1. `partition` was hardcoded to `'aws'` on BOTH the success and the failure
 *    path, so every ARN built from it — this module's own `Fn::GetAtt`
 *    construction plus `CloudControlProvider`'s enrichment sites — was wrong
 *    outside the commercial partition, and structurally valid, so nothing
 *    downstream could catch it.
 * 2. The FABRICATED fallback was cached for the process, so one transient STS
 *    failure poisoned every later caller in the run.
 */
describe('getAccountInfo partition + caching (issue #1730)', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalAccountId = process.env['AWS_ACCOUNT_ID'];

  beforeEach(() => {
    resetAccountInfoCache();
    stsSend.mockReset();
    warnSpy.mockClear();
    delete process.env['AWS_ACCOUNT_ID'];
    process.env['AWS_REGION'] = 'us-east-1';
  });

  afterEach(() => {
    resetAccountInfoCache();
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalAccountId === undefined) delete process.env['AWS_ACCOUNT_ID'];
    else process.env['AWS_ACCOUNT_ID'] = originalAccountId;
  });

  const succeed = (account = '123456789012') =>
    stsSend.mockResolvedValue({ Account: account });

  it('derives the partition from the region on the success path', async () => {
    succeed();
    process.env['AWS_REGION'] = 'cn-north-1';
    const info = await getAccountInfo();
    expect(info.partition).toBe('aws-cn');
  });

  it('derives aws-us-gov for a GovCloud region', async () => {
    succeed();
    process.env['AWS_REGION'] = 'us-gov-west-1';
    const info = await getAccountInfo();
    expect(info.partition).toBe('aws-us-gov');
  });

  it('still answers aws for a commercial region', async () => {
    succeed();
    const info = await getAccountInfo();
    expect(info.partition).toBe('aws');
  });

  it('honors an override region for the partition on the FIRST call', async () => {
    succeed();
    const info = await getAccountInfo('cn-northwest-1');
    expect(info.region).toBe('cn-northwest-1');
    expect(info.partition).toBe('aws-cn');
  });

  it('re-derives the partition for an override served from the CACHE', async () => {
    succeed();
    const first = await getAccountInfo();
    expect(first.partition).toBe('aws');

    // Served from the cache, whose partition was derived for us-east-1.
    const overridden = await getAccountInfo('cn-north-1');
    expect(overridden.region).toBe('cn-north-1');
    expect(overridden.partition).toBe('aws-cn');
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('derives the partition on the STS-failure fallback too', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    process.env['AWS_REGION'] = 'us-gov-east-1';
    const info = await getAccountInfo();
    expect(info.partition).toBe('aws-us-gov');
    expect(info.fabricated).toBe(true);
  });

  it('does NOT cache a fabricated fallback — a later call retries STS', async () => {
    stsSend.mockRejectedValueOnce(new Error('transient STS blip'));
    const fabricated = await getAccountInfo();
    expect(fabricated.fabricated).toBe(true);
    expect(fabricated.accountId).toBe('123456789012');

    stsSend.mockResolvedValue({ Account: '999988887777' });
    const healed = await getAccountInfo();
    expect(healed.fabricated).toBeUndefined();
    expect(healed.accountId).toBe('999988887777');
    expect(stsSend).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache a SUCCESS that carried no Account either', async () => {
    stsSend.mockResolvedValueOnce({});
    const fabricated = await getAccountInfo();
    expect(fabricated.fabricated).toBe(true);

    stsSend.mockResolvedValue({ Account: '999988887777' });
    const healed = await getAccountInfo();
    expect(healed.accountId).toBe('999988887777');
    expect(stsSend).toHaveBeenCalledTimes(2);
  });

  it('still caches a real answer (one STS round trip per run)', async () => {
    succeed('555566667777');
    await getAccountInfo();
    await getAccountInfo();
    await getAccountInfo();
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('an operator-supplied AWS_ACCOUNT_ID is a real answer, and IS cached', async () => {
    process.env['AWS_ACCOUNT_ID'] = '111122223333';
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const first = await getAccountInfo();
    expect(first.accountId).toBe('111122223333');
    expect(first.fabricated).toBeUndefined();

    await getAccountInfo();
    expect(stsSend).toHaveBeenCalledTimes(1);
  });
});

/**
 * The consumer half: `constructAttribute` builds ~30 account-bearing ARNs, and
 * an ARN carrying the placeholder account has no wildcard for
 * `isPlaceholderArn` (#1681) to catch — it is served as the resource's
 * `Fn::GetAtt` answer and recorded into state.
 *
 * The refusal is keyed on the CONSTRUCTED VALUE containing the fabricated
 * account, never on the attribute NAME: `AWS::S3::Bucket`'s `Arn` has no
 * account field, so a name-based `*Arn` guard would refuse a value the
 * fabricated id cannot corrupt. The counter-cases are what pin that.
 */
describe('Fn::GetAtt refuses an ARN built from a fabricated account (issue #1730)', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalAccountId = process.env['AWS_ACCOUNT_ID'];

  const mkContext = (resourceType: string, physicalId: string): ResolverContext => {
    const template: CloudFormationTemplate = {
      Resources: { Thing: { Type: resourceType, Properties: {} } },
    };
    return {
      template,
      resources: {
        Thing: {
          physicalId,
          resourceType,
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };
  };

  beforeEach(() => {
    resetAccountInfoCache();
    stsSend.mockReset();
    warnSpy.mockClear();
    delete process.env['AWS_ACCOUNT_ID'];
    process.env['AWS_REGION'] = 'us-east-1';
  });

  afterEach(() => {
    resetAccountInfoCache();
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalAccountId === undefined) delete process.env['AWS_ACCOUNT_ID'];
    else process.env['AWS_ACCOUNT_ID'] = originalAccountId;
  });

  it('refuses an account-bearing ARN when STS could not answer', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['Thing', 'Arn'] },
        mkContext('AWS::DynamoDB::Table', 'my-table')
      )
    ).rejects.toThrow(IntrinsicResolutionRefusalError);
  });

  it('the refusal names the placeholder account and the remedy', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['Thing', 'Arn'] },
        mkContext('AWS::DynamoDB::Table', 'my-table')
      )
    ).rejects.toThrow(/placeholder account 123456789012.*set AWS_ACCOUNT_ID/s);
  });

  it('does NOT refuse an ARN with no account field (S3 bucket, counter-case)', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'Arn'] },
      mkContext('AWS::S3::Bucket', 'my-bucket')
    );
    expect(result).toBe('arn:aws:s3:::my-bucket');
  });

  it('does NOT refuse a non-ARN attribute of the same resource (counter-case)', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'DomainName'] },
      mkContext('AWS::S3::Bucket', 'my-bucket')
    );
    expect(result).toBe('my-bucket.s3.amazonaws.com');
  });

  it('resolves the account-bearing ARN normally for a REAL account (counter-case)', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'Arn'] },
      mkContext('AWS::DynamoDB::Table', 'my-table')
    );
    expect(result).toBe('arn:aws:dynamodb:us-east-1:999988887777:table/my-table');
  });

  it('an operator-supplied AWS_ACCOUNT_ID is trusted and resolves (counter-case)', async () => {
    process.env['AWS_ACCOUNT_ID'] = '111122223333';
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Thing', 'Arn'] },
      mkContext('AWS::DynamoDB::Table', 'my-table')
    );
    expect(result).toBe('arn:aws:dynamodb:us-east-1:111122223333:table/my-table');
  });

  it('propagates out of an Fn::Sub too (the #1740 half, end to end)', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    const resolver = new IntrinsicFunctionResolver();
    await expect(
      resolver.resolve(
        { 'Fn::Sub': 'x-${Thing.Arn}-y' },
        mkContext('AWS::DynamoDB::Table', 'my-table')
      )
    ).rejects.toThrow(/placeholder account 123456789012/);
  });
});
