/**
 * go-to-k/cdkd#6754: the EC2 drift readback returns `Tags` on six types, a
 * zonal NAT gateway's declared secondary addresses, and an instance's declared
 * `SecurityGroups` / `UserData`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeInstanceAttributeCommand,
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkAclsCommand,
  DescribeRouteTablesCommand,
  DescribeSubnetsCommand,
  DescribeVpcAttributeCommand,
  DescribeVpcsCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { ReadCurrentStateContext } from '../../../src/types/resource.js';

const TAGS = [
  { Key: 'aws:cloudformation:stack-name', Value: 'S' },
  { Key: 'Name', Value: 'net' },
];
const CFN_TAGS = [{ Key: 'Name', Value: 'net' }];

type Reply = (command: unknown) => unknown;

/** Answer each command by its class; anything unlisted answers `{}`. */
function answer(replies: ReadonlyArray<[new (...args: never[]) => unknown, Reply]>): void {
  mockSend.mockImplementation((command: unknown) => {
    for (const [cls, reply] of replies) {
      if (command instanceof cls) return Promise.resolve(reply(command));
    }
    return Promise.resolve({});
  });
}

describe('EC2 drift readback gaps (go-to-k/cdkd#6754)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new EC2Provider();
  });

  describe('Tags', () => {
    const cases: Array<{
      type: string;
      id: string;
      reply: [new (...args: never[]) => unknown, (tags: unknown) => unknown];
    }> = [
      {
        type: 'AWS::EC2::VPC',
        id: 'vpc-1',
        reply: [DescribeVpcsCommand, (Tags) => ({ Vpcs: [{ VpcId: 'vpc-1', Tags }] })],
      },
      {
        type: 'AWS::EC2::Subnet',
        id: 'subnet-1',
        reply: [DescribeSubnetsCommand, (Tags) => ({ Subnets: [{ SubnetId: 'subnet-1', Tags }] })],
      },
      {
        type: 'AWS::EC2::InternetGateway',
        id: 'igw-1',
        reply: [
          DescribeInternetGatewaysCommand,
          (Tags) => ({ InternetGateways: [{ InternetGatewayId: 'igw-1', Tags }] }),
        ],
      },
      {
        type: 'AWS::EC2::NatGateway',
        id: 'nat-1',
        reply: [
          DescribeNatGatewaysCommand,
          (Tags) => ({ NatGateways: [{ NatGatewayId: 'nat-1', State: 'available', Tags }] }),
        ],
      },
      {
        type: 'AWS::EC2::RouteTable',
        id: 'rtb-1',
        reply: [
          DescribeRouteTablesCommand,
          (Tags) => ({ RouteTables: [{ RouteTableId: 'rtb-1', Tags }] }),
        ],
      },
      {
        type: 'AWS::EC2::NetworkAcl',
        id: 'acl-1',
        reply: [
          DescribeNetworkAclsCommand,
          (Tags) => ({ NetworkAcls: [{ NetworkAclId: 'acl-1', Tags }] }),
        ],
      },
    ];

    for (const { type, id, reply } of cases) {
      describe(type, () => {
        const read = async (
          tags: unknown,
          properties?: Record<string, unknown>,
          afterOwnWrite = false
        ): Promise<Record<string, unknown>> => {
          answer([
            [reply[0], () => reply[1](tags)],
            [DescribeVpcAttributeCommand, () => ({})],
          ]);
          return (await provider.readCurrentState(id, 'L', type, properties, {
            afterOwnWrite,
          })) as Record<string, unknown>;
        };

        it('returns the tags, the reserved aws: ones dropped', async () => {
          expect((await read(TAGS))['Tags']).toEqual(CFN_TAGS);
        });

        it('omits Tags when AWS reports none but the reserved ones', async () => {
          expect(await read([TAGS[0]])).not.toHaveProperty('Tags');
          expect(await read(undefined)).not.toHaveProperty('Tags');
        });

        it('keeps the declared tags on the capture right after its own write', async () => {
          const declared = [{ Key: 'Name', Value: 'new' }];
          expect((await read(TAGS, { Tags: declared }, true))['Tags']).toEqual(declared);
        });

        it('reports the live tags outside that capture', async () => {
          const declared = [{ Key: 'Name', Value: 'new' }];
          expect((await read(TAGS, { Tags: declared }, false))['Tags']).toEqual(CFN_TAGS);
        });

        it('records no Tags on that capture when the template declares none (the removal lags)', async () => {
          expect(await read(TAGS, {}, true)).not.toHaveProperty('Tags');
          // Outside the capture an undeclared live tag is reported as is.
          expect((await read(TAGS, {}, false))['Tags']).toEqual(CFN_TAGS);
        });

        it('keeps the live list on that capture when it is the declared set in another order', async () => {
          // The readback lists tags by key; the declared list is in another
          // order, so the result shows which of the two was returned.
          const live = [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: '2' },
          ];
          const declared = [live[1], live[0]];
          expect((await read(live, { Tags: declared }, true))['Tags']).toEqual(live);
        });
      });
    }
  });

  describe('AWS::EC2::NatGateway secondary addresses', () => {
    const read = async (
      addresses: unknown[],
      properties: Record<string, unknown>,
      availabilityMode?: string
    ): Promise<Record<string, unknown>> => {
      answer([
        [
          DescribeNatGatewaysCommand,
          () => ({
            NatGateways: [
              {
                NatGatewayId: 'nat-1',
                State: 'available',
                NatGatewayAddresses: addresses,
                ...(availabilityMode !== undefined && { AvailabilityMode: availabilityMode }),
              },
            ],
          }),
        ],
      ]);
      return (await provider.readCurrentState(
        'nat-1',
        'L',
        'AWS::EC2::NatGateway',
        properties
      )) as Record<string, unknown>;
    };
    const primary = { AllocationId: 'eipalloc-p', PrivateIp: '10.0.0.5', IsPrimary: true };

    it('reads declared secondary allocation ids and private addresses in declared order', async () => {
      const result = await read(
        [
          primary,
          { AllocationId: 'eipalloc-b', PrivateIp: '10.0.0.7', IsPrimary: false, Status: 'succeeded' },
          { AllocationId: 'eipalloc-a', PrivateIp: '10.0.0.6', IsPrimary: false, Status: 'succeeded' },
        ],
        {
          SecondaryAllocationIds: ['eipalloc-a', 'eipalloc-b'],
          SecondaryPrivateIpAddresses: ['10.0.0.6', '10.0.0.7'],
        }
      );
      expect(result['SecondaryAllocationIds']).toEqual(['eipalloc-a', 'eipalloc-b']);
      expect(result['SecondaryPrivateIpAddresses']).toEqual(['10.0.0.6', '10.0.0.7']);
      expect(result['AllocationId']).toBe('eipalloc-p');
      expect(result).not.toHaveProperty('SecondaryPrivateIpAddressCount');
    });

    it('reads a declared count as the number of live secondary addresses', async () => {
      const result = await read(
        [
          { PrivateIp: '10.0.0.5', IsPrimary: true },
          { PrivateIp: '10.0.0.8', IsPrimary: false, Status: 'succeeded' },
          { PrivateIp: '10.0.0.9', IsPrimary: false, Status: 'unassigning' },
        ],
        { SecondaryPrivateIpAddressCount: 2 }
      );
      expect(result['SecondaryPrivateIpAddressCount']).toBe(1);
      expect(result).not.toHaveProperty('SecondaryPrivateIpAddresses');
    });

    it('leaves out a secondary address being removed or one AWS failed to add', async () => {
      const result = await read(
        [
          primary,
          { AllocationId: 'eipalloc-a', PrivateIp: '10.0.0.6', Status: 'succeeded' },
          { AllocationId: 'eipalloc-b', PrivateIp: '10.0.0.7', Status: 'disassociating' },
          { AllocationId: 'eipalloc-c', PrivateIp: '10.0.0.8', Status: 'failed' },
          { AllocationId: 'eipalloc-d', PrivateIp: '10.0.0.9', Status: 'unassigning' },
          { AllocationId: 'eipalloc-e', PrivateIp: '10.0.0.10', Status: 'associating' },
        ],
        {
          SecondaryAllocationIds: ['eipalloc-a', 'eipalloc-e'],
          SecondaryPrivateIpAddresses: ['10.0.0.6', '10.0.0.10'],
          SecondaryPrivateIpAddressCount: 2,
        }
      );
      expect(result['SecondaryAllocationIds']).toEqual(['eipalloc-a', 'eipalloc-e']);
      expect(result['SecondaryPrivateIpAddresses']).toEqual(['10.0.0.6', '10.0.0.10']);
      expect(result['SecondaryPrivateIpAddressCount']).toBe(2);
    });

    it('reads a declared key as empty when no secondary address is live', async () => {
      const result = await read([primary], {
        SecondaryAllocationIds: ['eipalloc-a'],
        SecondaryPrivateIpAddressCount: 1,
      });
      expect(result['SecondaryAllocationIds']).toEqual([]);
      expect(result['SecondaryPrivateIpAddressCount']).toBe(0);
    });

    it('emits no secondary key the record does not declare', async () => {
      const result = await read(
        [primary, { AllocationId: 'eipalloc-a', PrivateIp: '10.0.0.6', Status: 'succeeded' }],
        {}
      );
      expect(result).not.toHaveProperty('SecondaryAllocationIds');
      expect(result).not.toHaveProperty('SecondaryPrivateIpAddresses');
      expect(result).not.toHaveProperty('SecondaryPrivateIpAddressCount');
    });

    it('reads no secondary key for a regional gateway', async () => {
      const result = await read(
        [primary, { AllocationId: 'eipalloc-a', PrivateIp: '10.0.0.6', Status: 'succeeded' }],
        { SecondaryAllocationIds: ['eipalloc-a'] },
        'regional'
      );
      expect(result).not.toHaveProperty('SecondaryAllocationIds');
    });
  });

  describe('AWS::EC2::Instance', () => {
    const read = async (
      properties: Record<string, unknown>,
      userData: string | null = 'IyEvYmluL2Jhc2g=',
      context?: ReadCurrentStateContext
    ): Promise<Record<string, unknown>> => {
      answer([
        [
          DescribeInstancesCommand,
          () => ({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-1',
                    State: { Name: 'running' },
                    SecurityGroups: [
                      { GroupId: 'sg-2', GroupName: 'web' },
                      { GroupId: 'sg-1', GroupName: 'app' },
                    ],
                  },
                ],
              },
            ],
          }),
        ],
        [
          DescribeInstanceAttributeCommand,
          (command) =>
            (command as DescribeInstanceAttributeCommand).input.Attribute === 'userData'
              ? { UserData: userData === null ? {} : { Value: userData } }
              : {},
        ],
      ]);
      return (await provider.readCurrentState(
        'i-1',
        'L',
        'AWS::EC2::Instance',
        properties,
        context
      )) as Record<string, unknown>;
    };
    const userDataCalls = (): number =>
      mockSend.mock.calls.filter(
        ([command]) =>
          command instanceof DescribeInstanceAttributeCommand &&
          command.input.Attribute === 'userData'
      ).length;

    it('reads declared SecurityGroups as group names in declared order', async () => {
      const result = await read({ SecurityGroups: ['app', 'web'] });
      expect(result['SecurityGroups']).toEqual(['app', 'web']);
    });

    it('emits no SecurityGroups for a record that does not declare it', async () => {
      expect(await read({ SecurityGroupIds: ['sg-1', 'sg-2'] })).not.toHaveProperty(
        'SecurityGroups'
      );
    });

    it('reads a declared UserData through DescribeInstanceAttribute', async () => {
      const result = await read({ UserData: 'IyEvYmluL2Jhc2g=' });
      expect(result['UserData']).toBe('IyEvYmluL2Jhc2g=');
      expect(userDataCalls()).toBe(1);
    });

    it('omits UserData when the instance has none, so a declared one reads as removed', async () => {
      const result = await read({ UserData: 'IyEvYmluL2Jhc2g=' }, null);
      expect(result).not.toHaveProperty('UserData');
    });

    it('makes no user-data call for a record that does not declare UserData', async () => {
      const result = await read({});
      expect(result).not.toHaveProperty('UserData');
      expect(userDataCalls()).toBe(0);
    });

    it('makes no user-data call for a record holding the mask, and declares it unknown', async () => {
      const result = await read({ UserData: SECRET_MASK });
      expect(result).not.toHaveProperty('UserData');
      expect(userDataCalls()).toBe(0);
      expect(
        provider.getDriftUnknownPaths('AWS::EC2::Instance', { UserData: SECRET_MASK })
      ).toContain('UserData');
      expect(
        provider.getDriftUnknownPaths('AWS::EC2::Instance', { UserData: 'IyEvYmluL2Jhc2g=' })
      ).not.toContain('UserData');      // An ABSENT bag compares (the unsettled re-check passes none; #7061 review).
      expect(provider.getDriftUnknownPaths('AWS::EC2::Instance')).not.toContain('UserData');
    });

    it('declares UserData unknown for a properties bag the record cannot be read through (unknown is masked)', () => {
      expect(provider.getDriftUnknownPaths('AWS::EC2::Instance', 'x' as never)).toContain('UserData');
    });

    // go-to-k/cdkd#7061: the record's provenance decides too, whatever the
    // value's text: a masked-property fingerprint or a `NoEcho` coordinate
    // under `UserData` means the record holds no value to compare with.
    it.each([
      ['a masked-property fingerprint', { maskedPropertyFingerprints: { UserData: 'sha256:00' } }],
      ['a NoEcho coordinate under it', { noEchoLeaves: [['UserData']] }],
    ])('makes no user-data call, and declares it unknown, for a record whose %s names UserData', async (_what, provenance) => {
      const result = await read({ UserData: 'IyEvYmluL2Jhc2g=' }, 'IyEvYmluL2Jhc2g=', { provenance });
      expect(result).not.toHaveProperty('UserData');
      expect(userDataCalls()).toBe(0);
      expect(
        provider.getDriftUnknownPaths('AWS::EC2::Instance', { UserData: 'IyEvYmluL2Jhc2g=' }, provenance)
      ).toContain('UserData');
    });

    it('throws when a declared UserData cannot be read, rather than reading it as removed', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof DescribeInstanceAttributeCommand &&
        command.input.Attribute === 'userData'
          ? Promise.reject(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }))
          : command instanceof DescribeInstancesCommand
            ? Promise.resolve({
                Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
              })
            : Promise.resolve({})
      );
      await expect(
        provider.readCurrentState('i-1', 'L', 'AWS::EC2::Instance', { UserData: 'eA==' })
      ).rejects.toThrow('denied');
    });
  });
});
