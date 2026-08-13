import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

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

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * Issue #1873 item 5a: a BARE `Fn::GetAtt` over
 * `AWS::Route53::HostedZone.NameServers` used directly as a stack Output.
 *
 * `resolveOutputs` stores whatever the resolver returned, verbatim — so since
 * PR #1868 kept the attribute in its CloudFormation list shape, such an Output
 * persists a JSON ARRAY into `state.outputs` where it used to persist a
 * comma-delimited string. That is a user-visible shape change in the state
 * file (and in the exports index) and had zero coverage: every existing test
 * read the attribute through `Fn::Join`, which collapses both shapes back to
 * one string.
 *
 * The resolver is deliberately NOT mocked here (unlike the sibling
 * `deploy-engine-outputs-only-change.test.ts`, whose identity-resolver mock
 * would make the assertion vacuous) — the point is to exercise the real
 * `resolveGetAtt` normalization all the way through to what `saveState`
 * receives.
 */
describe('DeployEngine - bare Fn::GetAtt over HostedZone NameServers as an Output (#1873)', () => {
  const stackName = 'route53-stack';

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
  let mockExportIndexStore: {
    updateForStack: ReturnType<typeof vi.fn>;
    lookup: ReturnType<typeof vi.fn>;
    patchEntry: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(),
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
      calculateDiff: vi.fn().mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'HostedZone',
            {
              logicalId: 'HostedZone',
              changeType: 'NO_CHANGE',
              resourceType: 'AWS::Route53::HostedZone',
            },
          ],
        ])
      ),
      hasChanges: vi.fn().mockReturnValue(false),
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
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    mockExportIndexStore = {
      updateForStack: vi.fn().mockResolvedValue(undefined),
      lookup: vi.fn().mockResolvedValue(null),
      patchEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  /**
   * `observedProperties` present keeps the auto-refresh path dormant, so the
   * only thing under test is what `resolveOutputs` persists.
   */
  function makeState(nameServers: unknown): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        HostedZone: {
          physicalId: 'Z1234567890',
          resourceType: 'AWS::Route53::HostedZone',
          properties: { Name: 'example.com' },
          observedProperties: { Name: 'example.com' },
          attributes: { Id: 'Z1234567890', NameServers: nameServers },
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    };
  }

  const template: CloudFormationTemplate = {
    Resources: {
      HostedZone: { Type: 'AWS::Route53::HostedZone', Properties: { Name: 'example.com' } },
    },
    Outputs: {
      // No Fn::Join — the raw attribute is the Output value.
      NameServers: { Value: { 'Fn::GetAtt': ['HostedZone', 'NameServers'] } },
    },
  };

  function makeEngine() {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: false },
      'us-east-1',
      mockExportIndexStore as never
    );
  }

  function savedOutputs(): Record<string, unknown> {
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    return (mockStateBackend.saveState.mock.calls[0]![2] as StackState).outputs as unknown as Record<
      string,
      unknown
    >;
  }

  it('persists the LIST verbatim into state.outputs (list-shaped state)', async () => {
    mockStateBackend.getState.mockResolvedValue({
      state: makeState(['ns-1.example.com', 'ns-2.example.com']),
      etag: 'etag-old',
    });

    const result = await makeEngine().deploy(stackName, template);

    // Element-wise equality, so a single-element collapse is RED.
    expect(savedOutputs()['NameServers']).toEqual(['ns-1.example.com', 'ns-2.example.com']);
    expect(result.outputs?.['NameServers']).toEqual(['ns-1.example.com', 'ns-2.example.com']);
  });

  it('persists a LIST for a LEGACY comma-delimited state value, not the string', async () => {
    // The v1 state shape (pre-#1868): a comma-joined string. The read-boundary
    // normalization must turn it into N elements before it lands in outputs.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState('ns-1.example.com,ns-2.example.com'),
      etag: 'etag-old',
    });

    await makeEngine().deploy(stackName, template);

    const persisted = savedOutputs()['NameServers'];
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted).toEqual(['ns-1.example.com', 'ns-2.example.com']);
  });

  it('persists an EMPTY list for an empty legacy value', async () => {
    mockStateBackend.getState.mockResolvedValue({
      state: makeState(''),
      etag: 'etag-old',
    });

    await makeEngine().deploy(stackName, template);

    expect(savedOutputs()['NameServers']).toEqual([]);
  });
});
