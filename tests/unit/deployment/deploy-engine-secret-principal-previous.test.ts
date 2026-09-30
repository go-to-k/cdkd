import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const warnSpy = vi.hoisted(() => vi.fn());
// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() }),
  }),
}));
const warned = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

/**
 * go-to-k/cdkd#4064: state keeps a secret-derived principal list as its
 * `{{resolve:...}}` expression, which is not a list of IAM names, so the
 * `AWS::IAM::Policy` and `AWS::IAM::UserToGroupAddition` providers (no live
 * source for the recorded side) refused every in-place update after the first
 * deploy. The engine now DROPS a recorded entry whose expression the template
 * still spells the same way from the previous side (the desired side names
 * that principal, and the provider's add is idempotent), at those types'
 * principal-list keys and nowhere else.
 */
const ROLE_EXPR = '{{resolve:secretsmanager:sdp:SecretString:role::}}';
const OTHER_EXPR = '{{resolve:secretsmanager:sdp-old:SecretString:role::}}';
const ROLE = 'secret-role-name';
const OTHER_ROLE = 'old-secret-role-name';
const SECRET_BY_EXPRESSION: Record<string, string> = {
  [ROLE_EXPR]: ROLE,
  [OTHER_EXPR]: OTHER_ROLE,
};

function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (typeof value === 'string') {
    const whole = SECRET_BY_EXPRESSION[value];
    if (whole !== undefined) {
      ctx.recordedSecretValues?.set(whole, value);
      return whole;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveWithSecrets(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveWithSecrets(v, ctx);
    }
    return out;
  }
  return value;
}

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi
      .fn()
      .mockImplementation((props: unknown, ctx: { recordedSecretValues?: Map<string, string> }) =>
        Promise.resolve(resolveWithSecrets(props, ctx ?? {}))
      ),
    resolveDynamicReferences: vi
      .fn()
      .mockImplementation((leaf: string, ctx: { recordedSecretValues?: Map<string, string> }) =>
        Promise.resolve(resolveWithSecrets(leaf, ctx ?? {}))
      ),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const DOC_OLD = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'a:b', Resource: '*' }] };
const DOC_NEW = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'a:c', Resource: '*' }] };

