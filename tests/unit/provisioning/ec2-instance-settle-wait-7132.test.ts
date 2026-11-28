import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstancesCommand,
  type EC2Client,
} from '@aws-sdk/client-ec2';
import {
  METADATA_STALE_READ_GRACE_POLLS,
  waitForInstanceMetadataOptionsSettled,
  waitForInstanceMonitoringSettled,
  waitForInstanceProfileAssociationSettled,
} from '../../../src/provisioning/providers/ec2/instance-settle-wait.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * go-to-k/cdkd#7132: MonitorInstances / UnmonitorInstances,
 * ModifyInstanceMetadataOptions and the IAM instance profile association
 * calls answer a transitional state, and CloudFormation's instance update
 * completes only once they settle. These pin the waits themselves; the
 * provider wiring is pinned in ec2-instance-settle-wiring-7132.test.ts.
 */

const send = vi.fn();
const debug = vi.fn();
const site = {
  client: { send } as unknown as EC2Client,
  logicalId: 'Web',
  instanceId: 'i-1',
  maskSecrets: (s: string) => s.replaceAll('SECRET', '***'),
  debug,
  pollMs: 0,
};

function monitoring(...states: string[]): void {
  for (const s of states) {
    send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: 'i-1', Monitoring: { State: s } }] }],
    });
  }
}

function metadata(...reads: Array<Record<string, unknown>>): void {
  for (const md of reads) {
    send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: 'i-1', MetadataOptions: md }] }],
    });
  }
}

function associations(...reads: Array<Array<Record<string, unknown>>>): void {
  for (const r of reads) send.mockResolvedValueOnce({ IamInstanceProfileAssociations: r });
}

const PROFILE = 'arn:aws:iam::123456789012:instance-profile/path/web-profile';

beforeEach(() => {
  send.mockReset();
  debug.mockReset();
});

afterEach(() => {
  delete process.env['CDKD_NO_WAIT'];
});

describe('waitForInstanceMonitoringSettled (#7132)', () => {
  it('reads the stale disabled and pending after MonitorInstances, and returns on enabled', async () => {
    monitoring('disabled', 'pending', 'enabled');
    await waitForInstanceMonitoringSettled(site, true);
    expect(send).toHaveBeenCalledTimes(3);
    const cmd = send.mock.calls[0]![0] as DescribeInstancesCommand;
    expect(cmd).toBeInstanceOf(DescribeInstancesCommand);
    expect(cmd.input).toEqual({ InstanceIds: ['i-1'] });
  });

  it('reads the stale enabled and disabling after UnmonitorInstances, and returns on disabled', async () => {
    monitoring('enabled', 'disabling', 'disabled');
    await waitForInstanceMonitoringSettled(site, false);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('throws non-retryably, never returns, when its poll cap runs out', async () => {
    send.mockResolvedValue({
      Reservations: [{ Instances: [{ Monitoring: { State: 'pending' } }] }],
    });
    const err = await waitForInstanceMonitoringSettled({ ...site, maxPolls: 3 }, true).catch(
      (e: unknown) => e
    );
    expect(String(err)).toMatch(/still pending .*not confirmed/);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('skips the wait under --no-wait, with a debug line and no read', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await waitForInstanceMonitoringSettled(site, true);
    expect(send).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('CDKD_NO_WAIT=true'));
  });

  it('reads again after a throttled or 5xx read, and fails at once on any other read error', async () => {
    send
      .mockRejectedValueOnce(Object.assign(new Error('slow down'), { name: 'RequestLimitExceeded' }))
      .mockRejectedValueOnce(
        Object.assign(new Error('oops'), {
          name: 'InternalError',
          $metadata: { httpStatusCode: 500 },
          $fault: 'server',
        })
      );
    monitoring('enabled');
    await waitForInstanceMonitoringSettled(site, true);
    expect(send).toHaveBeenCalledTimes(3);
    send.mockReset();
    send.mockRejectedValue(
      Object.assign(new Error('gone'), { name: 'InvalidInstanceID.NotFound' })
    );
    await expect(waitForInstanceMonitoringSettled(site, true)).rejects.toThrow('gone');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throws its own not-confirmed error once the resource deadline has expired', async () => {
    send.mockResolvedValue({
      Reservations: [{ Instances: [{ Monitoring: { State: 'pending' } }] }],
    });
    const error = await withResourceDeadline(
      () => waitForInstanceMonitoringSettled({ ...site, pollMs: 60_000 }, true),
      { warnAfterMs: 20, timeoutMs: 40, onTimeout: () => new Error('resource deadline fired') }
    ).then(
      () => {
        throw new Error('expected the wait to fail');
      },
      (e: unknown) => e
    );
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
        return { Reservations: [{ Instances: [{ Monitoring: { State: 'pending' } }] }] };
      });
      const error = await waitForInstanceMonitoringSettled(site, true).then(
        () => {
          throw new Error('expected the wait to fail');
        },
        (e: unknown) => e
      );
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      disarmInterruptWatchForTests();
    }
  });
});

