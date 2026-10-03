/**
 * go-to-k/cdkd#4461: an IAM role, user or group re-created under the same name
 * loses what is ATTACHED to it -- IAM refuses to delete a principal that
 * still has a managed policy, an instance profile or (for a group) members,
 * so every delete route detaches them first -- while the attaching resource
 * survives and its record still lists the principal. The engine updates such a
 * resource in place with the re-created principal's name dropped from the
 * recorded side, so the provider's own diff attaches it again.
 *
 * Driven through `DeployEngine.deploy` with the REAL `DiffCalculator`,
 * `DagBuilder` and `IntrinsicFunctionResolver`; only the providers are doubles.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'iam-reattach-stack';
const REGION = 'us-east-1';
const POLICY_ARN = 'arn:aws:iam::123456789012:policy/guardrail';
const DOC = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 's3:*', Resource: '*' }] };

function record(
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  dependencies: string[] = []
): ResourceState {
  return {
    physicalId,
    resourceType,
    properties,
    observedProperties: properties,
    attributes: {},
    dependencies,
    provisionedBy: 'sdk',
  } as ResourceState;
}

/** The principals, all fixed-name: a re-create keeps each one's id. */
const PRINCIPALS: Record<string, { type: string; id: string; props: Record<string, unknown> }> = {
  Role: { type: 'AWS::IAM::Role', id: 'fixed-role', props: { RoleName: 'fixed-role' } },
  User: { type: 'AWS::IAM::User', id: 'fixed-user', props: { UserName: 'fixed-user' } },
  Group: { type: 'AWS::IAM::Group', id: 'fixed-group', props: { GroupName: 'fixed-group' } },
};

type Provider = Record<'create' | 'update' | 'delete' | 'getAttribute', ReturnType<typeof vi.fn>>;

function makeProvider(): Provider {
  return {
    create: vi.fn((logicalId: string) =>
      Promise.resolve({
        physicalId: Object.hasOwn(PRINCIPALS, logicalId)
          ? PRINCIPALS[logicalId]!.id
          : `${logicalId}-new`,
        attributes: {},
      })
    ),
    update: vi.fn((_logicalId: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false })
    ),
    delete: vi.fn().mockResolvedValue(undefined),
    getAttribute: vi.fn(),
  };
}

