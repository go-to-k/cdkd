import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6715: an EIP associated through its own `InstanceId` is still
// associated when a destroy reaches it (the instance is deleted after it), and
// ReleaseAddress refuses that in a non-default VPC with
// `InvalidIPAddress.InUse`. CloudFormation's delete handler disassociates
// first; cdkd does after that refusal, and only its own association.

const { mockSend, providerLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  providerLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

import {
  DescribeAddressesCommand,
  DisassociateAddressCommand,
  ReleaseAddressCommand,
} from '@aws-sdk/client-ec2';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';

const EIP = 'AWS::EC2::EIP';
const ALLOC = 'eipalloc-0aaaaaaaaaaaaaaa1';
const PHYSICAL = `203.0.113.10|${ALLOC}`;
const INSTANCE = 'i-0aaaaaaaaaaaaaaa1';
const CTX = { expectedRegion: 'us-east-1' };

const awsError = (name: string): Error => Object.assign(new Error(name), { name });
const inUse = () => awsError('InvalidIPAddress.InUse');

type Handler = (cmd: unknown) => unknown;

/** Drive the EC2 client: per command class, a queue of answers (last repeats). */
function drive(answers: {
  release: Array<'ok' | Error>;
  describe?: { AssociationId?: string; InstanceId?: string } | Error | 'none';
  disassociate?: 'ok' | Error;
}): string[] {
  const sent: string[] = [];
  let releases = 0;
  const handler: Handler = (cmd) => {
    if (cmd instanceof ReleaseAddressCommand) {
      sent.push('ReleaseAddress');
      const a = answers.release[Math.min(releases++, answers.release.length - 1)];
      if (a instanceof Error) throw a;
      return {};
    }
    if (cmd instanceof DescribeAddressesCommand) {
      sent.push('DescribeAddresses');
      expect(cmd.input.AllocationIds).toEqual([ALLOC]);
      if (answers.describe instanceof Error) throw answers.describe;
      if (answers.describe === 'none') return { Addresses: [] };
      return { Addresses: [{ AllocationId: ALLOC, ...answers.describe }] };
    }
    if (cmd instanceof DisassociateAddressCommand) {
      sent.push(`DisassociateAddress:${cmd.input.AssociationId}`);
      if (answers.disassociate instanceof Error) throw answers.disassociate;
      return {};
    }
    throw new Error(`unexpected command ${(cmd as object).constructor.name}`);
  };
  mockSend.mockImplementation(async (cmd: unknown) => handler(cmd));
  return sent;
}

function provider(): EC2Provider {
  const p = new EC2Provider();
  vi.spyOn(p, 'sleep').mockResolvedValue(undefined);
  return p;
}

describe('AWS::EC2::EIP delete of an associated address (go-to-k/cdkd#6715)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('disassociates its own instance association after an InUse refusal, then releases', async () => {
    const sent = drive({
      release: [inUse(), 'ok'],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
    });
    await provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX);
    expect(sent).toEqual([
      'ReleaseAddress',
      'DescribeAddresses',
      'DisassociateAddress:eipassoc-1',
      'ReleaseAddress',
    ]);
  });

  it('sends no read when the first release succeeds', async () => {
    const sent = drive({ release: ['ok'] });
    await provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX);
    expect(sent).toEqual(['ReleaseAddress']);
  });

  it('retries the release while the disassociation has not settled', async () => {
    const sent = drive({
      release: [inUse(), inUse(), 'ok'],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
    });
    await provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX);
    expect(sent.filter((c) => c === 'ReleaseAddress')).toHaveLength(3);
  });

  it('never disassociates an association another resource made', async () => {
    const sent = drive({
      release: [inUse()],
      describe: { AssociationId: 'eipassoc-2', InstanceId: 'i-0bbbbbbbbbbbbbbb2' },
    });
    await expect(
      provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
    ).rejects.toThrow(/InvalidIPAddress\.InUse/);
    expect(sent).toEqual(['ReleaseAddress', 'DescribeAddresses']);
  });

  it('never disassociates when the record names no instance', async () => {
    const sent = drive({ release: [inUse()] });
    await expect(provider().delete('Eip', PHYSICAL, EIP, {}, CTX)).rejects.toThrow(
      /InvalidIPAddress\.InUse/
    );
    expect(sent).toEqual(['ReleaseAddress']);
  });

  it('marks the delete started when the release after the disassociation is refused', async () => {
    drive({
      release: [inUse(), awsError('UnauthorizedOperation')],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
    });
    const error = await provider()
      .delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(error).toBeInstanceOf(Error);
    expect(isDeleteStarted(error)).toBe(true);
  });

  it('treats an association already gone as disassociated', async () => {
    const sent = drive({
      release: [inUse(), 'ok'],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
      disassociate: awsError('InvalidAssociationID.NotFound'),
    });
    await provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX);
    expect(sent.at(-1)).toBe('ReleaseAddress');
  });

  it('retries the release when the association left after the refusal', async () => {
    const sent = drive({ release: [inUse(), 'ok'], describe: {} });
    await provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX);
    expect(sent).toEqual(['ReleaseAddress', 'DescribeAddresses', 'ReleaseAddress']);
  });

  it('leaves an association already gone unmarked when the retried release is refused', async () => {
    drive({ release: [inUse(), awsError('UnauthorizedOperation')], describe: {} });
    const error = await provider()
      .delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(String((error as Error).message)).toMatch(/UnauthorizedOperation/);
    expect(isDeleteStarted(error)).toBe(false);
  });

  it('marks a disassociation answered not-found when the retried release is refused', async () => {
    drive({
      release: [inUse(), awsError('UnauthorizedOperation')],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
      disassociate: awsError('InvalidAssociationID.NotFound'),
    });
    const error = await provider()
      .delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(isDeleteStarted(error)).toBe(true);
  });

  it('surfaces the InUse refusal when the read returns no address', async () => {
    const sent = drive({ release: [inUse()], describe: 'none' });
    await expect(
      provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
    ).rejects.toThrow(/InvalidIPAddress\.InUse/);
    expect(sent).toEqual(['ReleaseAddress', 'DescribeAddresses']);
  });

  it('reads nothing and disassociates nothing on a first refusal that is not InUse', async () => {
    const sent = drive({
      release: [awsError('UnauthorizedOperation')],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
    });
    await expect(
      provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
    ).rejects.toThrow(/UnauthorizedOperation/);
    expect(sent).toEqual(['ReleaseAddress']);
  });

  it('surfaces the InUse refusal when the address cannot be read', async () => {
    const sent = drive({ release: [inUse()], describe: awsError('UnauthorizedOperation') });
    const error = await provider()
      .delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(String((error as Error).message)).toMatch(/InvalidIPAddress\.InUse/);
    expect(isDeleteStarted(error)).toBe(false);
    expect(sent).toEqual(['ReleaseAddress', 'DescribeAddresses']);
  });

  it('propagates a refused disassociation without releasing again', async () => {
    const sent = drive({
      release: [inUse(), 'ok'],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
      disassociate: awsError('UnauthorizedOperation'),
    });
    const error = await provider()
      .delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(String((error as Error).message)).toMatch(/UnauthorizedOperation/);
    expect(isDeleteStarted(error)).toBe(false);
    expect(sent.filter((c) => c === 'ReleaseAddress')).toHaveLength(1);
  });

  it('gives up after a bounded number of InUse retries, marked started', async () => {
    const sent = drive({
      release: [inUse()],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
    });
    const error = await provider()
      .delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(isDeleteStarted(error)).toBe(true);
    // The first release, then five after the disassociation.
    expect(sent.filter((c) => c === 'ReleaseAddress')).toHaveLength(6);
  });

  it('stops retrying at once on a refusal that is not InUse', async () => {
    const sent = drive({
      release: [inUse(), inUse(), awsError('UnauthorizedOperation'), 'ok'],
      describe: { AssociationId: 'eipassoc-1', InstanceId: INSTANCE },
    });
    await expect(
      provider().delete('Eip', PHYSICAL, EIP, { InstanceId: INSTANCE }, CTX)
    ).rejects.toThrow(/UnauthorizedOperation/);
    expect(sent.filter((c) => c === 'ReleaseAddress')).toHaveLength(3);
  });
});
