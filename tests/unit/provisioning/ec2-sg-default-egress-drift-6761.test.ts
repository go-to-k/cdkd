/**
 * go-to-k/cdkd#6761: a security group whose record declares no
 * `SecurityGroupEgress` keeps AWS's default allow-all egress rule, as
 * CloudFormation's group does, so the readback reports it and revoking it out
 * of band is drift. The shapes CDK declares (`allowAllOutbound: true` and the
 * `255.255.255.255/32` "Disallow all traffic" placeholder of
 * `allowAllOutbound: false`, both in aws-cdk-lib's `security-group.js`) read
 * clean, and an egress rule added out of band drifts on every shape.
 *
 * Each case runs the real readback into the real comparison
 * (`compareDriftReadback`), with the deploy-time baseline produced by the same
 * readback, as cdkd records it.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { IpPermission } from '@aws-sdk/client-ec2';

const mockSend = vi.hoisted(() => vi.fn());
const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...childLogger, child: () => childLogger }),
}));

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { compareDriftReadback } from '../../../src/cli/commands/drift/compare.js';

const TYPE = 'AWS::EC2::SecurityGroup';
const GROUP = 'sg-0123456789abcdef0';

/** What CreateSecurityGroup attaches to every new group. */
const AWS_DEFAULT: IpPermission = { IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] };
/** aws-cdk-lib `ALLOW_ALL_RULE` (`allowAllOutbound: true`, the default). */
const CDK_ALLOW_ALL = {
  CidrIp: '0.0.0.0/0',
  Description: 'Allow all outbound traffic by default',
  IpProtocol: '-1',
};
const CDK_ALLOW_ALL_LIVE: IpPermission = {
  IpProtocol: '-1',
  IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'Allow all outbound traffic by default' }],
};
/** aws-cdk-lib `MATCH_NO_TRAFFIC` (`allowAllOutbound: false`). */
const CDK_NO_TRAFFIC = {
  CidrIp: '255.255.255.255/32',
  Description: 'Disallow all traffic',
  FromPort: 252,
  IpProtocol: 'icmp',
  ToPort: 86,
};
const CDK_NO_TRAFFIC_LIVE: IpPermission = {
  IpProtocol: 'icmp',
  FromPort: 252,
  ToPort: 86,
  IpRanges: [{ CidrIp: '255.255.255.255/32', Description: 'Disallow all traffic' }],
};
/** The rule an operator adds out of band. */
const ADDED_LIVE: IpPermission = {
  IpProtocol: 'tcp',
  FromPort: 443,
  ToPort: 443,
  IpRanges: [{ CidrIp: '203.0.113.0/24' }],
};

let provider: EC2Provider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new EC2Provider();
});

const read = async (properties: Record<string, unknown>, egress: IpPermission[]) => {
  mockSend.mockResolvedValueOnce({
    SecurityGroups: [
      {
        GroupId: GROUP,
        GroupName: 'g',
        Description: 'd',
        VpcId: 'vpc-1',
        IpPermissions: [],
        IpPermissionsEgress: egress,
      },
    ],
  });
  return (await provider.readCurrentState(GROUP, 'Sg', TYPE, properties)) as Record<
    string,
    unknown
  >;
};

/**
 * The drifted paths of a group recorded with `properties`, its baseline read
 * while AWS held `deployed` (or `baseline` verbatim), compared against a live
 * group holding `live`.
 */
const driftedPaths = async (
  properties: Record<string, unknown>,
  deployed: IpPermission[] | { baseline: Record<string, unknown> },
  live: IpPermission[]
): Promise<string[]> => {
  const observedProperties = Array.isArray(deployed)
    ? await read(properties, deployed)
    : deployed.baseline;
  const aws = await read(properties, live);
  const outcomes: Array<{ kind: string; changes?: Array<{ path: string }> }> = [];
  await compareDriftReadback({
    region: 'us-east-1',
    resolvePrincipalUniqueId: () => Promise.resolve(undefined),
    outcomes: outcomes as never,
    logger: childLogger as never,
    secretResolvers: {} as never,
    producerRegions: { regions: [], complete: true },
    stackSecretNames: new Map(),
    resource: {
      resourceType: TYPE,
      physicalId: GROUP,
      properties,
      observedProperties,
      attributes: {},
    } as never,
    logicalId: 'Sg',
    provider,
    secrets: new Map(),
    printing: new Map(),
    aws,
  });
  expect(outcomes).toHaveLength(1);
  return (outcomes[0]!.changes ?? []).map((c) => c.path);
};

const UNDECLARED = { GroupDescription: 'd', VpcId: 'vpc-1' };

describe('no SecurityGroupEgress declared: the group keeps the AWS default rule', () => {
  it('reads the default rule back', async () => {
    expect((await read(UNDECLARED, [AWS_DEFAULT]))['SecurityGroupEgress']).toEqual([
      { IpProtocol: '-1', CidrIp: '0.0.0.0/0' },
    ]);
  });

  it('is clean while the default rule stays', async () => {
    expect(await driftedPaths(UNDECLARED, [AWS_DEFAULT], [AWS_DEFAULT])).toEqual([]);
  });

  it('drifts when the default rule is revoked out of band (the issue)', async () => {
    expect(await driftedPaths(UNDECLARED, [AWS_DEFAULT], [])).toEqual(['SecurityGroupEgress']);
  });

  it('drifts when an egress rule is added out of band', async () => {
    expect(await driftedPaths(UNDECLARED, [AWS_DEFAULT], [AWS_DEFAULT, ADDED_LIVE])).toEqual([
      'SecurityGroupEgress',
    ]);
  });

  it('reads no phantom drift on a baseline an earlier cdkd captured without the rule', async () => {
    const baseline = { ...(await read(UNDECLARED, [])), SecurityGroupEgress: [] };
    expect(await driftedPaths(UNDECLARED, { baseline }, [AWS_DEFAULT])).toEqual([]);
  });
});

describe('CDK allowAllOutbound: true (declared allow-all with a description)', () => {
  const declared = { ...UNDECLARED, SecurityGroupEgress: [CDK_ALLOW_ALL] };

  it('is clean after deploy', async () => {
    expect(await driftedPaths(declared, [CDK_ALLOW_ALL_LIVE], [CDK_ALLOW_ALL_LIVE])).toEqual([]);
  });

  it('drifts when an egress rule is added out of band', async () => {
    expect(
      await driftedPaths(declared, [CDK_ALLOW_ALL_LIVE], [CDK_ALLOW_ALL_LIVE, ADDED_LIVE])
    ).toEqual(['SecurityGroupEgress']);
  });
});

describe('CDK allowAllOutbound: false (the 255.255.255.255/32 placeholder)', () => {
  const declared = { ...UNDECLARED, SecurityGroupEgress: [CDK_NO_TRAFFIC] };

  it('is clean after deploy', async () => {
    expect(await driftedPaths(declared, [CDK_NO_TRAFFIC_LIVE], [CDK_NO_TRAFFIC_LIVE])).toEqual([]);
  });

  it('drifts when an egress rule is added out of band', async () => {
    expect(
      await driftedPaths(declared, [CDK_NO_TRAFFIC_LIVE], [CDK_NO_TRAFFIC_LIVE, ADDED_LIVE])
    ).toEqual(['SecurityGroupEgress']);
  });

  it('drifts when the AWS default rule comes back out of band', async () => {
    expect(
      await driftedPaths(declared, [CDK_NO_TRAFFIC_LIVE], [CDK_NO_TRAFFIC_LIVE, AWS_DEFAULT])
    ).toEqual(['SecurityGroupEgress']);
  });
});
