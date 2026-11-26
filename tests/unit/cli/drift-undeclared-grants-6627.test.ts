import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#7025 step 6: this file's fake AWS keeps answering the drifted
// read after an update, so the post-revert re-read is stubbed out here; it is
// covered by `tests/unit/cli/drift-revert-verify-7025.test.ts`.
vi.mock('../../../src/cli/commands/drift/revert-verify.js', () => ({
  verifyRevertedStack: vi.fn(async () => ({ notApplied: 0, unverified: 0 })),
}));
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6627 end to end through `cdkd drift` / `--revert` / `--accept`
 * with the REAL IAM providers over a mocked IAM client: a role, user or group
 * whose template declares no `ManagedPolicyArns`, `Policies`,
 * `PermissionsBoundary` or (a user) `Groups` is drifted by an out-of-band
 * grant on BOTH baselines, and `--revert` removes exactly that member, one IAM
 * call per member, and never replaces the principal. A member a sibling record
 * of the stack writes is neither drift nor removed.
 */

const mockIamSend = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
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

vi.mock('../../../src/provisioning/read-only-properties.js', () => ({
  getReadOnlyPropertyPaths: vi.fn(async () => undefined),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';

const ACCOUNT = '123456789012';
const OOB_ARN = 'arn:aws:iam::aws:policy/AdministratorAccess';
const SIB_ARN = `arn:aws:iam::${ACCOUNT}:policy/TestStack-SiblingMp-ABC`;
const ACCEPTED_ARN = `arn:aws:iam::${ACCOUNT}:policy/OrgAutomation`;
const BOUNDARY_ARN = `arn:aws:iam::${ACCOUNT}:policy/Boundary`;
const TRUST = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
  ],
};
const DOC = (action: string): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: action, Resource: '*' }],
});

type Kind = 'Role' | 'User' | 'Group';
interface Principal {
  managed: string[];
  inline: Map<string, Record<string, unknown>>;
  boundary: string | undefined;
  groups: string[];
}

const NAME: Record<Kind, string> = { Role: 'app-role', User: 'alice', Group: 'devs' };
const UNIQUE_ID: Record<Kind, string> = {
  Role: 'AROAEXAMPLEROLEID',
  User: 'AIDAEXAMPLEUSERID',
  Group: 'AGPAEXAMPLEGROUPID',
};

let live: Principal;
/** Every IAM call that writes, in order, as `<Command> <member>`. */
const writes: string[] = [];

function freshPrincipal(): Principal {
  return { managed: [], inline: new Map(), boundary: undefined, groups: [] };
}

const enc = (doc: unknown): string => encodeURIComponent(JSON.stringify(doc));

