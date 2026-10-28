import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ModifyVpcAttributeCommand,
  ModifySubnetAttributeCommand,
  DescribeSubnetsCommand,
  CreateTagsCommand,
  DeleteTagsCommand,
  CreateRouteCommand,
  DeleteRouteCommand,
  ReplaceRouteCommand,
  CreateNetworkAclEntryCommand,
  DeleteNetworkAclEntryCommand,
  ReplaceNetworkAclEntryCommand,
  AuthorizeSecurityGroupIngressCommand,
  AuthorizeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  RevokeSecurityGroupEgressCommand,
  DescribeInstancesCommand,
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * Round-trip guard tests for `EC2Provider.update`: when `cdkd drift
 * --revert` round-trips `observedProperties` through `update(state, state)`
 * (= no-drift snapshot), the provider must NOT emit spurious mutating SDK
 * calls, and resource types whose every readable property is immutable
 * must reject loudly with `ResourceUpdateNotSupportedError` instead of
 * silently no-op'ing.
 *
 * See `docs/provider-rules.md#readcurrentstate-for-drift-detection` and the canonical
 * `tests/unit/provisioning/sns-topic-provider-roundtrip.test.ts`.
 */
describe('EC2Provider read-update round-trip', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EC2Provider();
  });

  // Helpers — count mutating SDK calls (anything that writes to AWS).
  const mutatingCommandTypes: Array<new (...args: never[]) => unknown> = [
    ModifyVpcAttributeCommand,
    ModifySubnetAttributeCommand,
    CreateTagsCommand,
    DeleteTagsCommand,
    CreateRouteCommand,
    DeleteRouteCommand,
    ReplaceRouteCommand,
    CreateNetworkAclEntryCommand,
    DeleteNetworkAclEntryCommand,
    ReplaceNetworkAclEntryCommand,
    AuthorizeSecurityGroupIngressCommand,
    AuthorizeSecurityGroupEgressCommand,
    RevokeSecurityGroupIngressCommand,
    RevokeSecurityGroupEgressCommand,
  ];
  const countMutatingCalls = (): number =>
    mockSend.mock.calls.filter((c) =>
      mutatingCommandTypes.some((cmd) => c[0] instanceof cmd)
    ).length;

  describe('AWS::EC2::VPC (mutable: DNS attrs + Tags)', () => {
    it('round-trip on no-drift state produces zero mutating SDK calls', async () => {
      // Both DNS attrs are diff-based — equal new vs old means no
      // ModifyVpcAttribute fires. Tags equal means no CreateTags/DeleteTags.
      const state = {
        CidrBlock: '10.0.0.0/16',
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
        Tags: [{ Key: 'aws:cdk:path', Value: 'Stack/Vpc' }],
      };

      const result = await provider.update('Vpc', 'vpc-123', 'AWS::EC2::VPC', state, state);

      expect(result.physicalId).toBe('vpc-123');
      expect(result.wasReplaced).toBe(false);
      expect(countMutatingCalls()).toBe(0);
    });

    it('round-trip is robust to "true" string vs true boolean equivalence', async () => {
      // CFn often serialises booleans as strings in templates; the diff
      // must treat `"true"` and `true` as the same value or `--revert`
      // would re-write DNS settings on every run.
      const state = {
        EnableDnsHostnames: 'true',
        EnableDnsSupport: 'true',
        Tags: [],
      };
      const observed = {
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
        Tags: [],
      };

      await provider.update('Vpc', 'vpc-123', 'AWS::EC2::VPC', state, observed);

      expect(countMutatingCalls()).toBe(0);
    });

    it('actual DNS drift fires ModifyVpcAttribute exactly once per changed attr', async () => {
      // Sanity: the diff is correctly detecting a real change too.
      mockSend.mockResolvedValue({}); // every send succeeds
      const newProps = { EnableDnsHostnames: true, EnableDnsSupport: true, Tags: [] };
      const oldProps = { EnableDnsHostnames: false, EnableDnsSupport: true, Tags: [] };

      await provider.update('Vpc', 'vpc-123', 'AWS::EC2::VPC', newProps, oldProps);

      const modifyCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof ModifyVpcAttributeCommand
      );
      expect(modifyCalls).toHaveLength(1);
    });
  });

  describe('AWS::EC2::SecurityGroup (Tags + ingress/egress rule diff)', () => {
    it('round-trip on no-drift state with empty rule lists produces zero calls', async () => {
      // Class 2 candidate — empty rule list `[]` is the always-emit
      // shape some providers' readCurrentState would produce. The diff
      // helper must treat `[] vs []` as zero calls (not "drop the empty
      // list and authorize nothing", which would accidentally fire).
      const state = {
        GroupName: 'sg-name',
        GroupDescription: 'desc',
        VpcId: 'vpc-1',
        SecurityGroupIngress: [],
        SecurityGroupEgress: [],
        Tags: [],
      };

      await provider.update('Sg', 'sg-1', 'AWS::EC2::SecurityGroup', state, state);

      expect(countMutatingCalls()).toBe(0);
    });

    it('round-trip on no-drift state with non-empty ingress + egress rules produces zero calls', async () => {
      // The rule diff must hash-match identical rules and produce no
      // revoke/authorize.
      const rule = {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        CidrIp: '0.0.0.0/0',
        Description: 'HTTPS',
      };
      const state = {
        GroupDescription: 'desc',
        VpcId: 'vpc-1',
        SecurityGroupIngress: [rule],
        SecurityGroupEgress: [rule],
        Tags: [{ Key: 'aws:cdk:path', Value: 'Stack/Sg' }],
      };

      await provider.update('Sg', 'sg-1', 'AWS::EC2::SecurityGroup', state, state);

      expect(countMutatingCalls()).toBe(0);
    });

    it('actual rule add fires AuthorizeSecurityGroupIngress once', async () => {
      mockSend.mockResolvedValue({});
      const oldProps = {
        VpcId: 'vpc-1',
        SecurityGroupIngress: [],
        SecurityGroupEgress: [],
        Tags: [],
      };
      const newProps = {
        VpcId: 'vpc-1',
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
        ],
        SecurityGroupEgress: [],
        Tags: [],
      };

      await provider.update('Sg', 'sg-1', 'AWS::EC2::SecurityGroup', newProps, oldProps);

      const authIngress = mockSend.mock.calls.filter(
        (c) => c[0] instanceof AuthorizeSecurityGroupIngressCommand
      );
      expect(authIngress).toHaveLength(1);
    });
  });

  describe('AWS::EC2::Instance (Tags only mutable)', () => {
    it('round-trip on no-drift state produces zero mutating calls (DescribeInstances is read-only)', async () => {
      // updateInstance always issues DescribeInstances at the end to
      // refresh attributes — that's a read, not a mutation, so it must
      // not count against the round-trip guard.
      mockSend.mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-1',
                PrivateIpAddress: '10.0.0.10',
                Placement: { AvailabilityZone: 'us-east-1a' },
              },
            ],
          },
        ],
      });
      const state = {
        ImageId: 'ami-1',
        InstanceType: 't3.micro',
        SubnetId: 'subnet-1',
        Tags: [{ Key: 'env', Value: 'prod' }],
      };

      await provider.update('Instance', 'i-1', 'AWS::EC2::Instance', state, state);

      // DescribeInstances is read-only — it's allowed.
      const describeCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DescribeInstancesCommand
      );
      expect(describeCalls).toHaveLength(1);
      // No CreateTags / DeleteTags / ModifyVpcAttribute / etc.
      expect(countMutatingCalls()).toBe(0);
    });
  });

  describe('AWS::EC2::Route (immutable: short-circuit on no-drift)', () => {
    it('round-trip on no-drift state does NOT delete + recreate', async () => {
      // Pre-PR: updateRoute unconditionally called deleteRoute +
      // createRoute. On a `cdkd drift --revert` round-trip with
      // state == AWS, this would needlessly churn the route.
      const state = {
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: 'nat-1',
      };

      const result = await provider.update(
        'Route',
        'rtb-1|0.0.0.0/0',
        'AWS::EC2::Route',
        state,
        state
      );

      expect(result.wasReplaced).toBe(false);
      expect(countMutatingCalls()).toBe(0);
    });

    it('actual target change is one in-place ReplaceRoute (#5068)', async () => {
      mockSend.mockResolvedValue({});
      const oldProps = {
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '0.0.0.0/0',
        GatewayId: 'igw-1',
      };
      const newProps = {
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: 'nat-1',
      };

      const result = await provider.update(
        'Route',
        'rtb-1|0.0.0.0/0',
        'AWS::EC2::Route',
        newProps,
        oldProps
      );

      expect(result.wasReplaced).toBe(false);
      const deleted = mockSend.mock.calls.some((c) => c[0] instanceof DeleteRouteCommand);
      const created = mockSend.mock.calls.some((c) => c[0] instanceof CreateRouteCommand);
      const replaced = mockSend.mock.calls.filter((c) => c[0] instanceof ReplaceRouteCommand);
      expect(deleted).toBe(false);
      expect(created).toBe(false);
      expect(replaced).toHaveLength(1);
    });
  });

  describe('Immutable resource types reject with ResourceUpdateNotSupportedError', () => {
    // PR I pattern: every resource type whose every readable property is
    // immutable must reject `update()` loudly so `cdkd drift --revert`
    // does not report `✓ reverted` on a console-side change AWS will
    // keep.
    const immutableCases: Array<[string, string]> = [
      // AWS::EC2::VPCGatewayAttachment left this list in go-to-k/cdkd#5216: it
      // swaps the gateway in place (ec2-vpc-gateway-attachment-vpn.test.ts).
      // AWS::EC2::NatGateway left this list in go-to-k/cdkd#2762: it updates
      // Tags and AvailabilityZoneAddresses in place
      // (ec2-natgateway-regional-2762.test.ts).
      // InternetGateway / RouteTable / NetworkAcl left it in go-to-k/cdkd#5448:
      // they update Tags in place (the describe block below).
      ['AWS::EC2::SubnetRouteTableAssociation', 'rtbassoc-1'],
      ['AWS::EC2::SubnetNetworkAclAssociation', 'aclassoc-1'],
    ];

    it.each(immutableCases)(
      '%s rejects with ResourceUpdateNotSupportedError on round-trip',
      async (resourceType, physicalId) => {
        const props = { Foo: 'bar' };
        await expect(
          provider.update('L', physicalId, resourceType, props, props)
        ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

        // No mutating SDK calls fired — the throw happened before any
        // network IO.
        expect(countMutatingCalls()).toBe(0);
      }
    );
  });

  describe('InternetGateway / RouteTable / NetworkAcl Tags update in place (#5448)', () => {
    const tagsOnlyCases: Array<[string, string, Record<string, unknown>]> = [
      ['AWS::EC2::InternetGateway', 'igw-1', {}],
      ['AWS::EC2::RouteTable', 'rtb-1', { VpcId: 'vpc-1' }],
      ['AWS::EC2::NetworkAcl', 'acl-1', { VpcId: 'vpc-1' }],
    ];
    const sent = <T>(cmd: new (...args: never[]) => T): T[] =>
      mockSend.mock.calls.filter((c) => c[0] instanceof cmd).map((c) => c[0] as T);

    it.each(tagsOnlyCases)(
      '%s round-trip on no-drift state resolves with zero mutating calls',
      async (resourceType, physicalId, base) => {
        const props = { ...base, Tags: [{ Key: 'env', Value: 'dev' }] };
        const result = await provider.update('L', physicalId, resourceType, props, props);
        expect(result).toEqual({ physicalId, wasReplaced: false });
        expect(countMutatingCalls()).toBe(0);
      }
    );

    it.each(tagsOnlyCases)(
      '%s applies a changed, an added and a removed tag on the same physical id',
      async (resourceType, physicalId, base) => {
        mockSend.mockResolvedValue({});
        const prev = {
          ...base,
          Tags: [
            { Key: 'env', Value: 'dev' },
            { Key: 'gone', Value: 'x' },
            { Key: 'same', Value: 's' },
          ],
        };
        const next = {
          ...base,
          Tags: [
            { Key: 'env', Value: 'prod' },
            { Key: 'same', Value: 's' },
            { Key: 'added', Value: 'a' },
          ],
        };
        const result = await provider.update('L', physicalId, resourceType, next, prev);

        expect(result).toEqual({ physicalId, wasReplaced: false });
        const deletes = sent(DeleteTagsCommand);
        expect(deletes).toHaveLength(1);
        expect(deletes[0]!.input).toEqual({ Resources: [physicalId], Tags: [{ Key: 'gone' }] });
        const creates = sent(CreateTagsCommand);
        expect(creates).toHaveLength(1);
        expect(creates[0]!.input).toEqual({
          Resources: [physicalId],
          Tags: [
            { Key: 'env', Value: 'prod' },
            { Key: 'added', Value: 'a' },
          ],
        });
      }
    );

    it.each(tagsOnlyCases)(
      '%s removing the whole Tags property untags every recorded key',
      async (resourceType, physicalId, base) => {
        mockSend.mockResolvedValue({});
        const prev = { ...base, Tags: [{ Key: 'env', Value: 'dev' }] };
        await provider.update('L', physicalId, resourceType, { ...base }, prev);

        expect(sent(DeleteTagsCommand).map((c) => c.input)).toEqual([
          { Resources: [physicalId], Tags: [{ Key: 'env' }] },
        ]);
        expect(sent(CreateTagsCommand)).toHaveLength(0);
      }
    );

    it.each([
      ['AWS::EC2::RouteTable', 'rtb-1'],
      ['AWS::EC2::NetworkAcl', 'acl-1'],
    ])(
      '%s still refuses a VpcId change (drift --revert path) before any call',
      async (resourceType, physicalId) => {
        const error = await provider
          .update(
            'L',
            physicalId,
            resourceType,
            { VpcId: 'vpc-2', Tags: [{ Key: 'env', Value: 'prod' }] },
            { VpcId: 'vpc-1', Tags: [{ Key: 'env', Value: 'dev' }] }
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
        expect((error as Error).message).toContain('VpcId is immutable in AWS');
        expect(countMutatingCalls()).toBe(0);
      }
    );
  });

  describe('AWS::EC2::NetworkAclEntry (#5070: in-place ReplaceNetworkAclEntry)', () => {
    const entry = {
      NetworkAclId: 'acl-1',
      RuleNumber: 100,
      Protocol: 6,
      RuleAction: 'allow',
      Egress: false,
      CidrBlock: '0.0.0.0/0',
      PortRange: { From: 80, To: 80 },
    };

    it('round-trip on no-drift state sends zero mutating SDK calls', async () => {
      const result = await provider.update('E', 'acl-1|100|false', 'AWS::EC2::NetworkAclEntry', entry, {
        ...entry,
      });
      expect(result).toEqual({ physicalId: 'acl-1|100|false', wasReplaced: false });
      expect(countMutatingCalls()).toBe(0);
    });

    it('a rule change is one ReplaceNetworkAclEntry, no delete or create', async () => {
      mockSend.mockResolvedValue({});
      const result = await provider.update(
        'E',
        'acl-1|100|false',
        'AWS::EC2::NetworkAclEntry',
        { ...entry, RuleAction: 'deny' },
        entry
      );
      expect(result.wasReplaced).toBe(false);
      expect(countMutatingCalls()).toBe(1);
      expect(
        mockSend.mock.calls.filter((c) => c[0] instanceof ReplaceNetworkAclEntryCommand)
      ).toHaveLength(1);
    });
  });

  describe('AWS::EC2::Subnet (issue #1300: property-aware update)', () => {
    const subnetState = {
      VpcId: 'vpc-1',
      CidrBlock: '10.0.0.0/24',
      AvailabilityZone: 'us-east-1a',
      MapPublicIpOnLaunch: true,
    };

    it('round-trip on no-drift state sends zero mutating SDK calls', async () => {
      const result = await provider.update(
        'Sub',
        'subnet-1',
        'AWS::EC2::Subnet',
        subnetState,
        subnetState
      );
      expect(result.wasReplaced).toBe(false);
      expect(countMutatingCalls()).toBe(0);
      expect(mockSend).not.toHaveBeenCalled();
      // No attributes on an in-place update — the deploy engine carries the
      // create-time attributes (SubnetId / AvailabilityZone) forward, and a
      // partial set returned here would REPLACE them (FSx attribute-wipe
      // incident shape).
      expect(result.attributes).toBeUndefined();
    });

    it('MapPublicIpOnLaunch drift reverts via ModifySubnetAttribute + read-back', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeSubnetsCommand) {
          return Promise.resolve({ Subnets: [{ MapPublicIpOnLaunch: false }] });
        }
        return Promise.resolve({});
      });

      // Revert direction: AWS drifted to true, state says false.
      await provider.update(
        'Sub',
        'subnet-1',
        'AWS::EC2::Subnet',
        { ...subnetState, MapPublicIpOnLaunch: false },
        { ...subnetState, MapPublicIpOnLaunch: true }
      );

      const modify = mockSend.mock.calls.find((c) => c[0] instanceof ModifySubnetAttributeCommand);
      expect(modify?.[0].input).toEqual({
        SubnetId: 'subnet-1',
        MapPublicIpOnLaunch: { Value: false },
      });
      // Read-back verified the write became visible before returning.
      const reads = mockSend.mock.calls.filter((c) => c[0] instanceof DescribeSubnetsCommand);
      expect(reads.length).toBeGreaterThanOrEqual(1);
    });

    it("string spelling 'true' is coerced (no spurious modify on 'true' vs true)", async () => {
      await provider.update(
        'Sub',
        'subnet-1',
        'AWS::EC2::Subnet',
        { ...subnetState, MapPublicIpOnLaunch: 'true' },
        { ...subnetState, MapPublicIpOnLaunch: true }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('Tags drift applies the tag diff', async () => {
      await provider.update(
        'Sub',
        'subnet-1',
        'AWS::EC2::Subnet',
        { ...subnetState, Tags: [{ Key: 'Owner', Value: 'a' }] },
        { ...subnetState, Tags: [{ Key: 'Owner', Value: 'b' }, { Key: 'Stale', Value: 'x' }] }
      );
      const created = mockSend.mock.calls.some((c) => c[0] instanceof CreateTagsCommand);
      const deleted = mockSend.mock.calls.some((c) => c[0] instanceof DeleteTagsCommand);
      expect(created).toBe(true);
      expect(deleted).toBe(true);
    });

    it.each(['VpcId', 'CidrBlock', 'AvailabilityZone'])(
      'create-only property %s change rejects with ResourceUpdateNotSupportedError',
      async (prop) => {
        await expect(
          provider.update(
            'Sub',
            'subnet-1',
            'AWS::EC2::Subnet',
            { ...subnetState, [prop]: 'changed-value' },
            subnetState
          )
        ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
        expect(countMutatingCalls()).toBe(0);
      }
    );
  });

  describe('AWS::EC2::SecurityGroupIngress (immutable rule, short-circuit)', () => {
    it('round-trip on no-drift state does NOT revoke + re-authorize', async () => {
      const state = {
        GroupId: 'sg-1',
        IpProtocol: 'tcp',
        FromPort: 22,
        ToPort: 22,
        CidrIp: '10.0.0.0/8',
      };

      const result = await provider.update(
        'Ing',
        'sg-1|tcp|22|22|10.0.0.0/8',
        'AWS::EC2::SecurityGroupIngress',
        state,
        state
      );

      expect(result.wasReplaced).toBe(false);
      expect(countMutatingCalls()).toBe(0);
    });
  });
});
