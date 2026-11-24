import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6641: a sibling standalone `AWS::EC2::SecurityGroupIngress`
 * whose ports were changed out of band (`ModifySecurityGroupRules`, which keeps
 * the `sgr-` id) no longer matched its record by identity, so the group
 * reported it as an extra inline rule and `cdkd drift --revert` REVOKED it,
 * while the rule's own record read as deleted. Driven end to end through the
 * command and the real `EC2Provider` (both readbacks and both `update()`s),
 * over a mocked EC2 that keeps rule ids.
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
const SIBLING_ID = 'sgr-0aaaaaaaaaaaaaaa1';

/** One live ingress rule with its `sgr-` id. */
interface LiveRule {
  id: string;
  port: number;
  cidr: string;
}

let live: LiveRule[] = [];
const revoked: number[] = [];
const authorized: number[] = [];
const sent: string[] = [];
/** When set, every `DescribeSecurityGroupRules` call fails with it. */
let rulesFailure: Error | undefined;

const INLINE: LiveRule = { id: 'sgr-0bbbbbbbbbbbbbbb1', port: 443, cidr: '10.0.0.0/16' };

function routeEc2(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
  const name = cmd.constructor.name;
  sent.push(name);
  if (name === 'DescribeSecurityGroupsCommand') {
    return {
      SecurityGroups: [
        {
          GroupId: GROUP,
          GroupName: 'A',
          Description: 'A',
          VpcId: 'vpc-1',
          IpPermissions: live.map((r) => ({
            IpProtocol: 'tcp',
            FromPort: r.port,
            ToPort: r.port,
            IpRanges: [{ CidrIp: r.cidr }],
          })),
          IpPermissionsEgress: [],
        },
      ],
    };
  }
  if (name === 'DescribeSecurityGroupRulesCommand') {
    if (rulesFailure) throw rulesFailure;
    const ids = cmd.input['SecurityGroupRuleIds'] as string[] | undefined;
    return {
      SecurityGroupRules: live
        .filter((r) => ids === undefined || ids.includes(r.id))
        .map((r) => ({
          SecurityGroupRuleId: r.id,
          GroupId: GROUP,
          IsEgress: false,
          IpProtocol: 'tcp',
          FromPort: r.port,
          ToPort: r.port,
          CidrIpv4: r.cidr,
        })),
    };
  }
  const write = /^(Revoke|Authorize)SecurityGroupIngressCommand$/.exec(name);
  if (write) {
    const perm = (cmd.input['IpPermissions'] as Array<Record<string, unknown>>)[0]!;
    const port = perm['FromPort'] as number;
    if (write[1] === 'Revoke') {
      revoked.push(port);
      live = live.filter((r) => r.port !== port);
    } else {
      authorized.push(port);
      const cidr = (perm['IpRanges'] as Array<{ CidrIp: string }>)[0]!.CidrIp;
      live = [...live, { id: `sgr-0ccccccccccccccc${live.length}`, port, cidr }];
    }
  }
  return {};
}

const cfnRule = (r: { port: number; cidr: string }) => ({
  IpProtocol: 'tcp',
  FromPort: r.port,
  ToPort: r.port,
  CidrIp: r.cidr,
});

/** A group declaring INLINE, plus a standalone CIDR ingress recorded on port 8443. */
function stack(): { state: StackState; etag: string } {
  const group: ResourceState = {
    physicalId: GROUP,
    resourceType: 'AWS::EC2::SecurityGroup',
    properties: { GroupDescription: 'A', VpcId: 'vpc-1', SecurityGroupIngress: [cfnRule(INLINE)] },
    observedProperties: {
      GroupName: 'A',
      GroupDescription: 'A',
      VpcId: 'vpc-1',
      SecurityGroupIngress: [cfnRule(INLINE)],
      SecurityGroupEgress: [],
    },
  };
  const rule: ResourceState = {
    physicalId: `${GROUP}|tcp|8443|8443`,
    resourceType: 'AWS::EC2::SecurityGroupIngress',
    properties: { GroupId: GROUP, ...cfnRule({ port: 8443, cidr: '10.1.0.0/16' }) },
    attributes: { Id: SIBLING_ID },
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { SgA: group, SgARule: rule },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;

/** Run `cdkd drift TestStack [...flags]`; returns the exit code and what it printed. */
async function runDrift(flags: string[]): Promise<{ code: number | undefined; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
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
  const code = calls.length === 0 ? undefined : (calls[calls.length - 1]![0] as number | undefined);
  return { code, out };
}

/** Which `--json` list (`drifted`, `clean`, `deleted`, ...) holds each logical id. */
function statuses(out: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            const lid = (entry as { logicalId?: unknown } | null)?.logicalId;
            if (typeof lid === 'string') result[lid] = key;
          }
        }
        walk(value);
      }
    }
  };
  walk(JSON.parse(out) as unknown);
  return result;
}