describe('waitForInstanceMetadataOptionsSettled (#7132)', () => {
  const requested = { HttpTokens: 'required', HttpPutResponseHopLimit: 2 } as const;

  it('polls through pending and returns on applied with the requested values', async () => {
    metadata(
      { State: 'pending', HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
      { State: 'applied', HttpTokens: 'required', HttpPutResponseHopLimit: 2 }
    );
    await waitForInstanceMetadataOptionsSettled(site, requested);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reads an applied read with the old values as stale for the grace polls, then takes applied', async () => {
    const old = { State: 'applied', HttpTokens: 'optional', HttpPutResponseHopLimit: 1 };
    metadata(old, { State: 'applied', HttpTokens: 'required', HttpPutResponseHopLimit: 2 });
    await waitForInstanceMetadataOptionsSettled(site, requested);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockReset();
    metadata(...Array(METADATA_STALE_READ_GRACE_POLLS + 1).fill(old));
    await waitForInstanceMetadataOptionsSettled(site, requested);
    expect(send).toHaveBeenCalledTimes(METADATA_STALE_READ_GRACE_POLLS + 1);
  });

  it('throws non-retryably when its poll cap runs out on pending', async () => {
    send.mockResolvedValue({
      Reservations: [{ Instances: [{ MetadataOptions: { State: 'pending' } }] }],
    });
    const err = await waitForInstanceMetadataOptionsSettled(
      { ...site, maxPolls: 2 },
      requested
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/still pending .*not confirmed/);
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('skips the wait under --no-wait', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await waitForInstanceMetadataOptionsSettled(site, requested);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('waitForInstanceProfileAssociationSettled (#7132)', () => {
  it('waits for the answered association id to read associated, ignoring the old one', async () => {
    associations(
      [
        { AssociationId: 'old', State: 'disassociating', IamInstanceProfile: { Arn: 'x' } },
        { AssociationId: 'new', State: 'associating', IamInstanceProfile: { Arn: PROFILE } },
      ],
      [{ AssociationId: 'new', State: 'associated', IamInstanceProfile: { Arn: PROFILE } }]
    );
    await waitForInstanceProfileAssociationSettled(site, {
      kind: 'associated',
      associationId: 'new',
    });
    expect(send).toHaveBeenCalledTimes(2);
    const cmd = send.mock.calls[0]![0] as DescribeIamInstanceProfileAssociationsCommand;
    expect(cmd).toBeInstanceOf(DescribeIamInstanceProfileAssociationsCommand);
    expect(cmd.input).toEqual({ Filters: [{ Name: 'instance-id', Values: ['i-1'] }] });
  });

  it('reads an association not yet listed as pending', async () => {
    associations(
      [],
      [{ AssociationId: 'new', State: 'associated', IamInstanceProfile: { Arn: PROFILE } }]
    );
    await waitForInstanceProfileAssociationSettled(site, {
      kind: 'associated',
      associationId: 'new',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('matches the requested profile by name when the call answered no association id', async () => {
    associations(
      [{ AssociationId: 'a', State: 'associating', IamInstanceProfile: { Arn: PROFILE } }],
      [{ AssociationId: 'a', State: 'associated', IamInstanceProfile: { Arn: PROFILE } }]
    );
    await waitForInstanceProfileAssociationSettled(site, {
      kind: 'associated',
      name: 'web-profile',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('fails non-retryably when the new association reads disassociated', async () => {
    associations([
      { AssociationId: 'new', State: 'disassociated', IamInstanceProfile: { Arn: PROFILE } },
    ]);
    const err = await waitForInstanceProfileAssociationSettled(site, {
      kind: 'associated',
      associationId: 'new',
    }).catch((e: unknown) => e);
    expect(String(err)).toContain('settled as disassociated, expected associated');
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('after a disassociate, waits until the association is gone', async () => {
    associations(
      [{ AssociationId: 'old', State: 'disassociating' }],
      [{ AssociationId: 'old', State: 'disassociating' }],
      []
    );
    await waitForInstanceProfileAssociationSettled(site, {
      kind: 'disassociated',
      associationId: 'old',
    });
    expect(send).toHaveBeenCalledTimes(3);
    send.mockReset();
    associations([{ AssociationId: 'old', State: 'disassociated' }]);
    await waitForInstanceProfileAssociationSettled(site, {
      kind: 'disassociated',
      associationId: 'old',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throws non-retryably when its poll cap runs out on associating', async () => {
    send.mockResolvedValue({
      IamInstanceProfileAssociations: [{ AssociationId: 'new', State: 'associating' }],
    });
    const err = await waitForInstanceProfileAssociationSettled(
      { ...site, maxPolls: 2 },
      { kind: 'associated', associationId: 'new' }
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/still associating .*not confirmed/);
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('skips the wait under --no-wait', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    await waitForInstanceProfileAssociationSettled(site, {
      kind: 'disassociated',
      associationId: 'old',
    });
    expect(send).not.toHaveBeenCalled();
  });
});
