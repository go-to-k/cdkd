import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { clearReplicationProbeCache } from '../../../src/state/s3-replication-purge-gap.js';
import {
  ensureCustomResourceResponseExpirationOnce,
  resetCustomResourceResponseExpirationMemo,
  CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID,
} from '../../../src/state/state-bucket-lifecycle.js';

// Issue #2353, the ALREADY-bootstrapped half: a state bucket bootstrapped
// before the lifecycle rule existed gets it from the first custom-resource
// response cdkd writes, once per process, and a missing lifecycle permission
// is a warning that never fails the resource.

const mockLambdaSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: vi.fn() },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/presigned-url'),
}));

vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: vi.fn().mockResolvedValue(null),
}));

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

const BUCKET = 'cdkd-state-123456789012';

/** Script S3: the lifecycle GET answers `lifecycleGet`; everything else succeeds. */
function scriptS3(lifecycleGet: () => Promise<unknown>): void {
  mockS3Send.mockImplementation(async (command: object) => {
    if (command instanceof GetBucketLifecycleConfigurationCommand) return lifecycleGet();
    if (command.constructor.name === 'ListObjectVersionsCommand') {
      return { Versions: [], DeleteMarkers: [], IsTruncated: false };
    }
    return {};
  });
}

function s3Commands(ctor: abstract new (...args: never[]) => object): object[] {
  return mockS3Send.mock.calls.map((c) => c[0] as object).filter((c) => c instanceof ctor);
}

/**
 * The provider does not await the check, so wait for it here: a second call
 * for a bucket already started returns the SAME memoized promise (the client
 * and logger passed are unused on a memo hit).
 */
const settled = (): Promise<void> =>
  ensureCustomResourceResponseExpirationOnce({} as never, BUCKET, { warn() {}, debug() {} });

const create = (provider: CustomResourceProvider, logicalId: string) =>
  provider.create(logicalId, 'Custom::MyResource', {
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:my-handler',
  });

describe('CustomResourceProvider response-prefix lifecycle rule (issue #2353)', () => {
  beforeEach(() => {
    resetCustomResourceResponseExpirationMemo();
    clearReplicationProbeCache();
    mockS3Send.mockReset();
    mockLambdaSend.mockReset();
    warn.mockReset();
    mockLambdaSend.mockImplementation(async (command: object) => {
      if (command.constructor.name === 'InvokeCommand') {
        return {
          Payload: Buffer.from(JSON.stringify({ PhysicalResourceId: 'phys-2353', Data: {} })),
        };
      }
      return { Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } };
    });
  });

  it('adds the rule to a bucket that lacks it, keeping the existing rules', async () => {
    const userRule = { ID: 'user-rule', Status: 'Enabled', Filter: { Prefix: 'x/' } };
    scriptS3(async () => ({ Rules: [userRule] }));
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);

    const result = await create(provider, 'First');
    await settled();

    expect(result.physicalId).toBe('phys-2353');
    const [put] = s3Commands(PutBucketLifecycleConfigurationCommand) as PutBucketLifecycleConfigurationCommand[];
    expect(put?.input.Bucket).toBe(BUCKET);
    expect(put?.input.LifecycleConfiguration?.Rules?.map((r) => r.ID)).toEqual([
      'user-rule',
      CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID,
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('pays the check once per process: later responses, from any provider instance, send no lifecycle call', async () => {
    scriptS3(async () => ({
      Rules: [{ ID: CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID, Status: 'Enabled' }],
    }));
    const first = new CustomResourceProvider();
    first.setResponseBucket(BUCKET);
    const second = new CustomResourceProvider();
    second.setResponseBucket(BUCKET);

    await create(first, 'A');
    await create(first, 'B');
    await create(second, 'C');
    await settled();

    expect(s3Commands(GetBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(s3Commands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    // ...while each of the three creates still wrote its own placeholder.
    expect(
      (s3Commands(PutObjectCommand) as PutObjectCommand[]).filter((c) => c.input.Body === '')
    ).toHaveLength(3);
  });

  it('a missing lifecycle permission warns once and the custom resource still succeeds', async () => {
    scriptS3(async () => {
      throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    });
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);

    const first = await create(provider, 'A');
    const second = await create(provider, 'B');
    await settled();

    expect(first.physicalId).toBe('phys-2353');
    expect(second.physicalId).toBe('phys-2353');
    expect(s3Commands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
    const lifecycleWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('expiration lifecycle rule')
    );
    expect(lifecycleWarnings).toHaveLength(1);
  });

  it('never makes a custom resource wait for the check (a GET that never answers)', async () => {
    scriptS3(() => new Promise(() => {}));
    const provider = new CustomResourceProvider();
    provider.setResponseBucket(BUCKET);

    const result = await create(provider, 'A');

    expect(result.physicalId).toBe('phys-2353');
    expect(s3Commands(GetBucketLifecycleConfigurationCommand)).toHaveLength(1);
  });

  it('makes no lifecycle call for a non-default response prefix, which the rule does not name', async () => {
    scriptS3(async () => ({ Rules: [] }));
    const provider = new CustomResourceProvider({ responsePrefix: 'elsewhere' });
    provider.setResponseBucket(BUCKET);

    await create(provider, 'A');

    expect(s3Commands(GetBucketLifecycleConfigurationCommand)).toHaveLength(0);
    expect(s3Commands(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('makes no lifecycle call when no response bucket is configured', async () => {
    scriptS3(async () => ({ Rules: [] }));
    const provider = new CustomResourceProvider();

    await create(provider, 'A');

    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
