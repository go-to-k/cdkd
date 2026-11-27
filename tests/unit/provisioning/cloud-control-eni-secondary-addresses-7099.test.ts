import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#7099 part B: Cloud Control reports an interface's
// `PrivateIpAddresses` change SUCCESS without applying it, where CloudFormation
// applies it in place. cdkd applies the secondary-address difference through
// EC2 Assign/UnassignPrivateIpAddresses, re-reads, and the update succeeds.

const mockCcSend = vi.fn();
const mockCfnSend = vi.fn();
const mockEc2Send = vi.fn();
const mockWarn = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCcSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: mockCfnSend },
  }),
}));

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  class FakeEC2Client {
    send = mockEc2Send;
    destroy(): void {}
  }
  return { ...actual, EC2Client: FakeEC2Client };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import { CC_SILENT_NOOP_TAG } from '../../../src/provisioning/cloud-control/unapplied-update.js';
import { secondaryAddressPlan } from '../../../src/provisioning/cloud-control/eni-secondary-addresses.js';

const ENI = 'AWS::EC2::NetworkInterface';
const P = '10.0.0.5';

type Entry = { PrivateIpAddress: string; Primary: boolean };
const list = (secondaries: string[]): Entry[] => [
  { PrivateIpAddress: P, Primary: true },
  ...secondaries.map((a) => ({ PrivateIpAddress: a, Primary: false })),
];

/**
 * Cloud Control accepts the update and changes nothing; EC2 assigns and
 * unassigns on `held`, which GetResource then reads (unless `stale`).
 */
function serve(initial: string[], opts: { stale?: boolean; refuse?: string } = {}): string[] {
  const held = [...initial];
  mockCfnSend.mockResolvedValue({
    Schema: JSON.stringify({
      createOnlyProperties: ['/properties/PrivateIpAddress', '/properties/SubnetId'],
      writeOnlyProperties: [],
      readOnlyProperties: ['/properties/Id'],
    }),
  });
  const original = [...initial];
  mockCcSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'UpdateResourceCommand':
        return { ProgressEvent: { RequestToken: 'tok', OperationStatus: 'IN_PROGRESS' } };
      case 'GetResourceRequestStatusCommand':
        return { ProgressEvent: { OperationStatus: 'SUCCESS' } };
      case 'GetResourceCommand':
        return {
          ResourceDescription: {
            Properties: JSON.stringify({
              Id: 'eni-1',
              SubnetId: 's',
              PrivateIpAddresses: list((opts.stale ? original : held).slice().sort()),
            }),
          },
        };
      default:
        return {};
    }
  });
  mockEc2Send.mockImplementation(
    async (command: { constructor: { name: string }; input: { PrivateIpAddresses: string[] } }) => {
      const name = command.constructor.name;
      if (opts.refuse === name) {
        throw Object.assign(new Error('Address 10.0.0.9 is in use.'), {
          name: 'InvalidParameterValue',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        });
      }
      for (const a of command.input.PrivateIpAddresses) {
        if (name === 'AssignPrivateIpAddressesCommand') held.push(a);
        else held.splice(held.indexOf(a), 1);
      }
      return {};
    }
  );
  return held;
}

const update = (previous: string[], desired: string[], extra: Record<string, unknown> = {}) =>
  new CloudControlProvider().update(
    'Eni',
    'eni-1',
    ENI,
    { SubnetId: 's', PrivateIpAddresses: list(desired), ...extra },
    { SubnetId: 's', PrivateIpAddresses: list(previous) }
  );

const ec2Calls = (): Array<[string, string[]]> =>
  mockEc2Send.mock.calls.map((c) => {
    const command = c[0] as { constructor: { name: string }; input: Record<string, unknown> };
    return [command.constructor.name, command.input['PrivateIpAddresses'] as string[]];
  });

const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: unknown) => String((e as Error).message)
  );

