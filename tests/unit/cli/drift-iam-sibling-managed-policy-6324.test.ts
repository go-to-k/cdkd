import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6324: a managed policy a SIBLING `AWS::IAM::ManagedPolicy`
 * attaches to a role through its `Roles` list is not the role's. `cdkd drift`
 * reported it as `ManagedPolicyArns` drift on a fresh stack, and
 * `cdkd drift --revert` DETACHED it. Driven end to end through the command,
 * the real `IAMRoleProvider` (readback AND `update()`), over a mocked IAM.
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
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { stripSiblingOwnedMembers } from '../../../src/provisioning/iam-sibling-managed-policies.js';

const ROLE = 'my-role';
const LAMBDA_BASIC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const SIBLING = 'arn:aws:iam::123456789012:policy/TestStack-Mp-ABC';
const OUT_OF_BAND = 'arn:aws:iam::aws:policy/AWSDenyAll';
const TRUST = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
  ],
};

/** The role's live attachments; the mocked IAM reads and writes it. */
let live: string[] = [];
const attached: string[] = [];
const detached: string[] = [];

function routeIam(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
  switch (cmd.constructor.name) {
    case 'GetRoleCommand':
      return {
        Role: {
          RoleName: ROLE,
          Path: '/',
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(TRUST)),
        },
      };
    case 'ListAttachedRolePoliciesCommand':
      return { AttachedPolicies: live.map((PolicyArn) => ({ PolicyArn })) };
    case 'ListRolePoliciesCommand':
      return { PolicyNames: [], IsTruncated: false };
    case 'ListRoleTagsCommand':
      return { Tags: [], IsTruncated: false };
    case 'AttachRolePolicyCommand':
      attached.push(cmd.input['PolicyArn'] as string);
      live = [...new Set([...live, cmd.input['PolicyArn'] as string])];
      return {};
    case 'DetachRolePolicyCommand':
      detached.push(cmd.input['PolicyArn'] as string);
      live = live.filter((a) => a !== cmd.input['PolicyArn']);
      return {};
    default:
      return {};
  }
}

function roleBaseline(managedPolicyArns: string[]): Record<string, unknown> {
  return {
    RoleName: ROLE,
    Description: '',
    MaxSessionDuration: 3600,
    Path: '/',
    PermissionsBoundary: '',
    AssumeRolePolicyDocument: TRUST,
    ManagedPolicyArns: managedPolicyArns,
    Policies: [],
    Tags: [],
  };
}

