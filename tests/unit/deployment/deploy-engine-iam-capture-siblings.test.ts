import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

// Logger silenced.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Resolver pass-through, EXCEPT a `{Fn::Sub: ...}` value resolves to a
// fixed string — so the capture-siblings builder's non-literal-PolicyName
// branch (which calls resolve()) can be exercised. Plain object/scalar
// inputs (resource properties) pass through unchanged.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => {
      if (props && typeof props === 'object' && 'Fn::Sub' in (props as object)) {
        return Promise.resolve('ResolvedSubPolicyName');
      }
      return Promise.resolve(props);
    }),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

// p-limit no-op so concurrency does not gate this test.
vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * The deploy-time `observedProperties` capture for an IAM principal
 * (`AWS::IAM::Role` / `::User` / `::Group`) must pass a sibling
 * context built from the TEMPLATE, so `readCurrentState` can filter inline
 * policies managed by a separate `AWS::IAM::Policy` resource — closing the
 * phantom-drift race where the role's `ListRolePolicies` capture lands
 * after the sibling's `PutRolePolicy`.
 */
describe('DeployEngine - IAM principal observed-capture sibling context', () => {
  const stackName = 'iam-capture-stack';

  let mockProvider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };

  let mockStateBackend: {
    getState: ReturnType<typeof vi.fn>;
    saveState: ReturnType<typeof vi.fn>;
    stackInstanceIdForFirstWrite: ReturnType<typeof vi.fn>;
  };
  let mockLockManager: {
    acquireLockWithRetry: ReturnType<typeof vi.fn>;
    releaseLock: ReturnType<typeof vi.fn>;
  };
  let mockDagBuilder: {
    buildGraph: ReturnType<typeof vi.fn>;
    getExecutionLevels: ReturnType<typeof vi.fn>;
    getDirectDependencies: ReturnType<typeof vi.fn>;
  };
  let mockDiffCalculator: {
    calculateDiff: ReturnType<typeof vi.fn>;
    hasChanges: ReturnType<typeof vi.fn>;
    filterByType: ReturnType<typeof vi.fn>;
  };
  let mockProviderRegistry: {
    getProvider: ReturnType<typeof vi.fn>;
    getProviderFor: ReturnType<typeof vi.fn>;
    getRegisteredTypes: ReturnType<typeof vi.fn>;
    validateResourceTypes: ReturnType<typeof vi.fn>;
    validateResourceProperties: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      // physicalId derived from logicalId so per-resource captures are
      // distinguishable.
      create: vi
        .fn()
        .mockImplementation(async (logicalId: string) => ({ physicalId: `phys-${logicalId}` })),
      update: vi.fn().mockResolvedValue({ physicalId: 'phys-update', wasReplaced: false }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue({ captured: true }),
    };

    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };

    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
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

    mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(mockProvider),
      getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };

    mockStateBackend = {
      getState: vi.fn().mockResolvedValue(undefined),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      stackInstanceIdForFirstWrite: vi
        .fn()
        .mockResolvedValue('00000000-0000-4000-8000-000000000000'),
    };
  });

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1'
    );
  }

  /**
   * Find the LAST readCurrentState call whose logicalId (2nd arg) matches.
   * Last, not first: when a resource pre-exists in loaded state, the
   * auto-refresh path fires its own capture before the CREATE/UPDATE
   * capture — the deploy-driven capture is the later one.
   *
   * Every deploy-driven capture follows cdkd's own write, so it carries
   * `afterOwnWrite` (issue #4112): asserted and split off here, leaving the
   * SIBLING context this file is about (`undefined` when there is none).
   */
  function captureContextFor(logicalId: string): unknown {
    const calls = mockProvider.readCurrentState.mock.calls;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]![1] !== logicalId) continue;
      const { afterOwnWrite, ...rest } = (calls[i]![4] ?? {}) as Record<string, unknown>;
      expect(afterOwnWrite).toBe(true);
      return Object.keys(rest).length === 0 ? undefined : rest;
    }
    return undefined;
  }

  it('passes the sibling AWS::IAM::Policy as capture context for a Role created with a DefaultPolicy', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        FnRole: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
        },
        FnDefaultPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: 'FnDefaultPolicyABC123',
            Roles: [{ Ref: 'FnRole' }],
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'FnRole',
          {
            logicalId: 'FnRole',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Role',
            desiredProperties: template.Resources!['FnRole']!.Properties,
          },
        ],
        [
          'FnDefaultPolicy',
          {
            logicalId: 'FnDefaultPolicy',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Policy',
            desiredProperties: template.Resources!['FnDefaultPolicy']!.Properties,
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['FnRole'], ['FnDefaultPolicy']]);

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);
    expect(result.created).toBe(2);

    // The Role's capture context carries the sibling policy, in the
    // resolved-property shape collectInlinePolicyNamesManagedBySiblings
    // consumes (Roles resolved to the role's physicalId; PolicyName the
    // inline name to exclude).
    expect(captureContextFor('FnRole')).toEqual({
      siblings: {
        FnDefaultPolicy: {
          resourceType: 'AWS::IAM::Policy',
          properties: { Roles: ['phys-FnRole'], PolicyName: 'FnDefaultPolicyABC123' },
        },
      },
    });

    // The sibling Policy itself is not an IAM principal — no capture context.
    expect(captureContextFor('FnDefaultPolicy')).toBeUndefined();
  });

  // go-to-k/cdkd#4821: a standalone AWS::IAM::RolePolicy manages its one name
  // on the role its RoleName names; a UserPolicy is another principal kind.
  it('passes a sibling AWS::IAM::RolePolicy naming the role, and not a UserPolicy, as capture context', async () => {
    const doc = { Version: '2012-10-17', Statement: [] };
    const template: CloudFormationTemplate = {
      Resources: {
        FnRole: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: doc } },
        Attach: {
          Type: 'AWS::IAM::RolePolicy',
          Properties: { PolicyName: 'attached', RoleName: { Ref: 'FnRole' }, PolicyDocument: doc },
        },
        OnUser: {
          Type: 'AWS::IAM::UserPolicy',
          Properties: { PolicyName: 'on-user', UserName: { Ref: 'FnRole' }, PolicyDocument: doc },
        },
        OtherRole: {
          Type: 'AWS::IAM::RolePolicy',
          Properties: { PolicyName: 'elsewhere', RoleName: 'some-other-role', PolicyDocument: doc },
        },
      },
    };
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>(
        Object.entries(template.Resources!).map(([id, r]) => [
          id,
          { logicalId: id, changeType: 'CREATE', resourceType: r.Type, desiredProperties: r.Properties },
        ])
      )
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['FnRole'], ['Attach', 'OnUser', 'OtherRole']]);

    await makeEngine().deploy(stackName, template);

    expect(captureContextFor('FnRole')).toEqual({
      siblings: {
        Attach: {
          resourceType: 'AWS::IAM::Policy',
          properties: { Roles: ['phys-FnRole'], PolicyName: 'attached' },
        },
      },
    });
  });

  it('passes no capture context for a Role with no sibling AWS::IAM::Policy', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        LoneRole: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
        },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'LoneRole',
          {
            logicalId: 'LoneRole',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Role',
            desiredProperties: template.Resources!['LoneRole']!.Properties,
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['LoneRole']]);

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(captureContextFor('LoneRole')).toBeUndefined();
  });

  it('matches the Users attachment field for an AWS::IAM::User principal', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        AppUser: { Type: 'AWS::IAM::User', Properties: {} },
        UserPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: 'AppUserDefaultPolicy',
            Users: [{ Ref: 'AppUser' }],
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'AppUser',
          {
            logicalId: 'AppUser',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::User',
            desiredProperties: {},
          },
        ],
        [
          'UserPolicy',
          {
            logicalId: 'UserPolicy',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Policy',
            desiredProperties: template.Resources!['UserPolicy']!.Properties,
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['AppUser'], ['UserPolicy']]);

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(captureContextFor('AppUser')).toEqual({
      siblings: {
        UserPolicy: {
          resourceType: 'AWS::IAM::Policy',
          properties: { Users: ['phys-AppUser'], PolicyName: 'AppUserDefaultPolicy' },
        },
      },
    });
  });

  it('matches a literal role-name attachment (hand-written template, no Ref)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        LiteralRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            RoleName: 'phys-LiteralRole',
            AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
        LiteralPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: 'LiteralAttachedPolicy',
            // Literal physical name instead of {Ref: ...} — the
            // capturedPhysicalId branch of the match must fire.
            Roles: ['phys-LiteralRole'],
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'LiteralRole',
          {
            logicalId: 'LiteralRole',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Role',
            desiredProperties: template.Resources!['LiteralRole']!.Properties,
          },
        ],
        [
          'LiteralPolicy',
          {
            logicalId: 'LiteralPolicy',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Policy',
            desiredProperties: template.Resources!['LiteralPolicy']!.Properties,
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['LiteralRole'], ['LiteralPolicy']]);
    // create() returns physicalId `phys-<logicalId>` => `phys-LiteralRole`,
    // matching the literal name in the template's Roles array.
    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(captureContextFor('LiteralRole')).toEqual({
      siblings: {
        LiteralPolicy: {
          resourceType: 'AWS::IAM::Policy',
          properties: { Roles: ['phys-LiteralRole'], PolicyName: 'LiteralAttachedPolicy' },
        },
      },
    });
  });

  it('resolves a non-literal (Fn::Sub) PolicyName via the resolver', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        SubRole: {
          Type: 'AWS::IAM::Role',
          Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
        },
        SubPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            // Intrinsic-valued PolicyName — the builder must resolve it to
            // a string before adding it to the exclude set.
            PolicyName: { 'Fn::Sub': '${AWS::StackName}-policy' },
            Roles: [{ Ref: 'SubRole' }],
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'SubRole',
          {
            logicalId: 'SubRole',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Role',
            desiredProperties: template.Resources!['SubRole']!.Properties,
          },
        ],
        [
          'SubPolicy',
          {
            logicalId: 'SubPolicy',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Policy',
            desiredProperties: template.Resources!['SubPolicy']!.Properties,
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['SubRole'], ['SubPolicy']]);

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(captureContextFor('SubRole')).toEqual({
      siblings: {
        SubPolicy: {
          resourceType: 'AWS::IAM::Policy',
          properties: { Roles: ['phys-SubRole'], PolicyName: 'ResolvedSubPolicyName' },
        },
      },
    });
  });

  it('carries the new physicalId for a Role replaced on UPDATE', async () => {
    // Existing state: role + sibling policy already deployed (old ids).
    mockStateBackend.getState.mockResolvedValue({
      state: {
        version: 8,
        region: 'us-east-1',
        stackName,
        resources: {
          ReplRole: {
            physicalId: 'phys-ReplRole-old',
            resourceType: 'AWS::IAM::Role',
            properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
          },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: {
        ReplRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            RoleName: 'changed-name',
            AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
        ReplPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: 'ReplDefaultPolicy',
            Roles: [{ Ref: 'ReplRole' }],
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        },
      },
    };

    // update() returns a NEW physicalId (replacement).
    mockProvider.update.mockResolvedValue({
      physicalId: 'phys-ReplRole-new',
      wasReplaced: true,
    });

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'ReplRole',
          {
            logicalId: 'ReplRole',
            changeType: 'UPDATE',
            resourceType: 'AWS::IAM::Role',
            desiredProperties: template.Resources!['ReplRole']!.Properties,
            currentProperties: {
              AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
            },
          },
        ],
        [
          'ReplPolicy',
          {
            logicalId: 'ReplPolicy',
            changeType: 'CREATE',
            resourceType: 'AWS::IAM::Policy',
            desiredProperties: template.Resources!['ReplPolicy']!.Properties,
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['ReplRole'], ['ReplPolicy']]);

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    // The capture context must reference the NEW physicalId, matching the
    // id handed to readCurrentState for the replaced role.
    expect(captureContextFor('ReplRole')).toEqual({
      siblings: {
        ReplPolicy: {
          resourceType: 'AWS::IAM::Policy',
          properties: { Roles: ['phys-ReplRole-new'], PolicyName: 'ReplDefaultPolicy' },
        },
      },
    });
  });

  // go-to-k/cdkd#6324: a sibling AWS::IAM::ManagedPolicy attaching itself via
  // `Roles` is keyed by its recorded ARN, so the capture's ManagedPolicyArns
  // leaves it out. It is in state only once it exists (an UPDATE of the role).
  it('passes a recorded sibling AWS::IAM::ManagedPolicy (by ARN) as capture context on a Role UPDATE', async () => {
    const doc = { Version: '2012-10-17', Statement: [] };
    const mpArn = 'arn:aws:iam::123456789012:policy/iam-capture-stack-Mp-ABC';
    mockStateBackend.getState.mockResolvedValue({
      state: {
        version: 8,
        region: 'us-east-1',
        stackName,
        resources: {
          Role: {
            physicalId: 'phys-Role',
            resourceType: 'AWS::IAM::Role',
            properties: { AssumeRolePolicyDocument: doc },
          },
          Mp: {
            physicalId: mpArn,
            resourceType: 'AWS::IAM::ManagedPolicy',
            properties: { PolicyDocument: doc, Roles: ['phys-Role'] },
          },
          OtherMp: {
            physicalId: 'arn:aws:iam::123456789012:policy/other',
            resourceType: 'AWS::IAM::ManagedPolicy',
            properties: { PolicyDocument: doc, Roles: ['some-other-role'] },
          },
          UserMp: {
            physicalId: 'arn:aws:iam::123456789012:policy/on-user',
            resourceType: 'AWS::IAM::ManagedPolicy',
            properties: { PolicyDocument: doc, Users: ['phys-Role'] },
          },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: 'etag-old',
    });
    const template: CloudFormationTemplate = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: { Description: 'new', AssumeRolePolicyDocument: doc } },
        Mp: { Type: 'AWS::IAM::ManagedPolicy', Properties: { PolicyDocument: doc, Roles: [{ Ref: 'Role' }] } },
        OtherMp: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: { PolicyDocument: doc, Roles: ['some-other-role'] },
        },
        // `Users` names a user, never this role, even one spelled alike.
        UserMp: { Type: 'AWS::IAM::ManagedPolicy', Properties: { PolicyDocument: doc, Users: [{ Ref: 'Role' }] } },
      },
    };
    mockProvider.update.mockResolvedValue({ physicalId: 'phys-Role', wasReplaced: false });
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Role',
          {
            logicalId: 'Role',
            changeType: 'UPDATE',
            resourceType: 'AWS::IAM::Role',
            desiredProperties: template.Resources!['Role']!.Properties,
            currentProperties: { AssumeRolePolicyDocument: doc },
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Role']]);

    await makeEngine().deploy(stackName, template);

    expect(captureContextFor('Role')).toEqual({
      siblings: {
        Mp: {
          resourceType: 'AWS::IAM::ManagedPolicy',
          physicalId: mpArn,
          properties: { Roles: ['phys-Role'] },
        },
      },
    });
  });

  // The policy's detach from the role runs AFTER this capture: a recorded
  // attachment the template drops (or a policy it removes) is still not the
  // role's own.
  it.each([
    ['the template drops the role from the policy', { Mp: { Type: 'AWS::IAM::ManagedPolicy', Properties: { PolicyDocument: {}, Roles: ['other'] } } }],
    ['the template removes the policy', {}],
  ])('passes a recorded ManagedPolicy still attached to the Role when %s', async (_label, extra) => {
    const doc = { Version: '2012-10-17', Statement: [] };
    const mpArn = 'arn:aws:iam::123456789012:policy/leaving';
    mockStateBackend.getState.mockResolvedValue({
      state: {
        version: 8,
        region: 'us-east-1',
        stackName,
        resources: {
          Role: { physicalId: 'phys-Role', resourceType: 'AWS::IAM::Role', properties: { AssumeRolePolicyDocument: doc } },
          Mp: { physicalId: mpArn, resourceType: 'AWS::IAM::ManagedPolicy', properties: { PolicyDocument: doc, Roles: ['phys-Role'] } },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: 'etag-old',
    });
    const template = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: { Description: 'new', AssumeRolePolicyDocument: doc } },
        ...extra,
      },
    } as CloudFormationTemplate;
    mockProvider.update.mockResolvedValue({ physicalId: 'phys-Role', wasReplaced: false });
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Role',
          {
            logicalId: 'Role',
            changeType: 'UPDATE',
            resourceType: 'AWS::IAM::Role',
            desiredProperties: template.Resources!['Role']!.Properties,
            currentProperties: { AssumeRolePolicyDocument: doc },
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Role']]);

    await makeEngine().deploy(stackName, template);

    expect(captureContextFor('Role')).toEqual({
      siblings: {
        Mp: { resourceType: 'AWS::IAM::ManagedPolicy', physicalId: mpArn, properties: { Roles: ['phys-Role'] } },
      },
    });
  });

  it('passes no ManagedPolicy sibling at a Role CREATE, where the policy has no recorded ARN yet', async () => {
    const doc = { Version: '2012-10-17', Statement: [] };
    const template: CloudFormationTemplate = {
      Resources: {
        Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: doc } },
        Mp: { Type: 'AWS::IAM::ManagedPolicy', Properties: { PolicyDocument: doc, Roles: [{ Ref: 'Role' }] } },
      },
    };
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>(
        Object.entries(template.Resources!).map(([id, r]) => [
          id,
          { logicalId: id, changeType: 'CREATE', resourceType: r.Type, desiredProperties: r.Properties },
        ])
      )
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Role'], ['Mp']]);
    // The policy's `Ref` to the role orders its create after the role's.
    mockDagBuilder.getDirectDependencies.mockImplementation((_dag: unknown, id: string) =>
      id === 'Mp' ? ['Role'] : []
    );

    await makeEngine().deploy(stackName, template);

    expect(mockProvider.create.mock.calls.map((c) => c[0])).toEqual(['Role', 'Mp']);
    expect(captureContextFor('Role')).toBeUndefined();
  });

  it("marks the capture after a create-only REPLACEMENT as following cdkd's own write (issue #4112)", async () => {
    mockStateBackend.getState.mockResolvedValue({
      state: {
        version: 1,
        region: 'us-east-1',
        stackName,
        resources: {
          Topic: {
            physicalId: 'phys-Topic-old',
            resourceType: 'AWS::SNS::Topic',
            properties: { TopicName: 'old-name' },
          },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: 'etag-old',
    });
    const template: CloudFormationTemplate = {
      Resources: {
        Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'new-name' } },
      },
    };
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Topic',
          {
            logicalId: 'Topic',
            changeType: 'UPDATE',
            resourceType: 'AWS::SNS::Topic',
            desiredProperties: { TopicName: 'new-name' },
            currentProperties: { TopicName: 'old-name' },
            propertyChanges: [
              {
                path: 'TopicName',
                oldValue: 'old-name',
                newValue: 'new-name',
                requiresReplacement: true,
              },
            ],
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Topic']]);

    await makeEngine().deploy(stackName, template);

    // The engine REPLACED it (create the new one), not an in-place update().
    expect(mockProvider.create).toHaveBeenCalledTimes(1);
    expect(mockProvider.update).not.toHaveBeenCalled();
    const capture = mockProvider.readCurrentState.mock.calls.find(
      (call) => call[0] === 'phys-Topic'
    );
    expect(capture?.[4]).toEqual({ afterOwnWrite: true });
  });

  it('passes no capture context for a non-IAM-principal resource (S3 bucket)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b' } },
      },
    };

    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Bucket',
          {
            logicalId: 'Bucket',
            changeType: 'CREATE',
            resourceType: 'AWS::S3::Bucket',
            desiredProperties: { BucketName: 'b' },
          },
        ],
      ])
    );
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Bucket']]);

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(captureContextFor('Bucket')).toBeUndefined();
  });

  // go-to-k/cdkd#6343: the Role is NO_CHANGE, so nothing re-captures it, while
  // its baseline (a CREATE-race or pre-#6324 capture) holds the policy's ARN.
  describe('a NO_CHANGE principal whose sibling ManagedPolicy stopped attaching it (#6343)', () => {
    const doc = { Version: '2012-10-17', Statement: [] };
    const oldArn = 'arn:aws:iam::123456789012:policy/iam-capture-stack-Mp-OLD';
    const awsManaged = 'arn:aws:iam::aws:policy/ReadOnlyAccess';

    function stateWith(roleDeclares: string[]) {
      return {
        state: {
          version: 8,
          region: 'us-east-1',
          stackName,
          resources: {
            Role: {
              physicalId: 'phys-Role',
              resourceType: 'AWS::IAM::Role',
              properties: { AssumeRolePolicyDocument: doc, ManagedPolicyArns: roleDeclares },
              observedProperties: { ManagedPolicyArns: [awsManaged, oldArn], RoleName: 'phys-Role' },
            },
            Mp: {
              physicalId: oldArn,
              resourceType: 'AWS::IAM::ManagedPolicy',
              properties: { PolicyDocument: doc, Roles: ['phys-Role'] },
              observedProperties: { Roles: ['phys-Role'] },
            },
          },
          outputs: {},
          lastModified: 0,
        },
        etag: 'etag-old',
      };
    }

    async function deployMpChange(
      mpProps: Record<string, unknown>,
      updated: { physicalId: string; wasReplaced: boolean },
      roleDeclares: string[],
      // A later CREATE that fails, on a `--no-rollback` deploy.
      failAfter = false
    ) {
      const template: CloudFormationTemplate = {
        Resources: {
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: { AssumeRolePolicyDocument: doc, ManagedPolicyArns: roleDeclares },
          },
          Mp: { Type: 'AWS::IAM::ManagedPolicy', Properties: mpProps },
          ...(failAfter && { Boom: { Type: 'AWS::S3::Bucket', Properties: {} } }),
        },
      };
      if (failAfter) {
        mockProvider.create.mockRejectedValue(new Error('boom'));
      }
      mockStateBackend.getState.mockResolvedValue(stateWith(roleDeclares));
      mockProvider.update.mockResolvedValue(updated);
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Role',
            {
              logicalId: 'Role',
              changeType: 'NO_CHANGE',
              resourceType: 'AWS::IAM::Role',
              desiredProperties: template.Resources!['Role']!.Properties,
              currentProperties: template.Resources!['Role']!.Properties,
            },
          ],
          [
            'Mp',
            {
              logicalId: 'Mp',
              changeType: 'UPDATE',
              resourceType: 'AWS::IAM::ManagedPolicy',
              desiredProperties: mpProps,
              currentProperties: { PolicyDocument: doc, Roles: ['phys-Role'] },
            },
          ],
          ...(failAfter
            ? ([
                [
                  'Boom',
                  { logicalId: 'Boom', changeType: 'CREATE', resourceType: 'AWS::S3::Bucket', desiredProperties: {} },
                ],
              ] as Array<[string, ResourceChange]>)
            : []),
        ])
      );
      mockDagBuilder.getExecutionLevels.mockReturnValue(
        failAfter ? [['Role'], ['Mp'], ['Boom']] : [['Role'], ['Mp']]
      );
      if (failAfter) {
        const engine = new DeployEngine(
          mockStateBackend as never,
          mockLockManager as never,
          mockDagBuilder as never,
          mockDiffCalculator as never,
          mockProviderRegistry as never,
          { dryRun: false, noRollback: true },
          'us-east-1'
        );
        await expect(engine.deploy(stackName, template)).rejects.toThrow();
      } else {
        await makeEngine().deploy(stackName, template);
      }
      const saved = mockStateBackend.saveState.mock.calls.at(-1)![2] as {
        resources: Record<string, { observedProperties?: Record<string, unknown> }>;
      };
      return saved.resources['Role']!.observedProperties;
    }

    it('drops the ARN once the policy drops the role from its Roles', async () => {
      const observed = await deployMpChange(
        { PolicyDocument: doc, Roles: ['some-other-role'] },
        { physicalId: oldArn, wasReplaced: false },
        [awsManaged]
      );
      expect(observed).toEqual({ ManagedPolicyArns: [awsManaged], RoleName: 'phys-Role' });
    });

    it('drops the OLD ARN once the policy is replaced under a new ARN', async () => {
      const newArn = 'arn:aws:iam::123456789012:policy/iam-capture-stack-Mp-NEW';
      const observed = await deployMpChange(
        { PolicyDocument: doc, ManagedPolicyName: 'renamed', Roles: [{ Ref: 'Role' }] },
        { physicalId: newArn, wasReplaced: true },
        [awsManaged]
      );
      expect(observed).toEqual({ ManagedPolicyArns: [awsManaged], RoleName: 'phys-Role' });
    });

    // `--no-rollback`: the policy's detach stays, and the next deploy would
    // see the new record as the previous one, so the failure save prunes too.
    it('drops the ARN in the state a --no-rollback failure saves', async () => {
      const observed = await deployMpChange(
        { PolicyDocument: doc, Roles: ['some-other-role'] },
        { physicalId: oldArn, wasReplaced: false },
        [awsManaged],
        true
      );
      expect(mockProvider.create).toHaveBeenCalled();
      expect(observed).toEqual({ ManagedPolicyArns: [awsManaged], RoleName: 'phys-Role' });
    });

    it("keeps the ARN when the role's own template declares it too", async () => {
      const observed = await deployMpChange(
        { PolicyDocument: doc, Roles: ['some-other-role'] },
        { physicalId: oldArn, wasReplaced: false },
        [awsManaged, oldArn]
      );
      expect(observed).toEqual({ ManagedPolicyArns: [awsManaged, oldArn], RoleName: 'phys-Role' });
    });
  });
});
