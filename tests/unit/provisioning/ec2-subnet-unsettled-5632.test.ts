import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AssociateSubnetCidrBlockCommand, DescribeSubnetsCommand,
  DisassociateSubnetCidrBlockCommand, ModifySubnetAttributeCommand,
} from '@aws-sdk/client-ec2';
import type { SubnetIpv6CidrBlockAssociation } from '@aws-sdk/client-ec2';

const { send, debug } = vi.hoisted(() => ({ send: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ec2: { send, config: { region: async () => 'ap-southeast-1' } } }),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ debug, info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() }),
}));

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { settleUnsettledPrevious, unsettledAfterUpdate } from '../../../src/deployment/unsettled-convergence.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { disarmInterruptWatchForTests, interruptWatchTestSeam, isInterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';

const type = 'AWS::EC2::Subnet';
const first = '2001:db8:1234:1::/64';
const second = '2001:db8:1234:2::/64';
const original = { VpcId: 'vpc-test', CidrBlock: '10.0.0.0/24', Ipv6CidrBlock: first, EnableDns64: false };

describe('subnet partial-update recovery (#5632)', () => {
  let provider: EC2Provider;
  let associations: SubnetIpv6CidrBlockAssociation[];
  let dns64: boolean;
  let failure: 'before-dns64' | 'after-dns64' | undefined;

  beforeEach(() => {
    send.mockReset();
    debug.mockReset();
    associations = [{ AssociationId: 'assoc-old', Ipv6CidrBlock: first, Ipv6CidrBlockState: { State: 'associated' } }];
    dns64 = false;
    failure = undefined;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeSubnetsCommand) {
        return { Subnets: [{ SubnetId: 'subnet-test', Ipv6CidrBlockAssociationSet: associations, EnableDns64: dns64 }] };
      }
      if (command instanceof DisassociateSubnetCidrBlockCommand) {
        const association = associations.find(item => item.AssociationId === command.input.AssociationId)!;
        association.Ipv6CidrBlockState = { State: 'disassociated' };
      }
      if (command instanceof AssociateSubnetCidrBlockCommand) {
        const association: SubnetIpv6CidrBlockAssociation = {
          AssociationId: `assoc-${associations.length}`, Ipv6CidrBlock: command.input.Ipv6CidrBlock,
          Ipv6CidrBlockState: { State: 'associated' },
        };
        associations.push(association);
        return { Ipv6CidrBlockAssociation: association };
      }
      if (command instanceof ModifySubnetAttributeCommand) {
        if (failure === 'before-dns64') throw new Error('DNS64 write refused');
        dns64 = command.input.EnableDns64?.Value ?? dns64;
        if (failure === 'after-dns64') throw new Error('DNS64 response lost');
      }
      return {};
    });
    provider = new EC2Provider();
  });

  const identity = () => ({ provider, physicalId: 'subnet-test', logicalId: 'Subnet', resourceType: type, recordedProperties: original });

  it.each(['Ipv6CidrBlock', 'EnableDns64'] as const)('restores %s after a partially applied update fails', async key => {
    const desired = { ...original, EnableDns64: true, ...(key === 'Ipv6CidrBlock' && { Ipv6CidrBlock: second }) };
    const names = new Set<string>();
    failure = key === 'Ipv6CidrBlock' ? 'before-dns64' : 'after-dns64';
    await expect(provider.update('Subnet', 'subnet-test', type, desired, original, {
      markUnsettled: name => names.add(name),
    })).rejects.toThrow(/DNS64 (write refused|response lost)/);
    expect((await provider.readCurrentState('subnet-test', 'Subnet', type) as Record<string, unknown>)[key]).toBe(desired[key]);
    failure = undefined;
    // The failed update did not replace the recorded bag. Use the same live
    // substitution and proof as deploy, rollback and drift recovery.
    const previous = await settleUnsettledPrevious({ ...identity(), names, previous: original, desired: original });
    await provider.update('Subnet', 'subnet-test', type, original, previous, { replayingState: true, unsettledProperties: names });
    expect((await provider.readCurrentState('subnet-test', 'Subnet', type) as Record<string, unknown>)[key]).toBe(original[key]);
    expect(names.has(key)).toBe(true);
    expect(await unsettledAfterUpdate({ ...identity(), names, desired: original })).toEqual([]);
  });

  it.each(['associating', 'disassociating', 'failing', undefined] as const)('refuses recovery while IPv6 is %s', async state => {
    associations[0]!.Ipv6CidrBlockState = { State: state };
    const names = new Set(['Ipv6CidrBlock']);
    await expect(settleUnsettledPrevious({ ...identity(), names, previous: original, desired: original })).rejects.toThrow(/settled|transition/);
    expect(send.mock.calls.every(([command]) => command instanceof DescribeSubnetsCommand)).toBe(true);
  });

  it.each(['Ipv6CidrBlock', 'EnableDns64'] as const)('converges a directly marked %s even when both recorded bags agree', async key => {
    associations[0]!.Ipv6CidrBlock = second;
    dns64 = true;
    await provider.update('Subnet', 'subnet-test', type, original, original, { unsettledProperties: new Set([key]) });
    expect((await provider.readCurrentState('subnet-test', 'Subnet', type) as Record<string, unknown>)[key]).toBe(original[key]);
  });

  it('does not read a transition beginning between the recovery probes as absence', async () => {
    const implementation = send.getMockImplementation()!;
    let reads = 0;
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeSubnetsCommand && ++reads === 2) {
        associations[0]!.Ipv6CidrBlockState = { State: 'disassociating' };
      }
      return implementation(command);
    });
    await expect(settleUnsettledPrevious({ ...identity(), names: new Set(['Ipv6CidrBlock']), previous: original, desired: {} })).rejects.toThrow(/could not be read/);
  });

  it('ignores historical failed associations when a current association is settled', async () => {
    associations.unshift({ AssociationId: 'assoc-failed', Ipv6CidrBlock: second, Ipv6CidrBlockState: { State: 'failed' } });
    expect(await settleUnsettledPrevious({ ...identity(), names: new Set(['Ipv6CidrBlock']), previous: original, desired: original })).toEqual(original);
  });

  it('does not prove a missing DNS64 readback settled', async () => {
    send.mockImplementation(async () => ({ Subnets: [{ SubnetId: 'subnet-test' }] }));
    const names = new Set(['EnableDns64']);
    expect(await unsettledAfterUpdate({ ...identity(), names, desired: { EnableDns64: true } })).toEqual(['EnableDns64']);
  });

  it('compares Boolean strings to the live Boolean during recovery proof', async () => {
    dns64 = true;
    expect(await unsettledAfterUpdate({ ...identity(), names: new Set(['EnableDns64']), desired: { EnableDns64: 'TRUE' } })).toEqual([]);
  });

  it('keeps read failures unsettled and refuses to derive a removal', async () => {
    send.mockRejectedValue(new Error('read denied'));
    const names = new Set(['Ipv6CidrBlock', 'EnableDns64']);
    await expect(settleUnsettledPrevious({ ...identity(), names, previous: original, desired: {} })).rejects.toThrow(/read|settled/);
    expect(await unsettledAfterUpdate({ ...identity(), names, desired: {} })).toEqual(['EnableDns64', 'Ipv6CidrBlock']);
  });

  it('does not mark reads or validation refusals as mutations', async () => {
    const markUnsettled = vi.fn();
    send.mockRejectedValue(new Error('read denied'));
    await expect(provider.update('Subnet', 'subnet-test', type, { ...original, Ipv6CidrBlock: second }, original, { markUnsettled })).rejects.toThrow('read denied');
    await expect(provider.update('Subnet', 'subnet-test', type, { ...original, EnableDns64: 'invalid' }, original, { markUnsettled })).rejects.toThrow(/must be/);
    expect(markUnsettled).not.toHaveBeenCalled();
  });

  it.each(['failed', 'failing'] as const)('restores the old block when an accepted replacement reads %s', async state => {
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (command: unknown) => {
      const result = await implementation(command);
      if (command instanceof AssociateSubnetCidrBlockCommand && command.input.Ipv6CidrBlock === second) {
        associations.at(-1)!.Ipv6CidrBlockState = { State: state };
      }
      return result;
    });
    await expect(provider.update('Subnet', 'subnet-test', type, { ...original, Ipv6CidrBlock: second }, original)).rejects.toThrow('IPv6 association change failed');
    expect(associations.filter(item => item.Ipv6CidrBlockState?.State === 'associated').map(item => item.Ipv6CidrBlock)).toEqual([first]);
    expect(send.mock.calls.filter(([command]) => command instanceof AssociateSubnetCidrBlockCommand).map(([command]) => command.input.Ipv6CidrBlock)).toEqual([second, first]);
  });

  const keepDetachPending = () => {
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (command: unknown) => {
      const result = await implementation(command);
      if (command instanceof DisassociateSubnetCidrBlockCommand) associations[0]!.Ipv6CidrBlockState = { State: 'disassociating' };
      return result;
    });
  };
  const expectOnlyDetach = () => {
    expect(send.mock.calls.filter(([command]) => command instanceof DisassociateSubnetCidrBlockCommand)).toHaveLength(1);
    expect(send.mock.calls.filter(([command]) => command instanceof AssociateSubnetCidrBlockCommand)).toEqual([]);
  };

  it('bounds a persistently pending detach and never attaches an overlapping replacement', async () => {
    keepDetachPending();
    vi.spyOn(provider as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockResolvedValue();
    const error: unknown = await provider.update('Subnet', 'subnet-test', type, { ...original, Ipv6CidrBlock: second }, original).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Timed out waiting');
    expect(isMarkedNonRetryable(error)).toBe(true);
    // Thirty reads in the update and thirty in its bounded recovery attempt,
    // each preceded by one live baseline read.
    expect(send.mock.calls.filter(([command]) => command instanceof DescribeSubnetsCommand)).toHaveLength(62);
    expectOnlyDetach();
  });

  it('stops a pending detach on SIGINT without replacement or compensation writes', async () => {
    keepDetachPending();
    const names = new Set<string>();
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    const baseline = process.listeners('SIGINT');
    try {
      vi.spyOn(provider as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockImplementation(async () => {
        const ours = process.listeners('SIGINT').filter(listener => !baseline.includes(listener));
        expect(ours).toHaveLength(1);
        for (const listener of ours) (listener as unknown as () => void)();
      });
      const error: unknown = await provider.update('Subnet', 'subnet-test', type, { ...original, Ipv6CidrBlock: second }, original, { markUnsettled: name => names.add(name) }).catch(error => error);
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(names).toEqual(new Set(['Ipv6CidrBlock']));
      expectOnlyDetach();
      expect(send.mock.calls.filter(([command]) => command instanceof DescribeSubnetsCommand)).toHaveLength(2);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    }
  });

  it('stops after the real resource deadline and issues no late recovery writes', async () => {
    keepDetachPending();
    const names = new Set<string>();
    let providerOutcome: Promise<unknown> | undefined;
    vi.useFakeTimers();
    try {
      const outer = withResourceDeadline(() => {
        const pending = provider.update('Subnet', 'subnet-test', type, { ...original, Ipv6CidrBlock: second }, original, { markUnsettled: name => names.add(name) });
        providerOutcome = pending.catch(error => error);
        return pending;
      }, { warnAfterMs: 10, timeoutMs: 100, onTimeout: () => new Error('deadline fired') }).catch(error => error as unknown);
      await vi.runAllTimersAsync();
      expect(await outer).toEqual(new Error('deadline fired'));
      const error = await providerOutcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Timed out waiting');
      expect(names).toEqual(new Set(['Ipv6CidrBlock']));
      expectOnlyDetach();
      expect(send.mock.calls.filter(([command]) => command instanceof DescribeSubnetsCommand)).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits a normalized secret from exhausted DNS64 readback diagnostics', async () => {
    const mask = createSecretMasker(new Map([['TRUE', '{{resolve:secretsmanager:fake}}']]));
    vi.spyOn(provider as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockResolvedValue();
    // AWS accepts the write, but all six reads still return the old value.
    const implementation = send.getMockImplementation()!;
    send.mockImplementation(async (command: unknown) => command instanceof ModifySubnetAttributeCommand ? {} : implementation(command));
    await provider.update('Subnet', 'subnet-test', type, { ...original, EnableDns64: 'TRUE' }, original, { maskSecrets: mask });
    const output = debug.mock.calls.map(([line]) => mask(String(line))).join('\n');
    expect(output).toContain('after 6 reads');
    expect(output).not.toMatch(/TRUE|true/);
  });
});
