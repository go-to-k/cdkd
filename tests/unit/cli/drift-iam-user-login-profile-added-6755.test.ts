import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateLoginProfileCommand,
  DeleteLoginProfileCommand,
  GetLoginProfileCommand,
  GetUserCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListUserPoliciesCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6755: a console login profile added out of band to an IAM user
 * whose template declares none. The readback records `null` for no profile,
 * `LoginProfile` is a compared undeclared-empty key for `AWS::IAM::User`, so
 * the add is drift; `--revert` deletes the profile (one `DeleteLoginProfile`,
 * no other write, the user kept); `--accept` records the profile without a
 * password. A baseline written before the change (no `LoginProfile` key) is
 * not compared on it. Runs the real IAM user provider over a mocked client.
 */

const { mockIamSend } = vi.hoisted(() => ({ mockIamSend: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { reserveStdoutForPayload: vi.fn(), getLogger: () => logger };
});

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.js', () => {
  const iam = { send: mockIamSend, config: { region: () => Promise.resolve('us-east-1') } };
  return {
    AwsClients: vi.fn(() => ({
      get s3() {
        return {};
      },
      get iam() {
        return iam;
      },
      destroy: vi.fn(),
    })),
    setAwsClients: vi.fn(),
    runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
    getAwsClients: () => ({ iam }),
  };
});

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockSaveState = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
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

const USER = 'AWS::IAM::User';
const NAME = 'alice';

/** The record's template: no `LoginProfile`. */
const PROPERTIES = { UserName: NAME };

/** The deploy-time capture of a user without a login profile. */
const BASELINE = {
  UserName: NAME,
  Path: '/',
  PermissionsBoundary: '',
  LoginProfile: null,
  ManagedPolicyArns: [],
  Groups: [],
  Policies: [],
};

