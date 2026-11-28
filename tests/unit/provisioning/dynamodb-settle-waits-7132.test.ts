import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeContributorInsightsCommand,
  DescribeKinesisStreamingDestinationCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  waitForContributorInsightsSettled,
  waitForKinesisEnableActive,
  SETTLE_STALE_READ_GRACE_POLLS,
} from '../../../src/provisioning/providers/dynamodb-settle-waits.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * go-to-k/cdkd#7132: the DynamoDB toggles answer ENABLING / DISABLING, and
 * CloudFormation completes only once they settle. These pin the two waits
 * themselves; the provider tests pin that every send site calls them.
 */

const STREAM = 'arn:aws:kinesis:us-east-1:123456789012:stream/s';
const send = vi.fn();
const client = { send } as unknown as DynamoDBClient;
const debug = vi.fn();
const opts = { maskSecrets: (s: string) => s.replaceAll('SECRET', '***'), debug, pollMs: 0 };

function insights(...statuses: (string | { status: string; desc: string })[]): void {
  for (const s of statuses) {
    send.mockResolvedValueOnce(
      typeof s === 'string'
        ? { ContributorInsightsStatus: s }
        : {
            ContributorInsightsStatus: s.status,
            FailureException: { ExceptionName: 'AccessDenied', ExceptionDescription: s.desc },
          }
    );
  }
}

function destinations(...reads: Array<Array<Record<string, string>>>): void {
  for (const r of reads) send.mockResolvedValueOnce({ KinesisDataStreamDestinations: r });
}

beforeEach(() => {
  send.mockReset();
  debug.mockReset();
});

describe('waitForContributorInsightsSettled (#7132)', () => {
  it('polls through ENABLING and returns on ENABLED, reading the index it was given', async () => {
    insights('ENABLING', 'ENABLING', 'ENABLED');
    await waitForContributorInsightsSettled(client, 't', 'gsi', 'ENABLE', 'table t', opts);
    expect(send).toHaveBeenCalledTimes(3);
    const cmd = send.mock.calls[0]![0] as DescribeContributorInsightsCommand;
    expect(cmd).toBeInstanceOf(DescribeContributorInsightsCommand);
    expect(cmd.input).toEqual({ TableName: 't', IndexName: 'gsi' });
  });

  it('waits for DISABLED after a DISABLE, and sends no IndexName for the table', async () => {
    insights('DISABLING', 'DISABLED');
    await waitForContributorInsightsSettled(client, 't', undefined, 'DISABLE', 'table t', opts);
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0]![0] as DescribeContributorInsightsCommand).input).toEqual({
      TableName: 't',
    });
  });

  it('fails on FAILED after the grace polls, with AWS reason in debug only', async () => {
    const failed = { status: 'FAILED', desc: 'role arn:aws:iam::123456789012:role/SECRET' };
    insights('ENABLING', ...Array(SETTLE_STALE_READ_GRACE_POLLS).fill(failed));
    const err = await waitForContributorInsightsSettled(
      client,
      't',
      undefined,
      'ENABLE',
      'table t',
      opts
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Contributor Insights on table t failed (status FAILED');
    expect((err as Error).message).not.toContain('123456789012');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('role/***'));
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(send).toHaveBeenCalledTimes(SETTLE_STALE_READ_GRACE_POLLS + 1);
  });

  it('after a call that answered ENABLING, a first ENABLED read (a Mode change on an enabled table) is not the result', async () => {
    insights('ENABLED', 'ENABLING', 'ENABLED');
    await waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', {
      ...opts,
      answeredStatus: 'ENABLING',
    });
    expect(send).toHaveBeenCalledTimes(3);
    send.mockReset();
    insights('ENABLED');
    await waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', {
      ...opts,
      answeredStatus: 'ENABLED',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads a stale FAILED from an earlier attempt as pending within the grace', async () => {
    insights('FAILED', 'ENABLING', 'ENABLED');
    await waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', opts);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('reads again after a throttled read, and fails at once on any other read error', async () => {
    send
      .mockRejectedValueOnce(
        Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
      )
      .mockResolvedValueOnce({ ContributorInsightsStatus: 'ENABLED' });
    await waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', opts);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockReset();
    send.mockRejectedValue(Object.assign(new Error('nope'), { name: 'ValidationException' }));
    await expect(
      waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', opts)
    ).rejects.toThrow('nope');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads the opposite settled status as stale for the grace polls, then fails', async () => {
    insights(...Array(SETTLE_STALE_READ_GRACE_POLLS).fill('DISABLED'), 'ENABLED');
    await waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', opts);
    send.mockReset();
    insights(...Array(SETTLE_STALE_READ_GRACE_POLLS + 1).fill('DISABLED'));
    await expect(
      waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', opts)
    ).rejects.toThrow('settled as DISABLED, expected ENABLED');
  });

  it('throws, never returns, when its poll cap runs out', async () => {
    send.mockResolvedValue({ ContributorInsightsStatus: 'ENABLING' });
    await expect(
      waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', {
        ...opts,
        maxPolls: 3,
      })
    ).rejects.toThrow(/still ENABLING .*not confirmed/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('throws its own not-confirmed error once the resource deadline has expired', async () => {
    send.mockResolvedValue({ ContributorInsightsStatus: 'ENABLING' });
    const error = await withResourceDeadline(
      () =>
        waitForContributorInsightsSettled(client, 't', undefined, 'ENABLE', 'table t', {
          ...opts,
          pollMs: 60_000,
        }),
      { warnAfterMs: 20, timeoutMs: 40, onTimeout: () => new Error('resource deadline fired') }
    ).then(
      () => {
        throw new Error('expected the wait to fail');
      },
      (e: unknown) => e
    );
    // The sleep is clamped to the deadline, so the wait wakes, sees it
    // expired, and reports the change as not confirmed (the engine's own
    // timeout error may win the race; neither reports success).
    expect(String(error)).toMatch(/resource deadline fired|not confirmed/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops on Ctrl-C with the interrupt error, without another read', async () => {
    const baseline = process.listeners('SIGINT');
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    interruptWatchTestSeam.forceQuit = vi.fn();
    try {
      send.mockImplementation(async () => {
        for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
          (l as unknown as () => void)();
        }
        return { ContributorInsightsStatus: 'ENABLING' };
      });
      const error = await waitForContributorInsightsSettled(
        client,
        't',
        undefined,
        'ENABLE',
        'table t',
        opts
      ).then(
        () => {
          throw new Error('expected the wait to fail');
        },
        (e: unknown) => e
      );
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
      delete interruptWatchTestSeam.forceQuit;
    }
  });
});

