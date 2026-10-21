/**
 * go-to-k/cdkd#5112: `UpdateContext.changedProperties` for the two updates a
 * parent re-created under the same name forces (go-to-k/cdkd#4411 / #4461),
 * whose template-to-template comparison sees no change at the parent's name.
 * The harness is the #4461 one:
 *
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
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

describe('UpdateContext.changedProperties for a child of a re-created parent (go-to-k/cdkd#5112)', () => {
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
        prefetch: vi.fn().mockResolvedValue(undefined),
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

  const changedFor = (): string[] | undefined => {
    const updated = callsFor(sdk.update, 'Child');
    expect(updated).toHaveLength(1);
    const context = updated[0]![5] as UpdateContext | undefined;
    return context?.changedProperties === undefined ? undefined : [...context.changedProperties].sort();
  };

  it('a re-attach names the list whose previous side dropped the re-created role', async () => {
    const props = { ManagedPolicyName: 'guardrail', PolicyDocument: DOC };
    await deployWith('Role', {
      type: 'AWS::IAM::ManagedPolicy',
      physicalId: POLICY_ARN,
      recorded: { ...props, Roles: ['fixed-role', 'other-role'] },
      templated: { ...props, Roles: [{ Ref: 'Role' }, 'other-role'] },
    });
    expect(changedFor()).toEqual(['Roles']);
  });

  it('a re-put, which changes nothing as written, names every key', async () => {
    const props = { PolicyName: 'deny-all', PolicyDocument: DOC };
    await deployWith('User', {
      type: 'AWS::IAM::Policy',
      physicalId: 'deny-all',
      recorded: { ...props, Users: ['fixed-user'] },
      templated: { ...props, Users: [{ Ref: 'User' }] },
    });
    expect(changedFor()).toEqual(['PolicyDocument', 'PolicyName', 'Users']);
  });
});
