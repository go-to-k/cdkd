import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateCloudFrontOriginAccessIdentityCommand } from '@aws-sdk/client-cloudfront';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { CloudFrontOAIProvider } from '../../../src/provisioning/providers/cloudfront-oai-provider.js';

const OAI_ID = 'E1ABCDEF123456';

describe('CloudFrontOAIProvider read-update round-trip', () => {
  let provider: CloudFrontOAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudFrontOAIProvider();
  });

  it('round-trip on empty Comment passes Comment: "" through to AWS (truthy-gate guard)', async () => {
    // Mechanical guard for the truthy-gate failure mode. See
    // docs/provider-development.md § 3b "Read-update round-trip test".
    //
    // If `update()` ever regresses to `if (config?.Comment) { ... }`,
    // an empty string would be silently dropped — and the
    // UpdateCloudFrontOriginAccessIdentity input would carry whatever
    // the prior code path left there. Round-tripping
    // `observedProperties` with `Comment: ''` (a legitimate value
    // that means "no comment") must reach AWS as `Comment: ''`, not
    // be coerced to undefined.

    // Get returns a non-empty AWS-current Comment so the round-trip
    // is exercising state="" overriding AWS=non-empty.
    mockSend.mockResolvedValueOnce({
      ETag: 'etag-abc',
      CloudFrontOriginAccessIdentity: {
        Id: OAI_ID,
        S3CanonicalUserId: 'canonical',
        CloudFrontOriginAccessIdentityConfig: {
          CallerReference: 'OAILogical',
          Comment: 'previous comment',
        },
      },
    });
    mockSend.mockResolvedValueOnce({}); // Update OK

    const observed = {
      CloudFrontOriginAccessIdentityConfig: {
        Comment: '',
      },
    };

    await provider.update(
      'OAILogical',
      OAI_ID,
      'AWS::CloudFront::CloudFrontOriginAccessIdentity',
      observed,
      observed
    );

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateCloudFrontOriginAccessIdentityCommand
    );
    expect(updateCalls).toHaveLength(1);

    const input = updateCalls[0]![0].input as {
      Id: string;
      IfMatch: string;
      CloudFrontOriginAccessIdentityConfig: { CallerReference: string; Comment: string };
    };
    expect(input.Id).toBe(OAI_ID);
    expect(input.IfMatch).toBe('etag-abc');
    expect(input.CloudFrontOriginAccessIdentityConfig.Comment).toBe('');
    // CallerReference is immutable; round-trip must preserve the
    // current AWS-side value rather than fall through to logicalId or
    // empty.
    expect(input.CloudFrontOriginAccessIdentityConfig.CallerReference).toBe('OAILogical');
  });

  it('round-trip on no-drift snapshot pushes the same Comment back (logical no-op)', async () => {
    // Stronger assertion mirroring `sns-topic-provider-roundtrip.test.ts`:
    // when state == AWS, the round-trip must NOT mutate the AWS-side
    // resource. OAI's update() always issues Get + Update by API
    // shape, so "no mutation" is structurally observable as "the
    // Update input's Comment matches the AWS-current Comment".
    mockSend.mockResolvedValueOnce({
      ETag: 'etag-abc',
      CloudFrontOriginAccessIdentity: {
        Id: OAI_ID,
        S3CanonicalUserId: 'canonical',
        CloudFrontOriginAccessIdentityConfig: {
          CallerReference: 'OAILogical',
          Comment: 'my OAI',
        },
      },
    });
    mockSend.mockResolvedValueOnce({}); // Update OK

    const observed = {
      CloudFrontOriginAccessIdentityConfig: {
        Comment: 'my OAI',
      },
    };

    await provider.update(
      'OAILogical',
      OAI_ID,
      'AWS::CloudFront::CloudFrontOriginAccessIdentity',
      observed,
      observed
    );

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateCloudFrontOriginAccessIdentityCommand
    );
    expect(updateCalls).toHaveLength(1);

    const input = updateCalls[0]![0].input as {
      CloudFrontOriginAccessIdentityConfig: { CallerReference: string; Comment: string };
    };
    expect(input.CloudFrontOriginAccessIdentityConfig.Comment).toBe('my OAI');
    expect(input.CloudFrontOriginAccessIdentityConfig.CallerReference).toBe('OAILogical');
  });

  it('declares CloudFrontOriginAccessIdentityConfig.CallerReference as drift-unknown', async () => {
    // Guard against the false-positive-drift bug: state.properties
    // (from the resolved template) carries CallerReference, but
    // readCurrentState intentionally does not surface it (cdkd always
    // sets it to logicalId at create time). Without this declaration
    // the comparator would fire drift on every clean run for any
    // stack whose template templated CallerReference. Field is
    // immutable in AWS post-create, so omitting it is also
    // semantically correct.
    expect(provider.getDriftUnknownPaths?.()).toEqual([
      'CloudFrontOriginAccessIdentityConfig.CallerReference',
    ]);
  });
});