describe('DeployEngine drops an unchanged secret principal reference from the recorded side, so the provider re-applies it (go-to-k/cdkd#4064)', () => {
  const stackName = 'secret-principal-previous';

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let deps: Record<string, Record<string, ReturnType<typeof vi.fn>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'phys', attributes: {} }),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((changes: Map<string, ResourceChange>, type: string) =>
          Array.from(changes.values()).filter((c) => c.changeType === type)
        ),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
    deps = {
      lock: {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      },
      dag: {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['P']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      },
      registry: {
        hasProvider: vi.fn().mockReturnValue(true),
        getProvider: vi.fn().mockReturnValue(mockProvider),
        getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        getAllowedUnsupportedProperties: vi.fn().mockReturnValue(new Set<string>()),
      },
    };
  });

  /** Deploy one resource of `type` over a record holding `recorded`, and return what update() got. */
  async function updateOnce(
    type: string,
    desired: Record<string, unknown>,
    recorded: Record<string, unknown>,
    physicalId?: string
  ): Promise<{
    desiredArg: Record<string, unknown>;
    previousArg: Record<string, unknown>;
    mask: (t: string) => string;
    saved: StackState;
  }> {
    const template: CloudFormationTemplate = {
      Resources: { P: { Type: type, Properties: desired } },
    };
    const prior: StackState = {
      version: 9,
      region: 'us-east-1',
      stackName,
      resources: {
        // The IAM::Policy provider names the old policy by its physical id.
        P: {
          physicalId:
            physicalId ??
            (typeof recorded['PolicyName'] === 'string' ? recorded['PolicyName'] : 'phys'),
          resourceType: type,
          properties: structuredClone(recorded),
        },
      },
      outputs: {},
      lastModified: 1,
    };
    mockStateBackend.getState!.mockResolvedValue({ state: prior, etag: 'etag-1' });
    mockDiffCalculator.calculateDiff!.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'P',
          {
            logicalId: 'P',
            changeType: 'UPDATE',
            resourceType: type,
            desiredProperties: desired,
            currentProperties: recorded,
          },
        ],
      ])
    );
    await new DeployEngine(
      mockStateBackend as never,
      deps['lock'] as never,
      deps['dag'] as never,
      mockDiffCalculator as never,
      deps['registry'] as never,
      { dryRun: false },
      'us-east-1'
    ).deploy(stackName, template);
    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    const call = mockProvider.update!.mock.calls[0]!;
    return {
      desiredArg: call[3] as Record<string, unknown>,
      previousArg: call[4] as Record<string, unknown>,
      mask: (call[5] as { maskSecrets: (t: string) => string }).maskSecrets,
      saved: mockStateBackend.saveState!.mock.calls.at(-1)![2] as StackState,
    };
  }

  it('IAM::Policy: an unchanged secret reference is dropped from the previous side, with a kinds-only warning', async () => {
    const { desiredArg, previousArg, saved } = await updateOnce(
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: DOC_NEW, Roles: [ROLE_EXPR, 'added-role'] },
      { PolicyName: 'pol', PolicyDocument: DOC_OLD, Roles: [ROLE_EXPR, 'kept-role'] }
    );
    expect(desiredArg['Roles']).toEqual([ROLE, 'added-role']);
    // The provider re-puts every desired principal and removes it from none
    // it still lists; the plain recorded name stays for its own diff.
    expect(previousArg['Roles']).toEqual(['kept-role']);
    // Everything else on the previous side is the record as written.
    expect(previousArg['PolicyDocument']).toEqual(DOC_OLD);
    // No plaintext enters the previous side, and state keeps the reference.
    expect(JSON.stringify(previousArg)).not.toContain(ROLE);
    expect(saved.resources['P']!.properties['Roles']).toEqual([ROLE_EXPR, 'added-role']);
    expect(JSON.stringify(saved)).not.toContain(ROLE);
    // The rotation residual is announced, by kind and never by name.
    expect(warned()).toContain(
      'P (AWS::IAM::Policy): the recorded Roles holds a secret reference the template still ' +
        'spells the same way'
    );
    expect(warned()).toContain('a principal only the OLD value named');
    expect(warned()).not.toContain(ROLE);
  });

  it('UserToGroupAddition: an unchanged secret reference in Users is dropped the same way', async () => {
    // Dropped, not replaced by the resolved name: after a rotation a replaced
    // name reads as already a member and the NEW user is never added.
    const { previousArg } = await updateOnce(
      'AWS::IAM::UserToGroupAddition',
      { GroupName: 'grp', Users: [ROLE_EXPR, 'added-user'] },
      { GroupName: 'grp', Users: [ROLE_EXPR] }
    );
    expect(previousArg['Users']).toEqual([]);
  });

  it('UserToGroupAddition moved to ANOTHER group keeps the record, so the provider refuses', async () => {
    // Dropped, the secret-named user would never be removed from the OLD group.
    const { previousArg } = await updateOnce(
      'AWS::IAM::UserToGroupAddition',
      { GroupName: 'new-grp', Users: [ROLE_EXPR] },
      { GroupName: 'old-grp', Users: [ROLE_EXPR] }
    );
    expect(previousArg['Users']).toEqual([ROLE_EXPR]);
    expect(warned()).not.toContain('holds a secret reference the template still spells');
  });

  it('a reference the template RE-POINTED stays the recorded expression (its names are not this deploy\'s)', async () => {
    const { previousArg } = await updateOnce(
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: DOC_NEW, Roles: [ROLE_EXPR] },
      { PolicyName: 'pol', PolicyDocument: DOC_OLD, Roles: [OTHER_EXPR] }
    );
    expect(previousArg['Roles']).toEqual([OTHER_EXPR]);
    expect(warned()).not.toContain('holds a secret reference the template still spells');
  });

  it('a recorded MASK stays the mask: equal masks say nothing about the value', async () => {
    const { previousArg } = await updateOnce(
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: DOC_NEW, Roles: ['***'] },
      { PolicyName: 'pol', PolicyDocument: DOC_OLD, Roles: ['***'] }
    );
    expect(previousArg['Roles']).toEqual(['***']);
  });

  it('a type with a LIVE source for the recorded side (ManagedPolicy) keeps the record', async () => {
    const { previousArg } = await updateOnce(
      'AWS::IAM::ManagedPolicy',
      { PolicyDocument: DOC_NEW, Roles: [ROLE_EXPR] },
      { PolicyDocument: DOC_OLD, Roles: [ROLE_EXPR] }
    );
    expect(previousArg['Roles']).toEqual([ROLE_EXPR]);
  });

  it('a non-principal property holding the same reference keeps the record', async () => {
    // Only the principal lists: elsewhere a provider diffing the recorded
    // expression against the plaintext re-sends a rotated secret on update.
    // A plain PolicyName, so this reaches the helper; the reference sits in
    // the document alongside a droppable principal reference.
    const doc = (action: string) => ({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: action, Resource: ROLE_EXPR }],
    });
    const { previousArg } = await updateOnce(
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: doc('a:c'), Roles: [ROLE_EXPR] },
      { PolicyName: 'pol', PolicyDocument: doc('a:b'), Roles: [ROLE_EXPR] }
    );
    expect(previousArg['Roles']).toEqual([]);
    expect(previousArg['PolicyDocument']).toEqual(doc('a:b'));
  });

  it('warns once, naming every dropped kind joined by " / "', async () => {
    await updateOnce(
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: DOC_NEW, Roles: [ROLE_EXPR], Users: [OTHER_EXPR] },
      { PolicyName: 'pol', PolicyDocument: DOC_OLD, Roles: [ROLE_EXPR], Users: [OTHER_EXPR] }
    );
    expect(warned()).toContain('the recorded Roles / Users holds a secret reference');
  });

  it('an IAM::Policy whose physical id names ANOTHER policy keeps the record (the engine passes the physical id)', async () => {
    const { previousArg } = await updateOnce(
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: DOC_NEW, Roles: [ROLE_EXPR] },
      { PolicyName: 'pol', PolicyDocument: DOC_OLD, Roles: [ROLE_EXPR] },
      'other-pol'
    );
    expect(previousArg['Roles']).toEqual([ROLE_EXPR]);
    expect(warned()).not.toContain('holds a secret reference the template still spells');
  });

  it('a mixed record (one kind droppable, one re-pointed) drops nothing and does not warn', async () => {
    const { previousArg } = await updateOnce(
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: DOC_NEW, Roles: [ROLE_EXPR], Users: [ROLE_EXPR] },
      { PolicyName: 'pol', PolicyDocument: DOC_OLD, Roles: [ROLE_EXPR], Users: [OTHER_EXPR] }
    );
    expect(previousArg['Roles']).toEqual([ROLE_EXPR]);
    expect(previousArg['Users']).toEqual([OTHER_EXPR]);
    expect(warned()).not.toContain('holds a secret reference the template still spells');
  });
});
