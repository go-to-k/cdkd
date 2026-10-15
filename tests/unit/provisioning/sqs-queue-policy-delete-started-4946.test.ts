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

import { SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';

const TYPE = 'AWS::SQS::QueuePolicy';
const Q1 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-1';
const Q2 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-2';

function accessDenied(): Error {
  const e = new Error('User is not authorized to perform: sqs:SetQueueAttributes');
  e.name = 'AccessDenied';
  return e;
}

/** Answer each queue's SetQueueAttributes: `'denied'` throws AccessDenied, else {}. */
function answerSets(outcome: Record<string, 'ok' | 'denied'>): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof SetQueueAttributesCommand) {
      const url = cmd.input.QueueUrl ?? '';
      if (outcome[url] === 'denied') return Promise.reject(accessDenied());
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
  });
}

async function deleteError(physicalId: string): Promise<unknown> {
  const provider = new SQSQueuePolicyProvider();
  return provider.delete('Policy', physicalId, TYPE, {}).then(
    () => {
      throw new Error('delete resolved');
    },
    (error: unknown) => error
  );
}

describe('SQSQueuePolicyProvider.delete marks a refusal after a cleared queue (go-to-k/cdkd#4946)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the refusal of the second queue once the first queue policy was cleared', async () => {
    answerSets({ [Q1]: 'ok', [Q2]: 'denied' });

    const err = await deleteError(`${Q1},${Q2}`);

    const sets = mockSend.mock.calls
      .filter((c) => c[0] instanceof SetQueueAttributesCommand)
      .map((c) => (c[0] as SetQueueAttributesCommand).input.QueueUrl);
    expect(sets).toEqual([Q1, Q2]);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('leaves the refusal of the FIRST queue unmarked, so it still reads as kept', async () => {
    answerSets({ [Q1]: 'denied', [Q2]: 'ok' });

    const err = await deleteError(`${Q1},${Q2}`);

    const sets = mockSend.mock.calls.filter((c) => c[0] instanceof SetQueueAttributesCommand);
    expect(sets).toHaveLength(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });
});
