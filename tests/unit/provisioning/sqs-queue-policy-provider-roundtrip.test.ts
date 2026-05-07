import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SetQueueAttributesCommand } from '@aws-sdk/client-sqs';

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

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123/my-queue';
const RESOURCE_TYPE = 'AWS::SQS::QueuePolicy';

describe('SQSQueuePolicyProvider read-update round-trip', () => {
  let provider: SQSQueuePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SQSQueuePolicyProvider();
    // SetQueueAttributesCommand response is empty
    mockSend.mockResolvedValue({});
  });

  it('round-trip: observed snapshot survives update() with a valid Policy attribute', async () => {
    // Mechanical guard for the round-trip code path used by `cdkd drift
    // --revert`. See docs/provider-development.md § 3b.
    //
    // For SQS::QueuePolicy:
    //   - Class 1 (type-discriminator-dependent fields): N/A — no
    //     discriminator in the 2-field shape (Queues, PolicyDocument).
    //   - Class 2 (structurally-incomplete-when-empty): N/A —
    //     readCurrentState returns `undefined` when no Policy is
    //     attached (state never carries an empty placeholder for
    //     PolicyDocument).
    //   - Truthy gate: update() validates with `!policyDocument`, but
    //     PolicyDocument cannot legally be falsy in observed state
    //     (readCurrentState returns undefined, not `{}` / null).
    //
    // This test exercises the happy round-trip: an observed snapshot
    // produced by readCurrentState is fed back into update(), and the
    // SetQueueAttributes call must carry a valid (non-empty,
    // non-malformed) Policy attribute.
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'events.amazonaws.com' },
          Action: 'sqs:SendMessage',
          Resource: 'arn:aws:sqs:us-east-1:123:my-queue',
        },
      ],
    };
    const observed = {
      Queues: [QUEUE_URL],
      PolicyDocument: policy,
    };

    await provider.update('L', QUEUE_URL, RESOURCE_TYPE, observed, observed);

    const setAttrCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrCalls).toHaveLength(1);
    const input = setAttrCalls[0]![0].input as {
      QueueUrl: string;
      Attributes: { Policy: string };
    };
    expect(input.QueueUrl).toBe(QUEUE_URL);
    // Policy is JSON-serialised back to a string for SetQueueAttributes.
    // Must NOT be the empty string (would clear the policy on AWS) nor
    // '{}' (AWS rejects with malformed policy document).
    expect(input.Attributes.Policy).not.toBe('');
    expect(input.Attributes.Policy).not.toBe('{}');
    expect(JSON.parse(input.Attributes.Policy)).toEqual(policy);
  });

  it('round-trip preserves a string-form PolicyDocument verbatim', async () => {
    // readCurrentState falls back to the raw string if JSON.parse fails
    // (line 273-276 of sqs-queue-policy-provider.ts). The string form
    // must survive update() unchanged — JSON.stringify on a string
    // would double-encode it.
    const policyStr = '{"Version":"2012-10-17","Statement":[]}';
    const observed = {
      Queues: [QUEUE_URL],
      PolicyDocument: policyStr,
    };

    await provider.update('L', QUEUE_URL, RESOURCE_TYPE, observed, observed);

    const setAttrCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrCalls).toHaveLength(1);
    const input = setAttrCalls[0]![0].input as {
      Attributes: { Policy: string };
    };
    expect(input.Attributes.Policy).toBe(policyStr);
  });
});