function routeIam(cmd: { constructor: { name: string }; input: Record<string, unknown> }): unknown {
  const i = cmd.input;
  const name = cmd.constructor.name.replace(/Command$/, '');
  const policyName = i['PolicyName'] as string;
  switch (name) {
    case 'GetRole':
      return {
        Role: {
          RoleName: NAME.Role,
          RoleId: UNIQUE_ID.Role,
          Arn: `arn:aws:iam::${ACCOUNT}:role/${NAME.Role}`,
          Path: '/',
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: enc(TRUST),
          ...(live.boundary ? { PermissionsBoundary: { PermissionsBoundaryArn: live.boundary } } : {}),
        },
      };
    case 'GetUser':
      return {
        User: {
          UserName: NAME.User,
          UserId: UNIQUE_ID.User,
          Arn: `arn:aws:iam::${ACCOUNT}:user/${NAME.User}`,
          Path: '/',
          ...(live.boundary ? { PermissionsBoundary: { PermissionsBoundaryArn: live.boundary } } : {}),
        },
      };
    case 'GetGroup':
      return {
        Group: {
          GroupName: NAME.Group,
          GroupId: UNIQUE_ID.Group,
          Arn: `arn:aws:iam::${ACCOUNT}:group/${NAME.Group}`,
          Path: '/',
        },
        Users: [],
        IsTruncated: false,
      };
    case 'ListAttachedRolePolicies':
    case 'ListAttachedUserPolicies':
    case 'ListAttachedGroupPolicies':
      return {
        AttachedPolicies: live.managed.map((PolicyArn) => ({ PolicyArn })),
        IsTruncated: false,
      };
    case 'ListRolePolicies':
    case 'ListUserPolicies':
    case 'ListGroupPolicies':
      return { PolicyNames: [...live.inline.keys()], IsTruncated: false };
    case 'GetRolePolicy':
    case 'GetUserPolicy':
    case 'GetGroupPolicy':
      return { PolicyName: policyName, PolicyDocument: enc(live.inline.get(policyName)) };
    case 'ListGroupsForUser':
      return { Groups: live.groups.map((GroupName) => ({ GroupName })), IsTruncated: false };
    case 'ListRoleTags':
    case 'ListUserTags':
      return { Tags: [], IsTruncated: false };
    case 'AttachRolePolicy':
    case 'AttachUserPolicy':
    case 'AttachGroupPolicy':
      writes.push(`${name} ${i['PolicyArn'] as string}`);
      live.managed.push(i['PolicyArn'] as string);
      return {};
    case 'DetachRolePolicy':
    case 'DetachUserPolicy':
    case 'DetachGroupPolicy':
      writes.push(`${name} ${i['PolicyArn'] as string}`);
      live.managed = live.managed.filter((a) => a !== i['PolicyArn']);
      return {};
    case 'PutRolePolicy':
    case 'PutUserPolicy':
    case 'PutGroupPolicy':
      writes.push(`${name} ${policyName}`);
      live.inline.set(policyName, JSON.parse(i['PolicyDocument'] as string));
      return {};
    case 'DeleteRolePolicy':
    case 'DeleteUserPolicy':
    case 'DeleteGroupPolicy':
      writes.push(`${name} ${policyName}`);
      live.inline.delete(policyName);
      return {};
    case 'PutRolePermissionsBoundary':
    case 'PutUserPermissionsBoundary':
      writes.push(`${name} ${i['PermissionsBoundary'] as string}`);
      live.boundary = i['PermissionsBoundary'] as string;
      return {};
    case 'DeleteRolePermissionsBoundary':
    case 'DeleteUserPermissionsBoundary':
      writes.push(name);
      live.boundary = undefined;
      return {};
    case 'AddUserToGroup':
      writes.push(`${name} ${i['GroupName'] as string}`);
      live.groups.push(i['GroupName'] as string);
      return {};
    case 'RemoveUserFromGroup':
      writes.push(`${name} ${i['GroupName'] as string}`);
      live.groups = live.groups.filter((g) => g !== i['GroupName']);
      return {};
    // The managed policy SIB_ARN (IAMManagedPolicyProvider's read): attached
    // to the Subject group when the group's live list holds it.
    case 'GetPolicy':
      return {
        Policy: { PolicyName: 'TestStack-SiblingMp-ABC', Path: '/', Arn: SIB_ARN, DefaultVersionId: 'v1' },
      };
    case 'GetPolicyVersion':
      return { PolicyVersion: { Document: enc(DOC('s3:GetObject')), VersionId: 'v1', IsDefaultVersion: true } };
    case 'ListEntitiesForPolicy':
      return {
        PolicyRoles: [],
        PolicyUsers: [],
        PolicyGroups: live.managed.includes(SIB_ARN) ? [{ GroupName: NAME.Group }] : [],
        IsTruncated: false,
      };
    case 'ListPolicyTags':
      return { Tags: [], IsTruncated: false };
    case 'UpdateRole':
      // Description / MaxSessionDuration, sent on every role update unchanged.
      return {};
    default:
      // Anything else that writes (a Create* / Delete<principal> / Tag*) is a
      // call this revert must never make.
      if (/^(Create|Delete|Update|Tag|Untag|Attach|Detach|Put|Add|Remove)/.test(name)) {
        writes.push(name);
      }
      return {};
  }
}

const TYPE = (k: Kind): string => `AWS::IAM::${k}`;

function principalRecord(k: Kind, observed?: Record<string, unknown>): ResourceState {
  return {
    physicalId: NAME[k],
    resourceType: TYPE(k),
    properties: k === 'Role' ? { AssumeRolePolicyDocument: TRUST } : {},
    attributes: { Arn: `arn:aws:iam::${ACCOUNT}:${k.toLowerCase()}/${NAME[k]}` },
    ...(observed ? { observedProperties: observed } : {}),
  };
}

function siblings(k: Kind): Record<string, ResourceState> {
  const field = `${k}s`;
  const out: Record<string, ResourceState> = {
    SibMp: {
      physicalId: SIB_ARN,
      resourceType: 'AWS::IAM::ManagedPolicy',
      properties: { PolicyDocument: DOC('s3:GetObject'), [field]: [NAME[k]] },
    },
    SibPolicy: {
      physicalId: 'SibInline',
      resourceType: 'AWS::IAM::Policy',
      properties: { PolicyName: 'SibInline', PolicyDocument: DOC('sqs:*'), [field]: [NAME[k]] },
    },
  };
  // A standalone RolePolicy / UserPolicy / GroupPolicy names its one principal.
  out['SibStandalone'] = {
    physicalId: `SibStandalone|${NAME[k]}`,
    resourceType: `AWS::IAM::${k}Policy`,
    properties: { PolicyName: 'SibStandalone', PolicyDocument: DOC('sns:*'), [`${k}Name`]: NAME[k] },
  };
  if (k === 'User') {
    out['SibAdd'] = {
      physicalId: `sib-group|${NAME.User}`,
      resourceType: 'AWS::IAM::UserToGroupAddition',
      properties: { GroupName: 'sib-group', Users: [NAME.User] },
    };
  }
  return out;
}

