import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

/**
 * Issue go-to-k/cdkd#4023: `cdkd drift --revert` handed its desired bag to the
 * REAL `IAMRoleProvider.update` / `IAMManagedPolicyProvider.update`, which
 * re-derive the physical name from it and REPLACE the resource on a mismatch.
 * The revert runs outside the deploy's stack-name / prefix scope, and with no
 * `observedProperties` its baseline is the TEMPLATE bag — so a stack deployed
 * with the legacy `--prefix-user-supplied-names` (live `TestStack-my-role`,
 * template `my-role`) had its role created anew as `my-role` and the live one
 * deleted, by a command that only meant to restore a Description.
 *
 * The providers are REAL here, only the IAM client's `send` stubbed, so the
 * assertions read the wire: no create / delete of the resource, and the
 * in-place call addressed to the recorded name.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
// The providers log through `getLogger().child(...)`; routed to the same
// spies so their warning is observable.
vi.mock('../../../src/utils/logger.js', () => {
  const make = (): Record<string, unknown> => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => make(),
  });
  return { reserveStdoutForPayload: vi.fn(), getLogger: () => make() };
});

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

const mockIamSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: mockIamSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({
    iam: { send: mockIamSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const mockGetState = vi.fn<() => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: vi.fn(async () => '"etag-2"'),
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
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';

const ROLE = 'AWS::IAM::Role';
const POLICY = 'AWS::IAM::ManagedPolicy';
const ASSUME = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
  ],
};
const POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const LIVE_POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
};
// The legacy `--prefix-user-supplied-names` shape: AWS holds the prefixed
// names, the record's template bag the declared ones.
const ROLE_ID = 'TestStack-my-role';
const POLICY_ARN = 'arn:aws:iam::123456789012:policy/TestStack-my-policy';

function state(resources: StackState['resources']): { state: StackState; etag: string } {
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

/** The live account: answers each read by command, records every call. */
function stubIam(): void {
  mockIamSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'GetRoleCommand':
        return {
          Role: {
            RoleName: ROLE_ID,
            Arn: `arn:aws:iam::123456789012:role/${ROLE_ID}`,
            RoleId: 'AROAEXAMPLE',
            Path: '/',
            Description: 'changed out of band',
            MaxSessionDuration: 3600,
            AssumeRolePolicyDocument: encodeURIComponent(JSON.stringify(ASSUME)),
          },
        };
      case 'ListAttachedRolePoliciesCommand':
        return { AttachedPolicies: [] };
      case 'ListRolePoliciesCommand':
        return { PolicyNames: [] };
      case 'ListRoleTagsCommand':
        return { Tags: [] };
      case 'GetPolicyCommand':
        return {
          Policy: {
            PolicyName: 'TestStack-my-policy',
            Arn: POLICY_ARN,
            Path: '/',
            DefaultVersionId: 'v1',
          },
        };
      case 'GetPolicyVersionCommand':
        return {
          PolicyVersion: { Document: encodeURIComponent(JSON.stringify(LIVE_POLICY_DOC)) },
        };
      case 'ListEntitiesForPolicyCommand':
        return { PolicyGroups: [], PolicyRoles: [], PolicyUsers: [] };
      case 'ListPolicyTagsCommand':
        return { Tags: [] };
      case 'ListPolicyVersionsCommand':
        return { Versions: [{ VersionId: 'v1', IsDefaultVersion: true }], IsTruncated: false };
      case 'CreatePolicyVersionCommand':
        return { PolicyVersion: { VersionId: 'v2' } };
      default:
        return {};
    }
  });
}

function sent(name: string): Array<{ input: Record<string, unknown> }> {
  return mockIamSend.mock.calls
    .map((call) => call[0] as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((command) => command.constructor.name === name);
}

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
    // An exit code is not what these cases read; the wire and the log are.
  } finally {
    process.stdout.write = original;
  }
}

const lines = (spy: typeof warnSpy): string =>
  spy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n');

describe('drift --revert keeps the recorded IAM name (issue #4023)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockIamSend.mockReset();
    mockGetState.mockReset();
    mockListStacks.mockReset().mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetProvider.mockReset();
    errorSpy.mockReset();
    warnSpy.mockReset();
    infoSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    stubIam();
    const role = new IAMRoleProvider();
    const policy = new IAMManagedPolicyProvider();
    mockGetProvider.mockImplementation((type: string) => (type === ROLE ? role : policy));
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('reverts an IAM role in place under its recorded name, with no observed baseline', async () => {
    mockGetState.mockResolvedValue(
      state({
        Role: {
          physicalId: ROLE_ID,
          resourceType: ROLE,
          properties: {
            RoleName: 'my-role',
            AssumeRolePolicyDocument: ASSUME,
            Description: 'deployed',
          },
        },
      })
    );

    await revert();

    // THE assertion: the live role is neither replaced nor deleted.
    expect(sent('CreateRoleCommand')).toEqual([]);
    expect(sent('DeleteRoleCommand')).toEqual([]);
    // The drifted property IS reverted, on the role AWS holds — the positive
    // marker that the update ran rather than aborting before any call.
    const updates = sent('UpdateRoleCommand');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input).toMatchObject({ RoleName: ROLE_ID, Description: 'deployed' });
    expect(lines(infoSpy)).toContain('TestStack/Role (AWS::IAM::Role): reverted.');
    expect(lines(warnSpy)).toContain('RoleName is not reverted');
    expect(lines(errorSpy)).toBe('');
  });

  it('reverts an IAM managed policy in place under its recorded name, with no observed baseline', async () => {
    mockGetState.mockResolvedValue(
      state({
        Policy: {
          physicalId: POLICY_ARN,
          resourceType: POLICY,
          properties: { ManagedPolicyName: 'my-policy', PolicyDocument: POLICY_DOC },
        },
      })
    );

    await revert();

    expect(sent('CreatePolicyCommand')).toEqual([]);
    expect(sent('DeletePolicyCommand')).toEqual([]);
    const versions = sent('CreatePolicyVersionCommand');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.input).toMatchObject({
      PolicyArn: POLICY_ARN,
      PolicyDocument: JSON.stringify(POLICY_DOC),
    });
    expect(lines(infoSpy)).toContain(
      'TestStack/Policy (AWS::IAM::ManagedPolicy): reverted.'
    );
    expect(lines(warnSpy)).toContain('ManagedPolicyName is not reverted');
    expect(lines(errorSpy)).toBe('');
  });
});
