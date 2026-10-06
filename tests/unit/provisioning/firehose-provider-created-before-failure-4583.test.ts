import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-firehose', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    FirehoseClient: vi.fn().mockImplementation(() => ({
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

import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

/** Route each SDK command by its class name to a handler. */
function route(handlers: Record<string, () => unknown>): void {
  mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw new Error(`unexpected ${command.constructor.name}`);
    return handler();
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const fail = (message: string) => () => {
  throw new Error(message);
};

// go-to-k/cdkd#4583: a failure after the create call returned names the
// resource still in AWS for `cdkd rollback --revert-failed`.
describe('FirehoseProvider create marks the resource it made before failing (#4583)', () => {
  const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
  const props = {
    DeliveryStreamName: 'my-stream',
    ExtendedS3DestinationConfiguration: {
      BucketARN: 'arn:aws:s3:::bucket',
      RoleARN: 'arn:aws:iam::123456789012:role/r',
    },
  };

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the stream name when DescribeDeliveryStream fails after CreateDeliveryStream returned', async () => {
    route({
      CreateDeliveryStreamCommand: () => ({
        DeliveryStreamARN: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/my-stream',
      }),
      DescribeDeliveryStreamCommand: fail('describe throttled'),
    });
    const error = await caught(new FirehoseProvider().create('Stream', TYPE, props));
    expect(createdBeforeFailure(error, 'Stream', TYPE)).toBe('my-stream');
  });

  it('marks the logical-id-derived name when DeliveryStreamName is absent', async () => {
    route({
      CreateDeliveryStreamCommand: () => ({}),
      DescribeDeliveryStreamCommand: fail('describe throttled'),
    });
    const { DeliveryStreamName: _omit, ...unnamed } = props;
    const error = await caught(new FirehoseProvider().create('Stream', TYPE, unnamed));
    expect(createdBeforeFailure(error, 'Stream', TYPE)).toBe('Stream');
  });

  it('does not mark when CreateDeliveryStream itself fails', async () => {
    route({ CreateDeliveryStreamCommand: fail('ResourceInUseException') });
    const error = await caught(new FirehoseProvider().create('Stream', TYPE, props));
    expect(createdBeforeFailure(error, 'Stream', TYPE)).toBeUndefined();
  });

  it('does not mark a malformed-Tags pre-flight refusal', async () => {
    const error = await caught(
      new FirehoseProvider().create('Stream', TYPE, { ...props, Tags: 'not-a-list' })
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Stream', TYPE)).toBeUndefined();
  });
});