let resources: Record<string, ResourceState> = {};

function stackState(): { state: StackState; etag: string } {
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: structuredClone(resources),
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdout = '';

async function runDrift(flags: string[]): Promise<number | undefined> {
  const original = process.stdout.write.bind(process.stdout);
  stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
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

function changes(): Array<{ logicalId: string; path: string }> {
  const [report] = JSON.parse(stdout) as Array<{
    drifted: Array<{ logicalId: string; changes: Array<{ path: string }> }>;
  }>;
  return report!.drifted.flatMap((d) =>
    d.changes.map((ch) => ({ logicalId: d.logicalId, path: ch.path }))
  );
}

/** The keys of `k` the template omits. */
const KEYS: Record<Kind, string[]> = {
  Role: ['ManagedPolicyArns', 'PermissionsBoundary', 'Policies'],
  User: ['Groups', 'ManagedPolicyArns', 'PermissionsBoundary', 'Policies'],
  Group: ['ManagedPolicyArns', 'Policies'],
};

/** Grant one out-of-band member under every key of `k`. */
function grantOutOfBand(k: Kind): void {
  live.managed.push(OOB_ARN);
  live.inline.set('oob-inline', DOC('*'));
  if (k !== 'Group') live.boundary = BOUNDARY_ARN;
  if (k === 'User') live.groups.push('oob-group');
}

/** The one IAM call per out-of-band member a revert makes, in provider order. */
function expectedRemovals(k: Kind): string[] {
  const out: string[] = [];
  if (k !== 'Group') out.push(`Delete${k}PermissionsBoundary`);
  out.push(`Detach${k}Policy ${OOB_ARN}`);
  if (k === 'User') out.push('RemoveUserFromGroup oob-group');
  out.push(`Delete${k}Policy oob-inline`);
  return out;
}

/** What a capture at deploy time records for `k` with its siblings' members filtered. */
async function captureObserved(k: Kind): Promise<Record<string, unknown>> {
  const provider = k === 'Role' ? new IAMRoleProvider() : new IAMUserGroupProvider();
  const ctx = { siblings: siblings(k) };
  const read = await (
    provider as unknown as {
      readCurrentState: (
        p: string,
        l: string,
        t: string,
        props: Record<string, unknown>,
        c: unknown
      ) => Promise<Record<string, unknown>>;
    }
  ).readCurrentState(NAME[k], 'Subject', TYPE(k), principalRecord(k).properties ?? {}, ctx);
  return read;
}

function setUp(): void {
  mockGetState.mockReset();
  mockListStacks.mockReset();
  mockRegistryGetProvider.mockReset();
  mockSaveState.mockReset();
  mockSaveState.mockResolvedValue('"etag-2"');
  mockIamSend.mockReset();
  mockIamSend.mockImplementation(async (cmd) => routeIam(cmd));
  writes.length = 0;
  live = freshPrincipal();
  const roleProvider = new IAMRoleProvider();
  const userGroupProvider = new IAMUserGroupProvider();
  mockRegistryGetProvider.mockImplementation((type) =>
    type === 'AWS::IAM::Role'
      ? roleProvider
      : type === 'AWS::IAM::User' || type === 'AWS::IAM::Group'
        ? userGroupProvider
        : // A sibling record reads back exactly as recorded.
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
  mockGetState.mockImplementation(async () => stackState());
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
}

describe.each(['Role', 'User', 'Group'] as const)(
  'cdkd drift on an AWS::IAM::%s whose template declares no grant (go-to-k/cdkd#6627)',
  (k) => {
    beforeEach(setUp);
    afterEach(() => exitSpy.mockRestore());

    describe.each([
      ['template-only', false],
      ['observed', true],
    ] as const)('%s baseline', (_label, observed) => {
      async function arrange(): Promise<void> {
        // The siblings' members are live before any capture, as after a deploy.
        live.managed.push(SIB_ARN);
        live.inline.set('SibInline', DOC('sqs:*'));
        live.inline.set('SibStandalone', DOC('sns:*'));
        if (k === 'User') live.groups.push('sib-group');
        resources = {
          Subject: principalRecord(k, observed ? await captureObserved(k) : undefined),
          ...siblings(k),
        };
      }

      it('is clean with only the same-stack siblings\' members live', async () => {
        await arrange();
        expect(await runDrift([])).toBe(0);
      });

      it('reports each out-of-band grant by its key', async () => {
        await arrange();
        grantOutOfBand(k);
        expect(await runDrift(['--json'])).toBe(1);
        expect(changes().sort((a, b) => a.path.localeCompare(b.path))).toEqual(
          KEYS[k].map((path) => ({ logicalId: 'Subject', path }))
        );
      });

      it('--revert removes exactly those members, one call each, lists each in the plan, and keeps the siblings\' members', async () => {
        await arrange();
        grantOutOfBand(k);
        expect(await runDrift(['--revert', '--yes'])).toBe(0);
        expect(writes).toEqual(expectedRemovals(k));
        // No replacement: no Create* / Delete<principal> call, and the same
        // principal (name + IAM unique id) is still there.
        expect(writes.some((w) => /^(Create|Delete(Role|User|Group)$)/.test(w))).toBe(false);
        expect(live.managed).toEqual([SIB_ARN]);
        expect([...live.inline.keys()]).toEqual(['SibInline', 'SibStandalone']);
        expect(live.boundary).toBeUndefined();
        if (k === 'User') expect(live.groups).toEqual(['sib-group']);
        expect(stdout).toContain(`- detaches managed policy ${OOB_ARN}`);
        expect(stdout).toContain('- deletes inline policy oob-inline');
        if (k !== 'Group') expect(stdout).toContain(`- deletes permissions boundary ${BOUNDARY_ARN}`);
        if (k === 'User') expect(stdout).toContain('- removes the user from group oob-group');
        expect(stdout).toContain(
          "run 'cdkd drift --accept' for this stack instead: it records everything AWS holds on every drifted resource of the stack"
        );
        expect(stdout).not.toContain(SIB_ARN);
        expect(stdout).not.toContain('SibInline');
        expect(stdout).not.toContain('SibStandalone');
        expect(stdout).not.toMatch(/replac/i);
        writes.length = 0;
        expect(await runDrift([])).toBe(0);
      });

      it('--accept adopts the out-of-band members, after which drift is clean and a revert removes nothing', async () => {
        await arrange();
        grantOutOfBand(k);
        expect(await runDrift(['--accept', '--yes'])).toBe(0);
        const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
        resources = saved.resources;
        expect(await runDrift([])).toBe(0);
        // Clean, so the revert has nothing to do and exits 0 without a write.
        expect(await runDrift(['--revert', '--yes'])).toBe(0);
        expect(writes).toEqual([]);
      });
    });
  }
);

describe('the observed baseline\'s recorded members (go-to-k/cdkd#6627)', () => {
  beforeEach(setUp);
  afterEach(() => exitSpy.mockRestore());

  it('a recorded member AWS no longer holds is not drift, and --revert never re-grants it (#6328 class)', async () => {
    resources = {
      Subject: principalRecord('User', {
        ...(await captureObserved('User')),
        ManagedPolicyArns: [ACCEPTED_ARN],
        Groups: ['stale-group'],
        Policies: [{ PolicyName: 'gone', PolicyDocument: DOC('s3:*') }],
      }),
    };
    expect(await runDrift([])).toBe(0);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([]);
  });

  it('a revert driven by an out-of-band member does not re-grant a recorded member AWS lost', async () => {
    resources = {
      Subject: principalRecord('User', {
        ...(await captureObserved('User')),
        ManagedPolicyArns: [ACCEPTED_ARN],
        Groups: ['stale-group'],
        Policies: [{ PolicyName: 'gone', PolicyDocument: DOC('s3:*') }],
      }),
    };
    live.managed.push(OOB_ARN);
    live.groups.push('oob-group');
    live.inline.set('oob-inline', DOC('*'));
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([
      `DetachUserPolicy ${OOB_ARN}`,
      'RemoveUserFromGroup oob-group',
      'DeleteUserPolicy oob-inline',
    ]);
    expect(live.managed).toEqual([]);
    expect(live.groups).toEqual([]);
    expect([...live.inline.keys()]).toEqual([]);
  });

  it('beside an accepted member, only the new out-of-band one is drift and removed', async () => {
    live.managed.push(ACCEPTED_ARN);
    resources = {
      Subject: principalRecord('Role', {
        ...(await captureObserved('Role')),
        ManagedPolicyArns: [ACCEPTED_ARN],
      }),
    };
    expect(await runDrift([])).toBe(0);
    live.managed.push(OOB_ARN);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([`DetachRolePolicy ${OOB_ARN}`]);
    expect(live.managed).toEqual([ACCEPTED_ARN]);
  });

  it('an accepted inline policy whose document changed out of band is drift, and --revert puts the recorded document back', async () => {
    live.inline.set('accepted', DOC('s3:GetObject'));
    resources = {
      Subject: principalRecord('Group', await captureObserved('Group')),
    };
    expect(await runDrift([])).toBe(0);
    live.inline.set('accepted', DOC('*'));
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual(['PutGroupPolicy accepted']);
    expect(live.inline.get('accepted')).toEqual(DOC('s3:GetObject'));
    expect(stdout).not.toContain('- deletes inline policy');
  });

  it('a recorded group whose spelling differs from the live one only in case stays, and the revert sends the live spelling', async () => {
    live.groups.push('admins');
    resources = {
      Subject: principalRecord('User', { ...(await captureObserved('User')), Groups: ['Admins'] }),
    };
    expect(await runDrift([])).toBe(0);
    live.groups.push('oob-group');
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual(['RemoveUserFromGroup oob-group']);
    expect(live.groups).toEqual(['admins']);
  });

  it("matches a sibling addition's group case-insensitively at compare and revert", async () => {
    live.groups.push('Sib-Group');
    resources = { Subject: principalRecord('User'), ...siblings('User') };
    expect(await runDrift([])).toBe(0);
    live.groups.push('oob-group');
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual(['RemoveUserFromGroup oob-group']);
    expect(live.groups).toEqual(['Sib-Group']);
  });

  it('a recorded boundary removed out of band (a widening) is drift, and --revert puts it back', async () => {
    live.boundary = BOUNDARY_ARN;
    resources = { Subject: principalRecord('Role', await captureObserved('Role')) };
    expect(await runDrift([])).toBe(0);
    live.boundary = undefined;
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([`PutRolePermissionsBoundary ${BOUNDARY_ARN}`]);
  });
});

describe("an attachment a same-stack ManagedPolicy's own declared list owns (iam-sibling-managed-policy-drift's AddGroup shape)", () => {
  beforeEach(setUp);
  afterEach(() => exitSpy.mockRestore());

  const mp = (declared: Record<string, unknown>): ResourceState => ({
    physicalId: SIB_ARN,
    resourceType: 'AWS::IAM::ManagedPolicy',
    properties: { PolicyDocument: DOC('s3:GetObject'), ...declared },
  });

  it.each([
    ['template-only', false],
    ['observed', true],
  ] as const)(
    "%s: the policy attached out of band to a group its declared Groups does not name is the policy's drift, not the group's, and the group's revert leaves it",
    async (_l, observed) => {
      resources = {
        Subject: principalRecord('Group', observed ? await captureObserved('Group') : undefined),
        Mp: mp({ Groups: ['other-group'] }),
      };
      live.managed.push(SIB_ARN);
      // Only the policy (read back as recorded here) could report it.
      expect(await runDrift(['--json'])).toBe(0);
      live.inline.set('oob-inline', DOC('*'));
      expect(await runDrift(['--revert', '--yes'])).toBe(0);
      expect(writes).toEqual(['DeleteGroupPolicy oob-inline']);
      expect(live.managed).toEqual([SIB_ARN]);
    }
  );

  it.each([
    ['a {{resolve:}} reference', ['{{resolve:ssm:/team/group}}']],
    ['a masked name', ['***']],
    ['an unresolved intrinsic', [{ Ref: 'Other' }]],
    ['a plain name beside a {{resolve:}} reference', ['other-group', '{{resolve:ssm:/team/group}}']],
    ['a single string, not a list', 'other-group'],
  ])("a declared Groups holding %s does not take the attachment from the group", async (_l, groups) => {
    resources = { Subject: principalRecord('Group'), Mp: mp({ Groups: groups }) };
    live.managed.push(SIB_ARN);
    expect(await runDrift(['--json'])).toBe(1);
    expect(changes()).toEqual([{ logicalId: 'Subject', path: 'ManagedPolicyArns' }]);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([`DetachGroupPolicy ${SIB_ARN}`]);
  });

  it('a declared EMPTY Groups takes the attachment: the policy reports it, and the revert detaches it exactly once', async () => {
    const policyProvider = new IAMManagedPolicyProvider();
    const groupProvider = new IAMUserGroupProvider();
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::IAM::ManagedPolicy' ? policyProvider : groupProvider
    );
    resources = { Subject: principalRecord('Group'), Mp: mp({ Groups: [] }) };
    live.managed.push(SIB_ARN);
    expect(await runDrift(['--json'])).toBe(1);
    expect(changes()).toEqual([{ logicalId: 'Mp', path: 'Groups' }]);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([`DetachGroupPolicy ${SIB_ARN}`]);
    expect(live.managed).toEqual([]);
  });

  it("the same attach of a policy that declares no Groups list is the group's drift, and its revert detaches it", async () => {
    resources = { Subject: principalRecord('Group'), Mp: mp({ Roles: ['some-role'] }) };
    live.managed.push(SIB_ARN);
    expect(await runDrift(['--json'])).toBe(1);
    expect(changes()).toEqual([{ logicalId: 'Subject', path: 'ManagedPolicyArns' }]);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([`DetachGroupPolicy ${SIB_ARN}`]);
  });
});

describe('a same-stack ManagedPolicy this run did not compare (go-to-k/cdkd#6697)', () => {
  beforeEach(setUp);
  afterEach(() => exitSpy.mockRestore());

  // `ZMp` sorts AFTER `Subject`, so a walk in template order would compare
  // the group before the policy's outcome exists.
  const mp = (groups: string[], extra: Partial<ResourceState> = {}): ResourceState => ({
    physicalId: SIB_ARN,
    resourceType: 'AWS::IAM::ManagedPolicy',
    properties: { PolicyDocument: DOC('s3:GetObject'), Groups: groups },
    ...extra,
  });
  const failPolicyRead = (): void => {
    const groupProvider = new IAMUserGroupProvider();
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::IAM::ManagedPolicy'
        ? {
            readCurrentState: async () => {
              throw new Error('AccessDenied: iam:GetPolicy');
            },
          }
        : groupProvider
    );
  };
  function notCompared(): Array<{ logicalId: string; cause: string }> {
    const [report] = JSON.parse(stdout) as Array<{
      notCompared: Array<{ logicalId: string; cause: string }>;
    }>;
    return report!.notCompared.map(({ logicalId, cause }) => ({ logicalId, cause }));
  }

  it.each([
    ['its read failed', 'readFailed', {}],
    ['its baseline was refused', 'baselineRefused', { observedBaselineRefused: true as const }],
  ] as const)(
    "when %s, its out-of-band attach to a group its Groups does not name is the group's drift, and --revert detaches it once",
    async (_l, cause, extra) => {
      if (cause === 'readFailed') failPolicyRead();
      resources = { Subject: principalRecord('Group'), ZMp: mp(['other-group'], extra) };
      live.managed.push(SIB_ARN);
      expect(await runDrift(['--json'])).toBe(1);
      expect(changes()).toEqual([{ logicalId: 'Subject', path: 'ManagedPolicyArns' }]);
      expect(notCompared()).toEqual([{ logicalId: 'ZMp', cause }]);
      expect(await runDrift(['--revert', '--yes'])).toBe(0);
      expect(writes).toEqual([`DetachGroupPolicy ${SIB_ARN}`]);
      expect(stdout).toContain(`- detaches managed policy ${SIB_ARN}`);
      expect(live.managed).toEqual([]);
    }
  );

  it('when it was compared, the same attach is the policy\'s alone, whichever comes first', async () => {
    resources = { Subject: principalRecord('Group'), ZMp: mp(['other-group']) };
    live.managed.push(SIB_ARN);
    // The policy reads back as recorded here, so only it could report the attach.
    expect(await runDrift(['--json'])).toBe(0);
    expect(changes()).toEqual([]);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([]);
  });

  it('an attachment its declared Groups names stays out of the group\'s comparison while it is not compared', async () => {
    failPolicyRead();
    resources = { Subject: principalRecord('Group'), ZMp: mp([NAME.Group]) };
    live.managed.push(SIB_ARN);
    expect(await runDrift(['--json'])).toBe(2);
    expect(changes()).toEqual([]);
    expect(notCompared()).toEqual([{ logicalId: 'ZMp', cause: 'readFailed' }]);
    await runDrift(['--revert', '--yes']);
    expect(writes).toEqual([]);
    expect(live.managed).toEqual([SIB_ARN]);
  });

  it("policies' failed reads, compared together first, do not trip the read breaker for the rest of the stack", async () => {
    failPolicyRead();
    resources = { Subject: principalRecord('Group') };
    for (let i = 0; i < 6; i++) {
      resources[`ZMp${i}`] = mp(['other-group'], { physicalId: `${SIB_ARN}${i}` });
    }
    live.managed.push(OOB_ARN);
    expect(await runDrift(['--json'])).toBe(1);
    expect(changes()).toEqual([{ logicalId: 'Subject', path: 'ManagedPolicyArns' }]);
    expect(notCompared().every((n) => n.cause === 'readFailed')).toBe(true);
    expect(notCompared().map((n) => n.logicalId)).not.toContain('Subject');
  });

  const warnings = (): string[] => mockWarn.mock.calls.map((c) => String(c[0]));
  const breakerLines = (): string[] =>
    warnings().filter((w) => w.includes('reads in a row in this stack failed'));

  it("a policy's failed read does not promise that cdkd goes on: the replay may trip on it", async () => {
    failPolicyRead();
    resources = { Subject: principalRecord('Group'), ZMp: mp(['other-group']) };
    mockWarn.mockClear();
    await runDrift(['--json']);
    const own = warnings().filter((w) => w.startsWith('ZMp '));
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('could not be compared');
    expect(own[0]).not.toContain('cdkd goes on');
  });

  it('the breaker warns once although replayed policy failures past the trip reach the threshold again', async () => {
    // P00-P04 fail, P05 reads, P06-P10 fail: replayed in template order that
    // trips at P04; P06-P10 would reach the threshold a second time.
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::IAM::ManagedPolicy'
        ? {
            readCurrentState: async (p: string, _l: string, _t: string, r: unknown) => {
              if (p.endsWith('#5')) return r;
              throw new Error('AccessDenied: iam:GetPolicy');
            },
          }
        : new IAMUserGroupProvider()
    );
    resources = { Subject: principalRecord('Group') };
    for (let i = 0; i <= 10; i++) {
      resources[`P${String(i).padStart(2, '0')}`] = mp(['other-group'], {
        physicalId: `${SIB_ARN}#${i}`,
      });
    }
    mockWarn.mockClear();
    await runDrift(['--json']);
    expect(breakerLines()).toHaveLength(1);
  });

  it('a policy read that returned still splits the failures around it in template order, so the breaker does not trip', async () => {
    // Template order: A1 A2 A3 fail, B (a policy) reads, C1 C2 D fail. In a
    // row that is 3, then 3: no trip, so D is read (readFailed). Counted in
    // the walk's order (the policy first), the six failures run together and
    // D would be readAborted.
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::IAM::ManagedPolicy'
        ? { readCurrentState: async (_p: string, _l: string, _t: string, r: unknown) => r }
        : {
            readCurrentState: async () => {
              throw new Error('ThrottlingException: Rate exceeded');
            },
          }
    );
    const queue = (id: string): ResourceState => ({
      physicalId: `https://sqs/${id}`,
      resourceType: 'AWS::SQS::Queue',
      properties: {},
    });
    resources = {
      A1: queue('a1'),
      A2: queue('a2'),
      A3: queue('a3'),
      B: mp(['other-group']),
      C1: queue('c1'),
      C2: queue('c2'),
      D: queue('d'),
    };
    await runDrift(['--json']);
    const causes = Object.fromEntries(notCompared().map((n) => [n.logicalId, n.cause]));
    expect(causes).toEqual({
      A1: 'readFailed',
      A2: 'readFailed',
      A3: 'readFailed',
      C1: 'readFailed',
      C2: 'readFailed',
      D: 'readFailed',
    });
  });
});

