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
const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
/**
 * The ELBv2 types through the command. Only `Name` matters here, and the
 * rewrite is type-agnostic past the table lookup, so a readback stub stands in
 * for the provider (whose file an open PR holds).
 */
const fakeElbv2 = {
  readCurrentState: async (
    _physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown>> => ({
    Name: resourceType === LB ? 'TestStack-my-lb' : 'TestStack-my-tg',
    Scheme: 'internet-facing',
  }),
  create: async () => ({ physicalId: '' }),
  update: async () => ({ physicalId: '', wasReplaced: false }),
  delete: async () => undefined,
};
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

async function run(flag: '--revert' | '--accept'): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(
      ['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', flag, '--yes'],
      { from: 'user' }
    );
  } catch {
    // An exit code is not what these cases read; the wire and the log are.
  } finally {
    process.stdout.write = original;
  }
}

/** `cdkd drift --json` (no write flag): the payload's per-resource change paths. */
async function detect(): Promise<{ drifted: Record<string, string[]>; clean: string[] }> {
  const out: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    out.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(
      ['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', '--json'],
      { from: 'user' }
    );
  } catch {
    // The exit code is read off the payload's verdicts instead.
  } finally {
    process.stdout.write = original;
  }
  const [report] = JSON.parse(out.join('')) as Array<{
    drifted: Array<{ logicalId: string; changes: Array<{ path: string }> }>;
    clean: Array<{ logicalId: string }>;
  }>;
  return {
    drifted: Object.fromEntries(
      report!.drifted.map((d) => [d.logicalId, d.changes.map((c) => c.path)])
    ),
    clean: report!.clean.map((c) => c.logicalId),
  };
}

const lines = (spy: typeof warnSpy): string =>
  spy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n');

