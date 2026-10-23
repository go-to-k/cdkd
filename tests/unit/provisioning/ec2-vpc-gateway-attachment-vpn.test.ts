import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AttachInternetGatewayCommand,
  AttachVpnGatewayCommand,
  DescribeInternetGatewaysCommand,
  DescribeVpnGatewaysCommand,
  DetachInternetGatewayCommand,
  DetachVpnGatewayCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();
const region = vi.hoisted(() => ({ current: 'us-east-1' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve(region.current) } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { getLogger } from '../../../src/utils/logger.js';

const loggerFns = getLogger() as unknown as { warn: ReturnType<typeof vi.fn> };
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';

/**
 * Issue #2762 backfill: `AWS::EC2::VPCGatewayAttachment.VpnGatewayId`. The SDK
 * provider used to send only `AttachInternetGateway`, so a VPN gateway
 * attachment routed through Cloud Control. It now attaches / detaches a VPN
 * gateway itself, waiting on AWS's asynchronous `attaching` / `detaching`
 * transitions the way CloudFormation's handler does.
 */
const TYPE = 'AWS::EC2::VPCGatewayAttachment';
const VPC = 'vpc-0ae97b9333626cb64';
const VGW = 'vgw-0a1b2c3d4e5f60718';
const IGW = 'igw-0803cffd840e0c1fe';

const vgwState = (state: string | undefined, gatewayState = 'available') => ({
  VpnGateways: [
    {
      VpnGatewayId: VGW,
      State: gatewayState,
      VpcAttachments: state === undefined ? [] : [{ VpcId: VPC, State: state }],
    },
  ],
});

const awsError = (name: string, message = name): Error => {
  const err = new Error(message);
  err.name = name;
  return err;
};

const commandsSent = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);

function makeProvider(): EC2Provider {
  const p = new EC2Provider();
  (p as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(() =>
    Promise.resolve()
  );
  return p;
}

describe('EC2Provider VPCGatewayAttachment with a VPN gateway (issue #2762)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    loggerFns.warn.mockClear();
    region.current = 'us-east-1';
  });

  describe('declarations', () => {
    // VpnGatewayId only, not the whole silent-drop list: a property a later
    // schema refresh adds to the type must not fail this suite.
    it('handles VpnGatewayId and no longer reports it as a silent drop', () => {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(TYPE);
      expect(coverage).toBeDefined();
      expect(coverage?.silentDrop.has('VpnGatewayId')).toBe(false);
      expect(coverage?.handled.has('VpnGatewayId')).toBe(true);
      expect(new EC2Provider().handledProperties.get(TYPE)?.has('VpnGatewayId')).toBe(true);
    });
  });

  describe('create', () => {
    it('attaches the VPN gateway, waits for `attached`, and records `<vgwId>|<vpcId>`', async () => {
      mockSend
        .mockResolvedValueOnce({ VpcAttachment: { VpcId: VPC, State: 'attaching' } })
        .mockResolvedValueOnce(vgwState('attaching'))
        .mockResolvedValueOnce(vgwState('attached'));
      await expect(
        makeProvider().create('Attach', TYPE, { VpcId: VPC, VpnGatewayId: VGW })
      ).resolves.toEqual({ physicalId: `${VGW}|${VPC}`, attributes: {} });

      const [attach, ...polls] = mockSend.mock.calls.map((c) => c[0]);
      expect(attach).toBeInstanceOf(AttachVpnGatewayCommand);
      expect((attach as AttachVpnGatewayCommand).input).toEqual({
        VpcId: VPC,
        VpnGatewayId: VGW,
      });
      expect(polls).toHaveLength(2);
      for (const poll of polls) {
        expect(poll).toBeInstanceOf(DescribeVpnGatewaysCommand);
        expect((poll as DescribeVpnGatewaysCommand).input).toEqual({ VpnGatewayIds: [VGW] });
      }
      expect(commandsSent()).not.toContain('AttachInternetGatewayCommand');
    });

    it('a stale `detached` entry beside the new `attaching` one does not end the wait', async () => {
      const both = (current: string) => ({
        VpnGateways: [
          {
            VpnGatewayId: VGW,
            State: 'available',
            VpcAttachments: [
              { VpcId: VPC, State: 'detached' },
              { VpcId: VPC, State: current },
            ],
          },
        ],
      });
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(both('attaching'))
        .mockResolvedValueOnce(both('attached'));
      await makeProvider().create('Attach', TYPE, { VpcId: VPC, VpnGatewayId: VGW });
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('an internet gateway attachment still sends AttachInternetGateway and no wait', async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(
        makeProvider().create('Attach', TYPE, { VpcId: VPC, InternetGatewayId: IGW })
      ).resolves.toEqual({ physicalId: `${IGW}|${VPC}`, attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(AttachInternetGatewayCommand);
    });

    it('refuses a bag naming both gateways, before any AWS call (CloudFormation takes exactly one)', async () => {
      await expect(
        makeProvider().create('Attach', TYPE, {
          VpcId: VPC,
          InternetGatewayId: IGW,
          VpnGatewayId: VGW,
        })
      ).rejects.toThrow(
        'VPCGatewayAttachment Attach specifies both InternetGatewayId and VpnGatewayId'
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a bag naming neither gateway, before any AWS call', async () => {
      await expect(makeProvider().create('Attach', TYPE, { VpcId: VPC })).rejects.toThrow(
        'VpcId and exactly one of InternetGatewayId / VpnGatewayId are required'
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a wait that never reaches `attached` fails with the attachment marked as created', async () => {
      const provider = makeProvider();
      const realNow = Date.now;
      let now = 0;
      Date.now = () => now;
      try {
        mockSend.mockResolvedValueOnce({});
        mockSend.mockImplementation(() => {
          now += 5 * 60 * 1000;
          return Promise.resolve(vgwState('attaching'));
        });
        const error = await provider
          .create('Attach', TYPE, { VpcId: VPC, VpnGatewayId: VGW })
          .then(
            () => undefined,
            (e: unknown) => e
          );
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toContain(
          `did not reach 'attached' within 10 minutes (last state: attaching)`
        );
        expect(createdBeforeFailure(error, 'Attach', TYPE)).toBe(`${VGW}|${VPC}`);
      } finally {
        Date.now = realNow;
      }
    });

    it('a `*.NotFound` on the attach poll throws (it is not "attached") and keeps the mark', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(awsError('InvalidVpnGatewayID.NotFound'));
      const error = await makeProvider()
        .create('Attach', TYPE, { VpcId: VPC, VpnGatewayId: VGW })
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(createdBeforeFailure(error, 'Attach', TYPE)).toBe(`${VGW}|${VPC}`);
    });

    it('a refused AttachVpnGateway leaves no created-before-failure mark', async () => {
      mockSend.mockRejectedValueOnce(awsError('InvalidVpnGatewayID.NotFound'));
      const error = await makeProvider()
        .create('Attach', TYPE, { VpcId: VPC, VpnGatewayId: VGW })
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(createdBeforeFailure(error, 'Attach', TYPE)).toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('detaches the VPN gateway and waits until the attachment is `detached`', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(vgwState('detaching'))
        .mockResolvedValueOnce(vgwState('detached'));
      await makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {});
      const [detach, ...polls] = mockSend.mock.calls.map((c) => c[0]);
      expect(detach).toBeInstanceOf(DetachVpnGatewayCommand);
      expect((detach as DetachVpnGatewayCommand).input).toEqual({
        VpnGatewayId: VGW,
        VpcId: VPC,
      });
      expect(polls.map((p) => (p as object).constructor.name)).toEqual([
        'DescribeVpnGatewaysCommand',
        'DescribeVpnGatewaysCommand',
      ]);
      expect(commandsSent()).not.toContain('DetachInternetGatewayCommand');
    });

    it('a detach that never reaches `detached` fails the delete after the cap', async () => {
      const provider = makeProvider();
      const realNow = Date.now;
      let now = 0;
      Date.now = () => now;
      try {
        mockSend.mockResolvedValueOnce({});
        mockSend.mockImplementation(() => {
          now += 5 * 60 * 1000;
          return Promise.resolve(vgwState('detaching'));
        });
        await expect(provider.delete('Attach', `${VGW}|${VPC}`, TYPE, {})).rejects.toThrow(
          `did not reach 'detached' within 10 minutes (last state: detaching)`
        );
      } finally {
        Date.now = realNow;
      }
    });

    it('an attachment AWS no longer lists counts as detached', async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(vgwState(undefined));
      await makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {});
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('a gateway EC2 no longer knows (`*.NotFound` on the poll) counts as detached', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(awsError('InvalidVpnGatewayID.NotFound'));
      await makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {});
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('a looser not-found-ish poll error is NOT taken as detached', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(awsError('InvalidParameterValue', 'InvalidParameterValue'));
      await expect(makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {})).rejects.toThrow(
        ProvisioningError
      );
    });

    it('a not-found detach still waits out an attachment left `detaching`', async () => {
      mockSend
        .mockRejectedValueOnce(awsError('InvalidVpnGatewayAttachment.NotFound'))
        .mockResolvedValueOnce(vgwState('detaching'))
        .mockResolvedValueOnce(vgwState('detached'));
      await makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('a loosely not-found-shaped detach refusal is thrown at once, not waited out', async () => {
      mockSend.mockRejectedValueOnce(
        awsError('InvalidParameterValue', 'The VPC does not exist in this gateway')
      );
      await expect(makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {})).rejects.toThrow(
        'Failed to delete VPCGatewayAttachment Attach'
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it.each(['IncorrectState', 'InvalidVpnGatewayAttachment.NotFound'])(
      'a re-sent detach refused as %s keeps polling',
      async (name) => {
        mockSend
          .mockRejectedValueOnce(awsError('IncorrectState'))
          .mockResolvedValueOnce(vgwState('attached'))
          .mockRejectedValueOnce(awsError(name))
          .mockResolvedValueOnce(vgwState('detached'));
        await makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {});
        expect(mockSend).toHaveBeenCalledTimes(4);
      }
    );

    it('a re-sent detach refused for another reason fails the delete', async () => {
      mockSend
        .mockRejectedValueOnce(awsError('IncorrectState'))
        .mockResolvedValueOnce(vgwState('attached'))
        .mockRejectedValueOnce(awsError('UnauthorizedOperation'));
      await expect(makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {})).rejects.toThrow(
        'Failed to delete VPCGatewayAttachment Attach'
      );
    });

    it('after an accepted detach, a lagging `attached` read sends no second detach', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(vgwState('attached'))
        .mockResolvedValueOnce(vgwState('detaching'))
        .mockResolvedValueOnce(vgwState('detached'));
      await makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {});
      expect(commandsSent().filter((c) => c === 'DetachVpnGatewayCommand')).toHaveLength(1);
      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    it('an `IncorrectState` detach (an attachment already detaching) goes to the wait', async () => {
      mockSend
        .mockRejectedValueOnce(awsError('IncorrectState'))
        .mockResolvedValueOnce(vgwState('detaching'))
        .mockResolvedValueOnce(vgwState('detached'));
      await makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {});
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('an `IncorrectState` detach of a still-attaching attachment is re-sent once it reads `attached`', async () => {
      mockSend
        .mockRejectedValueOnce(awsError('IncorrectState'))
        .mockResolvedValueOnce(vgwState('attaching'))
        .mockResolvedValueOnce(vgwState('attached'))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(vgwState('detaching'))
        .mockResolvedValueOnce(vgwState('attached'))
        .mockResolvedValueOnce(vgwState('detached'));
      await makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, {});
      // One re-sent detach, never a second one on the later `attached` read.
      expect(commandsSent().filter((c) => c === 'DetachVpnGatewayCommand')).toHaveLength(2);
      expect(mockSend).toHaveBeenCalledTimes(7);
    });

    it('a not-found detach in the wrong region is refused, not skipped', async () => {
      region.current = 'eu-west-1';
      mockSend.mockRejectedValueOnce(awsError('InvalidVpnGatewayAttachment.NotFound'));
      await expect(
        makeProvider().delete('Attach', `${VGW}|${VPC}`, TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).rejects.toThrow('does not match stack state region us-east-1');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('an internet gateway attachment still sends DetachInternetGateway and no poll', async () => {
      mockSend.mockResolvedValueOnce({});
      await makeProvider().delete('Attach', `${IGW}|${VPC}`, TYPE, {});
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DetachInternetGatewayCommand);
    });
  });

  describe('readCurrentState', () => {
    it('an `attached` VPN attachment reads back VpnGatewayId + VpcId', async () => {
      mockSend.mockResolvedValueOnce(vgwState('attached'));
      await expect(
        makeProvider().readCurrentState(`${VGW}|${VPC}`, 'Attach', TYPE)
      ).resolves.toEqual({ VpnGatewayId: VGW, VpcId: VPC });
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DescribeVpnGatewaysCommand);
    });

    it('an `attaching` VPN attachment reads as present, not gone', async () => {
      mockSend.mockResolvedValueOnce(vgwState('attaching'));
      await expect(
        makeProvider().readCurrentState(`${VGW}|${VPC}`, 'Attach', TYPE)
      ).resolves.toEqual({ VpnGatewayId: VGW, VpcId: VPC });
    });

    it.each(['detaching', 'detached', undefined])(
      'a VPN attachment in state %s reads as not found',
      async (state) => {
        mockSend.mockResolvedValueOnce(vgwState(state));
        await expect(
          makeProvider().readCurrentState(`${VGW}|${VPC}`, 'Attach', TYPE)
        ).resolves.toBe(RESOURCE_NOT_FOUND);
      }
    );

    it('a deleted VPN gateway reads as not found', async () => {
      mockSend.mockResolvedValueOnce(vgwState('attached', 'deleted'));
      await expect(
        makeProvider().readCurrentState(`${VGW}|${VPC}`, 'Attach', TYPE)
      ).resolves.toBe(RESOURCE_NOT_FOUND);
    });

    it('an internet gateway attachment still reads DescribeInternetGateways', async () => {
      mockSend.mockResolvedValueOnce({
        InternetGateways: [{ InternetGatewayId: IGW, Attachments: [{ VpcId: VPC }] }],
      });
      await expect(
        makeProvider().readCurrentState(`${IGW}|${VPC}`, 'Attach', TYPE)
      ).resolves.toEqual({ InternetGatewayId: IGW, VpcId: VPC });
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DescribeInternetGatewaysCommand);
    });
  });

  // go-to-k/cdkd#2762 review (M2): a Cloud-Control-shaped record names the
  // attachment TYPE, not the gateway. A pre-v7 row of that shape reaches this
  // provider, and the token must never be sent to AWS as a gateway id.
  describe('a type-token record (`VGW|vpc` / `IGW|vpc`)', () => {
    const FOREIGN_VGW = 'vgw-0999999999999999f';

    it('delete pins a `VGW` record to its recorded VpnGatewayId, with no VPC filter', async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(vgwState('detached'));
      await makeProvider().delete('Attach', `VGW|${VPC}`, TYPE, { VpcId: VPC, VpnGatewayId: VGW });
      const [detach, poll] = mockSend.mock.calls.map((c) => c[0]);
      expect((detach as DetachVpnGatewayCommand).input).toEqual({ VpnGatewayId: VGW, VpcId: VPC });
      expect((poll as DescribeVpnGatewaysCommand).input).toEqual({ VpnGatewayIds: [VGW] });
    });

    it.each([
      ['IGW', 'InternetGatewayId', IGW, DetachInternetGatewayCommand],
      ['InternetGateway', 'InternetGatewayId', IGW, DetachInternetGatewayCommand],
      ['VPN', 'VpnGatewayId', VGW, DetachVpnGatewayCommand],
    ] as const)(
      'delete of a `%s|vpc` record detaches the recorded %s, never the token',
      async (token, prop, id, Command) => {
        mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce(vgwState('detached'));
        await makeProvider().delete('Attach', `${token}|${VPC}`, TYPE, { VpcId: VPC, [prop]: id });
        const detach = mockSend.mock.calls[0]![0] as { input: Record<string, unknown> };
        expect(detach).toBeInstanceOf(Command);
        expect(detach.input).toEqual({ [prop]: id, VpcId: VPC });
      }
    );

    // The deletion-safety case: the record's own gateway was detached out of
    // band and another stack's gateway now sits on the shared VPC. The VPC
    // filter would return the foreign one; the pinned detach never names it.
    it('delete never detaches a foreign gateway the VPC filter would return', async () => {
      mockSend.mockImplementation((command: unknown) => {
        const name = (command as object).constructor.name;
        if (name === 'DetachVpnGatewayCommand') {
          return Promise.reject(awsError('InvalidVpnGatewayAttachment.NotFound'));
        }
        if (name === 'DescribeVpnGatewaysCommand') {
          const ids = (command as DescribeVpnGatewaysCommand).input.VpnGatewayIds;
          if (ids === undefined) {
            return Promise.resolve({
              VpnGateways: [
                {
                  VpnGatewayId: FOREIGN_VGW,
                  State: 'available',
                  VpcAttachments: [{ VpcId: VPC, State: 'attached' }],
                },
              ],
            });
          }
          return Promise.resolve({ VpnGateways: [{ VpnGatewayId: VGW, VpcAttachments: [] }] });
        }
        return Promise.reject(new Error(`unexpected ${name}`));
      });
      await makeProvider().delete(
        'Attach',
        `VGW|${VPC}`,
        TYPE,
        { VpcId: VPC, VpnGatewayId: VGW },
        { expectedRegion: 'us-east-1' }
      );
      const detaches = mockSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof DetachVpnGatewayCommand) as DetachVpnGatewayCommand[];
      expect(detaches.map((d) => d.input.VpnGatewayId)).toEqual([VGW]);
    });

    it('delete of a record naming no gateway refuses one the VPC filter finds, with no detach', async () => {
      mockSend.mockResolvedValueOnce(vgwState('attached'));
      await expect(makeProvider().delete('Attach', `VGW|${VPC}`, TYPE, {})).rejects.toThrow(
        'cdkd cannot tell whether it is this stack'
      );
      expect(commandsSent()).toEqual(['DescribeVpnGatewaysCommand']);
    });

    it('a `detaching` VPN gateway the filter finds is refused too, not read as gone', async () => {
      mockSend.mockResolvedValueOnce(vgwState('detaching'));
      await expect(makeProvider().delete('Attach', `VGW|${VPC}`, TYPE, {})).rejects.toThrow(
        'cdkd cannot tell whether it is this stack'
      );
    });

    it('delete of a token record whose VPC has no such gateway skips, in the recorded region', async () => {
      mockSend.mockResolvedValueOnce({ VpnGateways: [] });
      await makeProvider().delete('Attach', `VGW|${VPC}`, TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });
      expect(commandsSent()).toEqual(['DescribeVpnGatewaysCommand']);
    });

    it('delete of a token record finding nothing in the wrong region is refused', async () => {
      region.current = 'eu-west-1';
      mockSend.mockResolvedValueOnce({ VpnGateways: [] });
      await expect(
        makeProvider().delete('Attach', `VGW|${VPC}`, TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).rejects.toThrow('does not match stack state region us-east-1');
    });

    it('delete refuses an unrecognized gateway segment before any AWS call', async () => {
      await expect(makeProvider().delete('Attach', `bogus|${VPC}`, TYPE, {})).rejects.toThrow(
        'Invalid physicalId format for VPCGatewayAttachment Attach'
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('readCurrentState reads a `VGW` record by its recorded VpnGatewayId', async () => {
      mockSend.mockResolvedValueOnce(vgwState('attached'));
      await expect(
        makeProvider().readCurrentState(`VGW|${VPC}`, 'Attach', TYPE, { VpnGatewayId: VGW })
      ).resolves.toEqual({ VpnGatewayId: VGW, VpcId: VPC });
      expect((mockSend.mock.calls[0]![0] as DescribeVpnGatewaysCommand).input).toEqual({
        VpnGatewayIds: [VGW],
      });
    });

    it.each([`IGW|${VPC}`, `VGW|${VPC}`, `bogus|${VPC}`])(
      'readCurrentState of %s with no recorded gateway is "cannot tell", with no AWS call',
      async (physicalId) => {
        await expect(makeProvider().readCurrentState(physicalId, 'Attach', TYPE, {})).resolves.toBe(
          undefined
        );
        expect(mockSend).not.toHaveBeenCalled();
      }
    );
  });

  // go-to-k/cdkd#5216: CloudFormation swaps the gateway in place ("No
  // interruption"). A fake EC2 holding the attachment table drives each swap.
  describe('update swaps the gateway in place', () => {
    const VGW2 = 'vgw-0f0e0d0c0b0a09080';
    type Fake = {
      attachments: Map<string, string>;
      failAttach?: string[];
      failDetach?: string[];
      stuckAttach?: string;
    };
    const fakeEc2 = (fake: Fake) => (command: unknown) => {
      const input = (command as { input: Record<string, unknown> }).input;
      const name = (command as object).constructor.name;
      const vgwView = (id: string) => ({
        VpnGatewayId: id,
        State: 'available',
        VpcAttachments: fake.attachments.has(id) ? [{ VpcId: VPC, State: fake.attachments.get(id) }] : [],
      });
      switch (name) {
        case 'DescribeVpnGatewaysCommand': {
          clock.now += 60 * 1000;
          const ids = (input['VpnGatewayIds'] as string[] | undefined) ?? [VGW, VGW2];
          return Promise.resolve({ VpnGateways: ids.map(vgwView) });
        }
        case 'DescribeInternetGatewaysCommand':
          return Promise.resolve({
            InternetGateways: [
              {
                InternetGatewayId: IGW,
                Attachments: fake.attachments.has(IGW) ? [{ VpcId: VPC, State: 'available' }] : [],
              },
            ],
          });
        case 'AttachVpnGatewayCommand':
        case 'AttachInternetGatewayCommand': {
          const id = (input['VpnGatewayId'] ?? input['InternetGatewayId']) as string;
          if (fake.failAttach?.includes(id)) return Promise.reject(awsError('UnauthorizedOperation'));
          // Accepted, but never leaves `attaching`: the wait times out.
          fake.attachments.set(id, fake.stuckAttach === id ? 'attaching' : 'attached');
          return Promise.resolve({});
        }
        case 'DetachVpnGatewayCommand':
        case 'DetachInternetGatewayCommand': {
          const id = (input['VpnGatewayId'] ?? input['InternetGatewayId']) as string;
          if (fake.failDetach?.includes(id)) return Promise.reject(awsError('UnauthorizedOperation'));
          fake.attachments.delete(id);
          return Promise.resolve({});
        }
        default:
          return Promise.reject(new Error(`unexpected ${name}`));
      }
    };
    const clock = { now: 0 };
    let realNow: () => number;
    beforeEach(() => {
      realNow = Date.now;
      clock.now = 0;
      Date.now = () => clock.now;
    });
    afterEach(() => {
      Date.now = realNow;
    });
    const mutations = () =>
      commandsSent().filter((c) => /^(Attach|Detach)/.test(c));
    const update = (
      physicalId: string,
      props: Record<string, unknown>,
      previous: Record<string, unknown> = {}
    ) => makeProvider().update('Attach', physicalId, TYPE, { VpcId: VPC, ...props }, previous);

    it('VPN to VPN: detaches the old gateway, attaches the new one, records the new id', async () => {
      const fake: Fake = { attachments: new Map([[VGW, 'attached']]) };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${VGW}|${VPC}`, { VpnGatewayId: VGW2 })).resolves.toEqual({
        physicalId: `${VGW2}|${VPC}`,
        wasReplaced: false,
      });
      expect(mutations()).toEqual(['DetachVpnGatewayCommand', 'AttachVpnGatewayCommand']);
      expect([...fake.attachments.keys()]).toEqual([VGW2]);
    });

    it('internet gateway to VPN: attaches the new kind first, then detaches the old', async () => {
      const fake: Fake = { attachments: new Map([[IGW, 'attached']]) };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${IGW}|${VPC}`, { VpnGatewayId: VGW })).resolves.toEqual({
        physicalId: `${VGW}|${VPC}`,
        wasReplaced: false,
      });
      expect(mutations()).toEqual(['AttachVpnGatewayCommand', 'DetachInternetGatewayCommand']);
    });

    it('VPN to internet gateway: attaches the new kind first, then detaches the old', async () => {
      const fake: Fake = { attachments: new Map([[VGW, 'attached']]) };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${VGW}|${VPC}`, { InternetGatewayId: IGW })).resolves.toEqual({
        physicalId: `${IGW}|${VPC}`,
        wasReplaced: false,
      });
      expect(mutations()).toEqual(['AttachInternetGatewayCommand', 'DetachVpnGatewayCommand']);
    });

    it('an unchanged gateway sends no attach or detach', async () => {
      mockSend.mockImplementation(fakeEc2({ attachments: new Map([[VGW, 'attached']]) }));
      await expect(update(`${VGW}|${VPC}`, { VpnGatewayId: VGW })).resolves.toEqual({
        physicalId: `${VGW}|${VPC}`,
        wasReplaced: false,
      });
      expect(mutations()).toEqual([]);
    });

    it('a failed new attach re-attaches the old gateway and fails the update', async () => {
      const fake: Fake = { attachments: new Map([[VGW, 'attached']]), failAttach: [VGW2] };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${VGW}|${VPC}`, { VpnGatewayId: VGW2 })).rejects.toThrow(
        'Failed to update VPCGatewayAttachment Attach'
      );
      expect(mutations()).toEqual([
        'DetachVpnGatewayCommand',
        'AttachVpnGatewayCommand',
        'AttachVpnGatewayCommand',
      ]);
      expect([...fake.attachments.keys()]).toEqual([VGW]);
    });

    it('same kind: an accepted attach whose wait times out is detached again and the old gateway restored', async () => {
      const fake: Fake = { attachments: new Map([[VGW, 'attached']]), stuckAttach: VGW2 };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${VGW}|${VPC}`, { VpnGatewayId: VGW2 })).rejects.toThrow(
        `did not reach 'attached'`
      );
      expect(mutations()).toEqual([
        'DetachVpnGatewayCommand',
        'AttachVpnGatewayCommand',
        'DetachVpnGatewayCommand',
        'AttachVpnGatewayCommand',
      ]);
      expect([...fake.attachments.entries()]).toEqual([[VGW, 'attached']]);
    });

    it('cross kind: an accepted attach whose wait times out is detached again; the old gateway stays', async () => {
      const fake: Fake = { attachments: new Map([[IGW, 'attached']]), stuckAttach: VGW };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${IGW}|${VPC}`, { VpnGatewayId: VGW })).rejects.toThrow(
        `did not reach 'attached'`
      );
      expect(mutations()).toEqual(['AttachVpnGatewayCommand', 'DetachVpnGatewayCommand']);
      expect([...fake.attachments.keys()]).toEqual([IGW]);
    });

    it('an unchanged gateway AWS no longer holds (a rollback revert) is attached again', async () => {
      const fake: Fake = { attachments: new Map() };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${VGW}|${VPC}`, { VpnGatewayId: VGW })).resolves.toEqual({
        physicalId: `${VGW}|${VPC}`,
        wasReplaced: false,
      });
      expect(mutations()).toEqual(['AttachVpnGatewayCommand']);
    });

    it('re-running an interrupted swap converges without a refused attach or detach', async () => {
      // The old gateway was detached and the new one attached, but the record
      // still names the old one.
      const fake: Fake = { attachments: new Map([[VGW2, 'attached']]) };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${VGW}|${VPC}`, { VpnGatewayId: VGW2 })).resolves.toEqual({
        physicalId: `${VGW2}|${VPC}`,
        wasReplaced: false,
      });
      expect(mutations()).toEqual([]);
    });

    it('a type-token record detaches the old gateway its previous properties name', async () => {
      const fake: Fake = { attachments: new Map([[VGW, 'attached']]) };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(
        update(`VGW|${VPC}`, { VpnGatewayId: VGW2 }, { VpcId: VPC, VpnGatewayId: VGW })
      ).resolves.toEqual({
        physicalId: `${VGW2}|${VPC}`,
        wasReplaced: false,
      });
      const detach = mockSend.mock.calls
        .map((c) => c[0])
        .find((c) => c instanceof DetachVpnGatewayCommand) as DetachVpnGatewayCommand;
      expect(detach.input).toEqual({ VpnGatewayId: VGW, VpcId: VPC });
    });

    it('a type-token record whose VPC holds no such gateway just attaches the new one', async () => {
      const fake: Fake = { attachments: new Map() };
      mockSend.mockImplementation(fakeEc2(fake));
      // The fake's filter lists every VPN gateway; none is attached.
      await expect(update(`VPN|${VPC}`, { VpnGatewayId: VGW2 })).resolves.toEqual({
        physicalId: `${VGW2}|${VPC}`,
        wasReplaced: false,
      });
      expect(mutations()).toEqual(['AttachVpnGatewayCommand']);
    });

    it('a type-token record naming no gateway refuses a swap over one the filter finds', async () => {
      const fake: Fake = { attachments: new Map([[VGW, 'attached']]) };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`VGW|${VPC}`, { VpnGatewayId: VGW2 })).rejects.toThrow(
        'cdkd cannot tell whether it is this stack'
      );
      expect(mutations()).toEqual([]);
    });

    it('a recovery that succeeds warns that the previous gateway is attached again', async () => {
      const fake: Fake = { attachments: new Map([[VGW, 'attached']]), stuckAttach: VGW2 };
      mockSend.mockImplementation(fakeEc2(fake));
      await expect(update(`${VGW}|${VPC}`, { VpnGatewayId: VGW2 })).rejects.toThrow();
      expect(loggerFns.warn).toHaveBeenCalledWith(
        expect.stringContaining(`the previous gateway ${VGW} is attached again, as the record says`)
      );
    });

    it('a recovery whose steps fail is swallowed, and the warn says to redeploy before destroy', async () => {
      const fake: Fake = {
        attachments: new Map([[VGW, 'attached']]),
        stuckAttach: VGW2,
        failDetach: [VGW2],
        failAttach: [VGW],
      };
      mockSend.mockImplementation(fakeEc2(fake));
      // The swap's own error (the timed-out wait), not a recovery step's.
      await expect(update(`${VGW}|${VPC}`, { VpnGatewayId: VGW2 })).rejects.toThrow(
        `did not reach 'attached'`
      );
      const warned = loggerFns.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(`now has attached: ${VGW2}`);
      expect(warned).toContain(`Redeploy before any destroy: a destroy detaches only ${VGW}`);
      expect(warned).toContain(`and ${VGW2} left attached blocks DeleteVpc`);
    });

    it('a VpcId change is refused (create-only), with no AWS call', async () => {
      await expect(
        makeProvider().update(
          'Attach',
          `${VGW}|vpc-0123456789abcdef0`,
          TYPE,
          { VpcId: VPC, VpnGatewayId: VGW },
          {}
        )
      ).rejects.toThrow('VpcId is create-only');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
