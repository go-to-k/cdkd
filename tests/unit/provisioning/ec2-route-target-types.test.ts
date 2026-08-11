import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateRouteCommand,
  DeleteRouteCommand,
  DescribeRouteTablesCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * AWS::EC2::Route extra-target-type backfill (issue #609): the six formerly
 * silent-drop properties — CarrierGatewayId, CoreNetworkArn,
 * DestinationPrefixListId, LocalGatewayId, TransitGatewayId, VpcEndpointId —
 * must reach the CreateRoute wire call, round-trip through the
 * `<routeTableId>|<destination>` physicalId (prefix-list destinations
 * included), and read back for drift.
 */
describe('EC2Provider AWS::EC2::Route extra target types (#609)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EC2Provider();
  });

  const createInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateRouteCommand);
    expect(call).toBeDefined();
    return (call![0] as CreateRouteCommand).input as unknown as Record<string, unknown>;
  };

  const deleteInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteRouteCommand);
    expect(call).toBeDefined();
    return (call![0] as DeleteRouteCommand).input as unknown as Record<string, unknown>;
  };

  describe('create: new target types reach the CreateRoute wire call', () => {
    it.each([
      ['CarrierGatewayId', 'cagw-0123456789abcdef0'],
      ['CoreNetworkArn', 'arn:aws:networkmanager::123456789012:core-network/core-network-abc'],
      ['LocalGatewayId', 'lgw-0123456789abcdef0'],
      ['TransitGatewayId', 'tgw-0123456789abcdef0'],
      ['VpcEndpointId', 'vpce-0123456789abcdef0'],
    ])('%s is forwarded', async (key, value) => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.create('Route', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-111',
        DestinationCidrBlock: '10.1.0.0/16',
        [key]: value,
      });
      expect(createInput()).toEqual(
        expect.objectContaining({
          RouteTableId: 'rtb-111',
          DestinationCidrBlock: '10.1.0.0/16',
          [key]: value,
        })
      );
      expect(result.physicalId).toBe('rtb-111|10.1.0.0/16');
    });

    it('a route with none of the new targets does not send them (false polarity)', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.create('Route', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-111',
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: 'igw-222',
      });
      const input = createInput();
      expect(input['GatewayId']).toBe('igw-222');
      for (const key of [
        'CarrierGatewayId',
        'CoreNetworkArn',
        'LocalGatewayId',
        'TransitGatewayId',
        'VpcEndpointId',
        'DestinationPrefixListId',
      ]) {
        expect(input[key]).toBeUndefined();
      }
    });
  });

  describe('create: DestinationPrefixListId as the route destination', () => {
    it('sends DestinationPrefixListId (no CIDR keys) and keys the physicalId on it', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.create('Route', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-111',
        DestinationPrefixListId: 'pl-0123456789abcdef0',
        TransitGatewayId: 'tgw-333',
      });
      const input = createInput();
      expect(input['DestinationPrefixListId']).toBe('pl-0123456789abcdef0');
      expect(input['DestinationCidrBlock']).toBeUndefined();
      expect(input['DestinationIpv6CidrBlock']).toBeUndefined();
      expect(result.physicalId).toBe('rtb-111|pl-0123456789abcdef0');
    });

    it('a v4 CIDR still wins the destination slot when both are absent-vs-present', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.create('Route', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-111',
        DestinationCidrBlock: '10.2.0.0/16',
        GatewayId: 'igw-222',
      });
      expect(createInput()['DestinationCidrBlock']).toBe('10.2.0.0/16');
      expect(result.physicalId).toBe('rtb-111|10.2.0.0/16');
    });

    it('rejects a route with no destination at all, naming all three forms', async () => {
      await expect(
        provider.create('Route', 'AWS::EC2::Route', {
          RouteTableId: 'rtb-111',
          GatewayId: 'igw-222',
        })
      ).rejects.toThrow(
        /DestinationCidrBlock\/DestinationIpv6CidrBlock\/DestinationPrefixListId are required/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete: destination form is recovered from the physicalId', () => {
    it('pl- destination deletes via DestinationPrefixListId', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Route', 'rtb-111|pl-0123456789abcdef0', 'AWS::EC2::Route');
      const input = deleteInput();
      expect(input['DestinationPrefixListId']).toBe('pl-0123456789abcdef0');
      expect(input['DestinationCidrBlock']).toBeUndefined();
      expect(input['DestinationIpv6CidrBlock']).toBeUndefined();
    });

    it('IPv6 destination still deletes via DestinationIpv6CidrBlock', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Route', 'rtb-111|2001:db8::/32', 'AWS::EC2::Route');
      expect(deleteInput()['DestinationIpv6CidrBlock']).toBe('2001:db8::/32');
    });

    it('v4 destination still deletes via DestinationCidrBlock', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Route', 'rtb-111|10.1.0.0/16', 'AWS::EC2::Route');
      expect(deleteInput()['DestinationCidrBlock']).toBe('10.1.0.0/16');
    });
  });

  describe('update: replacement re-create carries the new targets', () => {
    it('target swap to TransitGatewayId deletes then re-creates with the new target', async () => {
      mockSend.mockResolvedValue({});
      const result = await provider.update(
        'Route',
        'rtb-111|10.1.0.0/16',
        'AWS::EC2::Route',
        {
          RouteTableId: 'rtb-111',
          DestinationCidrBlock: '10.1.0.0/16',
          TransitGatewayId: 'tgw-333',
        },
        {
          RouteTableId: 'rtb-111',
          DestinationCidrBlock: '10.1.0.0/16',
          NatGatewayId: 'nat-444',
        }
      );
      expect(deleteInput()['DestinationCidrBlock']).toBe('10.1.0.0/16');
      expect(createInput()['TransitGatewayId']).toBe('tgw-333');
      expect(result.wasReplaced).toBe(true);
    });
  });

  describe('readCurrentState: drift read covers the new shapes', () => {
    it('matches a prefix-list route and surfaces DestinationPrefixListId', async () => {
      mockSend.mockResolvedValueOnce({
        RouteTables: [
          {
            Routes: [
              { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' },
              {
                DestinationPrefixListId: 'pl-0123456789abcdef0',
                TransitGatewayId: 'tgw-333',
              },
            ],
          },
        ],
      });
      const result = await provider.readCurrentState(
        'rtb-111|pl-0123456789abcdef0',
        'Route',
        'AWS::EC2::Route'
      );
      expect(mockSend.mock.calls[0][0]).toBeInstanceOf(DescribeRouteTablesCommand);
      expect(result).toEqual({
        RouteTableId: 'rtb-111',
        DestinationPrefixListId: 'pl-0123456789abcdef0',
        TransitGatewayId: 'tgw-333',
      });
    });

    it('maps a vpce- GatewayId back to the CFn VpcEndpointId key', async () => {
      mockSend.mockResolvedValueOnce({
        RouteTables: [
          {
            Routes: [
              {
                DestinationCidrBlock: '10.1.0.0/16',
                GatewayId: 'vpce-0123456789abcdef0',
              },
            ],
          },
        ],
      });
      const result = await provider.readCurrentState(
        'rtb-111|10.1.0.0/16',
        'Route',
        'AWS::EC2::Route'
      );
      expect(result).toEqual({
        RouteTableId: 'rtb-111',
        DestinationCidrBlock: '10.1.0.0/16',
        VpcEndpointId: 'vpce-0123456789abcdef0',
      });
    });

    it('keeps a non-vpce GatewayId under GatewayId (false polarity)', async () => {
      mockSend.mockResolvedValueOnce({
        RouteTables: [
          {
            Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-222' }],
          },
        ],
      });
      const result = await provider.readCurrentState(
        'rtb-111|0.0.0.0/0',
        'Route',
        'AWS::EC2::Route'
      );
      expect(result).toEqual({
        RouteTableId: 'rtb-111',
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: 'igw-222',
      });
    });
  });

  it('create wraps AWS failures in ProvisioningError', async () => {
    mockSend.mockRejectedValueOnce(new Error('RouteAlreadyExists'));
    await expect(
      provider.create('Route', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-111',
        DestinationPrefixListId: 'pl-0123456789abcdef0',
        TransitGatewayId: 'tgw-333',
      })
    ).rejects.toThrow(ProvisioningError);
  });
});
