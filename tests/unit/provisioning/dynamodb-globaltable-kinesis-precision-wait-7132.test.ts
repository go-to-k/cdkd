import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeKinesisStreamingDestinationCommand,
  UpdateKinesisStreamingDestinationCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  waitForKinesisPrecisionSettled,
  SETTLE_STALE_READ_GRACE_POLLS,
} from '../../../src/provisioning/providers/dynamodb-settle-waits.js';
import { sendReplicaSettingOp } from '../../../src/provisioning/providers/dynamodb-globaltable/replica-ops.js';
import type { DynamoDBGlobalTableProvider } from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';

/**
 * go-to-k/cdkd#7132: on AWS::DynamoDB::GlobalTable, an
 * ApproximateCreationDateTimePrecision change holds the Kinesis destination
 * UPDATING for ~3 min; CloudFormation completes only once it reads ACTIVE at
 * the new precision. These pin the wait and that the GlobalTable send site
 * calls it.
 */

const STREAM = 'arn:aws:kinesis:us-east-1:123456789012:stream/s';
const send = vi.fn();
const client = { send } as unknown as DynamoDBClient;
const debug = vi.fn();
const opts = { maskSecrets: (s: string) => s.replaceAll('SECRET', '***'), debug, pollMs: 0 };

function dest(status: string, precision?: string, desc?: string): Record<string, string> {
  return {
    StreamArn: STREAM,
    DestinationStatus: status,
    ...(precision !== undefined && { ApproximateCreationDateTimePrecision: precision }),
    ...(desc !== undefined && { DestinationStatusDescription: desc }),
  };
}

function reads(...entries: Array<Record<string, string>>): void {
  for (const e of entries) send.mockResolvedValueOnce({ KinesisDataStreamDestinations: [e] });
}

beforeEach(() => {
  send.mockReset();
  debug.mockReset();
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});

describe('waitForKinesisPrecisionSettled (#7132)', () => {
  it('polls through UPDATING and returns once ACTIVE at the new precision', async () => {
    reads(dest('UPDATING', 'MICROSECOND'), dest('UPDATING'), dest('ACTIVE', 'MILLISECOND'));
    await waitForKinesisPrecisionSettled(client, 't', STREAM, 'MILLISECOND', 'replica r', opts);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(DescribeKinesisStreamingDestinationCommand);
  });

  it('reads ACTIVE at the old precision as stale for the grace polls, then fails non-retryable', async () => {
    reads(dest('ACTIVE', 'MICROSECOND'), dest('ACTIVE', 'MILLISECOND'));
    await waitForKinesisPrecisionSettled(client, 't', STREAM, 'MILLISECOND', 'replica r', opts);
    expect(send).toHaveBeenCalledTimes(2);

    send.mockReset();
    send.mockResolvedValue({ KinesisDataStreamDestinations: [dest('ACTIVE', 'MICROSECOND')] });
    const err = await waitForKinesisPrecisionSettled(
      client,
      't',
      STREAM,
      'MILLISECOND',
      'replica r',
      opts
    ).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain(
      'settled as ACTIVE with ApproximateCreationDateTimePrecision MICROSECOND, expected ACTIVE / MILLISECOND'
    );
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(send).toHaveBeenCalledTimes(SETTLE_STALE_READ_GRACE_POLLS + 1);
  });

  it('fails on a failed status after the grace, with AWS reason in debug only', async () => {
    send.mockResolvedValue({
      KinesisDataStreamDestinations: [
        dest('ENABLE_FAILED', 'MILLISECOND', 'denied for arn:aws:iam::123456789012:role/SECRET'),
      ],
    });
    const err = await waitForKinesisPrecisionSettled(
      client,
      't',
      STREAM,
      'MILLISECOND',
      'replica r',
      opts
    ).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain('settled as ENABLE_FAILED');
    expect((err as Error).message).not.toContain('role/');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('role/***'));
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('throws, never returns, when its poll cap runs out', async () => {
    send.mockResolvedValue({ KinesisDataStreamDestinations: [dest('UPDATING', 'MICROSECOND')] });
    const err = await waitForKinesisPrecisionSettled(client, 't', STREAM, 'MILLISECOND', 'r', {
      ...opts,
      maxPolls: 2,
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/still UPDATING \/ MICROSECOND .*not confirmed/);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('skips under --no-wait', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await waitForKinesisPrecisionSettled(client, 't', STREAM, 'MILLISECOND', 'r', opts);
    expect(send).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('CDKD_NO_WAIT=true'));
  });
});

describe('GlobalTable kinesisPrecision op waits (#7132)', () => {
  const self = {
    logger: { debug: vi.fn(), warn: vi.fn() },
    retrySettlingRefusal: (call: () => Promise<unknown>) => call().then(() => undefined),
  } as unknown as DynamoDBGlobalTableProvider;
  const op = { kind: 'kinesisPrecision', streamArn: STREAM, precision: 'MILLISECOND' } as const;
  const run = (): Promise<void> =>
    sendReplicaSettingOp.call(
      self,
      client,
      't',
      'us-east-1',
      'T',
      op,
      () => Promise.resolve({}),
      (s: string) => s
    );

  it('sends the update, then polls the destination until ACTIVE at the new precision', async () => {
    const describes = [dest('UPDATING', 'MICROSECOND'), dest('ACTIVE', 'MILLISECOND')];
    send.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof UpdateKinesisStreamingDestinationCommand
          ? { DestinationStatus: 'UPDATING' }
          : { KinesisDataStreamDestinations: [describes.shift()!] }
      )
    );
    vi.useFakeTimers();
    try {
      const p = run();
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    const names = send.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(names).toEqual([
      'UpdateKinesisStreamingDestinationCommand',
      'DescribeKinesisStreamingDestinationCommand',
      'DescribeKinesisStreamingDestinationCommand',
    ]);
  });

  it('fails the op when the destination never reaches the new precision', async () => {
    send.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof UpdateKinesisStreamingDestinationCommand
          ? {}
          : { KinesisDataStreamDestinations: [dest('ACTIVE', 'MICROSECOND')] }
      )
    );
    vi.useFakeTimers();
    try {
      const p = run().catch((e: unknown) => e as Error);
      await vi.runAllTimersAsync();
      const err = await p;
      expect((err as Error).message).toContain('expected ACTIVE / MILLISECOND');
      expect(isMarkedNonRetryable(err)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
