import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  SECRET_MASK,
  clearRecoverableMaskedOutputs,
  recoverMaskedOutput,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../../src/utils/ambient-client-defaults.js';
/** The credential identity the code under test keys the recovery store by (go-to-k/cdkd#3691). */
const AMBIENT_ID = (): string => credentialFingerprint(ambientCredentialConfig());

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
    // A NON-default identity (go-to-k/cdkd#3691), so a writer that keyed the
    // recovery store by a constant instead of the active clients' identity
    // records under the wrong one and the recovery assertions below miss.
    credentialConfig: { profile: 'noecho-writer-3691' },
  }),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const GENERATED = 'handler-generated-secret-9f2a';
const STACK = 'noecho-cr-stack';

describe('DeployEngine - a leaf EMBEDDING a NoEcho custom-resource value is positioned (go-to-k/cdkd#7189)', () => {
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
    purgeRollbackJournalVersions: ReturnType<typeof vi.fn>;
    rollbackJournalReadAbsent: ReturnType<typeof vi.fn>;
    warmConnections: ReturnType<typeof vi.fn>;
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
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
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

  function savedState(): StackState {
    return mockStateBackend.saveState.mock.calls.at(-1)![2] as StackState;
  }

  const embeddedValue = (value: string): string => `postgres://u:${value}@db/app`;
  const getAtt = (name: string): unknown => ({ 'Fn::GetAtt': ['Cr', name] });
  const CR_PROPS = { ServiceToken: 'arn:aws:lambda:...', Env: 'prod-env-9' };
  const PARAM_PROPS = {
    Name: '/app/url',
    Type: 'String',
    Description: { 'Fn::Join': ['/', [getAtt('Env'), getAtt('Region'), getAtt('Stack')]] },
    Value: { 'Fn::Join': ['', ['postgres://u:', getAtt('Secret'), '@db/app']] },
  };
  const template: CloudFormationTemplate = {
    Resources: {
      Cr: { Type: 'Custom::Thing', Properties: CR_PROPS },
      Param: { Type: 'AWS::SSM::Parameter', Properties: PARAM_PROPS },
    },
  };
  const CR_ATTRIBUTES = { Secret: GENERATED, Env: 'prod-env-9', Region: 'us-east-1', Stack: STACK };
  const MASKED_CR_ATTRIBUTES = {
    Secret: SECRET_MASK,
    Env: 'prod-env-9',
    Region: 'us-east-1',
    Stack: STACK,
  };
  const PUBLIC_DESCRIPTION = `prod-env-9/us-east-1/${STACK}`;

  function priorState(paramExtra: Partial<ResourceState>): { state: StackState; etag: string } {
    return {
      state: {
        version: 11,
        stackName: STACK,
        region: 'us-east-1',
        resources: {
          Cr: {
            physicalId: 'cr-phys',
            resourceType: 'Custom::Thing',
            properties: CR_PROPS,
            attributes: MASKED_CR_ATTRIBUTES,
            noEchoAttributeNames: ['Secret'],
          } as ResourceState,
          Param: {
            physicalId: 'param-phys',
            resourceType: 'AWS::SSM::Parameter',
            properties: {
              Name: '/app/url',
              Type: 'String',
              Description: PUBLIC_DESCRIPTION,
              Value: SECRET_MASK,
            },
            ...paramExtra,
          } as ResourceState,
        },
        outputs: {},
        lastModified: Date.now(),
      },
      etag: 'etag-old',
    };
  }

  it('records the coordinate where the containment rule masked the leaf, and not where it spared a public one', async () => {
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Cr',
          {
            logicalId: 'Cr',
            changeType: 'CREATE',
            resourceType: 'Custom::Thing',
            desiredProperties: CR_PROPS,
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
      ])
    );
    mockProvider.create.mockImplementation((logicalId: string) =>
      Promise.resolve(
        logicalId === 'Cr'
          ? { physicalId: 'cr-phys', attributes: CR_ATTRIBUTES, noEchoAttributes: true }
          : { physicalId: 'param-phys' }
      )
    );

    await makeEngine().deploy(STACK, template);

    const paramCall = mockProvider.create.mock.calls.find((c) => c[0] === 'Param')!;
    expect((paramCall[2] as Record<string, unknown>)['Value']).toBe(embeddedValue(GENERATED));
    const param = savedState().resources['Param']!;
    expect(param.properties['Value']).toBe(SECRET_MASK);
    // The spared public leaf stays in the clear and unpositioned.
    expect(param.properties['Description']).toBe(PUBLIC_DESCRIPTION);
    expect(param.noEchoLeaves).toEqual([['Value']]);
    expect(JSON.stringify(savedState())).not.toContain(GENERATED);
  });

  it('heals a record an older binary wrote (masked whole, no coordinate) on a deploy that does not touch it', async () => {
    mockStateBackend.getState.mockResolvedValue(priorState({}));
    mockDiffCalculator.calculateDiff.mockResolvedValue(
      new Map<string, ResourceChange>([
        [
          'Cr',
          {
            logicalId: 'Cr',
            changeType: 'NO_CHANGE',
            resourceType: 'Custom::Thing',
            desiredProperties: CR_PROPS,
            currentProperties: CR_PROPS,
          },
        ],
        [
          'Param',
          {
            logicalId: 'Param',
            changeType: 'NO_CHANGE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: PARAM_PROPS,
            currentProperties: priorState({}).state.resources['Param']!.properties,
          },
        ],
      ])
    );

    await makeEngine().deploy(STACK, template);

    expect(mockProvider.update).not.toHaveBeenCalled();
    const param = savedState().resources['Param']!;
    expect(param.properties['Value']).toBe(SECRET_MASK);
    expect(param.properties['Description']).toBe(PUBLIC_DESCRIPTION);
    expect(param.noEchoLeaves).toEqual([['Value']]);
  });

  describe('a record carrying the coordinate, on a deploy where the handler re-ran', () => {
    function bothUpdate(): Map<string, ResourceChange> {
      return new Map<string, ResourceChange>([
        [
          'Cr',
          {
            logicalId: 'Cr',
            changeType: 'UPDATE',
            resourceType: 'Custom::Thing',
            desiredProperties: { ...CR_PROPS, Bump: '2' },
            currentProperties: CR_PROPS,
          },
        ],
        [
          'Param',
          {
            logicalId: 'Param',
            changeType: 'UPDATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: PARAM_PROPS,
            currentProperties: priorState({}).state.resources['Param']!.properties,
          },
        ],
      ]);
    }
    const bumpedTemplate: CloudFormationTemplate = {
      Resources: {
        Cr: { Type: 'Custom::Thing', Properties: { ...CR_PROPS, Bump: '2' } },
        Param: template.Resources['Param']!,
      },
    };

    for (const [live, label] of [
      [embeddedValue(GENERATED), 'AWS already holds the fresh value'],
      [embeddedValue('previous-secret-0000'), 'AWS holds the previous value'],
    ] as const) {
      it(`never persists the plaintext and keeps the coordinate (${label})`, async () => {
        mockStateBackend.getState.mockResolvedValue(priorState({ noEchoLeaves: [['Value']] }));
        mockDiffCalculator.calculateDiff.mockResolvedValue(bothUpdate());
        mockProvider.update.mockImplementation((logicalId: string) =>
          Promise.resolve(
            logicalId === 'Cr'
              ? { physicalId: 'cr-phys', attributes: CR_ATTRIBUTES, noEchoAttributes: true }
              : { physicalId: 'param-phys', wasReplaced: false }
          )
        );
        mockProvider.readCurrentState.mockImplementation((physicalId: string) =>
          Promise.resolve(
            physicalId === 'param-phys'
              ? { Name: '/app/url', Type: 'String', Description: PUBLIC_DESCRIPTION, Value: live }
              : undefined
          )
        );

        await makeEngine().deploy(STACK, bumpedTemplate);

        // Whatever was sent carries the real value, never the mask.
        for (const call of mockProvider.update.mock.calls.filter((c) => c[0] === 'Param')) {
          expect((call[3] as Record<string, unknown>)['Value']).toBe(embeddedValue(GENERATED));
        }
        const state = savedState();
        const param = state.resources['Param']!;
        expect(param.properties['Value']).toBe(SECRET_MASK);
        expect(param.noEchoLeaves).toEqual([['Value']]);
        expect(JSON.stringify(state)).not.toContain(GENERATED);
      });
    }
  });
});
