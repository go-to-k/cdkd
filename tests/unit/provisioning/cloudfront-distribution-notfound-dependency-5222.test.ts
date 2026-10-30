/**
 * go-to-k/cdkd#5222: a `*NotFound` class from the disable step names a
 * DEPENDENCY (a referenced function or key group), never the distribution.
 * The delete wrap carries the class, which satisfies update-in-place's bare
 * `NotFound` "already deleted" needle, so the wrap must be marked not gone:
 * the classifiers check `isMarkedNotGone` before any needle (#5228), and the
 * mark leaves retryability to the retry classifiers.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  EntityNotFound,
  NoSuchCachePolicy,
  TrustedKeyGroupDoesNotExist,
} from '@aws-sdk/client-cloudfront';

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

import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';

const TYPE = 'AWS::CloudFront::Distribution';

async function deleteWithDisableFailure(error: Error): Promise<Error> {
  // GetDistributionConfig: enabled, so the disable step runs.
  mockSend.mockResolvedValueOnce({
    ETag: 'E1',
    DistributionConfig: { CallerReference: 'ref', Enabled: true },
  });
  // UpdateDistribution (the disable) fails.
  mockSend.mockRejectedValueOnce(error);
  return new CloudFrontDistributionProvider()
    .delete('MyDist', 'EDFDVBD6EXAMPLE', TYPE)
    .then(
      () => {
        throw new Error('expected the delete to fail');
      },
      (e: unknown) => e as Error
    );
}

describe('CloudFront Distribution delete: a dependency NotFound is not "already deleted" (#5222)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks the wrap not gone when the disable step answers EntityNotFound', async () => {
    const failure = await deleteWithDisableFailure(
      new EntityNotFound({ message: 'The entity was not found.', $metadata: {} })
    );

    // The premise: the class reaches the message and carries the needle.
    expect(failure.message).toContain('Failed to delete CloudFront Distribution MyDist');
    expect(failure.message).toContain('EntityNotFound');
    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  for (const [label, error] of [
    [
      'NoSuchCachePolicy (SDK class)',
      new NoSuchCachePolicy({ message: 'The cache policy does not exist.', $metadata: {} }),
    ],
    [
      'TrustedKeyGroupDoesNotExist (SDK class)',
      new TrustedKeyGroupDoesNotExist({ message: 'The key group does not exist.', $metadata: {} }),
    ],
    // Unredacted shape (no `$fault` / HTTP status): AWS's "does not exist"
    // text stays in the message and satisfies the classifiers' needle.
    [
      'NoSuchOrigin (unredacted text)',
      Object.assign(new Error('The origin does not exist.'), { name: 'NoSuchOrigin' }),
    ],
  ] as const) {
    it(`marks the wrap not gone on a missing dependency: ${label}`, async () => {
      const failure = await deleteWithDisableFailure(error);

      expect(failure.message).toContain('Failed to delete CloudFront Distribution MyDist');
      expect(isMarkedNotGone(failure)).toBe(true);
      expect(isMarkedNonRetryable(failure)).toBe(false);
    });
  }

  it('leaves a non-NotFound failure retryable (negative control)', async () => {
    const failure = await deleteWithDisableFailure(
      Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    expect(failure.message).toContain('ThrottlingException');
    expect(isMarkedNotGone(failure)).toBe(false);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });
});