function stateWith(observed: Record<string, unknown>): { state: StackState; etag: string } {
  const record: ResourceState = {
    physicalId: NAME,
    resourceType: USER,
    properties: structuredClone(PROPERTIES),
    observedProperties: structuredClone(observed),
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { User: record },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

/**
 * IAM: user `alice`, no groups or policies; a login profile while
 * `profile.live`, its reset flag `profile.reset`.
 */
function iamWith(profile: { live: boolean; reset?: boolean }): void {
  mockIamSend.mockImplementation((command: unknown) => {
    if (command instanceof GetUserCommand) {
      return Promise.resolve({
        User: { UserName: NAME, Path: '/', Arn: `arn:aws:iam::123456789012:user/${NAME}` },
      });
    }
    if (command instanceof GetLoginProfileCommand) {
      return profile.live
        ? Promise.resolve({
            LoginProfile: { UserName: NAME, PasswordResetRequired: profile.reset === true },
          })
        : Promise.reject(new NoSuchEntityException({ message: 'none', $metadata: {} }));
    }
    if (command instanceof DeleteLoginProfileCommand) {
      profile.live = false;
      return Promise.resolve({});
    }
    if (command instanceof ListAttachedUserPoliciesCommand) {
      return Promise.resolve({ AttachedPolicies: [], IsTruncated: false });
    }
    if (command instanceof ListGroupsForUserCommand) {
      return Promise.resolve({ Groups: [], IsTruncated: false });
    }
    if (command instanceof ListUserPoliciesCommand) {
      return Promise.resolve({ PolicyNames: [], IsTruncated: false });
    }
    return Promise.resolve({});
  });
}

/** Every IAM command sent that is not a read (`Get*` / `List*`). */
function writesSent(): string[] {
  return mockIamSend.mock.calls
    .map(([command]) => (command as object).constructor.name)
    .filter((name) => !/^(Get|List)/.test(name));
}

/** The last state `saveState` was given. */
function savedState(): StackState {
  expect(mockSaveState).toHaveBeenCalled();
  return mockSaveState.mock.calls
    .at(-1)!
    .find((arg) => typeof arg === 'object' && arg !== null && 'resources' in arg) as StackState;
}

interface StackReport {
  drifted: unknown[];
  clean: unknown[];
}

function parseReport(report: string): StackReport[] {
  return JSON.parse(report) as StackReport[];
}

async function runDrift(args: string[]): Promise<string> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', ...args], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
  return written.join('');
}

describe('cdkd drift on a login profile added to an IAM user declaring none (go-to-k/cdkd#6755)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockIamSend.mockReset();
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockSaveState.mockReset();
    mockSaveState.mockResolvedValue('"etag-2"');
    mockRegistryGetProvider.mockReset();
    const provider = new IAMUserGroupProvider();
    (provider as unknown as { ownWriteRereadDelaysMs: number[] }).ownWriteRereadDelaysMs = [];
    mockRegistryGetProvider.mockReturnValue(provider);
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('reports the added profile', async () => {
    mockGetState.mockResolvedValueOnce(stateWith(BASELINE));
    iamWith({ live: true });

    const report = await runDrift(['--json']);

    const [stack] = parseReport(report);
    expect(stack!.clean).toEqual([]);
    expect(stack!.drifted).toEqual([
      expect.objectContaining({
        logicalId: 'User',
        changes: [
          expect.objectContaining({
            path: 'LoginProfile',
            stateValue: null,
            awsValue: {},
          }),
        ],
      }),
    ]);
    expect(writesSent()).toEqual([]);
  });

  it('reports no drift for a user still without one', async () => {
    mockGetState.mockResolvedValueOnce(stateWith(BASELINE));
    iamWith({ live: false });

    const [stack] = parseReport(await runDrift(['--json']));
    expect(stack!.drifted).toEqual([]);
    expect(stack!.clean).toEqual([expect.objectContaining({ logicalId: 'User' })]);
  });

  it('does not compare it on a baseline written before the change (no LoginProfile key)', async () => {
    const { LoginProfile: _omitted, ...old } = BASELINE;
    mockGetState.mockResolvedValueOnce(stateWith(old));
    iamWith({ live: true });

    const [stack] = parseReport(await runDrift(['--json']));
    expect(stack!.drifted).toEqual([]);
    expect(stack!.clean).toEqual([expect.objectContaining({ logicalId: 'User' })]);
  });

  it('--revert deletes the profile with exactly one DeleteLoginProfile and no other write', async () => {
    mockGetState.mockResolvedValueOnce(stateWith(BASELINE));
    const profile = { live: true };
    iamWith(profile);

    await runDrift(['--revert', '--yes']);

    expect(writesSent()).toEqual(['DeleteLoginProfileCommand']);
    const del = mockIamSend.mock.calls.find(
      ([command]) => command instanceof DeleteLoginProfileCommand
    )?.[0] as DeleteLoginProfileCommand;
    expect(del.input).toEqual({ UserName: NAME });
    expect(profile.live).toBe(false);
    expect(
      mockIamSend.mock.calls.some(([command]) => command instanceof CreateLoginProfileCommand)
    ).toBe(false);
  });

  it('an accepted profile stays clean when IAM clears its reset flag at sign-in', async () => {
    mockGetState.mockResolvedValueOnce(stateWith({ ...BASELINE, LoginProfile: {} }));
    iamWith({ live: true, reset: false });

    const [stack] = parseReport(await runDrift(['--json']));
    expect(stack!.drifted).toEqual([]);
    expect(stack!.clean).toEqual([expect.objectContaining({ logicalId: 'User' })]);
  });

  it('--revert of an accepted profile deleted out of band is refused before any write, naming --accept', async () => {
    mockGetState.mockResolvedValueOnce(stateWith({ ...BASELINE, LoginProfile: {} }));
    iamWith({ live: false });

    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let report: string;
    try {
      report = await runDrift(['--revert', '--yes']);
    } finally {
      process.stderr.write = original;
    }

    expect(writesSent()).toEqual([]);
    const { getLogger } = await import('../../../src/utils/logger.js');
    const logged = [
      report,
      ...errors,
      ...(['error', 'warn', 'info'] as const).flatMap((level) =>
        (getLogger()[level] as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
          c.map(String).join(' ')
        )
      ),
    ].join('\n');
    expect(logged).toContain('no password to send');
    expect(logged).toContain('record its removal with drift --accept');
  });

  it('--accept records the profile in the baseline without a password', async () => {
    mockGetState.mockResolvedValueOnce(stateWith(BASELINE));
    iamWith({ live: true });

    await runDrift(['--accept', '--yes']);

    expect(writesSent()).toEqual([]);
    const saved = savedState();
    const record = saved.resources['User']!;
    expect(record.observedProperties?.['LoginProfile']).toEqual({});
    expect(record.properties).not.toHaveProperty('LoginProfile');
    expect(JSON.stringify(saved)).not.toMatch(/Password"/);
  });
});
