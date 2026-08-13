import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const mockSend = vi.fn();
const mockStsSend = vi.fn();

// Mutable so a test can drive the client's region (issue #1815 partition
// derivation). Reset to `us-east-1` in `beforeEach`.
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' as string | undefined }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
    sts: { send: mockStsSend },
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
    clientRegion.value = 'us-east-1';
    delete process.env['AWS_REGION'];
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

  it('resets ContentBasedDeduplication to "false" when removed on update (issue #1160)', async () => {
    // Reachable via a plain deploy since issue #1237 classified
    // ContentBasedDeduplication as updateable in replacement-rules.ts.
    // FIFO queue had ContentBasedDeduplication: true; the property is now
    // absent from the desired template. CFn resets a removed property to its
    // default (disabled) — SetQueueAttributes has merge semantics, so the
    // provider must send the explicit 'false'. Only a FIFO queue can carry
    // the attribute in previousProperties (AWS rejects it on standard
    // queues), so the reset is always FIFO-safe.
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { FifoQueue: true },
      { FifoQueue: true, ContentBasedDeduplication: true }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['ContentBasedDeduplication']).toBe('false');
  });

  it('does NOT send ContentBasedDeduplication when never present on either side', async () => {
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { VisibilityTimeout: 45 },
      { VisibilityTimeout: 30 }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['ContentBasedDeduplication']).toBeUndefined();
    expect(input.Attributes['SqsManagedSseEnabled']).toBeUndefined();
    expect(input.Attributes['DeduplicationScope']).toBeUndefined();
    expect(input.Attributes['FifoThroughputLimit']).toBeUndefined();
    expect(input.Attributes['VisibilityTimeout']).toBe('45');
  });

  it('mixed removal: kept fields pass through while ContentBasedDeduplication resets (issue #1160)', async () => {
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { FifoQueue: true, DelaySeconds: 5 },
      { FifoQueue: true, DelaySeconds: 5, ContentBasedDeduplication: true }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['ContentBasedDeduplication']).toBe('false');
    // Kept field passes through unchanged, not reset to its default.
    expect(input.Attributes['DelaySeconds']).toBe('5');
  });

  it('resets DeduplicationScope to "queue" when removed on update (issue #1160)', async () => {
    // FIFO queue had DeduplicationScope: messageGroup; the property is now
    // absent from the desired template. A bare FIFO queue reads
    // DeduplicationScope 'queue' (the default; live-verified 2026-07-27), so
    // removal resets to 'queue'. FIFO-only: only a FIFO queue can carry the
    // attribute in previousProperties (AWS rejects it on standard queues).
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { FifoQueue: true },
      { FifoQueue: true, DeduplicationScope: 'messageGroup' }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['DeduplicationScope']).toBe('queue');
  });

  it('resets FifoThroughputLimit to "perQueue" while a kept DeduplicationScope passes through (issue #1160)', async () => {
    // Only FifoThroughputLimit removed; DeduplicationScope: messageGroup kept.
    // 'perQueue' + 'messageGroup' is a valid combination — AWS accepts it in
    // one SetQueueAttributes call (live-verified 2026-07-27).
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { FifoQueue: true, DeduplicationScope: 'messageGroup' },
      {
        FifoQueue: true,
        DeduplicationScope: 'messageGroup',
        FifoThroughputLimit: 'perMessageGroupId',
      }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['FifoThroughputLimit']).toBe('perQueue');
    // Kept field passes through unchanged, not reset to its default.
    expect(input.Attributes['DeduplicationScope']).toBe('messageGroup');
  });

  it('resets both DeduplicationScope and FifoThroughputLimit in ONE call when both are removed (issue #1160)', async () => {
    // Template dropped the high-throughput FIFO config entirely. Both resets
    // ride the same SetQueueAttributes call — 'queue' + 'perQueue' together is
    // accepted by AWS (both defaults; live-verified 2026-07-27).
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { FifoQueue: true },
      {
        FifoQueue: true,
        DeduplicationScope: 'messageGroup',
        FifoThroughputLimit: 'perMessageGroupId',
      }
    );

    const calls = mockSend.mock.calls.filter((c) => c[0] instanceof SetQueueAttributesCommand);
    // ONE combined call, not one per attribute.
    expect(calls).toHaveLength(1);
    const input = calls[0]![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['DeduplicationScope']).toBe('queue');
    expect(input.Attributes['FifoThroughputLimit']).toBe('perQueue');
  });

  it('does NOT suppress the DeduplicationScope reset when the template keeps FifoThroughputLimit: perMessageGroupId (CFn parity)', async () => {
    // Removing ONLY DeduplicationScope while keeping FifoThroughputLimit:
    // perMessageGroupId is an invalid combination — AWS rejects the call
    // loudly (InvalidAttributeValue: "To set FifoThroughputLimit to
    // perMessageGroupId, the DeduplicationScope must be messageGroup";
    // live-verified 2026-07-27, queue state unchanged). CloudFormation's
    // reset-to-default hits the same service constraint, so cdkd passes the
    // reset through with NO guard — no sub-field synthesis, no suppression.
    // The user must drop / change FifoThroughputLimit too.
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { FifoQueue: true, FifoThroughputLimit: 'perMessageGroupId' },
      {
        FifoQueue: true,
        DeduplicationScope: 'messageGroup',
        FifoThroughputLimit: 'perMessageGroupId',
      }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    // The reset IS sent alongside the kept perMessageGroupId — AWS (and CFn)
    // own the rejection; cdkd must not silently keep the stale value.
    expect(input.Attributes['DeduplicationScope']).toBe('queue');
    expect(input.Attributes['FifoThroughputLimit']).toBe('perMessageGroupId');
  });

  it('resets SqsManagedSseEnabled to "true" when removed on update (issue #1160)', async () => {
    // A standard queue had SqsManagedSseEnabled: false; the property is now
    // absent. SSE-SQS is enabled by default when the property is undefined
    // (CFn docs), so removal resets to 'true'.
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      {},
      { SqsManagedSseEnabled: false }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['SqsManagedSseEnabled']).toBe('true');
  });

  it('skips the SqsManagedSseEnabled reset when the new template carries a non-empty KmsMasterKeyId', async () => {
    // SSE-SQS and SSE-KMS are mutually exclusive: AWS rejects a
    // SetQueueAttributes call carrying both a non-empty KmsMasterKeyId and
    // SqsManagedSseEnabled 'true' ("You can use one type of server-side
    // encryption (SSE) at one time.", live-verified). The template switched
    // to SSE-KMS, so the reset must be suppressed — setting the CMK
    // implicitly turns SSE-SQS off.
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { KmsMasterKeyId: 'alias/aws/sqs' },
      { SqsManagedSseEnabled: false }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['SqsManagedSseEnabled']).toBeUndefined();
    expect(input.Attributes['KmsMasterKeyId']).toBe('alias/aws/sqs');
  });

  it('still resets SqsManagedSseEnabled when the new KmsMasterKeyId is the empty-string placeholder', async () => {
    // readCurrentState emits KmsMasterKeyId: '' as the "no CMK" placeholder.
    // An empty key means SSE-KMS is NOT desired, so the SSE-SQS reset must
    // fire — AWS accepts KmsMasterKeyId '' + SqsManagedSseEnabled 'true' in
    // one call (live-verified).
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      { KmsMasterKeyId: '' },
      { SqsManagedSseEnabled: false }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['SqsManagedSseEnabled']).toBe('true');
    expect(input.Attributes['KmsMasterKeyId']).toBe('');
  });

  it('resets both KmsMasterKeyId and SqsManagedSseEnabled when both are removed at once', async () => {
    // Template dropped SSE config entirely: KmsMasterKeyId resets to '' and
    // SqsManagedSseEnabled resets to 'true' (back to the SSE-SQS default).
    // AWS accepts this combination in a single call (live-verified).
    mockSend.mockResolvedValueOnce({}); // SetQueueAttributes
    mockSend.mockResolvedValueOnce({ Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:0:q' } });

    await provider.update(
      'L',
      QUEUE_URL,
      'AWS::SQS::Queue',
      {},
      { KmsMasterKeyId: 'alias/aws/sqs', SqsManagedSseEnabled: false }
    );

    const setAttrsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof SetQueueAttributesCommand
    );
    expect(setAttrsCall).toBeDefined();
    const input = setAttrsCall![0].input as { Attributes: Record<string, string> };
    expect(input.Attributes['KmsMasterKeyId']).toBe('');
    expect(input.Attributes['SqsManagedSseEnabled']).toBe('true');
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
  // Issue #1815: `constructArn` hardcoded `arn:aws:`, so outside the
  // commercial partition create() recorded a structurally-valid but WRONG
  // ARN into state and served it as the queue's `Arn` attribute — nothing
  // downstream rejects it.
  describe('partition derivation (issue #1815)', () => {
    async function createAndGetArn(): Promise<unknown> {
      mockSend.mockResolvedValueOnce({ QueueUrl: QUEUE_URL }); // CreateQueue
      const result = await provider.create('L', 'AWS::SQS::Queue', { QueueName: 'my-queue' });
      return result.attributes?.['Arn'];
    }

    it('uses the aws-cn partition for a cn- region', async () => {
      clientRegion.value = 'cn-north-1';
      mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });

      expect(await createAndGetArn()).toBe('arn:aws-cn:sqs:cn-north-1:123456789012:my-queue');
    });

    it('uses the aws-us-gov partition for a us-gov- region', async () => {
      clientRegion.value = 'us-gov-west-1';
      mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });

      expect(await createAndGetArn()).toBe(
        'arn:aws-us-gov:sqs:us-gov-west-1:123456789012:my-queue'
      );
    });

    // The safety half of the pair: without a non-commercial account to test
    // against, "commercial output is unchanged byte for byte" is what makes
    // the change provably non-breaking.
    it('leaves a commercial region byte-identical to the pre-fix output', async () => {
      clientRegion.value = 'ap-northeast-1';
      mockStsSend.mockResolvedValueOnce({ Account: '123456789012' });

      expect(await createAndGetArn()).toBe('arn:aws:sqs:ap-northeast-1:123456789012:my-queue');
    });

    it('derives the placeholder ARN partition from AWS_REGION when STS fails', async () => {
      process.env['AWS_REGION'] = 'cn-northwest-1';
      mockStsSend.mockRejectedValueOnce(new Error('STS unreachable'));

      expect(await createAndGetArn()).toBe('arn:aws-cn:sqs:unknown:unknown:my-queue');
    });

    it('keeps the commercial placeholder ARN when STS fails with no AWS_REGION', async () => {
      mockStsSend.mockRejectedValueOnce(new Error('STS unreachable'));

      expect(await createAndGetArn()).toBe('arn:aws:sqs:unknown:unknown:my-queue');
    });
  });
});
