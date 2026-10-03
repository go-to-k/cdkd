import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockAccountInfo = vi.hoisted(() => ({
  unavailable: false,
  otherFailure: undefined as Error | undefined,
  value: {
    partition: 'aws',
    region: 'us-east-1',
    accountId: '123456789012',
  } as Record<string, unknown>,
}));

const ccClientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const getAccountInfoCalls = vi.hoisted(() => [] as (string | undefined)[]);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    // `config.region` is a PROVIDER function on a real SDK client, not a
    // string — `CloudControlProvider` awaits it (see `accountInfoForSynthesizedArn`
    // and the instance-protection path). The string form made this mock unfaithful.
    cloudControl: {
      send: vi.fn(),
      config: { region: () => Promise.resolve(ccClientRegion.value) },
    },
    cloudFormation: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async () => {
  const { AccountIdUnavailableError } = await import('../../../src/utils/error-handler.js');
  return {
  // Records the override it was CALLED with. Ignoring the argument is what let
  // the region fix ship unpinned: reverting the call site to a bare
  // `getAccountInfo()` left every test green (PR review).
  getAccountInfo: (overrideRegion?: string) => {
    // NOTE the enrichment path ALWAYS passes an override (the CC client's
    // region), so `ccClientRegion` — not the `region:` field of the
    // `mockAccountInfo.value` literals below — is the live knob for the region
    // that reaches a built ARN. Those `region:` fields are kept only so the
    // records read as realistic; changing one alone has no effect.
    getAccountInfoCalls.push(overrideRegion);
    if (mockAccountInfo.otherFailure) return Promise.reject(mockAccountInfo.otherFailure);
    if (mockAccountInfo.unavailable) {
      return Promise.reject(
        new AccountIdUnavailableError('Cannot determine the AWS account id: STS unreachable.')
      );
    }
    return Promise.resolve({
      ...mockAccountInfo.value,
      ...(overrideRegion ? { region: overrideRegion } : {}),
    });
  },
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return {
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: vi.fn(),
    };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

/**
 * Issue #1730: `getAccountInfo` REJECTS with `AccountIdUnavailableError` when
 * STS cannot name the account. Enrichment runs AFTER the resource was created,
 * so letting that escape would fail a create that already succeeded in AWS and
 * orphan the resource.
 *
 * These sites must omit the attribute instead. The counter-cases are what make
 * the assertions meaningful: a known account must still enrich, and the
 * non-ARN attributes of the same branch must be untouched.
 */
describe('CloudControlProvider ARN enrichment omits on an unknown account (issue #1730)', () => {
  let provider: CloudControlProvider;

  const enrich = (resourceType: string, physicalId: string) =>
    (
      provider as unknown as {
        enrichResourceAttributes: (
          resourceType: string,
          physicalId: string,
          attributes: Record<string, unknown>
        ) => Promise<Record<string, unknown>>;
      }
    ).enrichResourceAttributes(resourceType, physicalId, {});

  beforeEach(() => {
    mockLoggerWarn.mockClear();
    getAccountInfoCalls.length = 0;
    ccClientRegion.value = 'us-east-1';
    provider = new CloudControlProvider();
    mockAccountInfo.unavailable = false;
    mockAccountInfo.otherFailure = undefined;
    mockAccountInfo.value = {
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
    };
  });

  // Issue #1746 review: the enrichment path is the ONLY `getAccountInfo` caller
  // that passes no override, so after that change it resolved the ambient
  // `AWS_REGION` — which `deploy` mutates globally while stacks run
  // concurrently. It must pass the CC client's own region instead.
  it('passes the CC client region as the override, not the ambient one', async () => {
    ccClientRegion.value = 'eu-west-1';
    const previous = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'us-east-1';
    try {
      const enriched = await enrich('AWS::KMS::Key', 'abcd-1234');

      expect(getAccountInfoCalls).toEqual(['eu-west-1']);
      // ...and the override actually reaches the built ARN.
      expect(enriched['Arn']).toBe('arn:aws:kms:eu-west-1:123456789012:key/abcd-1234');
    } finally {
      if (previous === undefined) delete process.env['AWS_REGION'];
      else process.env['AWS_REGION'] = previous;
    }
  });

  const fabricate = () => {
    mockAccountInfo.unavailable = true;
  };

  it('omits the KMS Key Arn rather than failing the already-created resource', async () => {
    fabricate();
    const enriched = await enrich('AWS::KMS::Key', 'abcd-1234');
    expect(enriched['Arn']).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Not enriching AWS::KMS::Key Arn for abcd-1234: Cannot determine the AWS account id: .* the record heals on its next update\.$/
      )
    );
  });

  it('does NOT swallow a failure other than the unknown account', async () => {
    // Only `AccountIdUnavailableError` is the omit-with-reason case. Anything
    // else goes back to the enrichment site's own catch, and must not be
    // reported as the unknown-account omission.
    mockAccountInfo.otherFailure = new Error('unexpected failure');
    const enriched = await enrich('AWS::KMS::Key', 'abcd-1234');
    expect(enriched['Arn']).toBeUndefined();
    const messages = mockLoggerWarn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.startsWith('Not enriching'))).toBe(false);
  });

  it('still sets the KMS KeyId, which needs no account id', async () => {
    fabricate();
    const enriched = await enrich('AWS::KMS::Key', 'abcd-1234');
    expect(enriched['KeyId']).toBe('abcd-1234');
  });

  it('omits the ECR Repository Arn AND RepositoryUri', async () => {
    fabricate();
    const enriched = await enrich('AWS::ECR::Repository', 'my-repo');
    expect(enriched['Arn']).toBeUndefined();
    expect(enriched['RepositoryUri']).toBeUndefined();
  });

  // Both ECR attributes are separate call sites, so assert each warns under its
  // OWN name — otherwise collapsing them into one call still passes.
  it('names BOTH ECR attributes in its warnings, not just Arn', async () => {
    fabricate();
    await enrich('AWS::ECR::Repository', 'my-repo');
    const messages = mockLoggerWarn.mock.calls.map((call) => String(call[0]));
    expect(messages).toContainEqual(
      expect.stringContaining('Not enriching AWS::ECR::Repository Arn')
    );
    expect(messages).toContainEqual(
      expect.stringContaining('Not enriching AWS::ECR::Repository RepositoryUri')
    );
  });

  it('omits the Kinesis Stream Arn', async () => {
    fabricate();
    const enriched = await enrich('AWS::Kinesis::Stream', 'my-stream');
    expect(enriched['Arn']).toBeUndefined();
    // Warn asserted too: the production branch sits inside a swallowing
    // `catch`, so a bare toBeUndefined() also passes if the branch dies.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Not enriching AWS::Kinesis::Stream Arn')
    );
  });

  it('the ECR registry host follows the partition URL suffix (counter-case)', async () => {
    ccClientRegion.value = 'cn-north-1';
    mockAccountInfo.value = {
      partition: 'aws-cn',
      region: 'cn-north-1',
      // The CC client's region is what the enrichment now passes as the
      // override (issue #1746 review), so it must agree with the account info's
      // region or the ARN carries the client's.
      accountId: '123456789012',
    };
    const enriched = await enrich('AWS::ECR::Repository', 'my-repo');
    expect(enriched['RepositoryUri']).toBe(
      '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo'
    );
  });

  it('enriches the KMS Key Arn normally for a REAL account (counter-case)', async () => {
    const enriched = await enrich('AWS::KMS::Key', 'abcd-1234');
    expect(enriched['Arn']).toBe('arn:aws:kms:us-east-1:123456789012:key/abcd-1234');
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Not enriching')
    );
  });

  it('enriches the ECR pair normally for a REAL account (counter-case)', async () => {
    const enriched = await enrich('AWS::ECR::Repository', 'my-repo');
    expect(enriched['Arn']).toBe('arn:aws:ecr:us-east-1:123456789012:repository/my-repo');
    expect(enriched['RepositoryUri']).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo');
  });

  it('enriches the Kinesis Stream Arn normally for a REAL account (counter-case)', async () => {
    const enriched = await enrich('AWS::Kinesis::Stream', 'my-stream');
    expect(enriched['Arn']).toBe('arn:aws:kinesis:us-east-1:123456789012:stream/my-stream');
  });

  it('carries a NON-commercial partition into the built ARN (counter-case)', async () => {
    ccClientRegion.value = 'cn-north-1';
    mockAccountInfo.value = {
      partition: 'aws-cn',
      region: 'cn-north-1',
      accountId: '123456789012',
    };
    const enriched = await enrich('AWS::Kinesis::Stream', 'my-stream');
    expect(enriched['Arn']).toBe('arn:aws-cn:kinesis:cn-north-1:123456789012:stream/my-stream');
  });
});
