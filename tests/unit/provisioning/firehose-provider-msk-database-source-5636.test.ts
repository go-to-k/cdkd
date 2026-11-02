import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import {
  CreateDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  ListTagsForDeliveryStreamCommand,
} from '@aws-sdk/client-firehose';
import { FirehoseProvider } from '../../../src/provisioning/providers/firehose-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

// go-to-k/cdkd#5636: `MSKSourceConfiguration` on the SDK route.

const RESOURCE_TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const PHYSICAL_ID = 'msk-stream';
const CLUSTER = 'arn:aws:kafka:us-east-1:111111111111:cluster/c/0000-s1';
const ROLE = 'arn:aws:iam::111111111111:role/firehose';

const msk = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  MSKClusterARN: CLUSTER,
  TopicName: 'topic',
  AuthenticationConfiguration: { RoleARN: ROLE, Connectivity: 'PRIVATE' },
  ...extra,
});

const properties = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  DeliveryStreamName: PHYSICAL_ID,
  DeliveryStreamType: 'MSKAsSource',
  MSKSourceConfiguration: msk(extra),
  ExtendedS3DestinationConfiguration: { BucketARN: 'arn:aws:s3:::dest', RoleARN: ROLE },
});

function armCreate(): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof CreateDeliveryStreamCommand) {
      return Promise.resolve({
        DeliveryStreamARN: `arn:aws:firehose:us-east-1:111111111111:deliverystream/${PHYSICAL_ID}`,
      });
    }
    if (command instanceof DescribeDeliveryStreamCommand) {
      return Promise.resolve({ DeliveryStreamDescription: { DeliveryStreamStatus: 'ACTIVE' } });
    }
    return Promise.resolve({});
  });
}

function createInput(): Record<string, unknown> {
  const creates = mockSend.mock.calls.filter((c) => c[0] instanceof CreateDeliveryStreamCommand);
  expect(creates).toHaveLength(1);
  return (creates[0]![0] as { input: Record<string, unknown> }).input;
}

function armRead(source: Record<string, unknown>): void {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof DescribeDeliveryStreamCommand) {
      return Promise.resolve({
        DeliveryStreamDescription: {
          DeliveryStreamName: PHYSICAL_ID,
          DeliveryStreamType: 'MSKAsSource',
          Source: { MSKSourceDescription: source },
        },
      });
    }
    if (command instanceof ListTagsForDeliveryStreamCommand) return Promise.resolve({ Tags: [] });
    return Promise.resolve({});
  });
}

