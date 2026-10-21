import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The ElastiCache, CloudTrail, CloudFront Distribution and IAM AccessKey
 * failure wraps must not write the CALLER'S IDENTITY into a persisted store
 * (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and these services word an access denial as
 * `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized
 * to perform: ...`. Each AWS fixture here carries that wording and the smithy
 * service markers `describeAwsFailure` keys on. Both polarities: an
 * AWS-authored failure is named by its class with `cause` kept (so the retry
 * classifiers still read it), and a cdkd-authored failure keeps its own text.
 */

const { mockSend, debugSpy, warnSpy, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  const client = () => ({
    send: (command: unknown) => send(command),
    config: {
      region: () => Promise.resolve('us-east-1'),
      retryStrategy: () => Promise.resolve(undefined),
    },
    middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
  });
  return { mockSend: send, debugSpy: vi.fn(), warnSpy: vi.fn(), fakeClient: client };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ cloudFront: fakeClient(), iam: fakeClient() }),
}));
vi.mock('@aws-sdk/client-elasticache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-elasticache')>()),
  ElastiCacheClient: vi.fn().mockImplementation(fakeClient),
}));
vi.mock('@aws-sdk/client-cloudtrail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-cloudtrail')>()),
  CloudTrailClient: vi.fn().mockImplementation(fakeClient),
}));
vi.mock('@aws-sdk/client-iam', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-iam')>()),
  IAMClient: vi.fn().mockImplementation(fakeClient),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { ElastiCacheProvider } from '../../../src/provisioning/providers/elasticache-provider.js';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;
/** A resolved secret AWS quotes back inside its own text. */
const SECRET = 'tail-redaction-secret';
const maskSecrets = (text: string): string => text.split(SECRET).join('***');

/** An access denial as these services word it, AWS-authored, naming `SECRET`. */
function accessDenied(name: string, action: string): Error {
  return Object.assign(
    new Error(
      `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
        `arn:aws:x:us-east-1:${CALLER_ACCOUNT}:${SECRET} because no identity-based ` +
        `policy allows the ${action} action`
    ),
    { name, $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );
}

function awsError(name: string, message: string, status = 400): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });
}

/** Every call rejects with `error`. */
function failAll(error: unknown): void {
  mockSend.mockImplementation(() => Promise.reject(error));
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

const debugged = (): string => debugSpy.mock.calls.map((args) => String(args[0])).join('\n');
const warned = (): string => warnSpy.mock.calls.map((args) => String(args[0])).join('\n');

/** The persisted-message invariants every redacted wrap owes. */
function expectRedacted(error: Error, cause: Error, prefix: string): void {
  expect(error).toBeInstanceOf(ProvisioningError);
  expect(error.message).toBe(`${prefix}: ${cause.name}. ${VERBOSE_POINTER}`);
  for (const leak of [CALLER_ACCOUNT, CALLER_ROLE, CALLER_SESSION, SECRET]) {
    expect(error.message).not.toContain(leak);
  }
  expect(error.cause).toBe(cause);
  expect(hasRedactedCause(error)).toBe(true);
  // The IAM-propagation retry reads the withheld text on the cause chain.
  expect(isRetryableTransientError(error, error.message)).toBe(false);
  expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
  // AWS's text reaches debug, masked.
  expect(debugged()).toContain(`${prefix}: User: ${CALLER_ARN} is not authorized`);
  expect(debugged()).not.toContain(SECRET);
}

beforeEach(() => {
  mockSend.mockReset();
  debugSpy.mockReset();
  warnSpy.mockReset();
  resetIdempotencyTokensForTests();
});

const SUBNET_GROUP = { CacheSubnetGroupName: 'sg', Description: 'd', SubnetIds: ['subnet-1'] };
const CACHE_CLUSTER = {
  ClusterName: 'cc',
  CacheNodeType: 'cache.t3.micro',
  Engine: 'redis',
  NumCacheNodes: 1,
};

describe('ElastiCacheProvider (go-to-k/cdkd#2319)', () => {
  const provider = (): ElastiCacheProvider => new ElastiCacheProvider();

  it.each([
    {
      op: 'create CacheSubnetGroup',
      run: (p: ElastiCacheProvider) =>
        p.create('Sg', 'AWS::ElastiCache::SubnetGroup', SUBNET_GROUP, { maskSecrets }),
      prefix: 'Failed to create CacheSubnetGroup Sg',
    },
    {
      op: 'update CacheSubnetGroup',
      run: (p: ElastiCacheProvider) =>
        p.update(
          'Sg',
          'sg',
          'AWS::ElastiCache::SubnetGroup',
          { ...SUBNET_GROUP, SubnetIds: ['subnet-2'] },
          SUBNET_GROUP,
          { maskSecrets }
        ),
      prefix: 'Failed to update CacheSubnetGroup Sg',
    },
    {
      op: 'delete CacheSubnetGroup',
      run: (p: ElastiCacheProvider) =>
        p.delete('Sg', 'sg', 'AWS::ElastiCache::SubnetGroup', SUBNET_GROUP, { maskSecrets }),
      prefix: 'Failed to delete CacheSubnetGroup Sg',
    },
    {
      op: 'create CacheCluster',
      run: (p: ElastiCacheProvider) =>
        p.create('Cc', 'AWS::ElastiCache::CacheCluster', CACHE_CLUSTER, { maskSecrets }),
      prefix: 'Failed to create CacheCluster Cc',
    },
    {
      op: 'update CacheCluster',
      run: (p: ElastiCacheProvider) =>
        p.update(
          'Cc',
          'cc',
          'AWS::ElastiCache::CacheCluster',
          { ...CACHE_CLUSTER, CacheNodeType: 'cache.t3.small' },
          CACHE_CLUSTER,
          { maskSecrets }
        ),
      prefix: 'Failed to update CacheCluster Cc',
    },
    {
      op: 'delete CacheCluster',
      run: (p: ElastiCacheProvider) =>
        p.delete('Cc', 'cc', 'AWS::ElastiCache::CacheCluster', CACHE_CLUSTER, { maskSecrets }),
      prefix: 'Failed to delete CacheCluster Cc',
    },
  ])('$op: names the class, keeps the cause, sends AWS text to debug masked', async ({ run, prefix }) => {
    const denied = accessDenied('AccessDenied', 'elasticache:Any');
    failAll(denied);
    expectRedacted(await thrown(run(provider())), denied, prefix);
  });

  it('restates an "already exists" so a create-first replacement still sees the collision', async () => {
    const taken = awsError(
      'CacheSubnetGroupAlreadyExistsFault',
      `Cache subnet group sg already exists in account ${CALLER_ACCOUNT}.`
    );
    failAll(taken);
    const error = await thrown(
      provider().create('Sg', 'AWS::ElastiCache::SubnetGroup', SUBNET_GROUP)
    );
    expect(error.message).toBe(
      `Failed to create CacheSubnetGroup Sg: CacheSubnetGroupAlreadyExistsFault. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(error.message).not.toContain(CALLER_ACCOUNT);
    expect(isNameCollisionErrorFrom(error, 'Sg')).toBe(true);
  });

  it('keeps a cdkd-authored failure text', async () => {
    failAll(new Error('socket hang up'));
    const error = await thrown(
      provider().delete('Sg', 'sg', 'AWS::ElastiCache::SubnetGroup', SUBNET_GROUP)
    );
    expect(error.message).toBe('Failed to delete CacheSubnetGroup Sg: socket hang up');
    expect(hasRedactedCause(error)).toBe(false);
  });
});

