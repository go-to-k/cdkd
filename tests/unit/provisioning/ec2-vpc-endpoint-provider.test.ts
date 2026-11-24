/**
 * `EC2VPCEndpointProvider` (go-to-k/cdkd#6939): the SDK route for
 * `AWS::EC2::VPCEndpoint`, whose point is `--no-wait` returning once
 * `CreateVpcEndpoint` answers. Pins the create input, the `available` wait and
 * its skip, the attribute map (`DnsEntries` as `<hosted zone>:<name>`), the
 * `ModifyVpcEndpoint` diff, the delete's `Unsuccessful` handling and its
 * gone-wait, and the drift / import reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateTagsCommand,
  CreateVpcEndpointCommand,
  DeleteTagsCommand,
  DeleteVpcEndpointsCommand,
  DescribeVpcEndpointsCommand,
  ModifyVpcEndpointCommand,
} from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());
const mockRegion = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ ec2: { send: mockSend, config: { region: mockRegion } } }),
}));

import { EC2VPCEndpointProvider } from '../../../src/provisioning/providers/ec2-vpc-endpoint-provider.js';
import { hasCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::EC2::VPCEndpoint';
const ID = 'vpce-0123456789abcdef0';
const CREATED = new Date('2026-11-24T14:28:20.570Z');

const endpoint = (fields: Record<string, unknown> = {}) => ({
  VpcEndpointId: ID,
  VpcEndpointType: 'Interface',
  VpcId: 'vpc-1',
  ServiceName: 'com.amazonaws.us-east-1.secretsmanager',
  State: 'pending',
  SubnetIds: ['subnet-a'],
  Groups: [{ GroupId: 'sg-1', GroupName: 'default' }],
  RouteTableIds: [],
  IpAddressType: 'ipv4',
  DnsOptions: { DnsRecordIpType: 'ipv4' },
  PrivateDnsEnabled: false,
  NetworkInterfaceIds: ['eni-1'],
  DnsEntries: [
    { DnsName: 'vpce-1.secretsmanager.us-east-1.vpce.amazonaws.com', HostedZoneId: 'Z7HUB' },
  ],
  CreationTimestamp: CREATED,
  PolicyDocument: '{"Statement":[{"Action":"*","Effect":"Allow","Principal":"*","Resource":"*"}]}',
  Tags: [],
  ...fields,
});
const described = (fields: Record<string, unknown> = {}) => ({ VpcEndpoints: [endpoint(fields)] });
const notFound = () =>
  Object.assign(new Error('The Vpc Endpoint Id does not exist'), {
    name: 'InvalidVpcEndpointId.NotFound',
  });

const interfaceProps = (extra: Record<string, unknown> = {}) => ({
  VpcId: 'vpc-1',
  ServiceName: 'com.amazonaws.us-east-1.secretsmanager',
  VpcEndpointType: 'Interface',
  SubnetIds: ['subnet-a'],
  SecurityGroupIds: ['sg-1'],
  ...extra,
});

function provider(): EC2VPCEndpointProvider {
  const p = new EC2VPCEndpointProvider();
  p.endpointWait.sleep = () => Promise.resolve();
  return p;
}
const sent = <T>(ctor: new (...args: never[]) => T): T[] =>
  mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);

describe('EC2VPCEndpointProvider (#6939)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRegion.mockReset();
    mockRegion.mockResolvedValue('us-east-1');
    delete process.env['CDKD_NO_WAIT'];
  });
  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  describe('create', () => {
    it('sends the declared members, waits for available and records the attributes', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateVpcEndpointCommand) return Promise.resolve({ VpcEndpoint: endpoint() });
        return Promise.resolve(described({ State: 'available' }));
      });
      const result = await provider().create(
        'Endpoint',
        TYPE,
        interfaceProps({
          PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }] },
          DnsOptions: { DnsRecordIpType: 'ipv4', PrivateDnsOnlyForInboundResolverEndpoint: 'AllResolvers' },
          Tags: [{ Key: 'team', Value: 'a' }],
        })
      );
      const [create] = sent(CreateVpcEndpointCommand);
      expect(create!.input).toMatchObject({
        VpcId: 'vpc-1',
        VpcEndpointType: 'Interface',
        SubnetIds: ['subnet-a'],
        SecurityGroupIds: ['sg-1'],
        // CloudFormation's default for an absent PrivateDnsEnabled.
        PrivateDnsEnabled: false,
        PolicyDocument:
          '{"Statement":[{"Effect":"Allow","Principal":"*","Action":"*","Resource":"*"}]}',
        DnsOptions: { DnsRecordIpType: 'ipv4', PrivateDnsOnlyForInboundResolverEndpoint: false },
        TagSpecifications: [{ ResourceType: 'vpc-endpoint', Tags: [{ Key: 'team', Value: 'a' }] }],
      });
      expect(create!.input.ClientToken).toEqual(expect.any(String));
      expect(sent(DescribeVpcEndpointsCommand)).toHaveLength(1);
      expect(result).toEqual({
        physicalId: ID,
        attributes: {
          Id: ID,
          CreationTimestamp: '2026-11-24T14:28:20.570Z',
          DnsEntries: ['Z7HUB:vpce-1.secretsmanager.us-east-1.vpce.amazonaws.com'],
          NetworkInterfaceIds: ['eni-1'],
        },
      });
    });

    it('returns on the create answer under --no-wait, its network attributes recorded', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockResolvedValueOnce({ VpcEndpoint: endpoint() });
      const result = await provider().create('Endpoint', TYPE, interfaceProps());
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(result.attributes).toMatchObject({
        DnsEntries: ['Z7HUB:vpce-1.secretsmanager.us-east-1.vpce.amazonaws.com'],
        NetworkInterfaceIds: ['eni-1'],
      });
    });

    it('sends no PrivateDnsEnabled for a Gateway endpoint that declares none', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockResolvedValueOnce({
        VpcEndpoint: endpoint({ VpcEndpointType: 'Gateway', DnsEntries: [], NetworkInterfaceIds: [] }),
      });
      const result = await provider().create('Endpoint', TYPE, {
        VpcId: 'vpc-1',
        ServiceName: 'com.amazonaws.us-east-1.s3',
        RouteTableIds: ['rtb-1'],
      });
      const [create] = sent(CreateVpcEndpointCommand);
      expect(create!.input.PrivateDnsEnabled).toBeUndefined();
      expect(create!.input.RouteTableIds).toEqual(['rtb-1']);
      expect(result.attributes).toMatchObject({ DnsEntries: [], NetworkInterfaceIds: [] });
    });

    it('refuses a malformed id list before any call', async () => {
      await expect(
        provider().create('Endpoint', TYPE, interfaceProps({ SubnetIds: 'subnet-a' }))
      ).rejects.toThrow(/SubnetIds must be a list of ids/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('fails on a failed endpoint, marked as created so the rollback deletes it', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateVpcEndpointCommand) return Promise.resolve({ VpcEndpoint: endpoint() });
        return Promise.resolve(described({ State: 'failed' }));
      });
      const error = await provider()
        .create('Endpoint', TYPE, interfaceProps())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(String(error)).toMatch(/is failed, so it will not become available/);
      expect(hasCreatedBeforeFailure(error)).toBe(true);
    });

    it('keeps polling through a not-yet-listed id and a throttle', async () => {
      const replies: unknown[] = [
        Promise.reject(notFound()),
        Promise.reject(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })),
        Promise.resolve(described({ State: 'available' })),
      ];
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateVpcEndpointCommand) return Promise.resolve({ VpcEndpoint: endpoint() });
        return replies.shift();
      });
      const result = await provider().create('Endpoint', TYPE, interfaceProps());
      expect(result.physicalId).toBe(ID);
      expect(sent(DescribeVpcEndpointsCommand)).toHaveLength(3);
    });
  });

  describe('update', () => {
    it('diffs the id lists and changes the policy and private DNS in one ModifyVpcEndpoint, then waits', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeVpcEndpointsCommand) {
          return Promise.resolve(described({ State: 'available' }));
        }
        return Promise.resolve({});
      });
      await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps({
          SubnetIds: ['subnet-a', 'subnet-b'],
          SecurityGroupIds: ['sg-2'],
          PolicyDocument: { Statement: [] },
          PrivateDnsEnabled: true,
        }),
        interfaceProps({ PolicyDocument: '{"Statement":[{"Effect":"Allow"}]}' })
      );
      const [modify] = sent(ModifyVpcEndpointCommand);
      expect(modify!.input).toEqual({
        VpcEndpointId: ID,
        AddSubnetIds: ['subnet-b'],
        AddSecurityGroupIds: ['sg-2'],
        RemoveSecurityGroupIds: ['sg-1'],
        PolicyDocument: '{"Statement":[]}',
        PrivateDnsEnabled: true,
      });
      expect(sent(DescribeVpcEndpointsCommand)).toHaveLength(1);
    });

    it('resets a removed policy and turns off a removed private DNS (CloudFormation defaults)', async () => {
      mockSend.mockImplementation((cmd: unknown) =>
        Promise.resolve(cmd instanceof DescribeVpcEndpointsCommand ? described({ State: 'available' }) : {})
      );
      await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps(),
        interfaceProps({ PolicyDocument: { Statement: [] }, PrivateDnsEnabled: true })
      );
      expect(sent(ModifyVpcEndpointCommand)[0]!.input).toEqual({
        VpcEndpointId: ID,
        ResetPolicy: true,
        PrivateDnsEnabled: false,
      });
    });

    it('under --no-wait leaves out the network attributes of a still-pending endpoint', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockImplementation((cmd: unknown) =>
        Promise.resolve(cmd instanceof DescribeVpcEndpointsCommand ? described({ State: 'pending' }) : {})
      );
      const result = await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps({ SubnetIds: ['subnet-a', 'subnet-b'] }),
        interfaceProps()
      );
      expect(sent(ModifyVpcEndpointCommand)).toHaveLength(1);
      expect(result.attributes).toEqual({ Id: ID, CreationTimestamp: '2026-11-24T14:28:20.570Z' });
    });

    it('a tag-only change sends no ModifyVpcEndpoint and does not wait', async () => {
      mockSend.mockImplementation((cmd: unknown) =>
        Promise.resolve(cmd instanceof DescribeVpcEndpointsCommand ? described({ State: 'available' }) : {})
      );
      await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps({ Tags: [{ Key: 'team', Value: 'b' }] }),
        interfaceProps({ Tags: [{ Key: 'team', Value: 'a' }, { Key: 'old', Value: 'x' }] })
      );
      expect(sent(ModifyVpcEndpointCommand)).toHaveLength(0);
      expect(sent(DeleteTagsCommand)[0]!.input).toEqual({ Resources: [ID], Tags: [{ Key: 'old' }] });
      expect(sent(CreateTagsCommand)[0]!.input).toEqual({
        Resources: [ID],
        Tags: [{ Key: 'team', Value: 'b' }],
      });
      expect(sent(DescribeVpcEndpointsCommand)).toHaveLength(1);
    });

    it('refuses a create-only change (drift --revert) as an unsupported update', async () => {
      await expect(
        provider().update(
          'Endpoint',
          ID,
          TYPE,
          interfaceProps({ ServiceName: 'com.amazonaws.us-east-1.kms' }),
          interfaceProps()
        )
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a malformed template policy, and keeps the previous one on a state replay', async () => {
      await expect(
        provider().update('Endpoint', ID, TYPE, interfaceProps({ PolicyDocument: 42 }), interfaceProps())
      ).rejects.toThrow(/PolicyDocument is not a policy object/);
      expect(mockSend).not.toHaveBeenCalled();

      mockSend.mockImplementation((cmd: unknown) =>
        Promise.resolve(cmd instanceof DescribeVpcEndpointsCommand ? described({ State: 'available' }) : {})
      );
      const previous = interfaceProps({ PolicyDocument: { Statement: [] } });
      const result = await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps({ PolicyDocument: 42 }),
        previous,
        { replayingState: true }
      );
      expect(sent(ModifyVpcEndpointCommand)).toHaveLength(0);
      expect(result.effectiveProperties).toEqual(previous);
    });

    it('refuses a malformed desired id list on every path, before any call', async () => {
      await expect(
        provider().update('Endpoint', ID, TYPE, interfaceProps({ SubnetIds: [1] }), interfaceProps(), {
          replayingState: true,
        })
      ).rejects.toThrow(/SubnetIds must be a list of ids/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('reads the live list when the recorded one is unreadable', async () => {
      mockSend.mockImplementation((cmd: unknown) =>
        Promise.resolve(
          cmd instanceof DescribeVpcEndpointsCommand
            ? described({ State: 'available', SubnetIds: ['subnet-a', 'subnet-z'] })
            : {}
        )
      );
      await provider().update('Endpoint', ID, TYPE, interfaceProps(), interfaceProps({ SubnetIds: 'x' }));
      expect(sent(ModifyVpcEndpointCommand)[0]!.input).toEqual({
        VpcEndpointId: ID,
        RemoveSubnetIds: ['subnet-z'],
      });
    });

    it('refuses an update in another region than the record', async () => {
      await expect(
        provider().update('Endpoint', ID, TYPE, interfaceProps(), interfaceProps(), {
          expectedRegion: 'eu-west-1',
        })
      ).rejects.toThrow(/region/i);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes, then waits until the endpoint is gone', async () => {
      const replies: unknown[] = [
        Promise.resolve(described({ State: 'deleting' })),
        Promise.reject(notFound()),
      ];
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof DeleteVpcEndpointsCommand ? Promise.resolve({ Unsuccessful: [] }) : replies.shift()
      );
      await provider().delete('Endpoint', ID, TYPE);
      expect(sent(DeleteVpcEndpointsCommand)[0]!.input).toEqual({ VpcEndpointIds: [ID] });
      expect(sent(DescribeVpcEndpointsCommand)).toHaveLength(2);
    });

    it('treats an Unsuccessful not-found item as already deleted, after the region check', async () => {
      mockSend.mockResolvedValueOnce({
        Unsuccessful: [
          { ResourceId: ID, Error: { Code: 'InvalidVpcEndpoint.NotFound', Message: 'user 1 does not own' } },
        ],
      });
      await provider().delete('Endpoint', ID, TYPE, undefined, { expectedRegion: 'us-east-1' });
      expect(mockSend).toHaveBeenCalledTimes(1);

      mockSend.mockResolvedValueOnce({
        Unsuccessful: [{ ResourceId: ID, Error: { Code: 'InvalidVpcEndpoint.NotFound' } }],
      });
      await expect(
        provider().delete('Endpoint', ID, TYPE, undefined, { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow(/region/i);
    });

    it('fails on any other Unsuccessful item, naming its code but not its message', async () => {
      mockSend.mockResolvedValueOnce({
        Unsuccessful: [
          { ResourceId: ID, Error: { Code: 'UnauthorizedOperation', Message: 'arn:aws:sts::1:assumed-role/x' } },
        ],
      });
      const error = await provider()
        .delete('Endpoint', ID, TYPE)
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(/refused it \(UnauthorizedOperation\)/);
      expect(String(error)).not.toMatch(/assumed-role/);
      expect(sent(DescribeVpcEndpointsCommand)).toHaveLength(0);
    });

    it('treats a thrown not-found as already deleted', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      await provider().delete('Endpoint', ID, TYPE);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('reads', () => {
    it('getAttribute reads Id from the physical id and the rest live', async () => {
      const p = provider();
      expect(await p.getAttribute(ID, TYPE, 'Id', 'Endpoint')).toBe(ID);
      expect(mockSend).not.toHaveBeenCalled();
      mockSend.mockResolvedValueOnce(described({ State: 'available' }));
      expect(await p.getAttribute(ID, TYPE, 'NetworkInterfaceIds', 'Endpoint')).toEqual(['eni-1']);
    });

    it('readCurrentState maps the endpoint back to the declared properties', async () => {
      mockSend.mockResolvedValueOnce(
        described({
          State: 'available',
          PolicyDocument: '{\n  "Statement": [ { "Effect": "Allow", "Action": "*", "Principal": "*", "Resource": "*" } ]\n}',
          DnsOptions: { DnsRecordIpType: 'ipv4', PrivateDnsOnlyForInboundResolverEndpoint: false },
          Tags: [{ Key: 'team', Value: 'a' }],
        })
      );
      const declaredPolicy = {
        Statement: [{ Effect: 'Allow', Principal: '*', Action: '*', Resource: '*' }],
      };
      const read = await provider().readCurrentState(
        ID,
        'Endpoint',
        TYPE,
        interfaceProps({
          PolicyDocument: declaredPolicy,
          DnsOptions: { PrivateDnsOnlyForInboundResolverEndpoint: 'AllResolvers' },
        })
      );
      expect(read).toEqual({
        VpcId: 'vpc-1',
        ServiceName: 'com.amazonaws.us-east-1.secretsmanager',
        VpcEndpointType: 'Interface',
        SubnetIds: ['subnet-a'],
        SecurityGroupIds: ['sg-1'],
        PrivateDnsEnabled: false,
        IpAddressType: 'ipv4',
        PolicyDocument: declaredPolicy,
        DnsOptions: { PrivateDnsOnlyForInboundResolverEndpoint: 'AllResolvers' },
        Tags: [{ Key: 'team', Value: 'a' }],
      });
    });

    it('readCurrentState reports a deleted or deleting endpoint as not found', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      expect(await provider().readCurrentState(ID, 'Endpoint', TYPE, {})).toBe(RESOURCE_NOT_FOUND);
      mockSend.mockResolvedValueOnce(described({ State: 'deleting' }));
      expect(await provider().readCurrentState(ID, 'Endpoint', TYPE, {})).toBe(RESOURCE_NOT_FOUND);
    });

    it('import verifies an explicit id and adopts nothing without one', async () => {
      const p = provider();
      expect(
        await p.import({ logicalId: 'Endpoint', resourceType: TYPE, stackName: 's', region: 'us-east-1', properties: {} })
      ).toBeNull();
      mockSend.mockResolvedValueOnce(described({ State: 'available' }));
      expect(
        await p.import({
          logicalId: 'Endpoint',
          resourceType: TYPE,
          stackName: 's',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: ID,
        })
      ).toMatchObject({ physicalId: ID, attributes: { Id: ID, NetworkInterfaceIds: ['eni-1'] } });
      mockSend.mockRejectedValueOnce(notFound());
      expect(
        await p.import({
          logicalId: 'Endpoint',
          resourceType: TYPE,
          stackName: 's',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: ID,
        })
      ).toBeNull();
    });
  });

  describe('review round 1', () => {
    const availableOr = (cmd: unknown, fields: Record<string, unknown> = {}) =>
      Promise.resolve(cmd instanceof DescribeVpcEndpointsCommand ? described({ State: 'available', ...fields }) : {});

    it('under --no-wait never records a post-modify read as settled, even when it still says available', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      // The read right after ModifyVpcEndpoint can still report the old state.
      mockSend.mockImplementation((cmd: unknown) => availableOr(cmd, { NetworkInterfaceIds: ['eni-old'] }));
      const result = await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps({ SubnetIds: ['subnet-a', 'subnet-b'] }),
        interfaceProps()
      );
      expect(result.attributes).toEqual({ Id: ID, CreationTimestamp: '2026-11-24T14:28:20.570Z' });
    });

    it('under --no-wait a tag-only update still records an available read', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockImplementation((cmd: unknown) => availableOr(cmd));
      const result = await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps({ Tags: [{ Key: 'team', Value: 'b' }] }),
        interfaceProps()
      );
      expect(result.attributes).toMatchObject({ NetworkInterfaceIds: ['eni-1'] });
    });

    it('reads an absent VpcEndpointType as Gateway, so a drift revert of an L1 Gateway endpoint is not refused', async () => {
      mockSend.mockImplementation((cmd: unknown) => availableOr(cmd));
      const recorded = { VpcId: 'vpc-1', ServiceName: 'com.amazonaws.us-east-1.s3', RouteTableIds: ['rtb-1'] };
      await provider().update(
        'Endpoint',
        ID,
        TYPE,
        { ...recorded, VpcEndpointType: 'Gateway', RouteTableIds: ['rtb-1', 'rtb-2'] },
        recorded,
        { desiredFromAwsReadback: true }
      );
      expect(sent(ModifyVpcEndpointCommand)[0]!.input).toEqual({
        VpcEndpointId: ID,
        AddRouteTableIds: ['rtb-2'],
      });
      // An explicit change of type is still refused.
      await expect(
        provider().update('Endpoint', ID, TYPE, { ...recorded, VpcEndpointType: 'Interface' }, recorded)
      ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    });

    it('refuses a change to a create-only DnsOptions member', async () => {
      for (const member of [
        { PrivateDnsPreference: 'ALL_DOMAINS' },
        { PrivateDnsSpecifiedDomains: ['example.com'] },
      ]) {
        const error = await provider()
          .update(
            'Endpoint',
            ID,
            TYPE,
            interfaceProps({ DnsOptions: { DnsRecordIpType: 'ipv4', ...member } }),
            interfaceProps({ DnsOptions: { DnsRecordIpType: 'ipv4' } })
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
        expect(String((error as ResourceUpdateNotSupportedError).suggestion ?? error)).toMatch(
          /DnsOptions\.PrivateDns(Preference|SpecifiedDomains) cannot change in place/
        );
      }
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('sends a changed IpAddressType and DnsOptions, AllResolvers as false', async () => {
      mockSend.mockImplementation((cmd: unknown) => availableOr(cmd));
      await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps({
          IpAddressType: 'dualstack',
          DnsOptions: { DnsRecordIpType: 'dualstack', PrivateDnsOnlyForInboundResolverEndpoint: 'AllResolvers' },
        }),
        interfaceProps({ IpAddressType: 'ipv4', DnsOptions: { DnsRecordIpType: 'ipv4' } })
      );
      expect(sent(ModifyVpcEndpointCommand)[0]!.input).toEqual({
        VpcEndpointId: ID,
        IpAddressType: 'dualstack',
        DnsOptions: { DnsRecordIpType: 'dualstack', PrivateDnsOnlyForInboundResolverEndpoint: false },
      });
    });

    it.each([
      ['PrivateDnsEnabled', 'maybe', /PrivateDnsEnabled is not a boolean/],
      ['IpAddressType', 7, /IpAddressType is not a non-empty string/],
      ['DnsOptions', 'x', /DnsOptions must be an object/],
    ])('refuses a malformed template %s and keeps the recorded one on a drift revert', async (key, bad, says) => {
      await expect(
        provider().update('Endpoint', ID, TYPE, interfaceProps({ [key]: bad }), interfaceProps())
      ).rejects.toThrow(says);
      expect(mockSend).not.toHaveBeenCalled();

      mockSend.mockImplementation((cmd: unknown) => availableOr(cmd));
      const previous = interfaceProps({ [key]: key === 'DnsOptions' ? { DnsRecordIpType: 'ipv4' } : key === 'IpAddressType' ? 'ipv4' : true });
      const result = await provider().update(
        'Endpoint',
        ID,
        TYPE,
        interfaceProps({ [key]: bad }),
        previous,
        { desiredFromAwsReadback: true }
      );
      expect(sent(ModifyVpcEndpointCommand)).toHaveLength(0);
      expect(result.effectiveProperties).toEqual(previous);
    });

    it('fails a create whose wait runs out, marked as created', async () => {
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof CreateVpcEndpointCommand
          ? Promise.resolve({ VpcEndpoint: endpoint() })
          : Promise.resolve(described({ State: 'pending' }))
      );
      const p = provider();
      p.endpointWait.timeoutMs = 0;
      const error = await p.create('Endpoint', TYPE, interfaceProps()).catch((e: unknown) => e);
      expect(String(error)).toMatch(/was still pending when its available wait ran out/);
      expect(hasCreatedBeforeFailure(error)).toBe(true);
    });

    it('fails a create answered with no VpcEndpointId, and a refused create, with no created mark', async () => {
      mockSend.mockResolvedValueOnce({ VpcEndpoint: {} });
      const noId = await provider().create('Endpoint', TYPE, interfaceProps()).catch((e: unknown) => e);
      expect(String(noId)).toMatch(/returned no VpcEndpointId/);
      expect(hasCreatedBeforeFailure(noId)).toBe(false);

      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('bad service'), { name: 'InvalidServiceName' })
      );
      const refused = await provider().create('Endpoint', TYPE, interfaceProps()).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ProvisioningError);
      expect(String(refused)).toMatch(/Failed to create VPC endpoint Endpoint/);
      expect(hasCreatedBeforeFailure(refused)).toBe(false);
    });

    it('rethrows a non-transient read failure during the create wait', async () => {
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof CreateVpcEndpointCommand
          ? Promise.resolve({ VpcEndpoint: endpoint() })
          : Promise.reject(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }))
      );
      const error = await provider().create('Endpoint', TYPE, interfaceProps()).catch((e: unknown) => e);
      expect(String(error)).toMatch(/Failed to create VPC endpoint Endpoint: denied/);
      expect(hasCreatedBeforeFailure(error)).toBe(true);
      expect(sent(DescribeVpcEndpointsCommand)).toHaveLength(1);
    });

    it('wraps a refused ModifyVpcEndpoint as a ProvisioningError', async () => {
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof ModifyVpcEndpointCommand
          ? Promise.reject(Object.assign(new Error('nope'), { name: 'InvalidParameter' }))
          : availableOr(cmd)
      );
      const error = await provider()
        .update('Endpoint', ID, TYPE, interfaceProps({ SubnetIds: ['subnet-b'] }), interfaceProps())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(String(error)).toMatch(/Failed to update VPC endpoint Endpoint: nope/);
    });

    it('marks a thrown delete failure naming another NotFound as not gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('no such subnet'), { name: 'InvalidSubnetID.NotFound' })
      );
      const error = await provider().delete('Endpoint', ID, TYPE).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(isMarkedNotGone(error)).toBe(true);
    });
  });

  describe('review round 2', () => {
    it('sends no PrivateDnsEnabled when a non-Interface endpoint drops it', async () => {
      mockSend.mockImplementation((cmd: unknown) =>
        Promise.resolve(cmd instanceof DescribeVpcEndpointsCommand ? described({ State: 'available' }) : {})
      );
      const gateway = { VpcId: 'vpc-1', ServiceName: 'com.amazonaws.us-east-1.s3', VpcEndpointType: 'Gateway' };
      await provider().update('Endpoint', ID, TYPE, gateway, { ...gateway, PrivateDnsEnabled: true });
      expect(sent(ModifyVpcEndpointCommand)).toHaveLength(0);
    });

    describe('with the command owning interrupts', () => {
      beforeEach(() => {
        disarmInterruptWatchForTests();
        interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      });
      afterEach(() => {
        disarmInterruptWatchForTests();
        delete interruptWatchTestSeam.commandOwnsInterrupts;
      });

      it('stops the available wait on Ctrl-C, the endpoint marked as created', async () => {
        mockSend.mockImplementation((cmd: unknown) =>
          cmd instanceof CreateVpcEndpointCommand
            ? Promise.resolve({ VpcEndpoint: endpoint() })
            : Promise.resolve(described({ State: 'pending' }))
        );
        const p = provider();
        // Bounded, so a wait that ignored the interrupt fails on its deadline.
        p.endpointWait.timeoutMs = 1_000;
        p.endpointWait.sleep = () => {
          process.emit('SIGINT');
          return Promise.resolve();
        };
        const error = await p.create('Endpoint', TYPE, interfaceProps()).catch((e: unknown) => e);
        expect(isInterruptedWaitError(error)).toBe(true);
        expect(hasCreatedBeforeFailure(error)).toBe(true);
        expect(sent(DescribeVpcEndpointsCommand)).toHaveLength(1);
      });
    });
  });
});