describe('an interface secondary-address change Cloud Control did not apply (go-to-k/cdkd#7099)', () => {
  beforeEach(() => {
    mockCcSend.mockReset();
    mockCfnSend.mockReset();
    mockEc2Send.mockReset();
    mockWarn.mockReset();
    clearCreateOnlyPropertiesCache();
  });

  it('assigns an added secondary through EC2, and the update succeeds with it read back', async () => {
    const held = serve([]);
    const result = await update([], ['10.0.0.9']);
    expect(ec2Calls()).toEqual([['AssignPrivateIpAddressesCommand', ['10.0.0.9']]]);
    expect(
      (mockEc2Send.mock.calls[0]![0] as { input: Record<string, unknown> }).input
    ).toMatchObject({ NetworkInterfaceId: 'eni-1', AllowReassignment: false });
    expect(held).toEqual(['10.0.0.9']);
    expect(result.physicalId).toBe('eni-1');
    // Re-read after EC2: the last GetResource follows the assignment.
    const order = mockCcSend.mock.invocationCallOrder.filter(
      (_, i) =>
        (mockCcSend.mock.calls[i]![0] as { constructor: { name: string } }).constructor.name ===
        'GetResourceCommand'
    );
    expect(Math.max(...order)).toBeGreaterThan(mockEc2Send.mock.invocationCallOrder[0]!);
    expect(mockWarn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      CC_SILENT_NOOP_TAG
    );
  });

  it('assigns the new secondary before it unassigns the old one', async () => {
    const held = serve(['10.0.0.8']);
    await update(['10.0.0.8'], ['10.0.0.9']);
    expect(ec2Calls()).toEqual([
      ['AssignPrivateIpAddressesCommand', ['10.0.0.9']],
      ['UnassignPrivateIpAddressesCommand', ['10.0.0.8']],
    ]);
    expect(held).toEqual(['10.0.0.9']);
  });

  it('unassigns a secondary the template drops from the list', async () => {
    serve(['10.0.0.8', '10.0.0.9']);
    await update(['10.0.0.8', '10.0.0.9'], ['10.0.0.9']);
    expect(ec2Calls()).toEqual([['UnassignPrivateIpAddressesCommand', ['10.0.0.8']]]);
  });

  it('fails naming the EC2 call and its reason when EC2 refuses, and unassigns nothing', async () => {
    serve(['10.0.0.8'], { refuse: 'AssignPrivateIpAddressesCommand' });
    const message = await failure(update(['10.0.0.8'], ['10.0.0.9']));
    expect(message).toContain('EC2 AssignPrivateIpAddresses (10.0.0.9) was refused');
    expect(message).toContain('is in use');
    expect(ec2Calls().map(([name]) => name)).toEqual(['AssignPrivateIpAddressesCommand']);
  });

  it('keeps the failure when the re-read still lacks the address', async () => {
    serve([], { stale: true });
    const message = await failure(update([], ['10.0.0.9']));
    expect(message).toContain(
      `${CC_SILENT_NOOP_TAG} Cloud Control reported success but PrivateIpAddresses still holds its previous value`
    );
  });

  it('leaves a list that also declares SecondaryPrivateIpAddressCount to the failure', async () => {
    serve([]);
    const message = await failure(
      update([], ['10.0.0.9'], { SecondaryPrivateIpAddressCount: 1 })
    );
    expect(message).toContain(CC_SILENT_NOOP_TAG);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });
});

describe('secondaryAddressPlan (go-to-k/cdkd#7099)', () => {
  it('compares secondaries as a set and reads a string Primary', () => {
    expect(
      secondaryAddressPlan(
        {
          PrivateIpAddresses: [
            { PrivateIpAddress: '10.0.0.9', Primary: 'false' },
            { PrivateIpAddress: P, Primary: 'true' },
          ],
        },
        { PrivateIpAddresses: list(['10.0.0.9']) }
      )
    ).toEqual({ assign: [], unassign: [] });
  });

  it('does not cover a different primary, a list without one primary, or a missing model', () => {
    const live = { PrivateIpAddresses: list([]) };
    expect(
      secondaryAddressPlan(
        { PrivateIpAddresses: [{ PrivateIpAddress: '10.0.0.6', Primary: true }] },
        live
      )
    ).toBeUndefined();
    expect(
      secondaryAddressPlan(
        { PrivateIpAddresses: [{ PrivateIpAddress: '10.0.0.9', Primary: false }] },
        live
      )
    ).toBeUndefined();
    expect(secondaryAddressPlan({ PrivateIpAddresses: list(['10.0.0.9']) }, undefined)).toBeUndefined();
  });
});
