import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Tests for cross-account `Fn::GetStackOutput` resolution (closes issue #449).
 *
 * The cross-account path:
 *   1. Reject non-literal RoleArn at the template layer.
 *   2. Parse the role ARN for the producer's account id.
 *   3. `sts:AssumeRole` (cached per role for the deploy lifetime).
 *   4. `GetBucketLocation` against `cdkd-state-{producerAccountId}` with the
 *      assumed credentials.
 *   5. Build a fresh `S3Client` + `S3StateBackend` and call `getState`.
 *   6. Return the requested output.
 *
 * We mock `sts:AssumeRole`, `s3:GetBucketLocation`, and `s3:GetObject` (the
 * call `S3StateBackend.getState` makes) at the SDK layer.
 */

const mockStsSend = vi.fn();
vi.mock('@aws-sdk/client-sts', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sts')>(
    '@aws-sdk/client-sts',
  );
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: mockStsSend,
      destroy: vi.fn(),
    })),
  };
});

const mockS3Send = vi.fn();
const s3ClientFactory = vi.fn();
vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>(
    '@aws-sdk/client-s3',
  );
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation((cfg: unknown) => {
      s3ClientFactory(cfg);
      return {
        send: mockS3Send,
        destroy: vi.fn(),
        config: { region: async () => (cfg as { region?: string })?.region ?? 'us-east-1' },
      };
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { clearCrossAccountCredentialsCache } from '../../../src/utils/role-arn.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';

const PRODUCER_ROLE = 'arn:aws:iam::111122223333:role/cdkd-state-reader';
const PRODUCER_ACCOUNT = '111122223333';
const PRODUCER_BUCKET = `cdkd-state-${PRODUCER_ACCOUNT}`;
const PRODUCER_BUCKET_REGION = 'eu-west-1';

function buildContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  const template: CloudFormationTemplate = { Resources: {} };
  return {
    template,
    resources: {},
    stackName: 'Consumer',
    ...overrides,
  };
}

/**
 * Stub-shaped Body return value the AWS S3 SDK uses for GetObject responses.
 * `transformToString` is what `S3StateBackend.getState` calls.
 */
function bodyOf(json: unknown): { transformToString: () => Promise<string> } {
  return {
    transformToString: async () => JSON.stringify(json),
  };
}

function happyPathState(
  stackName: string,
  region: string,
  outputs: Record<string, unknown>,
): unknown {
  return {
    version: 4,
    stackName,
    region,
    resources: {},
    outputs,
    lastModified: 1700000000000,
  };
}

describe('Fn::GetStackOutput cross-account RoleArn', () => {
  beforeEach(() => {
    mockStsSend.mockReset();
    mockS3Send.mockReset();
    s3ClientFactory.mockReset();
    clearCrossAccountCredentialsCache();
    clearBucketRegionCache();
  });

  it('rejects RoleArn given as a Ref intrinsic with a clear literal-string error', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'BucketArn',
            Region: 'us-east-1',
            RoleArn: { Ref: 'CrossAccountRole' },
          },
        },
        buildContext(),
      ),
    ).rejects.toThrow(/RoleArn must be a literal string/);
  });

  it('rejects RoleArn given as Fn::Sub with a clear literal-string error', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'BucketArn',
            RoleArn: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/x' },
          },
        },
        buildContext(),
      ),
    ).rejects.toThrow(/RoleArn must be a literal string/);
  });

  it('rejects a malformed (non-IAM-role) RoleArn with a parser error', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'BucketArn',
            RoleArn: 'not-a-valid-arn',
          },
        },
        buildContext(),
      ),
    ).rejects.toThrow(/not a valid IAM role ARN/);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('rejects an IAM user ARN with the parser error (only roles permitted)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'BucketArn',
            RoleArn: 'arn:aws:iam::111122223333:user/some-user',
          },
        },
        buildContext(),
      ),
    ).rejects.toThrow(/not a valid IAM role ARN/);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('happy path: assumes role, reads producer bucket, returns the output value', async () => {
    // 1. STS AssumeRole hop
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-xacc',
        SecretAccessKey: 'xacc-secret',
        SessionToken: 'xacc-token',
        Expiration: new Date('2026-12-31T00:00:00Z'),
      },
    });

    // 2. GetBucketLocation against producer's bucket
    mockS3Send.mockResolvedValueOnce({
      LocationConstraint: PRODUCER_BUCKET_REGION,
    });

    // 3. GetObject for the producer's state.json
    mockS3Send.mockResolvedValueOnce({
      Body: bodyOf(
        happyPathState('Producer', 'us-east-1', {
          SharedBucketArn: 'arn:aws:s3:::producer-shared-bucket',
        }),
      ),
      ETag: '"abc123"',
    });

    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'SharedBucketArn',
          Region: 'us-east-1',
          RoleArn: PRODUCER_ROLE,
        },
      },
      buildContext(),
    );

    expect(result).toBe('arn:aws:s3:::producer-shared-bucket');

    // sts:AssumeRole invoked exactly once
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    const stsCmd = mockStsSend.mock.calls[0][0];
    expect(stsCmd.input.RoleArn).toBe(PRODUCER_ROLE);
    expect(stsCmd.input.RoleSessionName).toMatch(/^cdkd-xacc-\d+$/);

    // 2 S3 SDK calls total: GetBucketLocation + GetObject
    expect(mockS3Send).toHaveBeenCalledTimes(2);

    // MUST-FIX 4: assert the S3 calls hit the right bucket + state key.
    // Pre-fix the test only verified result equality, leaving the
    // bucket-naming convention (`cdkd-state-{accountId}`) and the state
    // key layout (`cdkd/{stackName}/{region}/state.json`) silently
    // un-asserted.
    const s3Cmds = mockS3Send.mock.calls.map((call) => call[0]);
    const getBucketLocationCmd = s3Cmds.find(
      (c) => c.constructor.name === 'GetBucketLocationCommand',
    );
    expect(getBucketLocationCmd).toBeDefined();
    expect(getBucketLocationCmd?.input.Bucket).toBe(PRODUCER_BUCKET);

    const getObjectCmd = s3Cmds.find((c) => c.constructor.name === 'GetObjectCommand');
    expect(getObjectCmd).toBeDefined();
    expect(getObjectCmd?.input.Bucket).toBe(PRODUCER_BUCKET);
    expect(getObjectCmd?.input.Key).toBe('cdkd/Producer/us-east-1/state.json');

    // The S3Client used to read state was constructed in the bucket's
    // region with the assumed credentials.
    const cfgs = s3ClientFactory.mock.calls.map((call) => call[0]) as Array<{
      region?: string;
      credentials?: { accessKeyId: string; sessionToken?: string };
    }>;
    const stateClientCfg = cfgs.find(
      (cfg) => cfg.region === PRODUCER_BUCKET_REGION && cfg.credentials !== undefined,
    );
    expect(stateClientCfg).toBeDefined();
    expect(stateClientCfg?.credentials?.accessKeyId).toBe('ASIA-xacc');
    expect(stateClientCfg?.credentials?.sessionToken).toBe('xacc-token');
  });

  it('caches assumed credentials per role across multiple resolves in the same deploy', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-1hop',
        SecretAccessKey: 'shh',
        SessionToken: 'tok',
      },
    });
    // GetBucketLocation also caches per bucket name in the
    // module-level cache — only 1 actual call across N resolves.
    mockS3Send.mockResolvedValueOnce({ LocationConstraint: PRODUCER_BUCKET_REGION });
    // Two GetObject calls (one per resolve)
    mockS3Send.mockResolvedValueOnce({
      Body: bodyOf(
        happyPathState('Producer', 'us-east-1', {
          OutA: 'value-a',
          OutB: 'value-b',
        }),
      ),
      ETag: '"e1"',
    });
    mockS3Send.mockResolvedValueOnce({
      Body: bodyOf(
        happyPathState('Producer', 'us-east-1', {
          OutA: 'value-a',
          OutB: 'value-b',
        }),
      ),
      ETag: '"e2"',
    });

    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const a = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'OutA',
          Region: 'us-east-1',
          RoleArn: PRODUCER_ROLE,
        },
      },
      buildContext(),
    );
    const b = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'OutB',
          Region: 'us-east-1',
          RoleArn: PRODUCER_ROLE,
        },
      },
      buildContext(),
    );

    expect(a).toBe('value-a');
    expect(b).toBe('value-b');

    // Only ONE sts:AssumeRole hop across both lookups (cache hit on the
    // second resolve) — closes acceptance criterion "Assumed credentials
    // cached per (roleArn, region) for the deploy lifetime".
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('auto-detects the producer bucket region via GetBucketLocation', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-region',
        SecretAccessKey: 'secret',
        SessionToken: 'session',
      },
    });
    // Producer's bucket lives in ap-northeast-1.
    mockS3Send.mockResolvedValueOnce({ LocationConstraint: 'ap-northeast-1' });
    mockS3Send.mockResolvedValueOnce({
      Body: bodyOf(
        happyPathState('Producer', 'us-west-2', {
          Out: 'cross-region-value',
        }),
      ),
      ETag: '"e"',
    });

    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'Out',
          Region: 'us-west-2',
          RoleArn: PRODUCER_ROLE,
        },
      },
      buildContext(),
    );

    expect(result).toBe('cross-region-value');

    // Asserts the state-bucket client was constructed with the
    // GetBucketLocation-derived region (ap-northeast-1), NOT with the
    // consumer's deploy region (us-east-1) nor the requested state
    // region (us-west-2 — which is the STATE record's region, not the
    // bucket's).
    const cfgs = s3ClientFactory.mock.calls.map((call) => call[0]) as Array<{
      region?: string;
      credentials?: unknown;
    }>;
    const stateClientCfg = cfgs.find(
      (cfg) => cfg.credentials !== undefined && cfg.region === 'ap-northeast-1',
    );
    expect(stateClientCfg).toBeDefined();
  });

  it('error when the producer state record is not found names the cross-account context', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-missing',
        SecretAccessKey: 's',
        SessionToken: 't',
      },
    });
    mockS3Send.mockResolvedValueOnce({ LocationConstraint: PRODUCER_BUCKET_REGION });
    // GetObject 404 for the requested state record.
    const noSuchKey = Object.assign(new Error('NoSuchKey'), {
      name: 'NoSuchKey',
      $metadata: {},
    });
    mockS3Send.mockRejectedValueOnce(noSuchKey);
    // The state backend also tries the legacy key on miss; reject it the same way.
    mockS3Send.mockRejectedValueOnce(noSuchKey);

    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'NotDeployedYet',
            OutputName: 'X',
            Region: 'us-east-1',
            RoleArn: PRODUCER_ROLE,
          },
        },
        buildContext(),
      ),
    ).rejects.toThrow(/cross-account via arn:aws:iam::111122223333:role\/cdkd-state-reader/);
  });

  it('accepts aws-us-gov partition role ARN', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-govcloud',
        SecretAccessKey: 'gov-secret',
        SessionToken: 'gov-token',
      },
    });
    mockS3Send.mockResolvedValueOnce({ LocationConstraint: 'us-gov-east-1' });
    mockS3Send.mockResolvedValueOnce({
      Body: bodyOf(
        happyPathState('Producer', 'us-gov-east-1', {
          Out: 'gov-value',
        }),
      ),
      ETag: '"e"',
    });

    const resolver = new IntrinsicFunctionResolver('us-gov-east-1');
    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'Out',
          Region: 'us-gov-east-1',
          RoleArn: 'arn:aws-us-gov:iam::555566667777:role/gov-state-reader',
        },
      },
      buildContext(),
    );

    expect(result).toBe('gov-value');
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('does not invoke STS when no RoleArn is supplied (preserves same-account path)', async () => {
    const fakeStateBackend = {
      getState: vi.fn(async () => ({
        state: {
          version: 4,
          stackName: 'Producer',
          region: 'us-east-1',
          resources: {},
          outputs: { Out: 'same-account-value' },
          lastModified: 1,
        },
        etag: 'e',
      })),
    };

    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'Out',
          Region: 'us-east-1',
        },
      },
      buildContext({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stateBackend: fakeStateBackend as any,
      }),
    );

    expect(result).toBe('same-account-value');
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(fakeStateBackend.getState).toHaveBeenCalledWith('Producer', 'us-east-1');
  });

  it('still rejects RoleArn === "" as not a literal string with content', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'X',
            RoleArn: '',
          },
        },
        buildContext(),
      ),
    ).rejects.toThrow(/RoleArn must be a literal string/);
  });

  // SHOULD-FIX 7: --state-prefix propagation through the cross-account branch.
  // The resolver reads `context.stateBackend?.prefix ?? 'cdkd'` so a consumer
  // running `cdkd deploy --state-prefix custom-prefix` should hit the
  // producer's bucket at `custom-prefix/{stack}/{region}/state.json`.
  it('propagates a custom state prefix from context.stateBackend into the cross-account state key', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-prefix',
        SecretAccessKey: 'prefix-secret',
        SessionToken: 'prefix-session',
      },
    });
    mockS3Send.mockResolvedValueOnce({ LocationConstraint: PRODUCER_BUCKET_REGION });
    mockS3Send.mockResolvedValueOnce({
      Body: bodyOf(
        happyPathState('Producer', 'us-east-1', { Out: 'custom-prefix-value' }),
      ),
      ETag: '"e"',
    });

    const fakeBackend = {
      bucket: 'consumer-bucket',
      prefix: 'custom-prefix',
      getState: vi.fn(),
    };

    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'Out',
          Region: 'us-east-1',
          RoleArn: PRODUCER_ROLE,
        },
      },
      buildContext({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stateBackend: fakeBackend as any,
      }),
    );

    expect(result).toBe('custom-prefix-value');

    // The GetObject must hit the producer's bucket at the consumer's
    // custom prefix — NOT the default `cdkd/...` prefix.
    const s3Cmds = mockS3Send.mock.calls.map((call) => call[0]);
    const getObjectCmd = s3Cmds.find((c) => c.constructor.name === 'GetObjectCommand');
    expect(getObjectCmd).toBeDefined();
    expect(getObjectCmd?.input.Key).toBe('custom-prefix/Producer/us-east-1/state.json');
  });

  it('defaults to `cdkd` prefix when context.stateBackend is undefined', async () => {
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-default',
        SecretAccessKey: 'default-secret',
        SessionToken: 'default-session',
      },
    });
    mockS3Send.mockResolvedValueOnce({ LocationConstraint: PRODUCER_BUCKET_REGION });
    mockS3Send.mockResolvedValueOnce({
      Body: bodyOf(happyPathState('Producer', 'us-east-1', { Out: 'default' })),
      ETag: '"e"',
    });

    const resolver = new IntrinsicFunctionResolver('us-east-1');
    await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'Out',
          Region: 'us-east-1',
          RoleArn: PRODUCER_ROLE,
        },
      },
      buildContext(), // no stateBackend
    );

    const s3Cmds = mockS3Send.mock.calls.map((call) => call[0]);
    const getObjectCmd = s3Cmds.find((c) => c.constructor.name === 'GetObjectCommand');
    expect(getObjectCmd?.input.Key).toBe('cdkd/Producer/us-east-1/state.json');
  });

  it('cross-account RoleArn is NOT treated as self-reference even when stackName + region match consumer', async () => {
    // Without RoleArn, "same stack + same region" trips the
    // self-reference guard. With a cross-account RoleArn the producer
    // genuinely lives in a different account, so the same name +
    // region must NOT short-circuit.
    mockStsSend.mockResolvedValueOnce({
      Credentials: {
        AccessKeyId: 'ASIA-xacc',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
      },
    });
    mockS3Send.mockResolvedValueOnce({ LocationConstraint: PRODUCER_BUCKET_REGION });
    mockS3Send.mockResolvedValueOnce({
      Body: bodyOf(
        happyPathState('Consumer', 'us-east-1', { Out: 'cross-acct-same-name' }),
      ),
      ETag: '"e"',
    });

    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Consumer', // same as consumer's stackName
          OutputName: 'Out',
          Region: 'us-east-1', // same as consumer's region
          RoleArn: PRODUCER_ROLE,
        },
      },
      buildContext({ stackName: 'Consumer' }),
    );

    expect(result).toBe('cross-acct-same-name');
  });
});