describe('cdkd drift on a sibling SecurityGroupIngress moved out of band (go-to-k/cdkd#6641)', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockEc2Send.mockReset();
    mockEc2Send.mockImplementation(async (cmd) => routeEc2(cmd));
    revoked.length = 0;
    authorized.length = 0;
    sent.length = 0;
    rulesFailure = undefined;
    const ec2 = new EC2Provider();
    mockRegistryGetProvider.mockImplementation(() => ec2);
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue(stack());
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('reports the moved rule on the RULE resource, not as an extra rule of the group', async () => {
    live = [INLINE, { id: SIBLING_ID, port: 8444, cidr: '10.1.0.0/16' }];

    const { code, out } = await runDrift(['--json']);

    expect(code).toBe(1);
    const status = statuses(out);
    expect(status['SgARule']).toBe('drifted');
    expect(status['SgA']).toBe('clean');
  });

  it('--revert never revokes the moved rule: the group leaves it and the rule refuses to replace itself', async () => {
    live = [INLINE, { id: SIBLING_ID, port: 8444, cidr: '10.1.0.0/16' }];

    await runDrift(['--revert', '--yes']);

    expect(revoked).toEqual([]);
    expect(authorized).toEqual([]);
    expect(live.map((r) => r.id)).toEqual([INLINE.id, SIBLING_ID]);
  });

  it('a rule with ANOTHER id on the same port is still the group drift, and --revert still revokes it', async () => {
    live = [
      INLINE,
      { id: SIBLING_ID, port: 8443, cidr: '10.1.0.0/16' },
      { id: 'sgr-0ddddddddddddddd1', port: 8444, cidr: '10.1.0.0/16' },
    ];

    const { out } = await runDrift(['--json']);
    expect(statuses(out)['SgA']).toBe('drifted');
    expect(statuses(out)['SgARule']).toBe('clean');

    exitSpy.mockClear();
    await runDrift(['--revert', '--yes']);
    expect(revoked).toEqual([8444]);
    expect(live.map((r) => r.id)).toEqual([INLINE.id, SIBLING_ID]);
  });

  it('an unmoved sibling: clean, and the rule ids replace one describe call each', async () => {
    live = [INLINE, { id: SIBLING_ID, port: 8443, cidr: '10.1.0.0/16' }];

    const { code } = await runDrift([]);

    expect(code ?? 0).toBe(0);
    // The group: its own describe plus ONE rule-id read. The rule: its rule-id
    // read in place of the group describe it made before.
    expect(sent.filter((n) => n === 'DescribeSecurityGroupRulesCommand')).toHaveLength(2);
    expect(sent.filter((n) => n === 'DescribeSecurityGroupsCommand')).toHaveLength(1);
  });

  it('B1: a sibling widened to 22 from anywhere plus a stranger at its old identity: the widening is the RULE drift, the stranger the GROUP drift, and --revert revokes only the stranger and never reports the widening reverted', async () => {
    live = [
      INLINE,
      { id: SIBLING_ID, port: 22, cidr: '0.0.0.0/0' },
      { id: 'sgr-0ddddddddddddddd1', port: 8443, cidr: '10.1.0.0/16' },
    ];

    const { out } = await runDrift(['--json']);
    expect(statuses(out)['SgARule']).toBe('drifted');
    expect(statuses(out)['SgA']).toBe('drifted');

    exitSpy.mockClear();
    const { code } = await runDrift(['--revert', '--yes']);
    expect(revoked).toEqual([8443]);
    expect(authorized).toEqual([]);
    expect(live.map((r) => r.id)).toEqual([INLINE.id, SIBLING_ID]);
    // The rule's own revert refused: the run is not a success.
    expect(code).toBe(2);
  });

  it('a sibling rule revoked out of band still reads as deleted', async () => {
    live = [INLINE];

    const { out } = await runDrift(['--json']);

    expect(statuses(out)['SgARule']).toBe('deleted');
    expect(statuses(out)['SgA']).toBe('clean');
  });

  it('a throttled rule-id read of the RULE is a failed read (exit 2), never "cannot tell" (exit 0)', async () => {
    // The group falls back to identity (clean here); the rule's read fails, so
    // the run cannot pass as clean.
    live = [INLINE, { id: SIBLING_ID, port: 8443, cidr: '10.1.0.0/16' }];
    rulesFailure = Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });

    const { code } = await runDrift([]);

    expect(code).toBe(2);
  });

  it('with a widened rule and every rule-id read throttled, the widening is drift on the group (exit 1)', async () => {
    live = [INLINE, { id: SIBLING_ID, port: 22, cidr: '0.0.0.0/0' }];
    rulesFailure = Object.assign(new Error('Rate exceeded'), { name: 'Throttling' });

    const { code, out } = await runDrift(['--json']);

    expect(code).toBe(1);
    expect(statuses(out)['SgA']).toBe('drifted');
  });

  it("a Cloud Control-provisioned group's revert refuses, before its update, to revoke a rule a sibling holds by id", async () => {
    live = [INLINE, { id: SIBLING_ID, port: 8444, cidr: '10.1.0.0/16' }];
    const ccUpdate = vi.fn(async () => ({ physicalId: GROUP, wasReplaced: false }));
    const ec2 = new EC2Provider();
    // Cloud Control reads every rule of the group, the sibling's moved one too.
    const cc = {
      readCurrentState: async () => ({
        GroupName: 'A',
        GroupDescription: 'A',
        VpcId: 'vpc-1',
        SecurityGroupIngress: live.map((r) => cfnRule(r)),
        SecurityGroupEgress: [],
      }),
      update: ccUpdate,
    };
    mockRegistryGetProvider.mockImplementation((type) => (type === 'AWS::EC2::SecurityGroup' ? cc : ec2));
    const state = stack();
    state.state.resources['SgA']!.provisionedBy = 'cc-api';
    mockGetState.mockResolvedValue(state);

    const { code } = await runDrift(['--revert', '--yes']);

    expect(ccUpdate).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);
    expect(code).toBe(2);
  });

  describe('a Cloud Control-provisioned group (its update replaces a changed rule list whole)', () => {
    const ccGroup = (tags: Array<{ Key: string; Value: string }> = []) => {
      const update = vi.fn(async () => ({ physicalId: GROUP, wasReplaced: false }));
      const ec2 = new EC2Provider();
      const cc = {
        readCurrentState: async () => ({
          GroupName: 'A',
          GroupDescription: 'A',
          VpcId: 'vpc-1',
          SecurityGroupIngress: live.map((r) => cfnRule(r)),
          SecurityGroupEgress: [],
          ...(tags.length > 0 && { Tags: tags }),
        }),
        update,
      };
      mockRegistryGetProvider.mockImplementation((type) => (type === 'AWS::EC2::SecurityGroup' ? cc : ec2));
      const state = stack();
      state.state.resources['SgA']!.provisionedBy = 'cc-api';
      if (tags.length > 0) {
        // The template declares the tag; the live value differs.
        const group = state.state.resources['SgA']!;
        group.properties = { ...group.properties, Tags: [{ Key: 'oob', Value: 'recorded' }] };
        group.observedProperties = { ...group.observedProperties, Tags: [{ Key: 'oob', Value: 'recorded' }] };
      }
      mockGetState.mockResolvedValue(state);
      return update;
    };

    it("refuses when an out-of-band inline rule would be reverted beside a sibling's unmoved rule", async () => {
      live = [INLINE, { id: SIBLING_ID, port: 8443, cidr: '10.1.0.0/16' }, { id: 'sgr-0ddddddddddddddd1', port: 9999, cidr: '10.9.0.0/16' }];
      const update = ccGroup();

      const { code } = await runDrift(['--revert', '--yes']);

      expect(update).not.toHaveBeenCalled();
      expect(code).toBe(2);
    });

    it('still reverts a change that leaves both rule lists alone (a tag)', async () => {
      live = [INLINE, { id: SIBLING_ID, port: 8443, cidr: '10.1.0.0/16' }];
      const update = ccGroup([{ Key: 'oob', Value: 'x' }]);

      await runDrift(['--revert', '--yes']);

      expect(update).toHaveBeenCalledTimes(1);
    });
  });
});
