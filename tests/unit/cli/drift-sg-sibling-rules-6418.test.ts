import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#7025 step 6: this file's fake AWS keeps answering the drifted
// read after an update, so the post-revert re-read is stubbed out here; it is
// covered by `tests/unit/cli/drift-revert-verify-7025.test.ts`.
vi.mock('../../../src/cli/commands/drift/revert-verify.js', () => ({
  verifyRevertedStack: vi.fn(async () => ({ notApplied: 0, unverified: 0 })),
}));
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6418: a rule a SIBLING standalone `AWS::EC2::SecurityGroupIngress`
 * / `SecurityGroupEgress` authorizes on a group is not the group's. On a group
 * whose template declares an inline rule list, `cdkd drift` reported it as
 * `SecurityGroupIngress` drift on a fresh stack, and `cdkd drift --revert`
 * REVOKED it. Driven end to end through the command, the real `EC2Provider`
 * (readback AND `update()`), over a mocked EC2.
 */

const mockEc2Send = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    get ec2() {
      return { send: mockEc2Send };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({ ec2: { send: mockEc2Send }, ec2SingleSend: { send: mockEc2Send } }),
}));

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: vi.fn(async () => '"etag-2"'),
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const GROUP = 'sg-0aaaaaaaaaaaaaaaa';
const PEER = 'sg-0bbbbbbbbbbbbbbbb';
const ACCOUNT = '123456789012';

/** One live rule, in the order `flattenIpPermissions` reads it. */
interface LiveRule {
  direction: 'ingress' | 'egress';
  port: number;
  cidr?: string;
  peer?: string;
  description?: string;
}

/** The group's live rules; the mocked EC2 reads and writes them. */
let live: LiveRule[] = [];
const revoked: Array<{ direction: string; port: number | undefined }> = [];
const authorized: Array<{ direction: string; port: number | undefined }> = [];

const INLINE_HTTPS: LiveRule = {
  direction: 'ingress',
  port: 443,
  cidr: '10.0.0.0/16',
  description: 'inline https',
};
const SIBLING_PG: LiveRule = { direction: 'ingress', port: 5432, peer: PEER, description: 'from B' };
const STRANGER: LiveRule = { direction: 'ingress', port: 9999, cidr: '10.9.0.0/16' };
const INLINE_EGRESS: LiveRule = { direction: 'egress', port: 443, cidr: '0.0.0.0/0' };
const SIBLING_EGRESS: LiveRule = { direction: 'egress', port: 8080, peer: PEER, description: 'to B' };

function permissionsOf(direction: 'ingress' | 'egress'): Array<Record<string, unknown>> {
  return live
    .filter((r) => r.direction === direction)
    .map((r) => ({
      IpProtocol: 'tcp',
      FromPort: r.port,
      ToPort: r.port,
      IpRanges: r.cidr
        ? [{ CidrIp: r.cidr, ...(r.description && { Description: r.description }) }]
        : [],
      Ipv6Ranges: [],
      PrefixListIds: [],
      UserIdGroupPairs: r.peer
        ? [
            {
              GroupId: r.peer,
              UserId: ACCOUNT,
              ...(r.description && { Description: r.description }),
            },
          ]
        : [],
    }));
}

function routeEc2(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
  const name = cmd.constructor.name;
  if (name === 'DescribeSecurityGroupsCommand') {
    return {
      SecurityGroups: [
        {
          GroupId: GROUP,
          GroupName: 'A',
          Description: 'A',
          VpcId: 'vpc-1',
          IpPermissions: permissionsOf('ingress'),
          IpPermissionsEgress: permissionsOf('egress'),
        },
      ],
    };
  }
  const write = /^(Revoke|Authorize)SecurityGroup(Ingress|Egress)Command$/.exec(name);
  if (write) {
    const direction = write[2] === 'Ingress' ? 'ingress' : 'egress';
    const perm = (cmd.input['IpPermissions'] as Array<Record<string, unknown>>)[0]!;
    const port = perm['FromPort'] as number | undefined;
    const cidr = (perm['IpRanges'] as Array<{ CidrIp: string }> | undefined)?.[0]?.CidrIp;
    const peer = (perm['UserIdGroupPairs'] as Array<{ GroupId: string }> | undefined)?.[0]?.GroupId;
    if (write[1] === 'Revoke') {
      revoked.push({ direction, port });
      live = live.filter(
        (r) =>
          !(r.direction === direction && r.port === port && r.cidr === cidr && r.peer === peer)
      );
    } else {
      authorized.push({ direction, port });
      live = [...live, { direction, port: port!, ...(cidr && { cidr }), ...(peer && { peer }) }];
    }
  }
  return {};
}