describe('a template that DECLARES the key keeps the ordinary comparison (go-to-k/cdkd#6627)', () => {
  beforeEach(setUp);
  afterEach(() => exitSpy.mockRestore());

  it('a declared ManagedPolicyArns still reports a member lost out of band, and --revert re-attaches it', async () => {
    resources = {
      Subject: {
        ...principalRecord('Role'),
        properties: { AssumeRolePolicyDocument: TRUST, ManagedPolicyArns: [ACCEPTED_ARN] },
      },
    };
    expect(await runDrift([])).toBe(1);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(writes).toEqual([`AttachRolePolicy ${ACCEPTED_ARN}`]);
  });
});

describe('a route whose readback is not filtered (Cloud Control, go-to-k/cdkd#6627)', () => {
  beforeEach(setUp);
  afterEach(() => exitSpy.mockRestore());

  // A Cloud Control read of the role: every live member, siblings' included;
  // an empty list and no boundary are omitted.
  let ccRead: Record<string, unknown> = {};
  const sent: Array<{ desired: Record<string, unknown>; previous: Record<string, unknown> }> = [];
  const SIB_POLICIES = [
    { PolicyName: 'SibInline', PolicyDocument: DOC('sqs:*') },
    { PolicyName: 'SibStandalone', PolicyDocument: DOC('sns:*') },
  ];
  const OOB_POLICY = { PolicyName: 'oob-inline', PolicyDocument: DOC('*') };
  const base = { RoleName: NAME.Role, Path: '/', AssumeRolePolicyDocument: TRUST };
  const withSiblings = (extra: { managed?: string[]; policies?: unknown[]; boundary?: string } = {}) => ({
    ...base,
    ManagedPolicyArns: [SIB_ARN, ...(extra.managed ?? [])],
    Policies: [...SIB_POLICIES, ...(extra.policies ?? [])],
    ...(extra.boundary ? { PermissionsBoundary: extra.boundary } : {}),
  });

  function routeCc(): void {
    sent.length = 0;
    mockRegistryGetProvider.mockImplementation((type) =>
      type === 'AWS::IAM::Role'
        ? {
            readCurrentState: async () => structuredClone(ccRead),
            update: async (
              _l: string,
              physicalId: string,
              _t: string,
              desired: Record<string, unknown>,
              previous: Record<string, unknown>
            ) => {
              sent.push({ desired: structuredClone(desired), previous: structuredClone(previous) });
              return { physicalId, wasReplaced: false };
            },
          }
        : {
            readCurrentState: async (
              _pid: string,
              _lid: string,
              _type: string,
              recorded: Record<string, unknown>
            ) => recorded,
          }
    );
  }

  const BASELINES: Array<[string, Record<string, unknown> | undefined]> = [
    ['template-only', undefined],
    ['observed, captured empty', { ...base, ManagedPolicyArns: [], Policies: [] }],
  ];

  it.each(BASELINES)('%s: only the siblings\' members live is clean', async (_l, observed) => {
    routeCc();
    ccRead = withSiblings();
    resources = { Subject: principalRecord('Role', observed), ...siblings('Role') };
    expect(await runDrift([])).toBe(0);
  });

  it.each(BASELINES)('%s: no member live (the read omits both lists and the boundary) is clean', async (_l, observed) => {
    routeCc();
    ccRead = { ...base };
    resources = { Subject: principalRecord('Role', observed) };
    expect(await runDrift([])).toBe(0);
  });

  it.each(BASELINES)('%s: an out-of-band grant is drift by its key, and the plan names no sibling member', async (_l, observed) => {
    routeCc();
    ccRead = withSiblings({ managed: [OOB_ARN], policies: [OOB_POLICY], boundary: BOUNDARY_ARN });
    resources = { Subject: principalRecord('Role', observed), ...siblings('Role') };
    expect(await runDrift(['--json'])).toBe(1);
    expect(changes().map((c) => c.path).sort()).toEqual(KEYS.Role);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(stdout).toContain(`- detaches managed policy ${OOB_ARN}`);
    expect(stdout).toContain('- deletes inline policy oob-inline');
    expect(stdout).toContain(`- deletes permissions boundary ${BOUNDARY_ARN}`);
    expect(stdout).not.toContain(SIB_ARN);
    expect(stdout).not.toContain('SibInline');
    expect(stdout).not.toContain('SibStandalone');
  });

  it.each(BASELINES)('%s: the revert bag keeps each live sibling member, drops each out-of-band one, sends no boundary, and changes no create-only key', async (_l, observed) => {
    routeCc();
    ccRead = withSiblings({ managed: [OOB_ARN], policies: [OOB_POLICY], boundary: BOUNDARY_ARN });
    resources = { Subject: principalRecord('Role', observed), ...siblings('Role') };
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sent).toHaveLength(1);
    const { desired, previous } = sent[0]!;
    expect(previous['ManagedPolicyArns']).toEqual([SIB_ARN, OOB_ARN]);
    expect(desired['ManagedPolicyArns']).toEqual([SIB_ARN]);
    expect(desired['Policies']).toEqual(SIB_POLICIES);
    expect(Object.hasOwn(desired, 'PermissionsBoundary')).toBe(false);
    // AWS::IAM::Role's create-only keys.
    expect(desired['RoleName']).toBe(previous['RoleName']);
    expect(desired['Path']).toBe(previous['Path']);
  });

  it.each(BASELINES)("%s: a sibling's inline policy whose document was edited out of band is reported as a change, and --revert restores the sibling's recorded document, never deletes it", async (_l, observed) => {
    routeCc();
    const edited = { PolicyName: 'SibInline', PolicyDocument: DOC('*') };
    ccRead = { ...withSiblings(), Policies: [edited, SIB_POLICIES[1]] };
    resources = { Subject: principalRecord('Role', observed), ...siblings('Role') };
    expect(await runDrift(['--json'])).toBe(1);
    expect(changes().map((c) => c.path)).toEqual(['Policies']);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(stdout).not.toContain('- deletes inline policy');
    expect(stdout).toContain('~ restores inline policy SibInline to its recorded document');
    expect(sent).toHaveLength(1);
    const byName = (l: unknown): unknown[] =>
      [...(l as Array<{ PolicyName: string }>)].sort((a, b) => a.PolicyName.localeCompare(b.PolicyName));
    expect(byName(sent[0]!.desired['Policies'])).toEqual(byName(SIB_POLICIES));
  });

  it("--accept on the principal does not silence a sibling's edited inline policy: drift compares it against the sibling's template", async () => {
    routeCc();
    const edited = { PolicyName: 'SibInline', PolicyDocument: DOC('*') };
    ccRead = { ...withSiblings(), Policies: [edited, SIB_POLICIES[1]] };
    resources = { Subject: principalRecord('Role'), ...siblings('Role') };
    expect(await runDrift(['--accept', '--yes'])).toBe(0);
    const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
    resources = saved.resources;
    expect(resources['Subject']!.observedProperties).toBeDefined();
    expect(await runDrift(['--json'])).toBe(1);
    expect(changes()).toEqual([{ logicalId: 'Subject', path: 'Policies' }]);
  });

  it("a recorded copy of a sibling's inline policy under an older document does not ride along beside the live one", async () => {
    routeCc();
    ccRead = withSiblings({ policies: [OOB_POLICY] });
    resources = {
      Subject: principalRecord('Role', {
        ...base,
        ManagedPolicyArns: [],
        // The sibling's policy as an earlier capture recorded it.
        Policies: [{ PolicyName: 'SibInline', PolicyDocument: DOC('*') }],
      }),
      ...siblings('Role'),
    };
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.desired['Policies']).toEqual(SIB_POLICIES);
  });
});