describe('FirehoseProvider MSKSourceConfiguration (go-to-k/cdkd#5636)', () => {
  let provider: FirehoseProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirehoseProvider();
  });

  it('handles MSKSourceConfiguration and still leaves DatabaseSourceConfiguration to Cloud Control', () => {
    const handled = provider.handledProperties.get(RESOURCE_TYPE)!;
    expect(handled.has('MSKSourceConfiguration')).toBe(true);
    expect(handled.has('DatabaseSourceConfiguration')).toBe(false);
  });

  // 2026-11-01T00:00:00Z and 2026-11-02T00:00:00Z in epoch milliseconds.
  const NOV_1 = '1793491200000';
  const NOV_2 = '1793577600000';

  it('create() sends the block and the MSKAsSource type, the timestamp as a Date', async () => {
    armCreate();
    await provider.create('L', RESOURCE_TYPE, properties({ ReadFromTimestamp: NOV_1 }));

    const input = createInput();
    expect(input['DeliveryStreamType']).toBe('MSKAsSource');
    expect(input['MSKSourceConfiguration']).toEqual({
      ...msk(),
      ReadFromTimestamp: new Date(Date.UTC(2026, 10, 1)),
    });
  });

  it('create() omits ReadFromTimestamp when the template does', async () => {
    armCreate();
    await provider.create('L', RESOURCE_TYPE, properties());

    const sent = createInput()['MSKSourceConfiguration'] as Record<string, unknown>;
    expect(sent).toEqual(msk());
    expect(Object.hasOwn(sent, 'ReadFromTimestamp')).toBe(false);
  });

  it('create() reads the timestamp as MILLISECONDS, as CloudFormation does', async () => {
    // Measured through Cloud Control: `1761955200` reached Firehose as
    // 1970-01-21T09:25:55.200Z, not as 2025-11-01.
    armCreate();
    await provider.create('L', RESOURCE_TYPE, properties({ ReadFromTimestamp: '1761955200' }));

    const sent = createInput()['MSKSourceConfiguration'] as Record<string, unknown>;
    expect((sent['ReadFromTimestamp'] as Date).toISOString()).toBe('1970-01-21T09:25:55.200Z');
  });

  it('create() takes the signed spelling Long.parseLong takes', async () => {
    armCreate();
    await provider.create('L', RESOURCE_TYPE, properties({ ReadFromTimestamp: `+${NOV_1}` }));

    const sent = createInput()['MSKSourceConfiguration'] as Record<string, unknown>;
    expect((sent['ReadFromTimestamp'] as Date).getTime()).toBe(Number(NOV_1));
  });

  it.each([
    ['an ISO 8601 date-time', '2026-11-01T00:00:00Z'],
    ['an offset-less date-time', '2026-11-01T00:00:00'],
    ['a date', '2026-11-01'],
    ['a word', 'yesterday'],
    ['a fraction', '1793491200000.5'],
    ['an empty string', ''],
    ['digits beyond the Date range', '9'.repeat(20)],
  ])(
    'create() refuses %s before any AWS call, as CloudFormation refuses it',
    async (_label, value) => {
      armCreate();
      const err = await provider
        .create('L', RESOURCE_TYPE, properties({ ReadFromTimestamp: value }))
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('MSKSourceConfiguration.ReadFromTimestamp');
      expect((err as Error).message).toContain('epoch milliseconds');
      expect((err as Error).message).toContain(JSON.stringify(value));
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('create() reads a whole NUMBER as its decimal string, as CloudFormation coerces it', async () => {
    armCreate();
    await provider.create('L', RESOURCE_TYPE, properties({ ReadFromTimestamp: Number(NOV_1) }));

    const sent = createInput()['MSKSourceConfiguration'] as Record<string, unknown>;
    expect((sent['ReadFromTimestamp'] as Date).getTime()).toBe(Number(NOV_1));
  });

  it('create() refuses a fractional NUMBER', async () => {
    armCreate();
    const err = await provider
      .create('L', RESOURCE_TYPE, properties({ ReadFromTimestamp: 1.5 }))
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect((err as Error).message).toContain('MSKSourceConfiguration.ReadFromTimestamp');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('create() masks a secret-derived ReadFromTimestamp in the refusal', async () => {
    armCreate();
    const err = (await provider
      .create('L', RESOURCE_TYPE, properties({ ReadFromTimestamp: 's3cr3t-value' }), {
        maskSecrets: (text: string) => text.split('s3cr3t-value').join('***'),
      })
      .then(
        () => undefined,
        (e: unknown) => e
      )) as Error;

    expect(err.message).toContain('"***"');
    expect(err.message).not.toContain('s3cr3t-value');
  });

  it('readCurrentState maps MSKSourceDescription back, without DeliveryStartTimestamp', async () => {
    armRead({
      MSKClusterARN: CLUSTER,
      TopicName: 'topic',
      AuthenticationConfiguration: { RoleARN: ROLE, Connectivity: 'PRIVATE' },
      DeliveryStartTimestamp: new Date(Date.UTC(2026, 10, 2)),
      ReadFromTimestamp: new Date(Date.UTC(2026, 10, 1)),
    });

    const observed = (await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE)) as Record<
      string,
      unknown
    >;
    expect(observed['MSKSourceConfiguration']).toEqual(msk({ ReadFromTimestamp: NOV_1 }));
  });

  it('readCurrentState keeps the recorded spelling of the same instant, so it does not drift', async () => {
    armRead({ ...msk(), ReadFromTimestamp: new Date(Date.UTC(2026, 10, 1)) });

    const observed = (await provider.readCurrentState(
      PHYSICAL_ID,
      'L',
      RESOURCE_TYPE,
      properties({ ReadFromTimestamp: `+0${NOV_1}` })
    )) as Record<string, unknown>;
    expect(observed['MSKSourceConfiguration']).toEqual(msk({ ReadFromTimestamp: `+0${NOV_1}` }));
  });

  it('readCurrentState carries no ReadFromTimestamp when AWS reports none', async () => {
    // Measured: a stream created without one reads back only the read-only
    // DeliveryStartTimestamp. The record holds one here, so the case also
    // proves the recorded spelling is never copied in when AWS reports none.
    armRead({ ...msk(), DeliveryStartTimestamp: new Date(Date.UTC(2026, 10, 2)) });

    const observed = (await provider.readCurrentState(
      PHYSICAL_ID,
      'L',
      RESOURCE_TYPE,
      properties({ ReadFromTimestamp: NOV_1 })
    )) as Record<string, unknown>;
    const block = observed['MSKSourceConfiguration'] as Record<string, unknown>;
    expect(block).toEqual(msk());
    expect(Object.hasOwn(block, 'ReadFromTimestamp')).toBe(false);
  });

  it('readCurrentState writes a timestamp the template omits as epoch milliseconds', async () => {
    armRead({ ...msk(), ReadFromTimestamp: new Date(Date.UTC(2026, 10, 1)) });

    const observed = (await provider.readCurrentState(
      PHYSICAL_ID,
      'L',
      RESOURCE_TYPE,
      properties()
    )) as Record<string, unknown>;
    expect(observed['MSKSourceConfiguration']).toEqual(msk({ ReadFromTimestamp: NOV_1 }));
  });

  it('readCurrentState reports a different instant in epoch milliseconds, so the drift shows', async () => {
    armRead({ ...msk(), ReadFromTimestamp: new Date(Date.UTC(2026, 10, 2)) });

    const observed = (await provider.readCurrentState(
      PHYSICAL_ID,
      'L',
      RESOURCE_TYPE,
      properties({ ReadFromTimestamp: NOV_1 })
    )) as Record<string, unknown>;
    expect(observed['MSKSourceConfiguration']).toEqual(msk({ ReadFromTimestamp: NOV_2 }));
  });

  it('readCurrentState emits no MSKSourceConfiguration for a stream without an MSK source', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeDeliveryStreamCommand) {
        return Promise.resolve({
          DeliveryStreamDescription: { DeliveryStreamName: PHYSICAL_ID, DeliveryStreamType: 'DirectPut' },
        });
      }
      return Promise.resolve({ Tags: [] });
    });

    const observed = (await provider.readCurrentState(PHYSICAL_ID, 'L', RESOURCE_TYPE)) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(observed, 'MSKSourceConfiguration')).toBe(false);
  });
});
