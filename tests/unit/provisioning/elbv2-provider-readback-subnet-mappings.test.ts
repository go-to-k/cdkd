/**
 * go-to-k/cdkd#6756: a load balancer's declared `SubnetMappings` is read back
 * from `DescribeLoadBalancers`' `AvailabilityZones[]`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-elastic-load-balancing-v2')
  >('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';

const ARN = 'arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/net/nlb/abc';

describe('ELBv2 LoadBalancer SubnetMappings readback (go-to-k/cdkd#6756)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ELBv2Provider();
  });

  const read = async (
    zones: unknown[],
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    mockSend.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof DescribeLoadBalancersCommand
          ? {
              LoadBalancers: [
                { LoadBalancerArn: ARN, Type: 'network', AvailabilityZones: zones },
              ],
            }
          : {}
      )
    );
    return (await provider.readCurrentState(
      ARN,
      'L',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      properties
    )) as Record<string, unknown>;
  };

  const zones = [
    {
      ZoneName: 'us-east-1b',
      SubnetId: 'subnet-b',
      LoadBalancerAddresses: [
        { IpAddress: '3.3.3.3', AllocationId: 'eipalloc-b', PrivateIPv4Address: '10.0.1.5' },
        { IPv6Address: '2600::b' },
      ],
      SourceNatIpv6Prefixes: ['2600:1f18::/80'],
    },
    {
      ZoneName: 'us-east-1a',
      SubnetId: 'subnet-a',
      LoadBalancerAddresses: [
        { IpAddress: '4.4.4.4', AllocationId: 'eipalloc-a', PrivateIPv4Address: '10.0.0.5' },
      ],
    },
  ];

  it('reads the declared members of each mapping, in the declared subnet order', async () => {
    const result = await read(zones, {
      SubnetMappings: [
        { SubnetId: 'subnet-a', AllocationId: 'eipalloc-old' },
        { SubnetId: 'subnet-b', AllocationId: 'eipalloc-b', IPv6Address: '2600::b' },
      ],
    });
    expect(result['SubnetMappings']).toEqual([
      { SubnetId: 'subnet-a', AllocationId: 'eipalloc-a' },
      { SubnetId: 'subnet-b', AllocationId: 'eipalloc-b', IPv6Address: '2600::b' },
    ]);
    // Subnets keeps its own reading.
    expect(result['Subnets']).toEqual(['subnet-b', 'subnet-a']);
  });

  it('never reports a private address the template did not declare', async () => {
    const result = await read(zones, {
      SubnetMappings: [{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }],
    });
    expect(result['SubnetMappings']).toEqual([{ SubnetId: 'subnet-a' }, { SubnetId: 'subnet-b' }]);
  });

  it('leaves out a declared member AWS does not report, so it differs from the template', async () => {
    const result = await read(zones, {
      SubnetMappings: [{ SubnetId: 'subnet-a', IPv6Address: '2600::a' }],
    });
    expect(result['SubnetMappings']).toEqual([
      { SubnetId: 'subnet-a' },
      // A subnet no entry declares reads as its id alone.
      { SubnetId: 'subnet-b' },
    ]);
  });

  it('echoes a declared auto_assigned source-NAT prefix while AWS reports one', async () => {
    const result = await read(zones, {
      SubnetMappings: [
        { SubnetId: 'subnet-b', SourceNatIpv6Prefix: 'auto_assigned' },
        { SubnetId: 'subnet-a', SourceNatIpv6Prefix: 'auto_assigned' },
      ],
    });
    expect(result['SubnetMappings']).toEqual([
      { SubnetId: 'subnet-b', SourceNatIpv6Prefix: 'auto_assigned' },
      { SubnetId: 'subnet-a' },
    ]);
  });

  it('reads an explicit source-NAT prefix as the live one', async () => {
    const result = await read(zones, {
      SubnetMappings: [{ SubnetId: 'subnet-b', SourceNatIpv6Prefix: '2600:1f18::9/80' }],
    });
    expect((result['SubnetMappings'] as unknown[])[0]).toEqual({
      SubnetId: 'subnet-b',
      SourceNatIpv6Prefix: '2600:1f18::/80',
    });
  });

  it('emits no SubnetMappings for a load balancer declared with Subnets', async () => {
    const result = await read(zones, { Subnets: ['subnet-a', 'subnet-b'] });
    expect(result).not.toHaveProperty('SubnetMappings');
    expect(await read(zones)).not.toHaveProperty('SubnetMappings');
  });
});