describe('DeployEngine - re-attaching what a same-name IAM principal re-create detached (go-to-k/cdkd#4461)', () => {
  let sdk: Provider;
  let cc: Provider;
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    sdk = makeProvider();
    cc = makeProvider();
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine(target: string, options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(sdk),
        getProviderFor: vi
          .fn()
          .mockImplementation((input: { provisionedBy?: 'sdk' | 'cc-api' }) =>
            input.provisionedBy === 'cc-api'
              ? { provider: cc, provisionedBy: 'cc-api' as const }
              : { provider: sdk, provisionedBy: 'sdk' as const }
          ),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      {
        dryRun: false,
        recreateTargets: {
          stackName: STACK,
          viaCcApi: new Set([target]),
          viaSdkProvider: new Set<string>(),
        },
        ...options,
      } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  /**
   * Deploy `child` (recorded with `recorded`, templated with `templated`)
   * beside the principal `parent`, which `--recreate-via-cc-api` re-creates.
   */
  async function deployWith(
    parent: string,
    child: {
      type: string;
      physicalId: string;
      recorded: Record<string, unknown>;
      templated: Record<string, unknown>;
      provisionedBy?: 'sdk' | 'cc-api';
    },
    options: Record<string, unknown> = {}
  ): Promise<void> {
    const p = PRINCIPALS[parent]!;
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: {
        [parent]: record(p.id, p.type, p.props),
        Child: {
          ...record(child.physicalId, child.type, child.recorded, [parent]),
          provisionedBy: child.provisionedBy ?? 'sdk',
        } as ResourceState,
      },
      outputs: {},
      lastModified: 0,
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const t: CloudFormationTemplate = {
      Resources: {
        [parent]: { Type: p.type, Properties: p.props },
        Child: { Type: child.type, Properties: child.templated },
      },
    };
    await makeEngine(parent, options).deploy(STACK, t);
    expect(callsFor(cc.create, parent)).toHaveLength(1);
  }

  function saved(id: string): ResourceState | undefined {
    const calls = stateBackend.saveState.mock.calls;
    return (calls[calls.length - 1]?.[2] as StackState | undefined)?.resources[id];
  }

  const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
    fn.mock.calls.filter((c) => c[0] === id);

  /** The one in-place update of `Child`: its desired and recorded sides. */
  function childUpdate(
    via: Provider = sdk
  ): { desired: Record<string, unknown>; previous: Record<string, unknown> } {
    const updated = callsFor(via.update, 'Child');
    expect(updated).toHaveLength(1);
    for (const p of [sdk, cc]) {
      expect(callsFor(p.create, 'Child')).toHaveLength(0);
      expect(callsFor(p.delete, 'Child')).toHaveLength(0);
    }
    return {
      desired: updated[0]![3] as Record<string, unknown>,
      previous: updated[0]![4] as Record<string, unknown>,
    };
  }

  it('re-attaches a managed policy to the re-created role, leaving its other roles as recorded', async () => {
    const props = { ManagedPolicyName: 'guardrail', PolicyDocument: DOC };
    await deployWith('Role', {
      type: 'AWS::IAM::ManagedPolicy',
      physicalId: POLICY_ARN,
      recorded: { ...props, Roles: ['fixed-role', 'other-role'] },
      templated: { ...props, Roles: [{ Ref: 'Role' }, 'other-role'] },
    });

    const { desired, previous } = childUpdate();
    expect(desired['Roles']).toEqual(['fixed-role', 'other-role']);
    expect(previous['Roles']).toEqual(['other-role']);
    // The record itself still lists the role: only the provider's side moved.
    expect(saved('Child')?.properties['Roles']).toEqual(['fixed-role', 'other-role']);
  });

  it('re-attaches a managed policy to a re-created user and a re-created group', async () => {
    const props = { ManagedPolicyName: 'guardrail', PolicyDocument: DOC };
    await deployWith('User', {
      type: 'AWS::IAM::ManagedPolicy',
      physicalId: POLICY_ARN,
      recorded: { ...props, Users: ['fixed-user'] },
      templated: { ...props, Users: [{ Ref: 'User' }] },
    });
    expect(childUpdate().previous['Users']).toEqual([]);

    vi.clearAllMocks();
    sdk = makeProvider();
    cc = makeProvider();
    await deployWith('Group', {
      type: 'AWS::IAM::ManagedPolicy',
      physicalId: POLICY_ARN,
      recorded: { ...props, Groups: ['fixed-group'] },
      templated: { ...props, Groups: [{ Ref: 'Group' }] },
    });
    expect(childUpdate().previous['Groups']).toEqual([]);
  });

  it('adds the re-created role back to its instance profile', async () => {
    await deployWith('Role', {
      type: 'AWS::IAM::InstanceProfile',
      physicalId: 'fixed-profile',
      recorded: { InstanceProfileName: 'fixed-profile', Roles: ['fixed-role'] },
      templated: { InstanceProfileName: 'fixed-profile', Roles: [{ Ref: 'Role' }] },
    });
    const { desired, previous } = childUpdate();
    expect(desired['Roles']).toEqual(['fixed-role']);
    expect(previous['Roles']).toEqual([]);
  });

  it('adds a user back to the re-created group it names', async () => {
    await deployWith('Group', {
      type: 'AWS::IAM::User',
      physicalId: 'member',
      recorded: { UserName: 'member', Groups: ['fixed-group', 'kept'] },
      templated: { UserName: 'member', Groups: [{ Ref: 'Group' }, 'kept'] },
    });
    expect(childUpdate().previous['Groups']).toEqual(['kept']);
  });

  it('adds every member back to a re-created group through its UserToGroupAddition', async () => {
    await deployWith('Group', {
      type: 'AWS::IAM::UserToGroupAddition',
      physicalId: 'stack-Membership-X',
      recorded: { GroupName: 'fixed-group', Users: ['u1', 'u2'] },
      templated: { GroupName: { Ref: 'Group' }, Users: ['u1', 'u2'] },
    });
    const { desired, previous } = childUpdate();
    expect(desired).toEqual({ GroupName: 'fixed-group', Users: ['u1', 'u2'] });
    expect(previous).toEqual({ GroupName: 'fixed-group', Users: [] });
  });

  it('re-puts an inline policy on a re-created user (its update writes to every principal it names)', async () => {
    const props = { PolicyName: 'deny-all', PolicyDocument: DOC };
    await deployWith('User', {
      type: 'AWS::IAM::Policy',
      physicalId: 'deny-all',
      recorded: { ...props, Users: ['fixed-user'] },
      templated: { ...props, Users: [{ Ref: 'User' }] },
    });
    // A re-put, not a re-attach: the recorded side is handed over as is.
    expect(childUpdate().previous['Users']).toEqual(['fixed-user']);
  });

  it('re-attaches the re-created role even when the same deploy also adds another role to the list', async () => {
    const props = { ManagedPolicyName: 'guardrail', PolicyDocument: DOC };
    await deployWith('Role', {
      type: 'AWS::IAM::ManagedPolicy',
      physicalId: POLICY_ARN,
      recorded: { ...props, Roles: ['fixed-role'] },
      templated: { ...props, Roles: [{ Ref: 'Role' }, 'new-role'] },
    });
    const { desired, previous } = childUpdate();
    expect(desired['Roles']).toEqual(['fixed-role', 'new-role']);
    // Both are attached: the re-created role as well as the added one.
    expect(previous['Roles']).toEqual([]);
  });

  it('hands a Cloud Control-recorded child the dropped side too, so its patch carries the attachment', async () => {
    const props = { ManagedPolicyName: 'guardrail', PolicyDocument: DOC };
    await deployWith('Role', {
      type: 'AWS::IAM::ManagedPolicy',
      physicalId: POLICY_ARN,
      recorded: { ...props, Roles: ['fixed-role'] },
      templated: { ...props, Roles: [{ Ref: 'Role' }] },
      provisionedBy: 'cc-api',
    });
    expect(childUpdate(cc).previous['Roles']).toEqual([]);
  });

  it('leaves a UserToGroupAddition the same deploy MOVES onto the re-created group to the ordinary move', async () => {
    await deployWith('Group', {
      type: 'AWS::IAM::UserToGroupAddition',
      physicalId: 'stack-Membership-X',
      recorded: { GroupName: 'other-group', Users: ['u1'] },
      templated: { GroupName: { Ref: 'Group' }, Users: ['u1'] },
    });
    // The recorded members stay, so the provider removes them from the old
    // group and adds them to the new one.
    expect(childUpdate().previous).toEqual({ GroupName: 'other-group', Users: ['u1'] });
  });

  it('keeps a managed policy\'s record, trimmed, when the deploy fails before re-attaching it (go-to-k/cdkd#4443)', async () => {
    const props = { ManagedPolicyName: 'guardrail', PolicyDocument: DOC };
    const sibProps = { Name: 'sib', Type: 'String', Value: 'v1' };
    const p = PRINCIPALS['Role']!;
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: {
        Role: record(p.id, p.type, p.props),
        Child: record(POLICY_ARN, 'AWS::IAM::ManagedPolicy', { ...props, Roles: ['fixed-role'] }, ['Role']),
        Sib: record('sib', 'AWS::SSM::Parameter', sibProps),
      },
      outputs: {},
      lastModified: 0,
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Sib'
        ? Promise.reject(new Error('ValidationException: forced sibling failure'))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const t: CloudFormationTemplate = {
      Resources: {
        Role: { Type: p.type, Properties: p.props },
        Sib: { Type: 'AWS::SSM::Parameter', Properties: { ...sibProps, Value: 'v2' }, DependsOn: ['Role'] },
        Child: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: { ...props, Roles: [{ Ref: 'Role' }] },
          DependsOn: ['Sib'],
        },
      },
    };

    await expect(makeEngine('Role', { noRollback: true }).deploy(STACK, t)).rejects.toThrow();

    expect(callsFor(sdk.update, 'Child')).toHaveLength(0);
    // Still recorded (the policy exists), minus the role it is no longer on,
    // so the next deploy diffs a change and attaches it again.
    expect(saved('Child')?.physicalId).toBe(POLICY_ARN);
    expect(saved('Child')?.properties['Roles']).toEqual([]);
  });

  it('trims a user whose own re-attach threw, and never advises re-creating it', async () => {
    // The user's update was attempted (its write may have landed), but a
    // re-create of the user would revoke its access keys: the record is
    // trimmed, so the next deploy re-adds it (`AddUserToGroup` is idempotent).
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Child'
        ? Promise.reject(
            Object.assign(new Error('The request was rejected'), { name: 'InvalidInputException' })
          )
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    await expect(
      deployWith('Group', {
        type: 'AWS::IAM::User',
        physicalId: 'member',
        recorded: { UserName: 'member', Groups: ['fixed-group'] },
        templated: { UserName: 'member', Groups: [{ Ref: 'Group' }] },
      }, { noRollback: true })
    ).rejects.toThrow();

    expect(callsFor(sdk.update, 'Child').length).toBeGreaterThan(0);
    expect(saved('Child')?.physicalId).toBe('member');
    expect(saved('Child')?.properties['Groups']).toEqual([]);
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('--recreate-via'))).toBe(false);
    // The partial-attach hazard is named: the group list dropping it later.
    expect(
      warned.some(
        (line) =>
          line.includes('Child (AWS::IAM::User) lost its attachment') &&
          line.includes('Its attach may already have landed on Group (fixed-group)') &&
          line.includes("if Child's Groups stops naming it before the next deploy") &&
          line.includes('detach it by hand')
      )
    ).toBe(true);
  });

  it('points a Cloud Control child whose update sent nothing at a hand attach, never a recreate', async () => {
    cc.update.mockImplementation((_l: string, physicalId: string) =>
      Promise.resolve({ physicalId, wasReplaced: false, sentNothing: true })
    );
    await deployWith('Group', {
      type: 'AWS::IAM::User',
      physicalId: 'member',
      recorded: { UserName: 'member', Groups: ['fixed-group'] },
      templated: { UserName: 'member', Groups: [{ Ref: 'Group' }] },
      provisionedBy: 'cc-api',
    });
    const warned = (getLogger().warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warned.some((line) => line.includes('Attach it there by hand'))).toBe(true);
    expect(warned.some((line) => line.includes('--recreate-via'))).toBe(false);
  });

  it('re-attaches a managed policy when the update-failure FALLBACK re-creates the role (go-to-k/cdkd#4444 dispatch)', async () => {
    const props = { ManagedPolicyName: 'guardrail', PolicyDocument: DOC };
    const roleProps = PRINCIPALS['Role']!.props;
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: {
        Role: record('fixed-role', 'AWS::IAM::Role', { ...roleProps, Description: 'v1' }),
        Child: record(POLICY_ARN, 'AWS::IAM::ManagedPolicy', { ...props, Roles: ['fixed-role'] }, ['Role']),
      },
      outputs: {},
      lastModified: 0,
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    // The role's in-place update is refused, so `--replace` deletes and
    // re-creates it under its name; the policy is a NO_CHANGE row.
    sdk.update.mockImplementation((logicalId: string, physicalId: string) =>
      logicalId === 'Role'
        ? Promise.reject(new ResourceUpdateNotSupportedError('AWS::IAM::Role', 'Role', 'cannot change'))
        : Promise.resolve({ physicalId, wasReplaced: false })
    );
    const t: CloudFormationTemplate = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: { ...roleProps, Description: 'v2' } },
        Child: { Type: 'AWS::IAM::ManagedPolicy', Properties: { ...props, Roles: [{ Ref: 'Role' }] } },
      },
    };
    await makeEngine('Nothing', { replace: true }).deploy(STACK, t);

    expect(callsFor(sdk.delete, 'Role')).toHaveLength(1);
    expect(callsFor(sdk.create, 'Role')).toHaveLength(1);
    expect(childUpdate().previous['Roles']).toEqual([]);
    const infos = (getLogger().info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(infos.some((line) => line.includes('Child was attached to a resource') && line.includes('attaching it again'))).toBe(true);
  });
});
