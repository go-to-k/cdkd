import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::SQS::QueuePolicy';
const Q1 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-1';
const Q2 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-2';
const Q3 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-3';
const PROPS = {
  Queues: [Q1, Q2, Q3],
  PolicyDocument: { Version: '2012-10-17', Statement: [] },
};

async function createError(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new SQSQueuePolicyProvider().create('QueuePolicy', TYPE, props).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

function clearedUrls(): unknown[] {
  return mockSend.mock.calls.map((c) => (c[0] as { input: { QueueUrl?: unknown } }).input.QueueUrl);
}

describe('SQSQueuePolicyProvider create marks exactly the written queues (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the comma-joined URLs written before a later SetQueueAttributes fails', async () => {
    mockSend.mockResolvedValueOnce({}); // Q1
    mockSend.mockResolvedValueOnce({}); // Q2
    mockSend.mockRejectedValueOnce(new Error('AccessDenied: not authorized')); // Q3
    const error = await createError();
    expect(createdBeforeFailure(error, 'QueuePolicy', TYPE)).toBe(`${Q1},${Q2}`);
  });

  it('marks only the first URL when the second SetQueueAttributes fails', async () => {
    mockSend.mockResolvedValueOnce({}); // Q1
    mockSend.mockRejectedValueOnce(new Error('AccessDenied: not authorized')); // Q2
    const error = await createError();
    expect(createdBeforeFailure(error, 'QueuePolicy', TYPE)).toBe(Q1);
  });

  it('leaves no mark when the first SetQueueAttributes fails', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('The specified queue does not exist'), {
        name: 'QueueDoesNotExist',
      })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'QueuePolicy', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight missing-Queues refusal', async () => {
    const error = await createError({ PolicyDocument: {} });
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'QueuePolicy', TYPE)).toBeUndefined();
  });

  it('still returns the first queue URL as the physical id on success', async () => {
    mockSend.mockResolvedValue({});
    const result = await new SQSQueuePolicyProvider().create('QueuePolicy', TYPE, PROPS);
    expect(result.physicalId).toBe(Q1);
  });
});

describe('SQSQueuePolicyProvider delete clears exactly the queues its id names (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('clears each URL of a comma-joined id and never a queue the id does not name', async () => {
    mockSend.mockResolvedValue({});
    // The attempted properties name Q3 too; delete must not read them.
    await new SQSQueuePolicyProvider().delete('QueuePolicy', `${Q1},${Q2}`, TYPE, PROPS);
    expect(clearedUrls()).toEqual([Q1, Q2]);
    for (const c of mockSend.mock.calls) {
      expect((c[0] as { input: { Attributes?: unknown } }).input.Attributes).toEqual({
        Policy: '',
      });
    }
  });

  it('skips a gone queue in a comma-joined id and still clears the rest', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('The specified queue does not exist'), {
        name: 'QueueDoesNotExist',
      })
    );
    mockSend.mockResolvedValueOnce({});
    await new SQSQueuePolicyProvider().delete('QueuePolicy', `${Q1},${Q2}`, TYPE, PROPS);
    expect(clearedUrls()).toEqual([Q1, Q2]);
  });

  it('clears only the single URL of a state id, whatever Queues lists', async () => {
    mockSend.mockResolvedValue({});
    await new SQSQueuePolicyProvider().delete('QueuePolicy', Q1, TYPE, PROPS);
    expect(clearedUrls()).toEqual([Q1]);
  });

  it('treats a gone queue under a single URL id as already deleted', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('The specified queue does not exist'), {
        name: 'QueueDoesNotExist',
      })
    );
    await expect(
      new SQSQueuePolicyProvider().delete('QueuePolicy', Q1, TYPE)
    ).resolves.toBeUndefined();
    expect(clearedUrls()).toEqual([Q1]);
  });

  it('throws on any other error under a single URL id', async () => {
    mockSend.mockRejectedValueOnce(new Error('AccessDenied: not authorized'));
    await expect(new SQSQueuePolicyProvider().delete('QueuePolicy', Q1, TYPE)).rejects.toThrow(
      /Failed to delete SQS queue policy QueuePolicy: AccessDenied/
    );
  });
});