describe('drift keeps the recorded IAM name (issues #4023, #4081)', () => {
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
    mockSaveState.mockClear();
    mockGetProvider.mockImplementation((type: string) =>
      type === ROLE ? role : type === POLICY ? policy : fakeElbv2
    );
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  // Issue #4081: a declared name the live one is DERIVED from (the legacy
  // prefix) is no longer reported, so the revert sends the live name and the
  // provider has nothing to warn about. A declared name it does NOT derive is
  // still drift, and the #4023 guard keeps the live role.
  it.each([
    ['derived from the declared name (issue #4081)', 'my-role', false],
    ['not derived from the declared name', 'other-role', true],
  ])(
    'reverts an IAM role in place under its recorded name, with no observed baseline — live name %s',
    async (_label, declared, warns) => {
      mockGetState.mockResolvedValue(
        state({
          Role: {
            physicalId: ROLE_ID,
            resourceType: ROLE,
            properties: {
              RoleName: declared,
              AssumeRolePolicyDocument: ASSUME,
              Description: 'deployed',
            },
          },
        })
      );

      await run('--revert');

      // THE assertion: the live role is neither replaced nor deleted.
      expect(sent('CreateRoleCommand')).toEqual([]);
      expect(sent('DeleteRoleCommand')).toEqual([]);
      // The drifted property IS reverted, on the role AWS holds — the positive
      // marker that the update ran rather than aborting before any call.
      const updates = sent('UpdateRoleCommand');
      expect(updates).toHaveLength(1);
      expect(updates[0]!.input).toMatchObject({ RoleName: ROLE_ID, Description: 'deployed' });
      expect(lines(infoSpy)).toContain('TestStack/Role (AWS::IAM::Role): reverted.');
      if (warns) expect(lines(warnSpy)).toContain('RoleName is not reverted');
      else expect(lines(warnSpy)).not.toContain('RoleName');
      expect(lines(errorSpy)).toBe('');
    }
  );

  it.each([
    ['derived from the declared name (issue #4081)', 'my-policy', false],
    ['not derived from the declared name', 'other-policy', true],
  ])(
    'reverts an IAM managed policy in place under its recorded name, with no observed baseline — live name %s',
    async (_label, declared, warns) => {
      mockGetState.mockResolvedValue(
        state({
          Policy: {
            physicalId: POLICY_ARN,
            resourceType: POLICY,
            properties: { ManagedPolicyName: declared, PolicyDocument: POLICY_DOC },
          },
        })
      );

      await run('--revert');

      expect(sent('CreatePolicyCommand')).toEqual([]);
      expect(sent('DeletePolicyCommand')).toEqual([]);
      const versions = sent('CreatePolicyVersionCommand');
      expect(versions).toHaveLength(1);
      expect(versions[0]!.input).toMatchObject({
        PolicyArn: POLICY_ARN,
        PolicyDocument: JSON.stringify(POLICY_DOC),
      });
      expect(lines(infoSpy)).toContain('TestStack/Policy (AWS::IAM::ManagedPolicy): reverted.');
      if (warns) expect(lines(warnSpy)).toContain('ManagedPolicyName is not reverted');
      else expect(lines(warnSpy)).not.toContain('ManagedPolicyName');
      expect(lines(errorSpy)).toBe('');
    }
  );

  // Issue #4081: detection itself. The live names are the legacy-prefixed
  // `TestStack-<name>`, the records hold the declared `<name>` with no
  // observed baseline. Each record also differs in one ordinary property, so
  // the resource is COMPARED (drifted) and the name's absence from its change
  // list is not a skipped resource.
  it('does not report a legacy-prefixed IAM name derived from the declared one (issue #4081)', async () => {
    mockGetState.mockResolvedValue(
      state({
        Role: {
          physicalId: ROLE_ID,
          resourceType: ROLE,
          properties: { RoleName: 'my-role', AssumeRolePolicyDocument: ASSUME, Description: 'deployed' },
        },
        Policy: {
          physicalId: POLICY_ARN,
          resourceType: POLICY,
          properties: { ManagedPolicyName: 'my-policy', PolicyDocument: POLICY_DOC },
        },
      })
    );

    const report = await detect();

    expect(report.drifted).toEqual({ Role: ['Description'], Policy: ['PolicyDocument.Statement'] });
    expect(sent('CreateRoleCommand')).toEqual([]);
  });

  it('reports a clean role as clean when only the derived name differs (issue #4081)', async () => {
    mockGetState.mockResolvedValue(
      state({
        Role: {
          physicalId: ROLE_ID,
          resourceType: ROLE,
          properties: {
            RoleName: 'my-role',
            AssumeRolePolicyDocument: ASSUME,
            Description: 'changed out of band',
          },
        },
      })
    );

    const report = await detect();

    expect(report).toEqual({ drifted: {}, clean: ['Role'] });
  });

  it.each([
    ['another name', 'other-role', 'other-policy'],
    // The live name is `TestStack-<name>`: a declared name that already
    // carries a prefix derives `TestStack-TestStack-<name>` or itself.
    ['the prefixed name recorded as declared under another stack', 'OtherStack-my-role', 'OtherStack-my-policy'],
  ])('still reports a declared name the live one is not derived from — %s', async (_label, role, policy) => {
    mockGetState.mockResolvedValue(
      state({
        Role: {
          physicalId: ROLE_ID,
          resourceType: ROLE,
          properties: { RoleName: role, AssumeRolePolicyDocument: ASSUME, Description: 'deployed' },
        },
        Policy: {
          physicalId: POLICY_ARN,
          resourceType: POLICY,
          properties: { ManagedPolicyName: policy, PolicyDocument: POLICY_DOC },
        },
      })
    );

    const report = await detect();

    expect(report.drifted).toEqual({
      Role: expect.arrayContaining(['RoleName', 'Description']),
      Policy: expect.arrayContaining(['ManagedPolicyName', 'PolicyDocument.Statement']),
    });
  });

  it('reports an ELBv2 LoadBalancer / TargetGroup name derived from the declared one as no drift (issue #4081)', async () => {
    mockGetState.mockResolvedValue(
      state({
        Lb: {
          physicalId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/TestStack-my-lb/abc',
          resourceType: LB,
          properties: { Name: 'my-lb', Scheme: 'internal' },
        },
        Tg: {
          physicalId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/TestStack-my-tg/abc',
          resourceType: TG,
          properties: { Name: 'my-tg', Scheme: 'internet-facing' },
        },
        Other: {
          physicalId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/TestStack-my-tg/def',
          resourceType: TG,
          properties: { Name: 'other-tg', Scheme: 'internet-facing' },
        },
      })
    );

    const report = await detect();

    expect(report.drifted).toEqual({ Lb: ['Scheme'], Other: ['Name'] });
    expect(report.clean).toEqual(['Tg']);
  });

  it('--accept records nothing for a derived name, only the ordinary drift (issue #4081)', async () => {
    mockGetState.mockResolvedValue(
      state({
        Role: {
          physicalId: ROLE_ID,
          resourceType: ROLE,
          properties: { RoleName: 'my-role', AssumeRolePolicyDocument: ASSUME, Description: 'deployed' },
        },
      })
    );

    await run('--accept');

    const records = mockSaveState.mock.calls.map((call) => {
      const saved = call.find(
        (arg): arg is StackState =>
          typeof arg === 'object' && arg !== null && 'resources' in arg
      );
      return saved!.resources['Role']!;
    });
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const bags = [record.properties, record.observedProperties].filter(
        (bag): bag is Record<string, unknown> => bag !== undefined
      );
      // The ordinary drift IS accepted — the marker that the write ran...
      expect(bags.some((bag) => bag['Description'] === 'changed out of band')).toBe(true);
      // ...and the live name is written into neither bag.
      expect(bags.map((bag) => bag['RoleName'])).not.toContain(ROLE_ID);
    }
    expect(lines(errorSpy)).toBe('');
  });
});
