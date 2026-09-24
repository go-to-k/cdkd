/**
 * Issue #3455 -- a Cloud-Control-routed `AWS::EC2::Volume` is deleted with EC2
 * `DeleteVolume`, never Cloud Control `DeleteResource`: the registry delete
 * handler was seen taking its own snapshot of the volume and then hanging past
 * the 15-minute wait.
 *
 * Every provider-level case asserts the ROUTE (which client got which call) as
 * well as the outcome, and one negative control keeps a non-volume type on
 * Cloud Control, so a regression in either direction is visible.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockEc2Send = vi.fn();
let ccRegion = 'us-east-1';
let ec2Region = 'us-east-1';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve(ccRegion) },
    },
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve(ec2Region) } },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { deleteEc2VolumeDirect } from '../../../src/provisioning/ec2-volume-delete.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isWaitAbandonedError } from '../../../src/provisioning/wait-abandoned.js';

const VOL = 'vol-0123456789abcdef0';

function awsError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const notFound = () => awsError('InvalidVolume.NotFound', `The volume '${VOL}' does not exist.`);

const callsOf = (send: ReturnType<typeof vi.fn>, cmdName: string) =>
  send.mock.calls.filter((c) => c[0]?.constructor?.name === cmdName);

/**
 * EC2 mock: `DeleteVolume` answers `deleteResult` (resolve or reject), and each
 * `DescribeVolumes` takes the next entry of `states` -- a state string, or
 * `'GONE'` for `InvalidVolume.NotFound`, `'THROTTLE'` for a transient throttle,
 * `'DENIED'` for a non-transient failure. The last entry repeats.
 */
function wireEc2(deleteResult: () => Promise<unknown>, states: string[]): void {
  let describeCall = 0;
  mockEc2Send.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'DeleteVolumeCommand') return deleteResult();
    if (name === 'DescribeVolumesCommand') {
      const state = states[Math.min(describeCall++, states.length - 1)];
      if (state === 'GONE') return Promise.reject(notFound());
      if (state === 'THROTTLE') {
        return Promise.reject(awsError('RequestLimitExceeded', 'Request limit exceeded.'));
      }
      if (state === 'DENIED') {
        return Promise.reject(
          awsError('UnauthorizedOperation', 'You are not authorized to perform this operation.')
        );
      }
      return Promise.resolve({ Volumes: [{ VolumeId: VOL, State: state }] });
    }
    return Promise.reject(new Error(`unexpected EC2 call ${name}`));
  });
}

