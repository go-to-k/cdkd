/**
 * Issue #2613: the three CloudFront providers run the same pre-update region
 * guard as every other SDK provider.
 *
 * CloudFront is a global service, but the providers' client is NOT pinned to
 * us-east-1: it is the shared `getAwsClients().cloudFront`, built in the
 * stack's region, which is also the region the state record carries. So a
 * stack outside us-east-1 must still UPDATE (the matching case below runs in
 * eu-west-1), and only a client whose region disagrees with the record is
 * refused, before any call is sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const mockRegion = vi.fn<() => Promise<string>>();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: mockRegion } },
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

import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { CloudFrontOACProvider } from '../../../src/provisioning/providers/cloudfront-oac-provider.js';
import { CloudFrontOAIProvider } from '../../../src/provisioning/providers/cloudfront-oai-provider.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

interface Subject {
  readonly name: string;
  readonly make: () => ResourceProvider;
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

const SUBJECTS: readonly Subject[] = [
  {
    name: 'CloudFrontDistributionProvider',
    make: () => new CloudFrontDistributionProvider(),
    type: 'AWS::CloudFront::Distribution',
    properties: { DistributionConfig: { Enabled: true, Comment: 'new' } },
  },
  {
    name: 'CloudFrontOACProvider',
    make: () => new CloudFrontOACProvider(),
    type: 'AWS::CloudFront::OriginAccessControl',
    properties: {
      OriginAccessControlConfig: {
        Name: 'MyStack-MyOac-ABC123',
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    },
  },
  {
    name: 'CloudFrontOAIProvider',
    make: () => new CloudFrontOAIProvider(),
    type: 'AWS::CloudFront::CloudFrontOriginAccessIdentity',
    properties: { CloudFrontOriginAccessIdentityConfig: { Comment: 'new' } },
  },
];

const PHYSICAL_ID = 'E1ABCDEF123456';
/** A sentinel the first AWS call rejects with, so "the update proceeded" is observable. */
const SENT = 'first AWS call reached';

describe.each(SUBJECTS)('$name update region guard (issue #2613)', (subject) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockRejectedValue(new Error(SENT));
  });

  it('refuses an update from a client in another region than the record, before any call', async () => {
    mockRegion.mockResolvedValue('us-east-1');
    await expect(
      subject
        .make()
        .update('MyRes', PHYSICAL_ID, subject.type, subject.properties, {}, {
          expectedRegion: 'eu-west-1',
        })
    ).rejects.toThrow(
      /Refusing to update MyRes .*region us-east-1 does not match stack state region eu-west-1\. This service has one global endpoint/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('proceeds for a stack outside us-east-1 whose client matches the record', async () => {
    // The case an exemption-by-pinning premise would get wrong: the client is
    // built in the stack's region, so a non-us-east-1 stack must not be refused.
    mockRegion.mockResolvedValue('eu-west-1');
    await expect(
      subject
        .make()
        .update('MyRes', PHYSICAL_ID, subject.type, subject.properties, {}, {
          expectedRegion: 'eu-west-1',
        })
    ).rejects.toThrow(SENT);
    expect(mockSend).toHaveBeenCalled();
  });

  it('does not read the client region when the record carries none', async () => {
    await expect(
      subject.make().update('MyRes', PHYSICAL_ID, subject.type, subject.properties, {}, {})
    ).rejects.toThrow(SENT);
    expect(mockRegion).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
  });
});
