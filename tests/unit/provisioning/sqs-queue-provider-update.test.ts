import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: vi.fn() },
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

import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue';

describe('SQSQueueProvider.update', () => {
  let provider: SQSQueueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SQSQueueProvider();
  });

  it('translates RedrivePolicy: {} to "" so SQS clears the DLQ instead of rejecting', async () => {
    // Regression for the user-reported `cdkd drift --revert` failure:
    // "Value {} for parameter RedrivePolicy is invalid. Reason:
    // Redrive policy does not contain mandatory attribute:
    // maxReceiveCount." — readCurrentState always-emits
    // RedrivePolicy: {} as a placeholder for queues without a DLQ,
    // and --revert round-trips that value through update(). The
    // fix translates the empty placeholder to "" (the documented SQS
    // way to clear RedrivePolicy on the queue).
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { VisibilityTimeout: 30, RedrivePolicy: {} },
      { VisibilityTimeout: 130, RedrivePolicy: {} }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    // Empty object placeholder -> "" (clear DLQ), not "{}" (which AWS rejects).
    expect(input.Attributes['RedrivePolicy']).toBe('');
    expect(input.Attributes['VisibilityTimeout']).toBe('30');
  });

  it('serialises a real RedrivePolicy object to canonical JSON', async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    const redrive = {
      deadLetterTargetArn: 'arn:aws:sqs:us-east-1:0:dlq',
      maxReceiveCount: 5,
    };

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { RedrivePolicy: redrive },
      {}
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['RedrivePolicy']).toBe(JSON.stringify(redrive));
  });

  it('serialises a RedriveAllowPolicy object to canonical JSON on update', async () => {
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    const redriveAllow = { redrivePermission: 'allowAll' };

    await provider.update('L', QUEUE_URL, 'AWS::SQS::Queue', { RedriveAllowPolicy: redriveAllow }, {});

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['RedriveAllowPolicy']).toBe(JSON.stringify(redriveAllow));
  });

  it('passes a RedriveAllowPolicy string through unchanged on update (no empty-object quirk)', async () => {
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    const raw = '{"redrivePermission":"byQueue","sourceQueueArns":["arn:aws:sqs:us-east-1:0:src"]}';

    await provider.update('L', QUEUE_URL, 'AWS::SQS::Queue', { RedriveAllowPolicy: raw }, {});

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    // Unlike RedrivePolicy, an empty object is NOT collapsed to "" — verify the
    // string passes through verbatim (no JSON re-stringify).
    expect(input.Attributes['RedriveAllowPolicy']).toBe(raw);
  });

  it('issues GetQueueAttributes for the QueueArn after the update', async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    const result = await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { VisibilityTimeout: 30 },
      {}
    );

    expect(result.attributes?.['Arn']).toBe('arn:aws:sqs:us-east-1:0:q');
    expect(mockSend.mock.calls.some((c) => c[0] instanceof GetQueueAttributesCommand)).toBe(true);
  });

  it('sends a RedriveAllowPolicy object as a JSON string on create', async () => {
    mockSend.mockResolvedValueOnce({ QueueUrl: QUEUE_URL }); // CreateQueue

    const redriveAllow = { redrivePermission: 'allowAll' };

    await provider.create('L', 'AWS::SQS::Queue', {
      QueueName: 'my-queue',
      RedriveAllowPolicy: redriveAllow,
    });

    const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateQueueCommand);
    expect(createCall).toBeDefined();
    const input = createCall![0].input as { Attributes?: Record<string, string> };
    expect(input.Attributes?.['RedriveAllowPolicy']).toBe(JSON.stringify(redriveAllow));
  });

  it('clears RedrivePolicy on AWS when it was set previously but is now absent (Fn::If -> AWS::NoValue)', async () => {
    // Regression for the conditions-update-2 integ: a WorkQueue carries a
    // RedrivePolicy in phase a (Fn::If true branch) and AWS::NoValue in
    // phase b. The phase-b resolved properties OMIT RedrivePolicy entirely.
    // The diff layer fires the change, but the provider must explicitly
    // reset the attribute to "" (clear) — otherwise the stale DLQ config
    // lingers on AWS. Pre-fix the update loop only acted on keys PRESENT in
    // the new properties, so the removal was a silent no-op.
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'WorkQueue',
      QUEUE_URL,
      'AWS::SQS::Queue',
      // phase-b desired props: RedrivePolicy resolved away (absent).
      {},
      // phase-a previous props: RedrivePolicy was set.
      {
        RedrivePolicy: {
          deadLetterTargetArn: 'arn:aws:sqs:us-east-1:0:dlq',
          maxReceiveCount: 3,
        },
      }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    // Documented SQS clear form — empty string, NOT "{}" (rejected) and NOT omitted.
    expect(input.Attributes['RedrivePolicy']).toBe('');
  });

  it('resets a numeric attribute to its SQS default when removed on update', async () => {
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      // VisibilityTimeout no longer present in the desired template.
      {},
      { VisibilityTimeout: 120 }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    // CFn resets a removed property to its default; SQS VisibilityTimeout default is 30.
    expect(input.Attributes['VisibilityTimeout']).toBe('30');
  });

  it('does NOT reset an attribute that was absent in BOTH previous and new properties', async () => {
    // Guard against over-clearing: a property never set must not be reset on
    // an unrelated update (e.g. a tag-only change).
    // applyTagDiff (TagQueue) fires before the trailing GetQueueAttributes,
    // so mock every send with the QueueArn response.
    mockSend.mockResolvedValue({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      // Only a tag change; no SQS attributes set on either side.
      { Tags: [{ Key: 'env', Value: 'prod' }] },
      {}
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    // No SetQueueAttributes at all — nothing to set or reset.
    expect(setAttrsCall).toBeUndefined();
  });

  it('round-trip: readCurrentState placeholders survive update() without AWS-invalid inputs', async () => {
    // Mechanical guard for Class 2 placeholder regression. See
    // docs/provider-development.md § 3b "Read-update round-trip test".
    //
    // 1. AWS-minimum response (queue with no DLQ, no KMS, no tags)
    //    triggers the always-emit placeholders that BIT us in PR #161.
    mockSend.mockResolvedValueOnce({
      Attributes: { VisibilityTimeout: '30', DelaySeconds: '0' },
    });
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const observed = await provider.readCurrentState(QUEUE_URL, 'L', 'AWS::SQS::Queue');
    // Spot-check the Class 2 placeholder is present (the always-emit
    // contract — see § 3b "emits placeholders for every user-controllable
    // top-level key").
    expect(observed?.['RedrivePolicy']).toEqual({});
    expect(observed?.['KmsMasterKeyId']).toBe('');

    // 2. Round-trip the snapshot through update(). No drift → AWS
    //    state should not change.
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributesCommand
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update('L', QUEUE_URL, 'AWS::SQS::Queue', observed!, observed!);

    // 3. Assert no AWS-rejection-shaped values reached the SDK.
    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const attrs = (setAttrsCall![0].input as { Attributes: Record<string, string> }).Attributes;
    // Class 2: empty-object RedrivePolicy must NEVER be sent as "{}"
    // — AWS rejects with "Redrive policy does not contain mandatory
    // attribute: maxReceiveCount". `serializeRedrivePolicy` translates
    // {} -> "" (the documented "clear" form).
    if (attrs['RedrivePolicy'] !== undefined) {
      expect(attrs['RedrivePolicy']).not.toBe('{}');
    }
  });
});
