import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#4447: `cdkd drift --revert` through the REAL `EC2Provider` for a
 * standalone `AWS::EC2::SecurityGroupIngress` whose live rule matches only by
 * identity (protocol, ports, source), not by description.
 *
 * The reader binds such a rule only on ownership evidence (the record's own
 * `sgr-` id names it), because `--revert` revokes the rule it read: binding a
 * rule someone re-added after cdkd's was revoked would remove THEIR rule. And
 * it binds none when a sibling record declares the same rule (#4492), whose
 * description AWS keeps from the first writer. Both are asserted at the wire:
 * no revoke / authorize / modify call reaches EC2.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const make = (): Record<string, unknown> => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => make(),
  });
  return { reserveStdoutForPayload: vi.fn(), getLogger: () => make() };
});

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

const mockEc2Send = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
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
  getAwsClients: () => ({
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const mockSaveState = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => '"etag-2"'));
const mockGetState = vi.fn<() => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    getLockInfo: vi.fn(async () => null),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const mockGetProvider = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: (type: string) => mockGetProvider(type),
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockGetProvider(input.resourceType),
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
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { buildReadCurrentStateContext, createDriftCommand } from '../../../src/cli/commands/drift.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const SGI = 'AWS::EC2::SecurityGroupIngress';
const OUR_ID = 'sgr-0aaaaaaaaaaaaaaaa';
const PHYS = 'sg-1|tcp|443|443';
const DECLARED = {
  GroupId: 'sg-1',
  IpProtocol: 'tcp',
  FromPort: 443,
  ToPort: 443,
  CidrIp: '10.0.0.0/16',
  Description: 'ours',
};

function stackState(resources: StackState['resources']): { state: StackState; etag: string } {
  return {
    state: {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

function ingressRecord(
  description: string,
  ruleId: string
): StackState['resources'][string] {
  return {
    physicalId: PHYS,
    resourceType: SGI,
    properties: { ...DECLARED, Description: description },
    attributes: { Id: ruleId },
  };
}

/**
 * The live account: the group holds ONE rule for the permission, with
 * `liveDescription` and id `liveId`. `DescribeSecurityGroupRules` answers by id
 * only for that rule; any other id is EC2's not-found.
 */
function stubEc2(liveId: string, liveDescription: string): void {
  const liveRule = {
    SecurityGroupRuleId: liveId,
    GroupId: 'sg-1',
    IsEgress: false,
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    CidrIpv4: '10.0.0.0/16',
    Description: liveDescription,
  };
  mockEc2Send.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      switch (command.constructor.name) {
        case 'DescribeSecurityGroupsCommand':
          return {
            SecurityGroups: [
              {
                GroupId: 'sg-1',
                IpPermissions: [
                  {
                    IpProtocol: 'tcp',
                    FromPort: 443,
                    ToPort: 443,
                    IpRanges: [{ CidrIp: '10.0.0.0/16', Description: liveDescription }],
                  },
                ],
              },
            ],
          };
        case 'DescribeSecurityGroupRulesCommand': {
          const ids = command.input['SecurityGroupRuleIds'] as string[] | undefined;
          if (ids && !ids.includes(liveId)) {
            const err = new Error(`The security group rule ID '${ids[0]}' does not exist`);
            err.name = 'InvalidSecurityGroupRuleId.NotFound';
            throw err;
          }
          return { SecurityGroupRules: [liveRule] };
        }
        default:
          return {};
      }
    }
  );
}

const WRITES = /Revoke|Authorize|Modify|UpdateSecurityGroupRuleDescriptions/;
const writes = (): string[] =>
  mockEc2Send.mock.calls
    .map((call) => (call[0] as { constructor: { name: string } }).constructor.name)
    .filter((name) => WRITES.test(name));

async function revert(): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(
      ['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', '--revert', '--yes'],
      { from: 'user' }
    );
  } catch {
    // The wire is what these cases read, not the exit code.
  } finally {
    process.stdout.write = original;
  }
}

describe('drift --revert on a standalone SG ingress rule matched by identity (go-to-k/cdkd#4447)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockEc2Send.mockReset();
    mockGetState.mockReset();
    mockSaveState.mockClear();
    mockListStacks.mockReset().mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    const ec2 = new EC2Provider();
    mockGetProvider.mockReset().mockImplementation(() => ec2);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('restores OUR rule’s description when the recorded id names the live rule', async () => {
    stubEc2(OUR_ID, 'edited in the console');
    mockGetState.mockResolvedValue(stackState({ Rule: ingressRecord('ours', OUR_ID) }));

    await revert();

    // Non-vacuity: the harness reaches the revert's writes for an OWNED rule.
    expect(writes().length).toBeGreaterThan(0);
  });

  it('does not touch a stranger’s rule: the recorded id is stale, the live rule has another id', async () => {
    stubEc2('sgr-0bbbbbbbbbbbbbbbb', 'a stranger re-added it');
    mockGetState.mockResolvedValue(stackState({ Rule: ingressRecord('ours', OUR_ID) }));

    await revert();

    expect(writes()).toEqual([]);
  });

  it('does not touch a rule two sibling records share (#4492)', async () => {
    stubEc2(OUR_ID, 'first');
    mockGetState.mockResolvedValue(
      stackState({
        First: ingressRecord('first', OUR_ID),
        Second: ingressRecord('second', OUR_ID),
      })
    );

    await revert();

    expect(writes()).toEqual([]);
  });
});

describe('buildReadCurrentStateContext (go-to-k/cdkd#4447)', () => {
  it('carries the read resource’s own recorded attributes', () => {
    const { state } = stackState({
      Rule: ingressRecord('ours', OUR_ID),
      Other: ingressRecord('other', 'sgr-0ccccccccccccccc0'),
    });

    const context = buildReadCurrentStateContext(state, 'Rule');

    expect(context.attributes).toEqual({ Id: OUR_ID });
    expect(Object.keys(context.siblings ?? {})).toEqual(['Other']);
  });

  it.each([
    ['no attributes', { physicalId: PHYS, resourceType: SGI, properties: {} }],
    ['a non-object attributes', { physicalId: PHYS, resourceType: SGI, properties: {}, attributes: 'x' }],
    ['an unreadable record', 'not-a-record'],
  ])('omits them for %s', (_label, record) => {
    const { state } = stackState({ Rule: record as never });

    expect(buildReadCurrentStateContext(state, 'Rule').attributes).toBeUndefined();
  });
});