describe('CloudControlProvider.delete: AWS::EC2::Volume goes through EC2 DeleteVolume (#3455)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    ccRegion = 'us-east-1';
    ec2Region = 'us-east-1';
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-1' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
      }
      return Promise.resolve({});
    });
    provider = new CloudControlProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(() =>
      Promise.resolve()
    );
  });

  it('issues DeleteVolume, waits until the volume is gone, and never calls DeleteResource', async () => {
    wireEc2(() => Promise.resolve({}), ['deleting', 'deleting', 'GONE']);

    const result = await provider.delete('Vol', VOL, 'AWS::EC2::Volume', undefined, {
      expectedRegion: 'us-east-1',
    });

    expect(result).toBeUndefined();
    const deletes = callsOf(mockEc2Send, 'DeleteVolumeCommand');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]![0].input).toEqual({ VolumeId: VOL });
    // Returned only after the third describe reported the volume gone.
    expect(callsOf(mockEc2Send, 'DescribeVolumesCommand')).toHaveLength(3);
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(0);
  });

  it("treats a describe reporting state 'deleted' as gone", async () => {
    wireEc2(() => Promise.resolve({}), ['deleting', 'deleted']);

    await expect(
      provider.delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(callsOf(mockEc2Send, 'DescribeVolumesCommand')).toHaveLength(2);
  });

  it('a DeleteVolume InvalidVolume.NotFound is the idempotent already-deleted success', async () => {
    wireEc2(() => Promise.reject(notFound()), ['GONE']);

    await expect(
      provider.delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(0);
  });

  it('a volume already deleting (IncorrectState) is waited on, not failed', async () => {
    wireEc2(
      () => Promise.reject(awsError('IncorrectState', `The volume '${VOL}' is 'deleting'.`)),
      ['deleting', 'deleting', 'GONE']
    );

    await expect(
      provider.delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(callsOf(mockEc2Send, 'DescribeVolumesCommand')).toHaveLength(3);
  });

  it('IncorrectState on a volume that is NOT deleting surfaces as a failure', async () => {
    wireEc2(
      () => Promise.reject(awsError('IncorrectState', `The volume '${VOL}' is 'in-use'.`)),
      ['in-use']
    );

    await expect(
      provider.delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
    ).rejects.toBeInstanceOf(ProvisioningError);
    // Exactly the one describe that classified the IncorrectState -- no wait.
    expect(callsOf(mockEc2Send, 'DescribeVolumesCommand')).toHaveLength(1);
  });

  it('any other DeleteVolume failure surfaces as a failure (the record is not dropped)', async () => {
    wireEc2(
      () => Promise.reject(awsError('VolumeInUse', `Volume ${VOL} is currently attached to i-0abc`)),
      ['in-use']
    );

    await expect(
      provider.delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow(/VolumeInUse|currently attached/);
    expect(callsOf(mockEc2Send, 'DescribeVolumesCommand')).toHaveLength(0);
  });

  it('refuses, with no EC2 call, when the EC2 client targets a different region than Cloud Control', async () => {
    ec2Region = 'eu-west-1';
    wireEc2(() => Promise.resolve({}), ['GONE']);

    const err = await provider
      .delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProvisioningError);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect((err as Error).message).toContain("targets region 'eu-west-1'");
    // Not a phrase the already-deleted classifiers read as success.
    expect((err as Error).message).not.toMatch(/not found|does not exist|NotFound/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  // A logical id carrying an already-deleted phrase: the provider's catch arm
  // (and the destroy runner's) match message SUBSTRINGS, and both refusals
  // below interpolate the logical id. Each must still REJECT.
  it('a region refusal for a logical id containing "NotFound" still rejects (never read as deleted)', async () => {
    ec2Region = 'eu-west-1';
    wireEc2(() => Promise.resolve({}), ['GONE']);

    const err = await provider
      .delete('DataNotFoundVol', VOL, 'AWS::EC2::Volume', undefined, {
        expectedRegion: 'us-east-1',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProvisioningError);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('a wait timeout for a logical id containing "NotFound" still rejects, marked as an abandoned wait', async () => {
    wireEc2(() => Promise.resolve({}), ['deleting']);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(
        (ms: number) => {
          vi.setSystemTime(Date.now() + ms);
          return Promise.resolve();
        }
      );

      const err = await provider
        .delete('DataNotFoundVol', VOL, 'AWS::EC2::Volume', undefined, {
          expectedRegion: 'us-east-1',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProvisioningError);
      expect(isWaitAbandonedError(err)).toBe(true);
      expect((err as Error).message).toContain("still 'deleting'");
      // Abandoned, not refused: a re-run may re-issue the idempotent delete.
      expect(isMarkedNonRetryable(err)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['gone', ['GONE']],
    ["'deleted'", ['deleted']],
  ])('IncorrectState on a volume already %s is success, not a failure', async (_label, states) => {
    wireEc2(
      () => Promise.reject(awsError('IncorrectState', `The volume '${VOL}' is 'deleting'.`)),
      states
    );

    await expect(
      provider.delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(0);
  });

  it('a describe failure while classifying IncorrectState keeps the ORIGINAL error, with the describe failure as its cause', async () => {
    const incorrect = awsError('IncorrectState', `The volume '${VOL}' is 'in-use'.`);
    wireEc2(() => Promise.reject(incorrect), ['DENIED']);

    const err = await provider
      .delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
      .catch((e: unknown) => e);

    // The provider wraps whatever leaves the helper; what it wrapped must be
    // the DeleteVolume failure itself, not the describe.
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toContain("is 'in-use'");
    const wrapped = (err as { cause?: unknown }).cause;
    expect(wrapped).toBe(incorrect);
    expect((wrapped as { cause?: { name?: string } }).cause?.name).toBe('UnauthorizedOperation');
  });

  it('a transient describe failure during the wait is re-polled, not fatal', async () => {
    wireEc2(() => Promise.resolve({}), ['deleting', 'THROTTLE', 'THROTTLE', 'GONE']);

    await expect(
      provider.delete('Vol', VOL, 'AWS::EC2::Volume', undefined, { expectedRegion: 'us-east-1' })
    ).resolves.toBeUndefined();
    expect(callsOf(mockEc2Send, 'DescribeVolumesCommand')).toHaveLength(4);
  });

  it('an unbroken transient outage past the Cloud Control grace is an abandoned wait', async () => {
    wireEc2(() => Promise.resolve({}), ['deleting', 'THROTTLE']);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(
        (ms: number) => {
          vi.setSystemTime(Date.now() + ms);
          return Promise.resolve();
        }
      );

      const err = await provider
        .delete('DataNotFoundVol', VOL, 'AWS::EC2::Volume', undefined, {
          expectedRegion: 'us-east-1',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProvisioningError);
      expect(isWaitAbandonedError(err)).toBe(true);
      expect((err as Error).message).toMatch(/could not read the volume's state for 1[2-3]\ds/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a NON-transient describe failure during the wait is an abandoned wait at once', async () => {
    wireEc2(() => Promise.resolve({}), ['deleting', 'DENIED']);

    const err = await provider
      .delete('DataNotFoundVol', VOL, 'AWS::EC2::Volume', undefined, {
        expectedRegion: 'us-east-1',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProvisioningError);
    expect(isWaitAbandonedError(err)).toBe(true);
    expect(callsOf(mockEc2Send, 'DescribeVolumesCommand')).toHaveLength(2);
  });

  it('negative control: a non-volume type still deletes through Cloud Control', async () => {
    await provider.delete('Q', 'https://sqs/q', 'AWS::SQS::Queue', undefined, {
      expectedRegion: 'us-east-1',
    });

    expect(callsOf(mockCloudControlSend, 'DeleteResourceCommand')).toHaveLength(1);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });
});

describe('deleteEc2VolumeDirect: bounded wait (#3455)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws after maxWaitMs with the record-kept wording, marked as an abandoned wait', async () => {
    wireEc2(() => Promise.resolve({}), ['deleting']);
    let clock = 0;
    const sleep = vi.fn((ms: number) => {
      clock += ms;
      return Promise.resolve();
    });

    const err = await deleteEc2VolumeDirect(
      { send: mockEc2Send } as never as Parameters<typeof deleteEc2VolumeDirect>[0],
      VOL,
      'Vol',
      {
        logger: { debug: vi.fn() },
        sleep,
        maxWaitMs: 60_000,
        transientGraceMs: 120_000,
        isTransientFailure: () => false,
        now: () => clock,
      }
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toContain("still 'deleting' after 60s");
    expect((err as Error).message).toContain('state record is kept');
    expect(isWaitAbandonedError(err)).toBe(true);
    // It did wait: slept until the budget was spent, not zero times.
    expect(clock).toBeGreaterThanOrEqual(60_000);
  });
});