function cfnRule(rule: LiveRule): Record<string, unknown> {
  const peerKey = rule.direction === 'ingress' ? 'SourceSecurityGroupId' : 'DestinationSecurityGroupId';
  return {
    IpProtocol: 'tcp',
    FromPort: rule.port,
    ToPort: rule.port,
    ...(rule.cidr && { CidrIp: rule.cidr }),
    ...(rule.peer && { [peerKey]: rule.peer }),
    ...(rule.description && { Description: rule.description }),
  };
}

function stateWith(opts: {
  declaredIngress: LiveRule[];
  baselineIngress: LiveRule[];
  declaredEgress?: LiveRule[];
  baselineEgress?: LiveRule[];
  siblingGroup?: string;
}): { state: StackState; etag: string } {
  const group: ResourceState = {
    physicalId: GROUP,
    resourceType: 'AWS::EC2::SecurityGroup',
    properties: {
      GroupDescription: 'A',
      VpcId: 'vpc-1',
      SecurityGroupIngress: opts.declaredIngress.map(cfnRule),
      ...(opts.declaredEgress && { SecurityGroupEgress: opts.declaredEgress.map(cfnRule) }),
    },
    observedProperties: {
      GroupName: 'A',
      GroupDescription: 'A',
      VpcId: 'vpc-1',
      SecurityGroupIngress: opts.baselineIngress.map(cfnRule),
      SecurityGroupEgress: (opts.baselineEgress ?? []).map(cfnRule),
    },
  };
  const ingress: ResourceState = {
    physicalId: `${opts.siblingGroup ?? GROUP}|tcp|5432|5432|${PEER}`,
    resourceType: 'AWS::EC2::SecurityGroupIngress',
    properties: { GroupId: opts.siblingGroup ?? GROUP, ...cfnRule(SIBLING_PG) },
  };
  const egress: ResourceState = {
    physicalId: `${GROUP}|egress`,
    resourceType: 'AWS::EC2::SecurityGroupEgress',
    properties: { GroupId: GROUP, ...cfnRule(SIBLING_EGRESS) },
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { SgA: group, SgAfromB: ingress, SgAtoB: egress },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

/** Run `cdkd drift TestStack [...flags]`; returns the exit code it asked for, if any. */
async function runDrift(flags: string[]): Promise<number | undefined> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', ...flags], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
  const calls = exitSpy.mock.calls;
  return calls.length === 0 ? undefined : (calls[calls.length - 1]![0] as number | undefined);
}

let exitSpy: ReturnType<typeof vi.spyOn>;

describe('cdkd drift on a security group a sibling SecurityGroupIngress / Egress writes to (go-to-k/cdkd#6418)', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockEc2Send.mockReset();
    mockEc2Send.mockImplementation(async (cmd) => routeEc2(cmd));
    revoked.length = 0;
    authorized.length = 0;
    const ec2 = new EC2Provider();
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::EC2::SecurityGroup'
        ? ec2
        : // The standalone rules read back exactly as recorded.
          {
            readCurrentState: async (
              _pid: string,
              _lid: string,
              _type: string,
              recorded: Record<string, unknown>
            ) => recorded,
          }
    );
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('a fresh deploy (baseline captured before the sibling authorized) reports no drift', async () => {
    live = [INLINE_HTTPS, SIBLING_PG];
    mockGetState.mockResolvedValue(
      stateWith({ declaredIngress: [INLINE_HTTPS], baselineIngress: [INLINE_HTTPS] })
    );

    expect((await runDrift([])) ?? 0).toBe(0);
  });

  it('a baseline captured AFTER the sibling authorized (a later group UPDATE) reports no drift', async () => {
    live = [INLINE_HTTPS, SIBLING_PG];
    mockGetState.mockResolvedValue(
      stateWith({ declaredIngress: [INLINE_HTTPS], baselineIngress: [INLINE_HTTPS, SIBLING_PG] })
    );

    expect((await runDrift([])) ?? 0).toBe(0);
  });

  it('a sibling SecurityGroupEgress on a group declaring inline egress reports no drift', async () => {
    live = [INLINE_HTTPS, INLINE_EGRESS, SIBLING_EGRESS];
    mockGetState.mockResolvedValue(
      stateWith({
        declaredIngress: [INLINE_HTTPS],
        baselineIngress: [INLINE_HTTPS],
        declaredEgress: [INLINE_EGRESS],
        baselineEgress: [INLINE_EGRESS],
      })
    );

    expect((await runDrift([])) ?? 0).toBe(0);
  });

  it('an out-of-band egress rule on the sibling egress port but to another peer still reports drift', async () => {
    live = [
      INLINE_HTTPS,
      INLINE_EGRESS,
      SIBLING_EGRESS,
      { direction: 'egress', port: 8080, peer: 'sg-0cccccccccccccccc' },
    ];
    mockGetState.mockResolvedValue(
      stateWith({
        declaredIngress: [INLINE_HTTPS],
        baselineIngress: [INLINE_HTTPS],
        declaredEgress: [INLINE_EGRESS],
        baselineEgress: [INLINE_EGRESS],
      })
    );

    expect(await runDrift([])).toBe(1);
  });

  it('an out-of-band rule still reports drift', async () => {
    live = [INLINE_HTTPS, SIBLING_PG, STRANGER];
    mockGetState.mockResolvedValue(
      stateWith({ declaredIngress: [INLINE_HTTPS], baselineIngress: [INLINE_HTTPS] })
    );

    expect(await runDrift([])).toBe(1);
  });

  it('a sibling authorizing on ANOTHER group does not hide the rule on this one', async () => {
    live = [INLINE_HTTPS, SIBLING_PG];
    mockGetState.mockResolvedValue(
      stateWith({
        declaredIngress: [INLINE_HTTPS],
        baselineIngress: [INLINE_HTTPS],
        siblingGroup: 'sg-0cccccccccccccccc',
      })
    );

    expect(await runDrift([])).toBe(1);
  });

  it.each([
    ['captured before the authorize', [INLINE_HTTPS]],
    ['captured after the authorize', [INLINE_HTTPS, SIBLING_PG]],
  ])(
    '--revert of an out-of-band rule revokes ONLY it, never the sibling (baseline %s)',
    async (_label, baseline) => {
      live = [INLINE_HTTPS, SIBLING_PG, STRANGER];
      mockGetState.mockResolvedValue(
        stateWith({ declaredIngress: [INLINE_HTTPS], baselineIngress: baseline })
      );

      await runDrift(['--revert', '--yes']);

      expect(revoked).toEqual([{ direction: 'ingress', port: 9999 }]);
      expect(authorized).toEqual([]);
      expect(live.map((r) => r.port).sort()).toEqual([443, 5432]);
    }
  );

  it('--revert on a clean stack leaves the sibling rules authorized', async () => {
    live = [INLINE_HTTPS, INLINE_EGRESS, SIBLING_PG, SIBLING_EGRESS];
    mockGetState.mockResolvedValue(
      stateWith({
        declaredIngress: [INLINE_HTTPS],
        baselineIngress: [INLINE_HTTPS],
        declaredEgress: [INLINE_EGRESS],
        baselineEgress: [INLINE_EGRESS],
      })
    );

    await runDrift(['--revert', '--yes']);

    expect(revoked).toEqual([]);
    expect(live).toHaveLength(4);
  });

  it('a rule the group ALSO declares inline stays compared: its revoke is drift and --revert re-authorizes it', async () => {
    live = [INLINE_HTTPS];
    mockGetState.mockResolvedValue(
      stateWith({
        declaredIngress: [INLINE_HTTPS, SIBLING_PG],
        baselineIngress: [INLINE_HTTPS, SIBLING_PG],
      })
    );

    expect(await runDrift([])).toBe(1);

    exitSpy.mockClear();
    await runDrift(['--revert', '--yes']);

    expect(authorized).toEqual([{ direction: 'ingress', port: 5432 }]);
    expect(revoked).toEqual([]);
  });
});
