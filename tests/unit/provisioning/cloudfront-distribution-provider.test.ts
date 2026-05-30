import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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

    it('update with tag diff but missing ARN warns and skips (does not throw)', async () => {
      // Defensive guard against a hypothetical SDK regression where
      // GetDistribution stops returning ARN. A silent drop here would
      // exactly reintroduce the silent-drop this PR closes — assert
      // that the warn fires AND no Tag/Untag send is attempted.
      mockSend.mockResolvedValueOnce({
        ETag: 'E1',
        DistributionConfig: { CallerReference: 'orig', Enabled: true },
      });
      mockSend.mockResolvedValueOnce({}); // UpdateDistribution
      mockSend.mockResolvedValueOnce({
        Distribution: { Id: 'EDFDVBD6EXAMPLE', DomainName: 'd1.cloudfront.net' /* no ARN */ },
      });

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

      // GetConfig + Update + GetDistribution = 3 (no Tag/Untag, no throw)
      expect(mockSend).toHaveBeenCalledTimes(3);
      // The warn is the load-bearing user-visible signal — without it
      // the silent drop would silently reintroduce itself.
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('GetDistribution returned no ARN')
      );
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

    it('update tag-side failure is logged but does NOT propagate (UpdateDistribution succeeded)', async () => {
      // The deploy engine treats provider.update() failure as a need to
      // retry. Since UpdateDistribution already committed before the tag
      // call, an exception here would force an idempotent retry against
      // the same etag — noisy but not destructive. The provider chooses
      // warn-and-continue so the user sees the unapplied tag delta
      // without rolling the whole deploy step.
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

      const result = await provider.update(
        'MyDistribution',
        'EDFDVBD6EXAMPLE',
        'AWS::CloudFront::Distribution',
        {
          DistributionConfig: { Enabled: true },
          Tags: [{ Key: 'NewKey', Value: 'NewVal' }],
        },
        { DistributionConfig: { Enabled: true } }
      );

      // update() returns normally (no throw) and the result is intact —
      // wasReplaced=false, attributes carry the new domainName etc.
      expect(result.physicalId).toBe('EDFDVBD6EXAMPLE');
      expect(result.wasReplaced).toBe(false);
      // The warn surfaces the unapplied delta with the failure message
      // so the operator can investigate; this guards against a future
      // `catch {}` swallow regression.
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tag diff failed')
      );
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('AccessDeniedException')
      );
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
});
