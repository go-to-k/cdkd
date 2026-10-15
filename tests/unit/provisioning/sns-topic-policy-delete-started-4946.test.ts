import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { SetTopicAttributesCommand } from '@aws-sdk/client-sns';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
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

import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';

const TYPE = 'AWS::SNS::TopicPolicy';
const T1 = 'arn:aws:sns:us-east-1:123456789012:topic-1';
const T2 = 'arn:aws:sns:us-east-1:123456789012:topic-2';

/** SNS spells its permission refusal `AuthorizationError`. */
function authorizationError(): Error {
  const e = new Error('User is not authorized to perform: SNS:SetTopicAttributes');
  e.name = 'AuthorizationError';
  return e;
}

function answerSets(outcome: Record<string, 'ok' | 'denied'>): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof SetTopicAttributesCommand) {
      const arn = cmd.input.TopicArn ?? '';
      if (outcome[arn] === 'denied') return Promise.reject(authorizationError());
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
  });
}

async function deleteError(physicalId: string): Promise<unknown> {
  const provider = new SNSTopicPolicyProvider();
  return provider.delete('Policy', physicalId, TYPE, {}).then(
    () => {
      throw new Error('delete resolved');
    },
    (error: unknown) => error
  );
}

function resetTopics(): unknown[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof SetTopicAttributesCommand)
    .map((c) => (c[0] as SetTopicAttributesCommand).input.TopicArn);
}

describe('SNSTopicPolicyProvider.delete marks a refusal after a reset topic (go-to-k/cdkd#4946)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the refusal of the second topic once the first topic policy was reset', async () => {
    answerSets({ [T1]: 'ok', [T2]: 'denied' });

    const err = await deleteError(`${T1},${T2}`);

    expect(resetTopics()).toEqual([T1, T2]);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('leaves the refusal of the FIRST topic unmarked, so it still reads as kept', async () => {
    answerSets({ [T1]: 'denied', [T2]: 'ok' });

    const err = await deleteError(`${T1},${T2}`);

    expect(resetTopics()).toEqual([T1]);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });
});
