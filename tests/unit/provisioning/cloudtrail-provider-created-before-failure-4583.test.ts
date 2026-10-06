import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateTrailCommand, StartLoggingCommand } from '@aws-sdk/client-cloudtrail';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudtrail')>(
    '@aws-sdk/client-cloudtrail'
  );
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

// go-to-k/cdkd#4583: a failure after CreateTrail returned names the trail ARN
// (delete()'s physical id) for the failed-CREATE journal.
const TYPE = 'AWS::CloudTrail::Trail';
const ARN = 'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-trail';

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected create() to throw');
}

describe('CloudTrailProvider.create created-before-failure mark (#4583)', () => {
  let provider: CloudTrailProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new CloudTrailProvider();
  });

  it('marks the trail ARN when StartLogging fails after CreateTrail returned', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateTrailCommand) return { TrailARN: ARN };
      if (cmd instanceof StartLoggingCommand) throw new Error('AccessDenied');
      return {};
    });
    const err = await caught(
      provider.create('Trail', TYPE, { TrailName: 'my-trail', S3BucketName: 'b' })
    );
    expect(createdBeforeFailure(err, 'Trail', TYPE)).toBe(ARN);
  });

  it('does not mark when CreateTrail itself fails', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('exists'), { name: 'TrailAlreadyExistsException' })
    );
    const err = await caught(
      provider.create('Trail', TYPE, { TrailName: 'my-trail', S3BucketName: 'b' })
    );
    expect(createdBeforeFailure(err, 'Trail', TYPE)).toBeUndefined();
  });

  it('does not mark the pre-flight refusal of a missing S3BucketName', async () => {
    const err = await caught(provider.create('Trail', TYPE, { TrailName: 'my-trail' }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(err, 'Trail', TYPE)).toBeUndefined();
  });
});