const TRAIL = { TrailName: 'trail', S3BucketName: 'bucket', IsLogging: true };
const TRAIL_ARN = `arn:aws:cloudtrail:us-east-1:${CALLER_ACCOUNT}:trail/trail`;

describe('CloudTrailProvider (go-to-k/cdkd#2319)', () => {
  it.each([
    {
      op: 'create',
      run: (p: CloudTrailProvider) =>
        p.create('Trail', 'AWS::CloudTrail::Trail', TRAIL, { maskSecrets }),
      prefix: 'Failed to create CloudTrail Trail Trail',
    },
    {
      op: 'update',
      run: (p: CloudTrailProvider) =>
        p.update(
          'Trail',
          TRAIL_ARN,
          'AWS::CloudTrail::Trail',
          { ...TRAIL, S3BucketName: 'bucket2' },
          TRAIL,
          { maskSecrets }
        ),
      prefix: 'Failed to update CloudTrail Trail Trail',
    },
    {
      op: 'delete',
      run: (p: CloudTrailProvider) =>
        p.delete('Trail', TRAIL_ARN, 'AWS::CloudTrail::Trail', TRAIL, { maskSecrets }),
      prefix: 'Failed to delete CloudTrail Trail Trail',
    },
  ])('$op: names the class, keeps the cause, sends AWS text to debug masked', async ({ run, prefix }) => {
    const denied = accessDenied('AccessDeniedException', 'cloudtrail:Any');
    failAll(denied);
    expectRedacted(await thrown(run(new CloudTrailProvider())), denied, prefix);
  });

  it('restates an "already exists" without the account AWS names', async () => {
    const taken = awsError(
      'TrailAlreadyExistsException',
      `Trail trail already exists for customer: ${CALLER_ACCOUNT}`
    );
    failAll(taken);
    const error = await thrown(new CloudTrailProvider().create('Trail', 'AWS::CloudTrail::Trail', TRAIL));
    expect(error.message).toBe(
      `Failed to create CloudTrail Trail Trail: TrailAlreadyExistsException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(isNameCollisionErrorFrom(error, 'Trail')).toBe(true);
  });
});

const DISTRIBUTION = {
  DistributionConfig: {
    Enabled: true,
    Comment: 'edge',
    DefaultCacheBehavior: { TargetOriginId: 'o1', ViewerProtocolPolicy: 'redirect-to-https' },
    Origins: [{ Id: 'o1', DomainName: 'origin.example.com', S3OriginConfig: {} }],
  },
};

describe('CloudFrontDistributionProvider (go-to-k/cdkd#2319)', () => {
  it.each([
    {
      op: 'create',
      run: (p: CloudFrontDistributionProvider) =>
        p.create('Cdn', 'AWS::CloudFront::Distribution', DISTRIBUTION, { maskSecrets }),
      prefix: 'Failed to create CloudFront Distribution Cdn',
    },
    {
      op: 'update',
      run: (p: CloudFrontDistributionProvider) =>
        p.update('Cdn', 'E1', 'AWS::CloudFront::Distribution', DISTRIBUTION, DISTRIBUTION, {
          maskSecrets,
        }),
      prefix: 'Failed to update CloudFront Distribution Cdn',
    },
    {
      op: 'delete',
      run: (p: CloudFrontDistributionProvider) =>
        p.delete('Cdn', 'E1', 'AWS::CloudFront::Distribution', DISTRIBUTION, { maskSecrets }),
      prefix: 'Failed to delete CloudFront Distribution Cdn',
    },
  ])('$op: names the class, keeps the cause, sends AWS text to debug masked', async ({ run, prefix }) => {
    const denied = accessDenied('AccessDenied', 'cloudfront:Any');
    failAll(denied);
    expectRedacted(await thrown(run(new CloudFrontDistributionProvider())), denied, prefix);
  });

  it("update's tag-diff failure names the class and ends one sentence", async () => {
    const denied = accessDenied('AccessDenied', 'cloudfront:TagResource');
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'GetDistributionConfigCommand':
          return Promise.resolve({ ETag: 'e1', DistributionConfig: DISTRIBUTION.DistributionConfig });
        case 'UpdateDistributionCommand':
          return Promise.resolve({});
        case 'GetDistributionCommand':
          return Promise.resolve({
            Distribution: { DomainName: 'd.cloudfront.net', ARN: 'arn:cf', Status: 'Deployed' },
          });
        default:
          return Promise.reject(denied);
      }
    });
    const error = await thrown(
      new CloudFrontDistributionProvider().update(
        'Cdn',
        'E1',
        'AWS::CloudFront::Distribution',
        { ...DISTRIBUTION, Tags: [{ Key: 'k', Value: 'v' }] },
        DISTRIBUTION,
        { maskSecrets }
      )
    );
    expect(error.message).toBe(
      `CloudFront Distribution E1: tag diff failed (removed=0, upserts=1): AccessDenied. ${VERBOSE_POINTER} ` +
        'UpdateDistribution succeeded but TagResource/UntagResource did not — state has NOT been updated so the next deploy will retry the tag-diff.'
    );
    expect(error.cause).toBe(denied);
    expect(hasRedactedCause(error)).toBe(true);
    expect(debugged()).toContain(`User: ${CALLER_ARN}`);
    expect(debugged()).not.toContain(SECRET);
  });
});

describe('IAMAccessKeyProvider (go-to-k/cdkd#2319)', () => {
  it.each([
    {
      op: 'create',
      run: (p: IAMAccessKeyProvider) =>
        p.create('Key', 'AWS::IAM::AccessKey', { UserName: 'u' }, { maskSecrets }),
      prefix: 'Failed to create IAM access key Key',
    },
    {
      op: 'update',
      run: (p: IAMAccessKeyProvider) =>
        p.update(
          'Key',
          'AKIAKEY',
          'AWS::IAM::AccessKey',
          { UserName: 'u', Status: 'Inactive' },
          { UserName: 'u' },
          { maskSecrets }
        ),
      prefix: 'Failed to update IAM access key Key',
    },
    {
      op: 'delete',
      run: (p: IAMAccessKeyProvider) =>
        p.delete('Key', 'AKIAKEY', 'AWS::IAM::AccessKey', { UserName: 'u' }, {
          maskSecrets,
        }),
      prefix: 'Failed to delete IAM access key Key',
    },
  ])('$op: names the class, keeps the cause, sends AWS text to debug masked', async ({ run, prefix }) => {
    const denied = accessDenied('AccessDenied', 'iam:Any');
    failAll(denied);
    expectRedacted(await thrown(run(new IAMAccessKeyProvider())), denied, prefix);
  });

  it('a denied ListAccessKeys warns with the class and the remedy, AWS text at debug', async () => {
    const denied = accessDenied('AccessDenied', 'iam:ListAccessKeys');
    failAll(denied);
    await thrown(new IAMAccessKeyProvider().create('Key', 'AWS::IAM::AccessKey', { UserName: 'u' }, { maskSecrets }));
    const lead = 'Could not list existing access keys for user u while creating Key';
    expect(warned()).toContain(
      `${lead}: AccessDenied. ${VERBOSE_POINTER} Orphan detection is DISABLED for this create`
    );
    expect(warned()).toContain('Grant iam:ListAccessKeys');
    for (const leak of [CALLER_ACCOUNT, CALLER_ROLE, CALLER_SESSION, SECRET]) {
      expect(warned()).not.toContain(leak);
    }
    expect(debugged()).toContain(`${lead}: User: ${CALLER_ARN}`);
    expect(debugged()).not.toContain(SECRET);
  });

  it('a refused cleanup of a partially-created key warns with the class, never the secret', async () => {
    const SECRET_ACCESS_KEY = 'minted-secret-access-key-value';
    const denied = accessDenied('AccessDenied', 'iam:DeleteAccessKey');
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'ListAccessKeysCommand':
          return Promise.resolve({ AccessKeyMetadata: [] });
        case 'CreateAccessKeyCommand':
          return Promise.resolve({
            AccessKey: { AccessKeyId: 'AKIAMINTED', SecretAccessKey: SECRET_ACCESS_KEY },
          });
        case 'UpdateAccessKeyCommand':
          return Promise.reject(awsError('ServiceFailure', 'status wiring failed', 500));
        default:
          return Promise.reject(denied);
      }
    });
    const error = await thrown(
      new IAMAccessKeyProvider().create(
        'Key',
        'AWS::IAM::AccessKey',
        { UserName: 'u', Status: 'Inactive' },
        { maskSecrets }
      )
    );
    const lead = 'Failed to clean up partially-created IAM access key Key (AKIAMINTED)';
    expect(warned()).toContain(`${lead}: AccessDenied. ${VERBOSE_POINTER} Manual deletion may be required`);
    expect(warned()).not.toContain(CALLER_ARN);
    expect(debugged()).toContain(`${lead}: User: ${CALLER_ARN}`);
    expect(error.message).toBe(
      `Failed to create IAM access key Key: ServiceFailure. ${VERBOSE_POINTER}`
    );
    const everything = `${warned()}\n${debugged()}\n${error.message}`;
    expect(everything).not.toContain(SECRET_ACCESS_KEY);
  });

  it('keeps a cdkd-authored failure text in the delete wrap', async () => {
    mockSend.mockImplementation(() => Promise.resolve({}));
    const error = await thrown(
      new IAMAccessKeyProvider().delete('Key', 'AKIAKEY', 'AWS::IAM::AccessKey', {})
    );
    expect(error.message).toBe(
      'Failed to delete IAM access key Key: cannot resolve the owning user for access key AKIAKEY'
    );
    expect(hasRedactedCause(error)).toBe(false);
  });
});
