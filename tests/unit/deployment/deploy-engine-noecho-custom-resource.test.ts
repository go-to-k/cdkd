import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  SECRET_MASK,
  clearRecoverableMaskedOutputs,
  recoverMaskedOutput,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

// Issue #2274, end to end through the REAL `IntrinsicFunctionResolver` — the
// resolver is deliberately NOT mocked here, because the registration this
// feature turns on happens inside `resolveGetAtt` and a mocked resolver would
// only prove the mock.
//
// Two invariants, and they pull in opposite directions, which is the whole
// reason the design is a mask-only channel rather than masking at capture:
//
//   1. `Fn::GetAtt` must keep resolving to the REAL value. CloudFormation
//      delivers a `NoEcho` custom resource's `Data` to a dependent resource in
//      the clear (measured against real CFn on the issue thread), so masking at
//      capture would make a template feeding it into
//      `AWS::SecretsManager::Secret.SecretString` store the literal mask AS the
//      secret.
//   2. The plaintext must not reach `state.json` by ANY route — not just the
//      custom resource's own `attributes`, but the DEPENDENT's resolved
//      `properties`, which are persisted too.

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const GENERATED = 'handler-generated-secret-9f2a';
const STACK = 'noecho-cr-stack';

describe('DeployEngine - a NoEcho custom resource Data never reaches state (#2274)', () => {
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
    loadRollbackJournal: ReturnType<typeof vi.fn>;
    appendRollbackJournalSegment: ReturnType<typeof vi.fn>;
  };
  let mockLockManager: Record<string, ReturnType<typeof vi.fn>>;
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
  let mockProviderRegistry: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Cr'], ['Param']]),
      // The event-driven executor orders by THIS, not by the levels — `Param`
      // must not resolve its `Fn::GetAtt` until `Cr` has recorded its
      // attributes, which is also the ordering the real DAG guarantees and the
      // reason the in-run `NoEcho` registry needs no persistence.
      getDirectDependencies: vi
        .fn()
        .mockImplementation((_dag: unknown, id: string) => (id === 'Cr' ? [] : ['Cr'])),
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
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    };
  });

  function makeEngine(): DeployEngine {
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

  /** `Cr` produces the value; `Param` consumes it through `Fn::GetAtt`. */
  const PARAM_PROPS = {
    Name: '/app/token',
    Type: 'String',
    Value: { 'Fn::GetAtt': ['Cr', 'Secret'] },
  };
  const template: CloudFormationTemplate = {
    Resources: {
      Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn:aws:lambda:...' } },
      Param: { Type: 'AWS::SSM::Parameter', Properties: PARAM_PROPS },
    },
    Outputs: { Token: { Value: { 'Fn::GetAtt': ['Cr', 'Secret'] } } },
  };

  function twoCreates(): Map<string, ResourceChange> {
    return new Map<string, ResourceChange>([
      [
        'Cr',
        {
          logicalId: 'Cr',
          changeType: 'CREATE',
          resourceType: 'Custom::Thing',
          desiredProperties: { ServiceToken: 'arn:aws:lambda:...' },
        },
      ],
      [
        'Param',
        {
          logicalId: 'Param',
          changeType: 'CREATE',
          resourceType: 'AWS::SSM::Parameter',
          desiredProperties: PARAM_PROPS,
        },
      ],
    ]);
  }

  function savedState(): StackState {
    return mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
  }

  it('resolves the REAL value to the dependent while persisting only the mask', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(twoCreates());
    mockProvider.create.mockImplementation((logicalId: string) =>
      logicalId === 'Cr'
        ? Promise.resolve({
            physicalId: 'cr-phys',
            attributes: { Secret: GENERATED },
            noEchoAttributes: true,
          })
        : Promise.resolve({ physicalId: 'param-phys' })
    );

    const result = await makeEngine().deploy(STACK, template);
    expect(result.created).toBe(2);

    // INVARIANT 1 — the SSM parameter was written with the REAL secret.
    const paramCall = mockProvider.create.mock.calls.find((c) => c[0] === 'Param')!;
    expect((paramCall[2] as Record<string, unknown>)['Value']).toBe(GENERATED);

    // INVARIANT 2 — nothing plaintext in ANY persisted bag.
    const state = savedState();
    expect(state.resources['Cr']!.attributes).toEqual({ Secret: SECRET_MASK });
    expect(state.resources['Param']!.properties['Value']).toBe(SECRET_MASK);
    // ...including the outputs bag, which is exported to consumer stacks.
    expect(state.outputs['Token']).toBe(SECRET_MASK);
    expect(JSON.stringify(state)).not.toContain(GENERATED);
  });

  it('masks an OBSERVED readback that echoes the value back', async () => {
    // The async observed-capture drain runs after the resolver context is
    // gone, so it redacts from `perResourceSecrets` — the same bag the
    // registration writes into.
    mockDiffCalculator.calculateDiff.mockResolvedValue(twoCreates());
    mockProvider.create.mockImplementation((logicalId: string) =>
      logicalId === 'Cr'
        ? Promise.resolve({
            physicalId: 'cr-phys',
            attributes: { Secret: GENERATED },
            noEchoAttributes: true,
          })
        : Promise.resolve({ physicalId: 'param-phys' })
    );
    mockProvider.readCurrentState.mockImplementation((_id: string, _type: string) =>
      Promise.resolve({ Name: '/app/token', Value: GENERATED })
    );

    await makeEngine().deploy(STACK, template);

    const state = savedState();
    expect(state.resources['Param']!.observedProperties?.['Value']).toBe(SECRET_MASK);
    expect(JSON.stringify(state)).not.toContain(GENERATED);
  });

  it('leaves a custom resource WITHOUT NoEcho in cleartext (the negative case)', async () => {
    // This is what `tests/integration/custom-resource-getatt-data` asserts and
    // must keep asserting: a handler that sets no `NoEcho` gets no redaction.
    mockDiffCalculator.calculateDiff.mockResolvedValue(twoCreates());
    mockProvider.create.mockImplementation((logicalId: string) =>
      logicalId === 'Cr'
        ? Promise.resolve({ physicalId: 'cr-phys', attributes: { Secret: GENERATED } })
        : Promise.resolve({ physicalId: 'param-phys' })
    );

    await makeEngine().deploy(STACK, template);

    const state = savedState();
    expect(state.resources['Cr']!.attributes).toEqual({ Secret: GENERATED });
    expect(state.resources['Param']!.properties['Value']).toBe(GENERATED);
    expect(state.outputs['Token']).toBe(GENERATED);
  });

  it('does not mask a SIBLING resource literal that happens to equal the value', async () => {
    // `perResourceSecrets` is keyed by logical id, and the registration happens
    // in the CONSUMER's resolution pass — so a resource that never referenced
    // the custom resource keeps its own literal.
    mockDagBuilder.getExecutionLevels.mockReturnValue([['Cr'], ['Param', 'Other']]);
    const changes = twoCreates();
    changes.set('Other', {
      logicalId: 'Other',
      changeType: 'CREATE',
      resourceType: 'AWS::SSM::Parameter',
      desiredProperties: { Name: '/app/other', Value: GENERATED },
    });
    mockDiffCalculator.calculateDiff.mockResolvedValue(changes);
    mockProvider.create.mockImplementation((logicalId: string) =>
      logicalId === 'Cr'
        ? Promise.resolve({
            physicalId: 'cr-phys',
            attributes: { Secret: GENERATED },
            noEchoAttributes: true,
          })
        : Promise.resolve({ physicalId: `${logicalId}-phys` })
    );

    const withOther: CloudFormationTemplate = {
      ...template,
      Resources: {
        ...template.Resources,
        Other: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: '/app/other', Value: GENERATED },
        },
      },
    };
    await makeEngine().deploy(STACK, withOther);

    const state = savedState();
    expect(state.resources['Param']!.properties['Value']).toBe(SECRET_MASK);
    expect(state.resources['Other']!.properties['Value']).toBe(GENERATED);
  });

  describe('the UPDATE arm, where the handler IS re-invoked', () => {
    // A redeploy that re-runs the handler is the MAIN runtime path, and its
    // registration is a DIFFERENT construction from the create arm's: it
    // registers against `carriedAttributes` rather than `result.attributes`,
    // because those are the values that land in the record. The two differ
    // exactly when a provider declares `NoEcho` and returns NO fresh
    // attributes. Both shapes are covered below; the create-path case above
    // fences neither of them.
    function updatedState(): { state: StackState; etag: string } {
      const cr: ResourceState = {
        physicalId: 'cr-phys',
        resourceType: 'Custom::Thing',
        properties: { ServiceToken: 'arn:aws:lambda:...' },
        attributes: { Secret: 'stale-value-from-a-previous-run' },
      };
      return {
        state: {
          version: 9,
          stackName: STACK,
          region: 'us-east-1',
          resources: { Cr: cr },
          outputs: {},
          lastModified: Date.now(),
        },
        etag: 'etag-old',
      };
    }

    function crUpdateAndParamCreate(): Map<string, ResourceChange> {
      return new Map<string, ResourceChange>([
        [
          'Cr',
          {
            logicalId: 'Cr',
            changeType: 'UPDATE',
            resourceType: 'Custom::Thing',
            desiredProperties: { ServiceToken: 'arn:aws:lambda:...', Bump: '2' },
          },
        ],
        [
          'Param',
          {
            logicalId: 'Param',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: PARAM_PROPS,
          },
        ],
      ]);
    }

    it('masks a FRESH value the update handler returned', async () => {
      mockStateBackend.getState.mockResolvedValue(updatedState());
      mockDiffCalculator.calculateDiff.mockResolvedValue(crUpdateAndParamCreate());
      mockProvider.update.mockResolvedValue({
        physicalId: 'cr-phys',
        attributes: { Secret: GENERATED },
        noEchoAttributes: true,
      });
      mockProvider.create.mockResolvedValue({ physicalId: 'param-phys' });

      await makeEngine().deploy(STACK, template);

      // INVARIANT 1 still holds on this arm.
      const paramCall = mockProvider.create.mock.calls.find((c) => c[0] === 'Param')!;
      expect((paramCall[2] as Record<string, unknown>)['Value']).toBe(GENERATED);

      const state = savedState();
      expect(state.resources['Cr']!.attributes).toEqual({ Secret: SECRET_MASK });
      expect(state.resources['Param']!.properties['Value']).toBe(SECRET_MASK);
      expect(JSON.stringify(state)).not.toContain(GENERATED);
    });

    it('masks a CARRIED-FORWARD value when the update returns no fresh attributes', async () => {
      // The shape the call site's comment names, and the one an
      // `result.attributes`-based registration would miss entirely: the update
      // declares `NoEcho` but hands back nothing, so the engine carries the
      // PRIOR attributes into the record. Those carried values are what gets
      // persisted, so those are what must be registered.
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 9,
          stackName: STACK,
          region: 'us-east-1',
          resources: {
            Cr: {
              physicalId: 'cr-phys',
              resourceType: 'Custom::Thing',
              properties: { ServiceToken: 'arn:aws:lambda:...' },
              attributes: { Secret: GENERATED },
            } as ResourceState,
          },
          outputs: {},
          lastModified: Date.now(),
        },
        etag: 'etag-old',
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(crUpdateAndParamCreate());
      mockProvider.update.mockResolvedValue({
        physicalId: 'cr-phys',
        noEchoAttributes: true,
      });
      mockProvider.create.mockResolvedValue({ physicalId: 'param-phys' });

      await makeEngine().deploy(STACK, template);

      const state = savedState();
      expect(state.resources['Cr']!.attributes).toEqual({ Secret: SECRET_MASK });
      expect(JSON.stringify(state)).not.toContain(GENERATED);
    });

    it('leaves a carried-forward value alone when the update declares no NoEcho', async () => {
      // The negative twin, so the two cases above cannot pass by masking
      // unconditionally on the update arm.
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 9,
          stackName: STACK,
          region: 'us-east-1',
          resources: {
            Cr: {
              physicalId: 'cr-phys',
              resourceType: 'Custom::Thing',
              properties: { ServiceToken: 'arn:aws:lambda:...' },
              attributes: { Secret: GENERATED },
            } as ResourceState,
          },
          outputs: {},
          lastModified: Date.now(),
        },
        etag: 'etag-old',
      });
      mockDiffCalculator.calculateDiff.mockResolvedValue(crUpdateAndParamCreate());
      mockProvider.update.mockResolvedValue({ physicalId: 'cr-phys' });
      mockProvider.create.mockResolvedValue({ physicalId: 'param-phys' });

      await makeEngine().deploy(STACK, template);

      expect(savedState().resources['Cr']!.attributes).toEqual({ Secret: GENERATED });
    });
  });

  describe('a LATER deploy that does not re-invoke the handler', () => {
    /**
     * State as the deploy above left it: the custom resource is unchanged, so
     * CloudFormation semantics say its handler does not run, and the only thing
     * `Fn::GetAtt` can read is the persisted mask. `ResourceState` carries no
     * durable per-attribute `NoEcho` flag to recover from (issue #2449).
     */
    function stateWithMaskedAttribute(): { state: StackState; etag: string } {
      const cr: ResourceState = {
        physicalId: 'cr-phys',
        resourceType: 'Custom::Thing',
        properties: { ServiceToken: 'arn:aws:lambda:...' },
        attributes: { Secret: SECRET_MASK },
      };
      const param: ResourceState = {
        physicalId: 'param-phys',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK },
      };
      return {
        state: {
          version: 9,
          stackName: STACK,
          region: 'us-east-1',
          resources: { Cr: cr, Param: param },
          outputs: {},
          lastModified: Date.now(),
        },
        etag: 'etag-old',
      };
    }

    it('REFUSES to push the mask to AWS, naming the attribute and the remedy', async () => {
      mockStateBackend.getState.mockResolvedValue(stateWithMaskedAttribute());
      mockDagBuilder.getExecutionLevels.mockReturnValue([['Param']]);
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Param',
            {
              logicalId: 'Param',
              changeType: 'UPDATE',
              resourceType: 'AWS::SSM::Parameter',
              desiredProperties: { ...PARAM_PROPS, Description: 'changed' },
              currentProperties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK },
            },
          ],
        ])
      );

      // The engine wraps every per-resource failure, so the refusal is read
      // off the CAUSE — asserting only the wrapper would pass for any failure.
      const failure = await makeEngine()
        .deploy(STACK, template)
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error & { cause?: Error }).cause?.message)).toContain(
        'Cannot resolve Cr.Secret for Param'
      );
      expect(String((failure as Error & { cause?: Error }).cause?.message)).toContain(
        'NoEcho: true'
      );
      expect(String((failure as Error & { cause?: Error }).cause?.message)).toContain('2449');
      // The AWS call never happened — the refusal is BEFORE the provider.
      expect(mockProvider.update).not.toHaveBeenCalled();
    });

    it('does not refuse when nothing reads the redacted attribute', async () => {
      // A resource that touches no `Fn::GetAtt` against the custom resource is
      // unaffected: the bag is only non-empty when one was actually served.
      mockStateBackend.getState.mockResolvedValue(stateWithMaskedAttribute());
      mockDagBuilder.getExecutionLevels.mockReturnValue([['Param']]);
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Param',
            {
              logicalId: 'Param',
              changeType: 'UPDATE',
              resourceType: 'AWS::SSM::Parameter',
              desiredProperties: { Name: '/app/token', Type: 'String', Value: 'literal' },
              currentProperties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK },
            },
          ],
        ])
      );
      mockProvider.update.mockResolvedValue({ physicalId: 'param-phys', wasReplaced: false });

      const noGetAtt: CloudFormationTemplate = {
        Resources: {
          Cr: template.Resources['Cr']!,
          Param: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Name: '/app/token', Type: 'String', Value: 'literal' },
          },
        },
      };
      const result = await makeEngine().deploy(STACK, noGetAtt);
      expect(result.updated).toBe(1);
      expect(mockProvider.update).toHaveBeenCalledTimes(1);
    });

    it('REFUSES on the CREATE arm too, for a NEW dependent added to such a stack', async () => {
      // Review round 2: the create-side refusal shipped unfenced, and it is the
      // arm a user reaches most naturally — adding a resource that consumes an
      // already-masked attribute. The two arms are separate `case` blocks, so
      // the update case above says nothing about this one.
      mockStateBackend.getState.mockResolvedValue(stateWithMaskedAttribute());
      mockDagBuilder.getExecutionLevels.mockReturnValue([['NewParam']]);
      mockDagBuilder.getDirectDependencies.mockReturnValue([]);
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'NewParam',
            {
              logicalId: 'NewParam',
              changeType: 'CREATE',
              resourceType: 'AWS::SSM::Parameter',
              desiredProperties: {
                Name: '/app/copy',
                Type: 'String',
                Value: { 'Fn::GetAtt': ['Cr', 'Secret'] },
              },
            },
          ],
        ])
      );

      const withNew: CloudFormationTemplate = {
        Resources: {
          Cr: template.Resources['Cr']!,
          NewParam: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Name: '/app/copy',
              Type: 'String',
              Value: { 'Fn::GetAtt': ['Cr', 'Secret'] },
            },
          },
        },
      };
      const failure = await makeEngine()
        .deploy(STACK, withNew)
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      const cause = String((failure as Error & { cause?: Error }).cause?.message);
      expect(cause).toContain('Cannot resolve Cr.Secret for NewParam');
      // The AWS call never happened.
      expect(mockProvider.create).not.toHaveBeenCalled();
    });

    it('names remedies that CAN work, and not the one that cannot', async () => {
      // Review round 2, blocker 3's message half. The first cut told the user
      // to "re-deploy the PRODUCER stack first", which cannot help: the
      // producer re-masks the value on the way into its own state, so the
      // consumer's next run reads the mask again. Asserting the ABSENCE is the
      // point — the wording is the only thing this arm changes for a user.
      mockStateBackend.getState.mockResolvedValue(stateWithMaskedAttribute());
      mockDagBuilder.getExecutionLevels.mockReturnValue([['Param']]);
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Param',
            {
              logicalId: 'Param',
              changeType: 'UPDATE',
              resourceType: 'AWS::SSM::Parameter',
              desiredProperties: { ...PARAM_PROPS, Description: 'changed' },
              currentProperties: { Name: '/app/token', Type: 'String', Value: SECRET_MASK },
            },
          ],
        ])
      );

      const failure = await makeEngine()
        .deploy(STACK, template)
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      const cause = String((failure as Error & { cause?: Error }).cause?.message);
      expect(cause).toContain('force that custom resource to update');
      expect(cause).toContain('cdkd deploy --all');
      expect(cause).not.toContain('re-deploy the PRODUCER stack first');
    });
  });

  describe('the values cdkd itself supplied are never masked back at it', () => {
    it('keeps the ServiceToken addressable when the handler ECHOES it into Data', async () => {
      // Review round 2, minor 1 (the security half). A handler returning its
      // own `event.ResourceProperties` inside `Data` — what the CDK `Provider`
      // samples encourage — makes `Data.FunctionArn` equal the resource's own
      // `ServiceToken`. Registering that as a needle rewrites
      // `properties.ServiceToken` to `***` in the very record
      // `CustomResourceProvider.delete` reads it back from, where the mask is a
      // TRUTHY STRING that passes both of that method's guards, so the delete
      // would invoke a "Lambda" named `***`.
      const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:111122223333:function:CrHandler';
      const echoTemplate: CloudFormationTemplate = {
        Resources: {
          Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: SERVICE_TOKEN } },
        },
      };
      mockDagBuilder.getExecutionLevels.mockReturnValue([['Cr']]);
      mockDagBuilder.getDirectDependencies.mockReturnValue([]);
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Cr',
            {
              logicalId: 'Cr',
              changeType: 'CREATE',
              resourceType: 'Custom::Thing',
              desiredProperties: { ServiceToken: SERVICE_TOKEN },
            },
          ],
        ])
      );
      mockProvider.create.mockResolvedValue({
        physicalId: 'cr-phys',
        attributes: { FunctionArn: SERVICE_TOKEN, Token: GENERATED },
        noEchoAttributes: true,
      });

      await makeEngine().deploy(STACK, echoTemplate);

      const state = savedState();
      // The genuinely handler-generated value IS masked...
      expect(state.resources['Cr']!.attributes?.['Token']).toBe(SECRET_MASK);
      // ...while the echoed input survives in the record cdkd deletes from.
      expect(state.resources['Cr']!.properties['ServiceToken']).toBe(SERVICE_TOKEN);
    });
  });

  describe('the IN-RUN recovery store, written by the outputs redaction', () => {
    // Review round 2, blocker 3, the WRITE half. Every cross-stack route reads
    // the PRODUCER's persisted outputs, so masking one made the first deploy of
    // a consumer refuse a template that deployed before this feature. The
    // engine remembers the plaintext behind each output it just masked, keyed
    // by (stack, region, output key), and the three read sites recover from it.
    it('remembers the plaintext behind an output it just masked', async () => {
      clearRecoverableMaskedOutputs();
      mockDiffCalculator.calculateDiff.mockResolvedValue(twoCreates());
      mockProvider.create.mockImplementation((logicalId: string) =>
        logicalId === 'Cr'
          ? Promise.resolve({
              physicalId: 'cr-phys',
              attributes: { Secret: GENERATED },
              noEchoAttributes: true,
            })
          : Promise.resolve({ physicalId: 'param-phys' })
      );

      await makeEngine().deploy(STACK, template);

      // The persisted bag holds the mask (asserted elsewhere too)...
      expect(savedState().outputs['Token']).toBe(SECRET_MASK);
      // ...while the in-run channel can still answer for it, at that exact
      // coordinate and no other.
      expect(recoverMaskedOutput(STACK, 'us-east-1', 'Token')).toBe(GENERATED);
      expect(recoverMaskedOutput(STACK, 'eu-west-1', 'Token')).toBeUndefined();
      expect(recoverMaskedOutput('OtherStack', 'us-east-1', 'Token')).toBeUndefined();
      clearRecoverableMaskedOutputs();
    });

    it('remembers NOTHING when no output was masked', async () => {
      // The negative twin: a deploy with no `NoEcho` anywhere must leave the
      // store empty, or the case above could pass by the engine recording
      // every output unconditionally.
      clearRecoverableMaskedOutputs();
      mockDiffCalculator.calculateDiff.mockResolvedValue(twoCreates());
      mockProvider.create.mockImplementation((logicalId: string) =>
        logicalId === 'Cr'
          ? Promise.resolve({ physicalId: 'cr-phys', attributes: { Secret: GENERATED } })
          : Promise.resolve({ physicalId: 'param-phys' })
      );

      await makeEngine().deploy(STACK, template);

      expect(savedState().outputs['Token']).toBe(GENERATED);
      expect(recoverMaskedOutput(STACK, 'us-east-1', 'Token')).toBeUndefined();
      clearRecoverableMaskedOutputs();
    });
  });

  describe('the REPLACEMENT re-create registers too', () => {
    it('masks the fresh attributes a replacement create returned', async () => {
      // A different `case` block from both the create and the update arms, and
      // the one an UpdateReplacePolicy path takes. Unfenced before review
      // round 2, so a mask-only registration could be dropped there and every
      // other case stayed green.
      mockStateBackend.getState.mockResolvedValue({
        state: {
          version: 9,
          stackName: STACK,
          region: 'us-east-1',
          resources: {
            Cr: {
              physicalId: 'cr-old',
              resourceType: 'Custom::Thing',
              properties: { ServiceToken: 'arn:aws:lambda:...' },
              attributes: { Secret: 'stale' },
            } as ResourceState,
          },
          outputs: {},
          lastModified: Date.now(),
        },
        etag: 'etag-old',
      });
      mockDagBuilder.getExecutionLevels.mockReturnValue([['Cr']]);
      mockDagBuilder.getDirectDependencies.mockReturnValue([]);
      mockDiffCalculator.calculateDiff.mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'Cr',
            {
              logicalId: 'Cr',
              changeType: 'UPDATE',
              resourceType: 'Custom::Thing',
              desiredProperties: { ServiceToken: 'arn:aws:lambda:...', Seed: 'new' },
              currentProperties: { ServiceToken: 'arn:aws:lambda:...' },
              // What actually routes the UPDATE into the replacement
              // re-create arm: a property change marked as requiring one.
              propertyChanges: [
                { path: 'Seed', oldValue: undefined, newValue: 'new', requiresReplacement: true },
              ],
            },
          ],
        ])
      );
      mockProvider.create.mockResolvedValue({
        physicalId: 'cr-new',
        attributes: { Secret: GENERATED },
        noEchoAttributes: true,
      });

      const crOnly: CloudFormationTemplate = {
        Resources: { Cr: template.Resources['Cr']! },
      };
      await makeEngine().deploy(STACK, crOnly);

      const state = savedState();
      expect(state.resources['Cr']!.attributes).toEqual({ Secret: SECRET_MASK });
      expect(JSON.stringify(state)).not.toContain(GENERATED);
    });
  });
});