describe('waitForKinesisEnableActive (#7132)', () => {
  it('polls through ENABLING and returns on ACTIVE for the stream it enabled', async () => {
    destinations(
      [{ StreamArn: STREAM, DestinationStatus: 'ENABLING' }],
      [
        { StreamArn: 'arn:other', DestinationStatus: 'ENABLE_FAILED' },
        { StreamArn: STREAM, DestinationStatus: 'ACTIVE' },
      ]
    );
    await waitForKinesisEnableActive(client, 't', STREAM, 'table t', opts);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(DescribeKinesisStreamingDestinationCommand);
  });

  it('judges the live entry over a lingering ENABLE_FAILED history entry', async () => {
    destinations(
      [
        { StreamArn: STREAM, DestinationStatus: 'ENABLE_FAILED' },
        { StreamArn: STREAM, DestinationStatus: 'ENABLING' },
      ],
      [
        { StreamArn: STREAM, DestinationStatus: 'ENABLE_FAILED' },
        { StreamArn: STREAM, DestinationStatus: 'ACTIVE' },
      ]
    );
    await waitForKinesisEnableActive(client, 't', STREAM, 'table t', opts);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails on ENABLE_FAILED after the grace polls, with AWS reason in debug only', async () => {
    const failed = [
      {
        StreamArn: STREAM,
        DestinationStatus: 'ENABLE_FAILED',
        DestinationStatusDescription: 'denied for arn:aws:iam::123456789012:role/SECRET',
      },
    ];
    destinations(...Array(SETTLE_STALE_READ_GRACE_POLLS + 1).fill(failed));
    const err = await waitForKinesisEnableActive(client, 't', STREAM, 'table t', opts).catch(
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('settled as ENABLE_FAILED, expected ACTIVE');
    expect((err as Error).message).not.toContain('role/');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('role/***'));
    expect(send).toHaveBeenCalledTimes(SETTLE_STALE_READ_GRACE_POLLS + 1);
  });

  it('fails when the destination never appears', async () => {
    send.mockResolvedValue({ KinesisDataStreamDestinations: [] });
    await expect(waitForKinesisEnableActive(client, 't', STREAM, 'table t', opts)).rejects.toThrow(
      'settled as absent, expected ACTIVE'
    );
  });

  it('throws, never returns, when its poll cap runs out', async () => {
    send.mockResolvedValue({
      KinesisDataStreamDestinations: [{ StreamArn: STREAM, DestinationStatus: 'ENABLING' }],
    });
    await expect(
      waitForKinesisEnableActive(client, 't', STREAM, 'table t', { ...opts, maxPolls: 2 })
    ).rejects.toThrow(/still ENABLING .*not confirmed/);
  });
});
