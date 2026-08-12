import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockAccountInfo = vi.hoisted(() => ({
  value: {
    partition: 'aws',
    region: 'us-east-1',
    accountId: '123456789012',
  } as Record<string, unknown>,
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: vi.fn(), config: { region: 'us-east-1' } },
    cloudFormation: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () => Promise.resolve(mockAccountInfo.value),
}));

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
 * Issue #1730: `getAccountInfo` reports `fabricated: true` when the account id
 * is the hardcoded `123456789012` fallback rather than this deploy's real
 * account. An ARN built from it carries no wildcard, so `isPlaceholderArn`
 * (issue #1681) cannot catch it — the value is RECORDED into state and served
 * as the resource's `Fn::GetAtt` answer, indistinguishable from a real one.
 *
 * These sites must omit the attribute instead. The counter-cases are what make
 * the assertions meaningful: a non-fabricated answer must still enrich, and the
 * non-ARN attributes of the same branch must be untouched.
 */
describe('CloudControlProvider ARN enrichment refuses a fabricated account (issue #1730)', () => {
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
    provider = new CloudControlProvider();
    mockAccountInfo.value = {
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
    };
  });

  const fabricate = () => {
    mockAccountInfo.value = {
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
      fabricated: true,
    };
  };

  it('omits the KMS Key Arn rather than building one from a placeholder account', async () => {
    fabricate();
    const enriched = await enrich('AWS::KMS::Key', 'abcd-1234');
    expect(enriched['Arn']).toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Not enriching AWS::KMS::Key Arn')
    );
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
    mockAccountInfo.value = {
      partition: 'aws-cn',
      region: 'cn-north-1',
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
    mockAccountInfo.value = {
      partition: 'aws-cn',
      region: 'cn-north-1',
      accountId: '123456789012',
    };
    const enriched = await enrich('AWS::Kinesis::Stream', 'my-stream');
    expect(enriched['Arn']).toBe('arn:aws-cn:kinesis:cn-north-1:123456789012:stream/my-stream');
  });
});