function stateWith(opts: {
  declared: string[];
  baseline: string[];
  siblingRoles?: string[];
}): { state: StackState; etag: string } {
  const role: ResourceState = {
    physicalId: ROLE,
    resourceType: 'AWS::IAM::Role',
    properties: { AssumeRolePolicyDocument: TRUST, ManagedPolicyArns: opts.declared },
    observedProperties: roleBaseline(opts.baseline),
  };
  const mp: ResourceState = {
    physicalId: SIBLING,
    resourceType: 'AWS::IAM::ManagedPolicy',
    properties: {
      PolicyDocument: { Version: '2012-10-17', Statement: [] },
      Roles: opts.siblingRoles ?? [ROLE],
    },
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { Role: role, Mp: mp },
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

describe('cdkd drift on a role a sibling AWS::IAM::ManagedPolicy attaches to (go-to-k/cdkd#6324)', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockIamSend.mockReset();
    mockIamSend.mockImplementation(async (cmd) => routeIam(cmd));
    attached.length = 0;
    detached.length = 0;
    const roleProvider = new IAMRoleProvider();
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::IAM::Role'
        ? roleProvider
        : // The sibling reads back exactly as recorded.
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

  it('a fresh deploy (baseline captured before the sibling attached) reports no drift', async () => {
    live = [SIBLING, LAMBDA_BASIC];
    mockGetState.mockResolvedValue(stateWith({ declared: [LAMBDA_BASIC], baseline: [LAMBDA_BASIC] }));

    const code = await runDrift([]);

    expect(code ?? 0).toBe(0);
  });

  it('a baseline captured AFTER the sibling attached (an old record) reports no drift', async () => {
    live = [SIBLING, LAMBDA_BASIC];
    mockGetState.mockResolvedValue(
      stateWith({ declared: [LAMBDA_BASIC], baseline: [SIBLING, LAMBDA_BASIC] })
    );

    const code = await runDrift([]);

    expect(code ?? 0).toBe(0);
  });

  it('an out-of-band attachment still reports drift', async () => {
    live = [SIBLING, LAMBDA_BASIC, OUT_OF_BAND];
    mockGetState.mockResolvedValue(stateWith({ declared: [LAMBDA_BASIC], baseline: [LAMBDA_BASIC] }));

    const code = await runDrift([]);

    expect(code).toBe(1);
  });

  it('a sibling attached to ANOTHER role does not hide its ARN on this one', async () => {
    live = [SIBLING, LAMBDA_BASIC];
    mockGetState.mockResolvedValue(
      stateWith({ declared: [LAMBDA_BASIC], baseline: [LAMBDA_BASIC], siblingRoles: ['other-role'] })
    );

    const code = await runDrift([]);

    expect(code).toBe(1);
  });

  it.each([
    ['captured before the attach', [LAMBDA_BASIC]],
    ['captured after the attach (old record)', [SIBLING, LAMBDA_BASIC]],
  ])(
    '--revert of an out-of-band attachment detaches ONLY it, never the sibling (baseline %s)',
    async (_label, baseline) => {
      live = [SIBLING, LAMBDA_BASIC, OUT_OF_BAND];
      mockGetState.mockResolvedValue(stateWith({ declared: [LAMBDA_BASIC], baseline }));

      await runDrift(['--revert', '--yes']);

      expect(detached).toEqual([OUT_OF_BAND]);
      expect(attached).toEqual([]);
      expect([...live].sort()).toEqual([LAMBDA_BASIC, SIBLING].sort());
    }
  );

  it('--revert on a clean stack leaves the sibling attached', async () => {
    live = [SIBLING, LAMBDA_BASIC];
    mockGetState.mockResolvedValue(stateWith({ declared: [LAMBDA_BASIC], baseline: [LAMBDA_BASIC] }));

    await runDrift(['--revert', '--yes']);

    expect(detached).toEqual([]);
    expect(live).toContain(SIBLING);
  });

  it('an ARN the role ALSO declares stays compared: its out-of-band detach is drift and --revert re-attaches it', async () => {
    live = [LAMBDA_BASIC];
    mockGetState.mockResolvedValue(
      stateWith({ declared: [SIBLING, LAMBDA_BASIC], baseline: [SIBLING, LAMBDA_BASIC] })
    );

    expect(await runDrift([])).toBe(1);

    exitSpy.mockClear();
    await runDrift(['--revert', '--yes']);

    expect(attached).toEqual([SIBLING]);
    expect(detached).toEqual([]);
  });
});

describe('stripSiblingOwnedMembers (go-to-k/cdkd#6324)', () => {
  const context = {
    siblings: {
      Mp: { resourceType: 'AWS::IAM::ManagedPolicy', physicalId: SIBLING, properties: { Roles: [ROLE] } },
    },
  };

  it('drops the sibling ARN from both bags without mutating either', () => {
    const baseline = { ManagedPolicyArns: [SIBLING, LAMBDA_BASIC] };
    const aws = { ManagedPolicyArns: [LAMBDA_BASIC, SIBLING, OUT_OF_BAND] };
    const out = stripSiblingOwnedMembers('AWS::IAM::Role', ROLE, baseline, aws, {}, context);
    expect(out.baseline).toEqual({ ManagedPolicyArns: [LAMBDA_BASIC] });
    expect(out.aws).toEqual({ ManagedPolicyArns: [LAMBDA_BASIC, OUT_OF_BAND] });
    expect(baseline.ManagedPolicyArns).toEqual([SIBLING, LAMBDA_BASIC]);
    expect(aws.ManagedPolicyArns).toEqual([LAMBDA_BASIC, SIBLING, OUT_OF_BAND]);
  });

  it.each([
    ['a non-principal type', 'AWS::S3::Bucket', context],
    ['no context', 'AWS::IAM::Role', undefined],
    ['a sibling listing another role', 'AWS::IAM::Role', {
      siblings: { Mp: { resourceType: 'AWS::IAM::ManagedPolicy', physicalId: SIBLING, properties: { Roles: ['x'] } } },
    }],
  ])('returns both bags by identity for %s', (_label, type, ctx) => {
    const baseline = { ManagedPolicyArns: [SIBLING] };
    const aws = { ManagedPolicyArns: [SIBLING] };
    const out = stripSiblingOwnedMembers(type, ROLE, baseline, aws, {}, ctx);
    expect(out.baseline).toBe(baseline);
    expect(out.aws).toBe(aws);
  });
});
