import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6328: list members a SIBLING owns, end to end through
 * `cdkd drift` / `--revert` with the real providers over a mocked IAM:
 *  - a user's `Groups` a sibling `AWS::IAM::UserToGroupAddition` writes (the
 *    live-reproduced shape: an UNDECLARED `Groups` whose baseline raced the
 *    addition, which then dropped the user, and `--revert` re-granted it);
 *  - a managed policy's `Roles` a sibling role writes through its own
 *    `ManagedPolicyArns`.
 */

const mockIamSend = vi.hoisted(() => vi.fn());

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
    get iam() {
      return { send: mockIamSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({ iam: { send: mockIamSend } }),
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
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';

const USER = 'alice';
const MP_ARN = 'arn:aws:iam::123456789012:policy/TestStack-Mp-ABC';

/** Live IAM, read and written by the mocked client. */
let userGroups: string[] = [];
let policyRoles: string[] = [];
const writes: string[] = [];

function routeIam(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
  const i = cmd.input;
  switch (cmd.constructor.name) {
    case 'GetUserCommand':
      return { User: { UserName: USER, Path: '/' } };
    case 'ListAttachedUserPoliciesCommand':
      return { AttachedPolicies: [] };
    case 'ListGroupsForUserCommand':
      return { Groups: userGroups.map((GroupName) => ({ GroupName })) };
    case 'ListUserPoliciesCommand':
      return { PolicyNames: [], IsTruncated: false };
    case 'AddUserToGroupCommand':
      writes.push(`add ${i['GroupName'] as string}`);
      userGroups = [...userGroups, i['GroupName'] as string];
      return {};
    case 'RemoveUserFromGroupCommand':
      writes.push(`remove ${i['GroupName'] as string}`);
      userGroups = userGroups.filter((g) => g !== i['GroupName']);
      return {};
    case 'GetPolicyCommand':
      return { Policy: { PolicyName: 'TestStack-Mp-ABC', Path: '/', Arn: MP_ARN } };
    case 'ListEntitiesForPolicyCommand':
      return {
        PolicyRoles: policyRoles.map((RoleName) => ({ RoleName })),
        PolicyUsers: [],
        PolicyGroups: [],
        IsTruncated: false,
      };
    case 'ListPolicyTagsCommand':
      return { Tags: [], IsTruncated: false };
    case 'AttachRolePolicyCommand':
      writes.push(`attach ${i['RoleName'] as string}`);
      policyRoles = [...policyRoles, i['RoleName'] as string];
      return {};
    case 'DetachRolePolicyCommand':
      writes.push(`detach ${i['RoleName'] as string}`);
      policyRoles = policyRoles.filter((r) => r !== i['RoleName']);
      return {};
    default:
      return {};
  }
}

function stack(resources: Record<string, ResourceState>): { state: StackState; etag: string } {
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

function user(declared: Record<string, unknown>, baselineGroups: string[]): ResourceState {
  return {
    physicalId: USER,
    resourceType: 'AWS::IAM::User',
    properties: { UserName: USER, ...declared },
    observedProperties: {
      UserName: USER,
      Path: '/',
      PermissionsBoundary: '',
      ManagedPolicyArns: [],
      Groups: baselineGroups,
      Policies: [],
    },
  };
}

function addition(group: string, users: string[]): ResourceState {
  return {
    physicalId: `${group}|${users.join(',')}`,
    resourceType: 'AWS::IAM::UserToGroupAddition',
    properties: { GroupName: group, Users: users },
  };
}

function policy(declared: Record<string, unknown>, baselineRoles: string[]): ResourceState {
  return {
    physicalId: MP_ARN,
    resourceType: 'AWS::IAM::ManagedPolicy',
    properties: { PolicyDocument: { Version: '2012-10-17', Statement: [] }, ...declared },
    observedProperties: {
      ManagedPolicyName: 'TestStack-Mp-ABC',
      Description: '',
      Path: '/',
      Groups: [],
      Roles: baselineRoles,
      Users: [],
      Tags: [],
    },
  };
}

function attachingRole(name: string, arns: string[]): ResourceState {
  return {
    physicalId: name,
    resourceType: 'AWS::IAM::Role',
    properties: { ManagedPolicyArns: arns },
  };
}

/** Run `cdkd drift TestStack [...flags]`; returns the exit code it asked for, if any. */
async function runDrift(flags: string[]): Promise<number | undefined> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  exitSpy.mockClear();
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
  return calls.length === 0 ? 0 : (calls[calls.length - 1]![0] as number | undefined);
}

let exitSpy: ReturnType<typeof vi.spyOn>;

describe('cdkd drift on IAM list members a sibling owns (go-to-k/cdkd#6328)', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockIamSend.mockReset();
    mockIamSend.mockImplementation(async (cmd) => routeIam(cmd));
    writes.length = 0;
    const userProvider = new IAMUserGroupProvider();
    const policyProvider = new IAMManagedPolicyProvider();
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::IAM::User'
        ? userProvider
        : type === 'AWS::IAM::ManagedPolicy'
          ? policyProvider
          : // Every other record reads back exactly as recorded.
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

  // The live-reproduced shape: no declared Groups, a baseline that raced the
  // addition, then the addition dropped the user.
  it('an UNDECLARED Groups whose baseline holds a stale addition member is not drift, and --revert does not re-grant it', async () => {
    userGroups = [];
    mockGetState.mockResolvedValue(
      stack({ User: user({}, ['GroupA']), Add: addition('GroupA', ['bob']) })
    );

    expect(await runDrift([])).toBe(0);
    await runDrift(['--revert', '--yes']);

    expect(writes).toEqual([]);
    expect(userGroups).toEqual([]);
  });

  it.each([
    ['captured before the addition', ['own']],
    ['captured after it (old record)', ['own', 'GroupA']],
  ])("a DECLARED Groups leaves the addition's group out on both sides; --revert removes only an out-of-band group (baseline %s)", async (_l, baseline) => {
    userGroups = ['own', 'GroupA'];
    mockGetState.mockResolvedValue(
      stack({ User: user({ Groups: ['own'] }, baseline), Add: addition('GroupA', [USER]) })
    );
    expect(await runDrift([])).toBe(0);

    userGroups = ['own', 'GroupA', 'oob'];
    expect(await runDrift([])).toBe(1);
    await runDrift(['--revert', '--yes']);

    expect(writes).toEqual(['remove oob']);
    expect([...userGroups].sort()).toEqual(['GroupA', 'own']);
  });

  // IAM names are case-insensitive: a hand-written GroupName / user name need
  // not match AWS's spelling, at the compare-time baseline strip and the
  // revert desired-bag strip alike.
  it('matches the addition case-insensitively at compare and revert', async () => {
    userGroups = ['own', 'Added'];
    mockGetState.mockResolvedValue(
      stack({ User: user({ Groups: ['own'] }, ['own', 'Added']), Add: addition('ADDED', ['Alice']) })
    );
    expect(await runDrift([])).toBe(0);

    userGroups = ['own', 'Added', 'oob'];
    await runDrift(['--revert', '--yes']);

    expect(writes).toEqual(['remove oob']);
  });

  it('a DECLARED Groups still reports a group the user lost out of band', async () => {
    userGroups = [];
    mockGetState.mockResolvedValue(stack({ User: user({ Groups: ['own'] }, ['own']) }));

    expect(await runDrift([])).toBe(1);
  });

  it.each([
    ['captured before the attach', ['declared']],
    ['captured after it (old record)', ['declared', 'attacher']],
  ])("a policy's DECLARED Roles leaves a role attaching it via ManagedPolicyArns out; --revert detaches only an out-of-band role (baseline %s)", async (_l, baseline) => {
    policyRoles = ['declared', 'attacher'];
    mockGetState.mockResolvedValue(
      stack({
        Mp: policy({ Roles: ['declared'] }, baseline),
        Attacher: attachingRole('attacher', [MP_ARN]),
      })
    );
    expect(await runDrift([])).toBe(0);

    policyRoles = ['declared', 'attacher', 'oob'];
    expect(await runDrift([])).toBe(1);
    await runDrift(['--revert', '--yes']);

    expect(writes).toEqual(['detach oob']);
    expect([...policyRoles].sort()).toEqual(['attacher', 'declared']);
  });

  it("a policy's UNDECLARED Roles whose baseline raced a role's attach is not drift once that role lets go", async () => {
    policyRoles = [];
    mockGetState.mockResolvedValue(
      stack({ Mp: policy({}, ['attacher']), Attacher: attachingRole('attacher', []) })
    );

    expect(await runDrift([])).toBe(0);
    await runDrift(['--revert', '--yes']);

    expect(writes).toEqual([]);
  });
});
