import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { NoSuchDistribution } from '@aws-sdk/client-cloudfront';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

// Hoisted childLogger so individual tests can assert against it (warn
// behavior is load-bearing for the silent-drop-closure this PR ships —
// the test must verify the warn fires, not just that no exception
// propagates). `vi.hoisted` runs before `vi.mock`, which itself runs
// before the SUT import — so the same object instance the provider
// constructor sees via `getLogger().child()` is the one the test asserts on.
const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { importTagWalkTestHooks } from '../../../src/provisioning/import-tag-walk.js';

describe('CloudFrontDistributionProvider', () => {
  let provider: CloudFrontDistributionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudFrontDistributionProvider();
  });

  describe('create', () => {
    it('should create distribution and return Id as physicalId with DomainName attribute', async () => {
      // CreateDistributionCommand
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          DomainName: 'd111111abcdef8.cloudfront.net',
        },
      });
      // GetDistributionCommand (waitForDistributionStable)
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          Status: 'Deployed',
          DistributionConfig: { Enabled: true },
        },
      });

      const result = await provider.create(
        'MyDistribution',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: {
            DefaultCacheBehavior: {
              TargetOriginId: 'myS3Origin',
              ViewerProtocolPolicy: 'redirect-to-https',
            },
            Enabled: true,
          },
        }
      );

      expect(result.physicalId).toBe('EDFDVBD6EXAMPLE');
      expect(result.attributes).toEqual({
        Id: 'EDFDVBD6EXAMPLE',
        DistributionId: 'EDFDVBD6EXAMPLE',
        DomainName: 'd111111abcdef8.cloudfront.net',
      });
      expect(mockSend).toHaveBeenCalledTimes(2);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateDistributionCommand');
      expect(createCall.input.DistributionConfig.CallerReference).toBeDefined();
      expect(createCall.input.DistributionConfig.Enabled).toBe(true);
    });

    it('should convert DistributionConfig with Origins Items to SDK Quantity format', async () => {
      // CreateDistributionCommand
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          DomainName: 'd111111abcdef8.cloudfront.net',
        },
      });
      // GetDistributionCommand (waitForDistributionStable)
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          Status: 'Deployed',
          DistributionConfig: { Enabled: true },
        },
      });

      await provider.create('MyDistribution', 'AWS::CloudFront::Distribution', {
        DistributionConfig: {
          Origins: [
            {
              Id: 'myS3Origin',
              DomainName: 'mybucket.s3.amazonaws.com',
            },
          ],
          DefaultCacheBehavior: {
            TargetOriginId: 'myS3Origin',
            ViewerProtocolPolicy: 'redirect-to-https',
          },
          Enabled: true,
        },
      });

      const createCall = mockSend.mock.calls[0][0];
      const origins = createCall.input.DistributionConfig.Origins;
      expect(origins).toEqual({
        Quantity: 1,
        Items: [
          {
            Id: 'myS3Origin',
            DomainName: 'mybucket.s3.amazonaws.com',
          },
        ],
      });
    });

    it('should throw ProvisioningError on failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.create('MyDistribution', 'AWS::CloudFront::Distribution', {
          DistributionConfig: {
            Enabled: true,
          },
        })
      ).rejects.toThrow('Failed to create CloudFront Distribution MyDistribution');
    });
  });

  describe('update', () => {
    it('should get current config (ETag), then update with IfMatch', async () => {
      // GetDistributionConfigCommand
      mockSend.mockResolvedValueOnce({
        ETag: 'E2QWRUHAPOMQZL',
        DistributionConfig: {
          CallerReference: 'original-caller-ref',
          Enabled: true,
          DefaultCacheBehavior: {
            TargetOriginId: 'myS3Origin',
            ViewerProtocolPolicy: 'allow-all',
          },
        },
      });
      // UpdateDistributionCommand
      mockSend.mockResolvedValueOnce({});
      // GetDistributionCommand (for updated attributes)
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          DomainName: 'd111111abcdef8.cloudfront.net',
        },
      });

      const result = await provider.update(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: {
            DefaultCacheBehavior: {
              TargetOriginId: 'myS3Origin',
              ViewerProtocolPolicy: 'redirect-to-https',
            },
            Enabled: true,
          },
        },
        {
          DistributionConfig: {
            DefaultCacheBehavior: {
              TargetOriginId: 'myS3Origin',
              ViewerProtocolPolicy: 'allow-all',
            },
            Enabled: true,
          },
        }
      );

      expect(result.physicalId).toBe('EDFDVBD6EXAMPLE');
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({
        Id: 'EDFDVBD6EXAMPLE',
        DistributionId: 'EDFDVBD6EXAMPLE',
        DomainName: 'd111111abcdef8.cloudfront.net',
      });
      expect(mockSend).toHaveBeenCalledTimes(3);

      // Verify GetDistributionConfigCommand
      const getConfigCall = mockSend.mock.calls[0][0];
      expect(getConfigCall.constructor.name).toBe('GetDistributionConfigCommand');
      expect(getConfigCall.input.Id).toBe('EDFDVBD6EXAMPLE');

      // Verify UpdateDistributionCommand with IfMatch
      const updateCall = mockSend.mock.calls[1][0];
      expect(updateCall.constructor.name).toBe('UpdateDistributionCommand');
      expect(updateCall.input.Id).toBe('EDFDVBD6EXAMPLE');
      expect(updateCall.input.IfMatch).toBe('E2QWRUHAPOMQZL');
      // CallerReference should be preserved from the current config
      expect(updateCall.input.DistributionConfig.CallerReference).toBe('original-caller-ref');
    });
  });

  describe('delete', () => {
    it('should disable first if enabled, then delete with IfMatch', async () => {
      // GetDistributionConfigCommand (initial)
      mockSend.mockResolvedValueOnce({
        ETag: 'E2QWRUHAPOMQZL',
        DistributionConfig: {
          CallerReference: 'original-caller-ref',
          Enabled: true,
        },
      });
      // UpdateDistributionCommand (disable)
      mockSend.mockResolvedValueOnce({
        ETag: 'E3NEWETAG',
      });
      // GetDistributionCommand (wait for stable: Status=Deployed AND Enabled=false)
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          Status: 'Deployed',
          DistributionConfig: { Enabled: false },
        },
      });
      // GetDistributionConfigCommand (re-fetch ETag after waiting)
      mockSend.mockResolvedValueOnce({
        ETag: 'E4FINALETAG',
        DistributionConfig: {
          CallerReference: 'original-caller-ref',
          Enabled: false,
        },
      });
      // DeleteDistributionCommand
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution'
      );

      expect(mockSend).toHaveBeenCalledTimes(5);

      // Verify initial GetDistributionConfigCommand
      const getConfigCall = mockSend.mock.calls[0][0];
      expect(getConfigCall.constructor.name).toBe('GetDistributionConfigCommand');
      expect(getConfigCall.input.Id).toBe('EDFDVBD6EXAMPLE');

      // Verify UpdateDistributionCommand (disable)
      const updateCall = mockSend.mock.calls[1][0];
      expect(updateCall.constructor.name).toBe('UpdateDistributionCommand');
      expect(updateCall.input.Id).toBe('EDFDVBD6EXAMPLE');
      expect(updateCall.input.IfMatch).toBe('E2QWRUHAPOMQZL');
      expect(updateCall.input.DistributionConfig.Enabled).toBe(false);

      // Verify DeleteDistributionCommand with final ETag
      const deleteCall = mockSend.mock.calls[4][0];
      expect(deleteCall.constructor.name).toBe('DeleteDistributionCommand');
      expect(deleteCall.input.Id).toBe('EDFDVBD6EXAMPLE');
      expect(deleteCall.input.IfMatch).toBe('E4FINALETAG');
    });

    it('should keep waiting when GetDistribution still reports Enabled=true after disable (eventual consistency)', async () => {
      // Speed up the test: cap the wait loop with a fake timer for the sleeps.
      // We don't actually need timers here because each polling round only sleeps
      // when the stable condition is not met; we satisfy it on the second poll.
      vi.useFakeTimers();

      try {
        // GetDistributionConfigCommand (initial)
        mockSend.mockResolvedValueOnce({
          ETag: 'E2QWRUHAPOMQZL',
          DistributionConfig: {
            CallerReference: 'original-caller-ref',
            Enabled: true,
          },
        });
        // UpdateDistributionCommand (disable)
        mockSend.mockResolvedValueOnce({
          ETag: 'E3NEWETAG',
        });
        // GetDistributionCommand (1st poll: stale read - still Enabled=true)
        mockSend.mockResolvedValueOnce({
          Distribution: {
            Id: 'EDFDVBD6EXAMPLE',
            Status: 'Deployed',
            DistributionConfig: { Enabled: true },
          },
        });
        // GetDistributionCommand (2nd poll: still propagating, InProgress)
        mockSend.mockResolvedValueOnce({
          Distribution: {
            Id: 'EDFDVBD6EXAMPLE',
            Status: 'InProgress',
            DistributionConfig: { Enabled: false },
          },
        });
        // GetDistributionCommand (3rd poll: stable Disabled+Deployed)
        mockSend.mockResolvedValueOnce({
          Distribution: {
            Id: 'EDFDVBD6EXAMPLE',
            Status: 'Deployed',
            DistributionConfig: { Enabled: false },
          },
        });
        // GetDistributionConfigCommand (re-fetch ETag after waiting)
        mockSend.mockResolvedValueOnce({
          ETag: 'E4FINALETAG',
          DistributionConfig: {
            CallerReference: 'original-caller-ref',
            Enabled: false,
          },
        });
        // DeleteDistributionCommand
        mockSend.mockResolvedValueOnce({});

        const deletePromise = provider.delete(
          'MyDistribution',
          'EDFDVBD6EXAMPLE',
          'AWS::CloudFront::Distribution'
        );

        // Advance fake timers far enough to flush all the sleep loops
        // (5s + 7.5s + 11.25s = ~24s of polling backoff).
        await vi.advanceTimersByTimeAsync(60_000);
        await deletePromise;

        // The wait loop must NOT exit early on the first stale Deployed read.
        // We expect: GetConfig + Update + 3xGet + GetConfig + Delete = 7 calls.
        expect(mockSend).toHaveBeenCalledTimes(7);

        const deleteCall = mockSend.mock.calls[6][0];
        expect(deleteCall.constructor.name).toBe('DeleteDistributionCommand');
        expect(deleteCall.input.IfMatch).toBe('E4FINALETAG');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should handle NoSuchDistribution gracefully', async () => {
      // GetDistributionConfigCommand throws NoSuchDistribution
      mockSend.mockRejectedValueOnce(
        new NoSuchDistribution({
          $metadata: {},
          message: 'The specified distribution does not exist.',
        })
      );

      await provider.delete(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('Tags backfill (#609)', () => {
    it('create with Tags routes through CreateDistributionWithTagsCommand', async () => {
      // CreateDistributionWithTagsCommand
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          DomainName: 'd111111abcdef8.cloudfront.net',
        },
      });
      // GetDistributionCommand (waitForDistributionStable)
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          Status: 'Deployed',
          DistributionConfig: { Enabled: true },
        },
      });

      await provider.create('MyDistribution', 'AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: {
            TargetOriginId: 'myS3Origin',
            ViewerProtocolPolicy: 'redirect-to-https',
          },
          Enabled: true,
        },
        Tags: [
          { Key: 'Owner', Value: 'team-x' },
          { Key: 'Env', Value: 'prod' },
        ],
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateDistributionWithTagsCommand');
      expect(createCall.input.DistributionConfigWithTags.Tags.Items).toEqual([
        { Key: 'Owner', Value: 'team-x' },
        { Key: 'Env', Value: 'prod' },
      ]);
      expect(
        createCall.input.DistributionConfigWithTags.DistributionConfig.CallerReference
      ).toBeDefined();
    });

    it('create without Tags routes through plain CreateDistributionCommand', async () => {
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net' },
      });
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          Status: 'Deployed',
          DistributionConfig: { Enabled: true },
        },
      });

      await provider.create('MyDistribution', 'AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: {
            TargetOriginId: 'myS3Origin',
            ViewerProtocolPolicy: 'redirect-to-https',
          },
          Enabled: true,
        },
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateDistributionCommand');
    });

    it('create with empty Tags array routes through plain CreateDistributionCommand', async () => {
      // An empty `Tags: []` from CFn is semantically identical to "no tags";
      // routing through the tags-enabled command class would still hit the
      // same control plane for no benefit, so we collapse to the simpler call.
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net' },
      });
      mockSend.mockResolvedValueOnce({
        Distribution: {
          Id: 'EDFDVBD6EXAMPLE',
          Status: 'Deployed',
          DistributionConfig: { Enabled: true },
        },
      });

      await provider.create('MyDistribution', 'AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: {
            TargetOriginId: 'myS3Origin',
            ViewerProtocolPolicy: 'redirect-to-https',
          },
          Enabled: true,
        },
        Tags: [],
      });

      expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateDistributionCommand');
    });

    it('update adds new tags via TagResource', async () => {
      const arn = 'arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE';
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      }); // GetDistributionConfig
      mockSend.mockResolvedValueOnce({}); // UpdateDistribution
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net', ARN: arn },
      }); // GetDistribution
      mockSend.mockResolvedValueOnce({}); // TagResource

      await provider.update(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'NewKey', Value: 'NewVal' }],
        },
        {
          DistributionConfig: { Enabled: true },
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(4);
      const tagCall = mockSend.mock.calls[3][0];
      expect(tagCall.constructor.name).toBe('TagResourceCommand');
      expect(tagCall.input.Resource).toBe(arn);
      expect(tagCall.input.Tags.Items).toEqual([{ Key: 'NewKey', Value: 'NewVal' }]);
    });

    it('update removes dropped tags via UntagResource', async () => {
      const arn = 'arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE';
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateDistribution
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net', ARN: arn },
      });
      mockSend.mockResolvedValueOnce({}); // UntagResource

      await provider.update(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: { Enabled: true },
          Tags: [],
        },
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'Stale', Value: 'v' }],
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(4);
      const untagCall = mockSend.mock.calls[3][0];
      expect(untagCall.constructor.name).toBe('UntagResourceCommand');
      expect(untagCall.input.Resource).toBe(arn);
      expect(untagCall.input.TagKeys.Items).toEqual(['Stale']);
    });

    it('update value-change on same key issues only TagResource (no Untag)', async () => {
      const arn = 'arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE';
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateDistribution
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net', ARN: arn },
      });
      mockSend.mockResolvedValueOnce({}); // TagResource

      await provider.update(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'Env', Value: 'prod' }],
        },
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'Env', Value: 'dev' }],
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(4);
      expect(mockSend.mock.calls[3][0].constructor.name).toBe('TagResourceCommand');
      expect(mockSend.mock.calls[3][0].input.Tags.Items).toEqual([
        { Key: 'Env', Value: 'prod' },
      ]);
    });

    it('update with unchanged tags issues neither Tag nor Untag', async () => {
      const arn = 'arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE';
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      });
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net', ARN: arn },
      });

      await provider.update(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'Env', Value: 'prod' }],
        },
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'Env', Value: 'prod' }],
        }
      );

      // GetConfig + Update + GetDistribution = 3 (no Tag/Untag)
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('update with tag diff but missing ARN THROWS (issue #740 — refuses to silently drop the tag update)', async () => {
      // Defensive guard against a hypothetical SDK regression where
      // GetDistribution stops returning ARN. Pre-#740 this was a warn-
      // and-skip (silent tag drop); now we throw so state is not written
      // and the next deploy retries — surfaces the SDK regression to the
      // operator instead of silently accruing AWS-side tag drift.
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateDistribution
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net' /* no ARN */ },
      });

      await expect(
        provider.update(
          'MyDistribution',
          'EDFDVBD6EXAMPLE',
          'AWS::CloudFront::Distribution',
          {
            DistributionConfig: { Enabled: true },
            Tags: [{ Key: 'NewKey', Value: 'NewVal' }],
          },
          {
            DistributionConfig: { Enabled: true },
          }
        )
      ).rejects.toThrow(/GetDistribution returned no ARN/);

      // GetConfig + Update + GetDistribution = 3 sends fired before throw.
      // No Tag/Untag attempted (we throw before reaching the AWS tag call).
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('update with NO tag diff and no ARN does NOT warn (no-op skip is silent)', async () => {
      // computeTagDiff short-circuits before touching ARN, so a no-op
      // update never logs the "skipping tag diff" warn — that warn is
      // reserved for the load-bearing case of a missing-ARN + non-empty
      // delta (where the silent drop would actually lose user intent).
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      });
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net' /* no ARN */ },
      });

      await provider.update(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution',
        { DistributionConfig: { Enabled: true } },
        { DistributionConfig: { Enabled: true } }
      );

      expect(mockSend).toHaveBeenCalledTimes(3);
      // Guards against an "always warn" refactor: a true no-op must stay
      // quiet, otherwise routine deploys spam the log with false alarms.
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it('update tag-side failure THROWS (issue #740 — was warn-swallow, now propagates as ProvisioningError)', async () => {
      // Pre-#740: warn-and-continue let the deploy engine record the new
      // properties.Tags into state as if applied. AWS-side tags then
      // stayed stale FOREVER (next deploy sees no diff → no retry).
      //
      // Post-#740: throw a ProvisioningError so state is NOT written.
      // The next deploy compares the still-old state Tags vs new template
      // Tags → tag-diff re-fires. UpdateDistribution will re-issue against
      // the now-current config but AWS accepts that as a no-op idempotently.
      //
      // The trade-off (extra UpdateDistribution noise on retry) is much
      // cheaper than silent tag drift.
      const arn = 'arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE';
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateDistribution
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net', ARN: arn },
      });
      mockSend.mockRejectedValueOnce(new Error('AccessDeniedException: tag policy denies')); // TagResource

      await expect(
        provider.update(
          'MyDistribution',
          'EDFDVBD6EXAMPLE',
          'AWS::CloudFront::Distribution',
          {
            DistributionConfig: { Enabled: true },
            Tags: [{ Key: 'NewKey', Value: 'NewVal' }],
          },
          { DistributionConfig: { Enabled: true } }
        )
      ).rejects.toThrow(/tag diff failed.*AccessDeniedException/s);

      // GetConfig + Update + GetDistribution + TagResource = 4 sends attempted.
      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    it('update mixed adds + removes issues Untag then Tag in that order', async () => {
      const arn = 'arn:aws:cloudfront::123456789012:distribution/EDFDVBD6EXAMPLE';
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      });
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net', ARN: arn },
      });
      mockSend.mockResolvedValueOnce({}); // UntagResource
      mockSend.mockResolvedValueOnce({}); // TagResource

      await provider.update(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'Env', Value: 'prod' }],
        },
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'Owner', Value: 'team-x' }],
        }
      );

      expect(mockSend).toHaveBeenCalledTimes(5);
      expect(mockSend.mock.calls[3][0].constructor.name).toBe('UntagResourceCommand');
      expect(mockSend.mock.calls[3][0].input.TagKeys.Items).toEqual(['Owner']);
      expect(mockSend.mock.calls[4][0].constructor.name).toBe('TagResourceCommand');
      expect(mockSend.mock.calls[4][0].input.Tags.Items).toEqual([{ Key: 'Env', Value: 'prod' }]);
    });
  });

  describe('readCurrentState', () => {
    it('returns undefined for a non-CloudFront resource type', async () => {
      const result = await provider.readCurrentState(
        'EDFDVBD6EXAMPLE',
        'MyDistribution',
        'AWS::S3::Bucket'
      );
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns undefined when the distribution no longer exists', async () => {
      mockSend.mockRejectedValueOnce(
        new NoSuchDistribution({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        'EDFDVBD6EXAMPLE',
        'MyDistribution',
        'AWS::CloudFront::Distribution'
      );
      expect(result).toBeUndefined();
    });

    it('inverts convertToSdkFormat: drops Quantity wrappers + CallerReference, surfaces tags', async () => {
      // GetDistributionConfigCommand — AWS-shape DistributionConfig with
      // the { Quantity, Items } wrappers cdkd's create path injects.
      mockSend.mockResolvedValueOnce({
        ETag: 'E2QWRUHAPOMQZL',
        DistributionConfig: {
          CallerReference: '1700000000000-MyDistribution-abc123',
          Comment: 'integ',
          Enabled: true,
          DefaultRootObject: 'index.html',
          Aliases: { Quantity: 1, Items: ['cdn.example.com'] },
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: 'myS3Origin',
                DomainName: 'bucket.s3.amazonaws.com',
                CustomHeaders: {
                  Quantity: 1,
                  Items: [{ HeaderName: 'X-From', HeaderValue: 'cdn' }],
                },
                CustomOriginConfig: {
                  HTTPPort: 80,
                  HTTPSPort: 443,
                  OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] },
                },
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: 'myS3Origin',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: {
              Quantity: 2,
              Items: ['GET', 'HEAD'],
              CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] },
            },
          },
          CacheBehaviors: {
            Quantity: 1,
            Items: [
              {
                PathPattern: '/api/*',
                TargetOriginId: 'myS3Origin',
                ViewerProtocolPolicy: 'https-only',
                ForwardedValues: {
                  QueryString: true,
                  Headers: { Quantity: 1, Items: ['Authorization'] },
                },
              },
            ],
          },
        },
      });
      // GetDistributionCommand (ARN for tag lookup)
      mockSend.mockResolvedValueOnce({
        Distribution: { ARN: 'arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE' },
      });
      // ListTagsForResourceCommand — includes an aws:cdk:* tag that must
      // be filtered out (CDK auto-injects it; comparing it fires false drift).
      mockSend.mockResolvedValueOnce({
        Tags: {
          Items: [
            { Key: 'Env', Value: 'prod' },
            { Key: 'aws:cdk:path', Value: 'Stack/Distribution/Resource' },
          ],
        },
      });

      const result = await provider.readCurrentState(
        'EDFDVBD6EXAMPLE',
        'MyDistribution',
        'AWS::CloudFront::Distribution'
      );

      expect(result).toBeDefined();
      const cfg = result!['DistributionConfig'] as Record<string, unknown>;

      // CallerReference dropped.
      expect(cfg['CallerReference']).toBeUndefined();
      // Top-level Quantity + Items → bare arrays.
      expect(cfg['Aliases']).toEqual(['cdn.example.com']);
      expect(Array.isArray(cfg['Origins'])).toBe(true);
      expect(Array.isArray(cfg['CacheBehaviors'])).toBe(true);

      // Nested origin fields unwrapped.
      const origin = (cfg['Origins'] as Record<string, unknown>[])[0]!;
      expect(origin['CustomHeaders']).toEqual([{ HeaderName: 'X-From', HeaderValue: 'cdn' }]);
      const customOrigin = origin['CustomOriginConfig'] as Record<string, unknown>;
      expect(customOrigin['OriginSslProtocols']).toEqual(['TLSv1.2']);

      // DefaultCacheBehavior: AllowedMethods unwraps to a bare array, and the
      // AWS-nested CachedMethods is hoisted to a sibling bare array (matching
      // the CFn shape CDK synthesizes).
      const dcb = cfg['DefaultCacheBehavior'] as Record<string, unknown>;
      expect(dcb['AllowedMethods']).toEqual(['GET', 'HEAD']);
      expect(dcb['CachedMethods']).toEqual(['GET', 'HEAD']);

      // CacheBehaviors[].ForwardedValues.Headers unwrapped.
      const cb = (cfg['CacheBehaviors'] as Record<string, unknown>[])[0]!;
      const fv = cb['ForwardedValues'] as Record<string, unknown>;
      expect(fv['Headers']).toEqual(['Authorization']);

      // Tags surfaced, aws:cdk:* filtered out.
      expect(result!['Tags']).toEqual([{ Key: 'Env', Value: 'prod' }]);
    });

    it('unwraps the deeper cache-behavior {Quantity,Items} fields (LambdaFunctionAssociations + 3-level ForwardedValues.Cookies.WhitelistedNames + QueryStringCacheKeys)', async () => {
      // These fields are in CACHE_BEHAVIOR_QUANTITY_FIELDS but not covered by
      // the main round-trip above; the 3-level Cookies.WhitelistedNames path
      // exercises unwrapQuantityAtPath's multi-level recursion specifically.
      mockSend.mockResolvedValueOnce({
        DistributionConfig: {
          CallerReference: 'ref',
          Enabled: true,
          Comment: '',
          DefaultCacheBehavior: {
            TargetOriginId: 'o',
            ViewerProtocolPolicy: 'https-only',
            LambdaFunctionAssociations: {
              Quantity: 1,
              Items: [{ EventType: 'origin-request', LambdaFunctionARN: 'arn:aws:lambda:...' }],
            },
            FunctionAssociations: { Quantity: 0, Items: [] },
            ForwardedValues: {
              QueryString: true,
              QueryStringCacheKeys: { Quantity: 1, Items: ['lang'] },
              Cookies: {
                Forward: 'whitelist',
                WhitelistedNames: { Quantity: 2, Items: ['sid', 'theme'] },
              },
            },
          },
        },
      });
      mockSend.mockResolvedValueOnce({
        Distribution: { ARN: 'arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE' },
      });
      mockSend.mockResolvedValueOnce({ Tags: { Items: [] } });

      const result = await provider.readCurrentState(
        'EDFDVBD6EXAMPLE',
        'MyDistribution',
        'AWS::CloudFront::Distribution'
      );

      const dcb = (result!['DistributionConfig'] as Record<string, unknown>)[
        'DefaultCacheBehavior'
      ] as Record<string, unknown>;
      expect(dcb['LambdaFunctionAssociations']).toEqual([
        { EventType: 'origin-request', LambdaFunctionARN: 'arn:aws:lambda:...' },
      ]);
      expect(dcb['FunctionAssociations']).toEqual([]);
      const fv = dcb['ForwardedValues'] as Record<string, unknown>;
      expect(fv['QueryStringCacheKeys']).toEqual(['lang']);
      // The 3-level nested path: ForwardedValues.Cookies.WhitelistedNames.
      const cookies = fv['Cookies'] as Record<string, unknown>;
      expect(cookies['WhitelistedNames']).toEqual(['sid', 'theme']);
      expect(cookies['Forward']).toBe('whitelist');
    });

    it('returns DistributionConfig without Tags key when no user tags exist', async () => {
      mockSend.mockResolvedValueOnce({
        DistributionConfig: { CallerReference: 'ref', Enabled: true, Comment: '' },
      });
      mockSend.mockResolvedValueOnce({
        Distribution: { ARN: 'arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE' },
      });
      mockSend.mockResolvedValueOnce({ Tags: { Items: [] } });

      const result = await provider.readCurrentState(
        'EDFDVBD6EXAMPLE',
        'MyDistribution',
        'AWS::CloudFront::Distribution'
      );
      expect(result).toBeDefined();
      expect(result!['Tags']).toBeUndefined();
      expect(result!['DistributionConfig']).toEqual({ Enabled: true, Comment: '' });
    });

    it('passes OriginGroups through UNCHANGED — it is {Quantity,Items} in both CFn and the SDK (#873)', async () => {
      // The CFn DistributionConfig.OriginGroups property (+ its inner Members /
      // FailoverCriteria.StatusCodes) is ITSELF a { Quantity, Items } object, so
      // it must NOT be unwrapped like Origins/CacheBehaviors/Aliases — the
      // template and the AWS read-back are identical and compare equal.
      const originGroups = {
        Quantity: 1,
        Items: [
          {
            Id: 'group1',
            FailoverCriteria: { StatusCodes: { Quantity: 4, Items: [500, 502, 503, 504] } },
            Members: {
              Quantity: 2,
              Items: [{ OriginId: 'origin1' }, { OriginId: 'origin2' }],
            },
          },
        ],
      };
      mockSend.mockResolvedValueOnce({
        DistributionConfig: { CallerReference: 'ref', Enabled: true, Comment: '', OriginGroups: originGroups },
      });
      mockSend.mockResolvedValueOnce({
        Distribution: { ARN: 'arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE' },
      });
      mockSend.mockResolvedValueOnce({ Tags: { Items: [] } });

      const result = await provider.readCurrentState(
        'EDFDVBD6EXAMPLE',
        'MyDistribution',
        'AWS::CloudFront::Distribution'
      );

      // OriginGroups is byte-equal to the input { Quantity, Items } shape — not
      // unwrapped to a bare array (which is what caused the #873 phantom drift).
      expect((result!['DistributionConfig'] as Record<string, unknown>)['OriginGroups']).toEqual(
        originGroups
      );
    });

    it('still returns DistributionConfig when the tag read fails', async () => {
      mockSend.mockResolvedValueOnce({
        DistributionConfig: { CallerReference: 'ref', Enabled: true },
      });
      // GetDistributionCommand fails — tag read is best-effort.
      mockSend.mockRejectedValueOnce(new Error('throttled'));

      const result = await provider.readCurrentState(
        'EDFDVBD6EXAMPLE',
        'MyDistribution',
        'AWS::CloudFront::Distribution'
      );
      expect(result).toBeDefined();
      expect(result!['DistributionConfig']).toEqual({ Enabled: true });
      expect(result!['Tags']).toBeUndefined();
    });

    it('readCurrentState output is byte-stable across two reads (no phantom drift)', async () => {
      const awsConfig = {
        CallerReference: '1700000000000-MyDistribution-abc123',
        Comment: 'integ',
        Enabled: true,
        Origins: {
          Quantity: 1,
          Items: [{ Id: 'o1', DomainName: 'b.s3.amazonaws.com' }],
        },
        DefaultCacheBehavior: {
          TargetOriginId: 'o1',
          ViewerProtocolPolicy: 'redirect-to-https',
        },
      };
      const read = async () => {
        mockSend.mockResolvedValueOnce({ DistributionConfig: { ...awsConfig } });
        mockSend.mockResolvedValueOnce({
          Distribution: { ARN: 'arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE' },
        });
        mockSend.mockResolvedValueOnce({ Tags: { Items: [{ Key: 'Env', Value: 'prod' }] } });
        return provider.readCurrentState(
          'EDFDVBD6EXAMPLE',
          'MyDistribution',
          'AWS::CloudFront::Distribution'
        );
      };
      const first = await read();
      const second = await read();
      expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    });
  });

  describe('getDriftUnknownPaths', () => {
    it('excludes CallerReference + Logging.Bucket for CloudFront::Distribution (OriginGroups is now drift-checked, #873)', () => {
      expect(provider.getDriftUnknownPaths('AWS::CloudFront::Distribution')).toEqual([
        'DistributionConfig.CallerReference',
        'DistributionConfig.Logging.Bucket',
      ]);
    });

    it('returns an empty list for unrelated resource types', () => {
      expect(provider.getDriftUnknownPaths('AWS::S3::Bucket')).toEqual([]);
    });
  });

  // Issue #1091 batch 3: the tag walk is an N+1 ListTagsForResource burst
  // routed through the shared importTagWalk helper: a throttled per-candidate
  // tag read is retried with backoff instead of aborting the whole import,
  // while a non-throttling error still surfaces immediately. The CloudFront
  // pagination shape (IsTruncated gating NextMarker) folds into the walk's
  // nextMarker.
  describe('import', () => {
    const CDK_PATH = 'MyStack/MyDistribution/Resource';
    const ARN_1 = 'arn:aws:cloudfront::123456789012:distribution/E1AAAAAAAAAAAA';
    const ARN_2 = 'arn:aws:cloudfront::123456789012:distribution/E2BBBBBBBBBBBB';

    beforeEach(() => {
      // Drop once-queued responses leaked by earlier tests: clearAllMocks()
      // clears calls but NOT unconsumed mockResolvedValueOnce entries.
      mockSend.mockReset();
      // Skip the walk's real throttle backoff waits.
      importTagWalkTestHooks.sleep = async () => {};
    });
    afterEach(() => {
      importTagWalkTestHooks.sleep = undefined;
    });

    const importInput = () => ({
      logicalId: 'MyDistribution',
      resourceType: 'AWS::CloudFront::Distribution',
      cdkPath: CDK_PATH,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
    });

    it('paginates across IsTruncated/NextMarker and matches the tagged distribution', async () => {
      mockSend
        // Page 1: one candidate whose tags do not match; IsTruncated with a
        // NextMarker continues the walk.
        .mockResolvedValueOnce({
          DistributionList: {
            Items: [{ Id: 'E1AAAAAAAAAAAA', ARN: ARN_1 }],
            IsTruncated: true,
            NextMarker: 'marker-1',
          },
        })
        .mockResolvedValueOnce({
          Tags: { Items: [{ Key: 'aws:cdk:path', Value: 'OtherStack/Other/Resource' }] },
        })
        // Page 2: the match. IsTruncated false ends the walk even though a
        // NextMarker is present (CloudFront's pagination contract).
        .mockResolvedValueOnce({
          DistributionList: {
            Items: [{ Id: 'E2BBBBBBBBBBBB', ARN: ARN_2 }],
            IsTruncated: false,
            NextMarker: 'marker-2',
          },
        })
        .mockResolvedValueOnce({
          Tags: { Items: [{ Key: 'aws:cdk:path', Value: CDK_PATH }] },
        });

      const result = await provider.import(importInput());

      expect(result).toEqual({ physicalId: 'E2BBBBBBBBBBBB', attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(4);
      // The second list call carries the first page's NextMarker.
      const secondList = mockSend.mock.calls[2][0];
      expect(secondList.constructor.name).toBe('ListDistributionsCommand');
      expect(secondList.input.Marker).toBe('marker-1');
    });

    it('retries a throttled ListTagsForResource mid-walk and still finds the match', async () => {
      const throttled = new Error('Rate exceeded') as Error & {
        $metadata: { httpStatusCode: number };
      };
      throttled.name = 'ThrottlingException';
      throttled.$metadata = { httpStatusCode: 400 };

      mockSend
        .mockResolvedValueOnce({
          DistributionList: {
            Items: [{ Id: 'E2BBBBBBBBBBBB', ARN: ARN_2 }],
            IsTruncated: false,
          },
        })
        .mockRejectedValueOnce(throttled)
        .mockResolvedValueOnce({
          Tags: { Items: [{ Key: 'aws:cdk:path', Value: CDK_PATH }] },
        });

      const result = await provider.import(importInput());

      expect(result).toEqual({ physicalId: 'E2BBBBBBBBBBBB', attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('does not retry a non-throttling error during the walk', async () => {
      const denied = new Error(
        'User is not authorized to perform cloudfront:ListTagsForResource'
      );
      denied.name = 'AccessDeniedException';

      mockSend
        .mockResolvedValueOnce({
          DistributionList: {
            Items: [{ Id: 'E2BBBBBBBBBBBB', ARN: ARN_2 }],
            IsTruncated: false,
          },
        })
        .mockRejectedValueOnce(denied);

      await expect(provider.import(importInput())).rejects.toThrow(/not authorized/);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });
});
