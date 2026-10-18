import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateRouteCommand, DeleteRouteCommand, ReplaceRouteCommand } from '@aws-sdk/client-ec2';

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
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';

/**
 * Issue #5068: an `AWS::EC2::Route` TARGET change is one atomic `ReplaceRoute`,
 * as CloudFormation does it ("Update requires: No interruption"), never a
 * `DeleteRoute` + `CreateRoute`, which left the route table without the route
 * between the two calls and lost it outright when the create was refused.
 * Delete + create stays only for a bag that names a different route than the
 * physical id (a route table or destination change, both createOnly).
 */
describe('EC2Provider AWS::EC2::Route target change uses ReplaceRoute (#5068)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new EC2Provider();
  });

  const sentOf = <T>(ctor: new (...args: never[]) => T): T[] =>
    mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
  const replaceInputs = (): Array<Record<string, unknown>> =>
    sentOf(ReplaceRouteCommand).map((c) => c.input as unknown as Record<string, unknown>);
  const deleteOrCreateSent = (): boolean =>
    sentOf(DeleteRouteCommand).length > 0 || sentOf(CreateRouteCommand).length > 0;

  // Derived, not hand-listed: every handled property that is not createOnly is
  // a target. A target cdkd learns to handle later joins this population on its
  // own, and fails here until the ReplaceRoute arm carries it too.
  const createOnly = new Set(
    (CREATE_ONLY_PATHS_SNAPSHOT.get('AWS::EC2::Route') ?? []).map((path) => path.join('.'))
  );
  const targetKeys = [...(PROPERTY_COVERAGE_BY_TYPE.get('AWS::EC2::Route')?.handled ?? [])]
    .filter((key) => !createOnly.has(key))
    .sort();

  it('derives the eleven CloudFormation target keys', () => {
    expect(createOnly).toEqual(
      new Set([
        'DestinationCidrBlock',
        'DestinationIpv6CidrBlock',
        'DestinationPrefixListId',
        'RouteTableId',
      ])
    );
    expect(targetKeys).toEqual([
      'CarrierGatewayId',
      'CoreNetworkArn',
      'EgressOnlyInternetGatewayId',
      'GatewayId',
      'InstanceId',
      'LocalGatewayId',
      'NatGatewayId',
      'NetworkInterfaceId',
      'TransitGatewayId',
      'VpcEndpointId',
      'VpcPeeringConnectionId',
    ]);
  });

  describe('the in-place arm', () => {
    const PREVIOUS_TARGET_OF: Record<string, string> = { GatewayId: 'NatGatewayId' };

    it.each(targetKeys)(
      'a change to %s is one ReplaceRoute carrying it, and nothing is deleted',
      async (key) => {
        const previousKey = PREVIOUS_TARGET_OF[key] ?? 'GatewayId';
        const result = await provider.update(
          'Route',
          'rtb-1|0.0.0.0/0',
          'AWS::EC2::Route',
          { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', [key]: 'new-target' },
          { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', [previousKey]: 'old-target' }
        );

        expect(deleteOrCreateSent()).toBe(false);
        const inputs = replaceInputs();
        expect(inputs).toHaveLength(1);
        const defined = Object.fromEntries(
          Object.entries(inputs[0]!).filter(([, value]) => value !== undefined)
        );
        expect(defined).toEqual({
          RouteTableId: 'rtb-1',
          DestinationCidrBlock: '0.0.0.0/0',
          [key]: 'new-target',
        });
        expect(result).toEqual({ physicalId: 'rtb-1|0.0.0.0/0', wasReplaced: false });
      }
    );

    it.each([
      ['DestinationIpv6CidrBlock', '::/0'],
      ['DestinationPrefixListId', 'pl-0123456789abcdef0'],
      ['DestinationCidrBlock', '10.1.0.0/16'],
    ])('sends %s as the destination and no other', async (destinationKey, destination) => {
      await provider.update(
        'Route',
        `rtb-1|${destination}`,
        'AWS::EC2::Route',
        { RouteTableId: 'rtb-1', [destinationKey]: destination, TransitGatewayId: 'tgw-1' },
        { RouteTableId: 'rtb-1', [destinationKey]: destination, GatewayId: 'igw-1' }
      );

      expect(deleteOrCreateSent()).toBe(false);
      const input = replaceInputs()[0]!;
      const destinationsSent = Object.keys(input).filter(
        (k) => k.startsWith('Destination') && input[k] !== undefined
      );
      expect(destinationsSent).toEqual([destinationKey]);
      expect(input[destinationKey]).toBe(destination);
      expect(input['TransitGatewayId']).toBe('tgw-1');
      expect(input['GatewayId']).toBeUndefined();
    });

    it('a rollback revert of a target change replaces the target back in place', async () => {
      // The rollback executor reverts an in-place update by calling update()
      // with the recorded previous bag; `wasReplaced: false` journaled on the
      // forward op is what routes it here instead of a reverse replacement.
      const result = await provider.update(
        'Route',
        'rtb-1|0.0.0.0/0',
        'AWS::EC2::Route',
        { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' },
        { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', TransitGatewayId: 'tgw-1' },
        { replayingState: true }
      );

      expect(deleteOrCreateSent()).toBe(false);
      expect(replaceInputs()[0]?.['GatewayId']).toBe('igw-1');
      expect(replaceInputs()[0]?.['TransitGatewayId']).toBeUndefined();
      expect(result.wasReplaced).toBe(false);
    });

    it('a refused ReplaceRoute fails the update with the route untouched', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('The transitGateway ID tgw-1 does not exist'), {
          name: 'InvalidTransitGatewayID.NotFound',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        })
      );

      const error = await provider
        .update(
          'Route',
          'rtb-1|0.0.0.0/0',
          'AWS::EC2::Route',
          { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', TransitGatewayId: 'tgw-1' },
          { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as ProvisioningError).message).toMatch(/^Failed to update Route Route: /);
      expect((error as ProvisioningError).physicalId).toBe('rtb-1|0.0.0.0/0');
      // The point of the fix: a refusal no longer follows a delete.
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(deleteOrCreateSent()).toBe(false);
    });
  });

  describe('the delete + create arm, for a bag naming another route', () => {
    it.each([
      [
        'a destination change',
        { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.2.0.0/16', GatewayId: 'igw-2' },
        'rtb-1|10.2.0.0/16',
      ],
      [
        'a route table change',
        { RouteTableId: 'rtb-2', DestinationCidrBlock: '10.1.0.0/16', GatewayId: 'igw-2' },
        'rtb-2|10.1.0.0/16',
      ],
    ])('%s deletes the recorded route, then creates the desired one', async (_l, props, id) => {
      const result = await provider.update(
        'Route',
        'rtb-1|10.1.0.0/16',
        'AWS::EC2::Route',
        props,
        { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.1.0.0/16', GatewayId: 'igw-1' }
      );

      expect(sentOf(ReplaceRouteCommand)).toHaveLength(0);
      const deleteAt = mockSend.mock.calls.findIndex((c) => c[0] instanceof DeleteRouteCommand);
      const createAt = mockSend.mock.calls.findIndex((c) => c[0] instanceof CreateRouteCommand);
      expect(deleteAt).toBeGreaterThanOrEqual(0);
      expect(createAt).toBeGreaterThan(deleteAt);
      expect(sentOf(DeleteRouteCommand)[0]?.input).toEqual({
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '10.1.0.0/16',
      });
      expect(result.wasReplaced).toBe(true);
      expect(result.physicalId).toBe(id);
    });
  });

  it('an unchanged bag still sends nothing', async () => {
    const props = { RouteTableId: 'rtb-1', DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' };
    const result = await provider.update('Route', 'rtb-1|0.0.0.0/0', 'AWS::EC2::Route', props, {
      ...props,
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(result).toEqual({ physicalId: 'rtb-1|0.0.0.0/0', wasReplaced: false });
  });
});
