import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-firehose', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-firehose')>(
    '@aws-sdk/client-firehose'
  );
  return {
    ...actual,
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const RESOURCE_TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const PHYSICAL_ID = 'my-stream';

describe('FirehoseProvider read-update round-trip', () => {
  let provider: FirehoseProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  it('Class 1 — DirectPut readCurrentState does NOT emit KinesisStreamSourceConfiguration', async () => {
    // Mechanical guard for Class 1 placeholder regression on type-
    // discriminator-dependent fields. See docs/provider-development.md
    // § 3b "Read-update round-trip test".
    //
    // KinesisStreamSourceConfiguration is only valid when
    // DeliveryStreamType === 'KinesisStreamAsSource'. AWS only returns
    // Source.KinesisStreamSourceDescription on streams of that type, so
    // a DirectPut stream's snapshot must NOT contain the source key —
    // otherwise --revert (if Firehose ever supported update) or any
    // future re-creation pathway would push a Class 1 invalid value.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: PHYSICAL_ID,
          DeliveryStreamType: 'DirectPut',
          // Source intentionally absent — DirectPut has no source.
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const observed = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);
    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty('KinesisStreamSourceConfiguration');
    expect(observed?.DeliveryStreamType).toBe('DirectPut');
  });

  it('Class 1 — KinesisStreamAsSource emits KinesisStreamSourceConfiguration on the discriminator-true path', async () => {
    // Complement to the DirectPut test: the field MUST appear when the
    // discriminator is true, otherwise drift detection misses
    // console-side source-arn / role-arn changes.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: PHYSICAL_ID,
          DeliveryStreamType: 'KinesisStreamAsSource',
          Source: {
            KinesisStreamSourceDescription: {
              KinesisStreamARN: 'arn:aws:kinesis:us-east-1:1:stream/src',
              RoleARN: 'arn:aws:iam::1:role/r',
            },
          },
        },
      })
      .mockResolvedValueOnce({ Tags: [] });

    const observed = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);
    expect(observed?.KinesisStreamSourceConfiguration).toEqual({
      KinesisStreamARN: 'arn:aws:kinesis:us-east-1:1:stream/src',
      RoleARN: 'arn:aws:iam::1:role/r',
    });
  });

  it('always emits Tags (even when ListTagsForDeliveryStream fails on a non-NotFound error)', async () => {
    // Per docs/provider-development.md § 3b: omitting `Tags` on the
    // failure path means the comparator's state-keys-only walk skips
    // Tags forever, hiding console-side tag adds from drift on the
    // unlucky run that hit the Tags API throttle.
    mockSend
      .mockResolvedValueOnce({
        DeliveryStreamDescription: {
          DeliveryStreamName: PHYSICAL_ID,
          DeliveryStreamType: 'DirectPut',
        },
      })
      .mockRejectedValueOnce(new Error('throttled'));

    const observed = await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE);
    expect(observed).toBeDefined();
    expect(observed?.Tags).toEqual([]);
  });

  it('round-trip: update() rejects with ResourceUpdateNotSupportedError without sending any AWS call', async () => {
    // Firehose update() is intentionally a hard reject (PR I): every
    // user-visible CFn property change requires replacement on AWS, so
    // `cdkd drift --revert` surfaces a clear "use --replace or
    // re-deploy" message instead of silently no-op'ing. This is the
    // structural guard against a future PR adding a half-implemented
    // UpdateDestination call that would resurface the Class 1 / Class
    // 2 / truthy-gate hazards documented in § 3b.
    const observed = {
      DeliveryStreamName: PHYSICAL_ID,
      DeliveryStreamType: 'DirectPut',
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await expect(
      provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed)
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    // Zero AWS calls — the reject path must not touch the wire.
    expect(mockSend).not.toHaveBeenCalled();
  });
});
