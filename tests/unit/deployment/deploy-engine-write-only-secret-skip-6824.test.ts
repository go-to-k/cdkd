import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { recordReferenceResolution } from '../../../src/deployment/secret-redaction/reference-provenance.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/**
 * go-to-k/cdkd#6824, the engine wiring: the deploy's in-place UPDATE names an
 * unchanged write-only secret reference in
 * `UpdateContext.unchangedWriteOnlySecretProperties` only at the version the
 * record attests was last sent, writes the record ahead (without that
 * version) before an update sends another one, and never sends when that
 * write-ahead fails. The pure decision: `write-only-secret-skip-6824.test.ts`.
 */
const TOKEN = '{{resolve:secretsmanager:db-secret:SecretString:password::}}';
const PLAIN = 'resolved-password-value';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const V2 = 'b1b2c3d4-0000-1111-2222-333333333333';
const TYPE = 'AWS::DMS::Endpoint';
const REGION = 'us-east-1';

/** The version the mock resolver serves for TOKEN in the next deploy. */
const served = vi.hoisted(() => ({ version: '' }));

function resolveWithSecrets(
  value: unknown,
  ctx: { recordedSecretValues?: Map<string, string> }
): unknown {
  if (value === TOKEN) {
    if (ctx.recordedSecretValues !== undefined) {
      ctx.recordedSecretValues.set(PLAIN, TOKEN);
      recordReferenceResolution(ctx.recordedSecretValues, TOKEN, {
        region: REGION,
        version: served.version,
        route: 'literal',
      });
    }
    return PLAIN;
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
vi.mock('../../../src/deployment/intrinsic-resolver/dynamic-refs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/intrinsic-resolver/dynamic-refs.js')>()),
  resolveDynamicReferences: vi.fn(
    (resolver: { resolveDynamicReferences: (...args: unknown[]) => unknown }, ...rest: unknown[]) =>
      resolver.resolveDynamicReferences(...rest)
  ),
}));

// The deploy-start DescribeType prefetch settles in a real deploy; here the
// type's create-only paths are known and hold no password, so the written
// record's token takes this pass's entry (an unknown set unions every token,
// which attests nothing).
vi.mock('../../../src/provisioning/create-only-properties.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/create-only-properties.js')>()),
  cachedCreateOnlyPropertyPaths: vi.fn(() => Promise.resolve([['EndpointIdentifier']])),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

const TAGS_A = [{ Key: 'k', Value: 'a' }];
const TAGS_B = [{ Key: 'k', Value: 'b' }];

const attestedRecord = (overrides: Partial<ResourceState> = {}): ResourceState => ({
  physicalId: 'endpoint-1',
  resourceType: TYPE,
  provisionedBy: 'cc-api',
  properties: { EndpointType: 'source', Password: TOKEN, Tags: TAGS_A },
  referenceProvenance: { [TOKEN]: { region: REGION, versions: [V1], versionsSent: true } },
  ...overrides,
});

describe('DeployEngine: an unchanged write-only secret reference (go-to-k/cdkd#6824)', () => {
  const stackName = 'write-only-secret';
  let order: string[];
  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;
  let deps: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
  let route: 'sdk' | 'cc-api';

  beforeEach(() => {
    vi.clearAllMocks();
    order = [];
    route = 'cc-api';
    served.version = V1;
    mockProvider = {
      create: vi.fn().mockResolvedValue({ physicalId: 'endpoint-1', attributes: {} }),
      update: vi.fn().mockImplementation(() => {
        order.push('update');
        return Promise.resolve({ physicalId: 'endpoint-1', wasReplaced: false });
      }),
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
      saveState: vi.fn().mockImplementation(() => {
        order.push('save');
        return Promise.resolve('etag-new');
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
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
        getProviderFor: vi
          .fn()
          .mockImplementation(() => ({ provider: mockProvider, provisionedBy: route })),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        getAllowedUnsupportedProperties: vi.fn().mockReturnValue(new Set<string>()),
        getCloudControlProvider: vi.fn().mockReturnValue(mockProvider),
      },
    };
  });

  /** A Tags-only deploy over `record`; returns the context update() got and every save. */
  async function tagsOnlyDeploy(record: ResourceState): Promise<{
    context: { unchangedWriteOnlySecretProperties?: ReadonlySet<string> } | undefined;
    saves: StackState[];
    thrown: unknown;
  }> {
    const desired = { EndpointType: 'source', Password: TOKEN, Tags: TAGS_B };
    const template: CloudFormationTemplate = {
      Resources: { P: { Type: TYPE, Properties: desired } },
    };
    const prior: StackState = {
      version: 17,
      region: REGION,
      stackName,
      resources: { P: structuredClone(record) },
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
            resourceType: TYPE,
            desiredProperties: desired,
            currentProperties: record.properties,
          },
        ],
      ])
    );
    let thrown: unknown;
    try {
      await new DeployEngine(
        mockStateBackend as never,
        deps['lock'] as never,
        deps['dag'] as never,
        mockDiffCalculator as never,
        deps['registry'] as never,
        { dryRun: false },
        REGION
      ).deploy(stackName, template);
    } catch (error) {
      thrown = error;
    }
    const call = mockProvider.update!.mock.calls[0];
    return {
      context: call?.[5] as never,
      saves: mockStateBackend.saveState!.mock.calls.map((c) => structuredClone(c[2] as StackState)),
      thrown,
    };
  }

  const named = (run: { context?: { unchangedWriteOnlySecretProperties?: ReadonlySet<string> } }) =>
    run.context?.unchangedWriteOnlySecretProperties?.has('Password') === true;
  const provenanceOf = (state: StackState | undefined) =>
    state?.resources['P']?.referenceProvenance?.[TOKEN];

  it('the attested version again: Password is named, and nothing is written ahead', async () => {
    const run = await tagsOnlyDeploy(attestedRecord());
    expect(run.thrown).toBeUndefined();
    expect(named(run)).toBe(true);
    expect(order[0]).toBe('update');
    // The written record attests the version this deploy resolved (and left unsent).
    expect(provenanceOf(run.saves.at(-1))).toEqual({
      region: REGION,
      versions: [V1],
      versionsSent: true,
    });
  });

  it('a rotated version: sent, and the record is saved without a version BEFORE the update', async () => {
    served.version = V2;
    const run = await tagsOnlyDeploy(attestedRecord());
    expect(run.thrown).toBeUndefined();
    expect(named(run)).toBe(false);
    expect(order.slice(0, 2)).toEqual(['save', 'update']);
    expect(provenanceOf(run.saves[0])).toEqual({ region: REGION });
    expect(provenanceOf(run.saves.at(-1))).toEqual({
      region: REGION,
      versions: [V2],
      versionsSent: true,
    });
  });

  it('a failed write-ahead save: the update is never sent', async () => {
    served.version = V2;
    mockStateBackend.saveState!.mockImplementationOnce(() => {
      order.push('save');
      return Promise.reject(new Error('PreconditionFailed'));
    });
    const run = await tagsOnlyDeploy(attestedRecord());
    expect(run.thrown).toBeDefined();
    expect(mockProvider.update).not.toHaveBeenCalled();
  });

  it('partial apply then stage moved back: the record the kill left names no version, so V1 is sent', async () => {
    // Deploy 1: rotated to V2, written ahead, then the update fails after
    // AWS applied it (a kill leaves exactly the write-ahead on disk).
    served.version = V2;
    mockProvider.update!.mockImplementationOnce(() => {
      order.push('update');
      return Promise.reject(new Error('handler failed after ModifyEndpoint'));
    });
    const first = await tagsOnlyDeploy(attestedRecord());
    expect(first.thrown).toBeDefined();
    const onDisk = first.saves[0]!.resources['P']!;
    expect(onDisk.referenceProvenance?.[TOKEN]).toEqual({ region: REGION });
    // The journaled pre-op record a rollback restores keeps its version (the
    // pin) but never the attestation.
    const journaled = JSON.stringify(mockStateBackend.appendRollbackJournalSegment!.mock.calls);
    expect(journaled).toContain(V1);
    expect(journaled).not.toContain('versionsSent');
    // Deploy 2: AWSCURRENT moved back to V1, no journal (the kill wrote none).
    vi.clearAllMocks();
    served.version = V1;
    const second = await tagsOnlyDeploy(onDisk);
    expect(second.thrown).toBeUndefined();
    expect(mockProvider.update).toHaveBeenCalledTimes(1);
    expect(named(second)).toBe(false);
  });

  it('a journal segment from an earlier run: sent', async () => {
    mockStateBackend.loadRollbackJournal!.mockResolvedValue({
      journalVersion: 1,
      segments: [{ reason: 'failed', operations: [], failedOperations: [] }],
    });
    const run = await tagsOnlyDeploy(attestedRecord());
    expect(named(run)).toBe(false);
  });

  it('an unreadable journal: sent', async () => {
    mockStateBackend.loadRollbackJournal!.mockRejectedValue(new Error('AccessDenied'));
    const run = await tagsOnlyDeploy(attestedRecord());
    expect(named(run)).toBe(false);
  });

  it('an SDK-written record: sent', async () => {
    const run = await tagsOnlyDeploy(attestedRecord({ provisionedBy: 'sdk' }));
    expect(named(run)).toBe(false);
  });

  it('an SDK route: sent, and its write attests nothing (a provider may leave a reference unsent)', async () => {
    route = 'sdk';
    const run = await tagsOnlyDeploy(attestedRecord());
    expect(named(run)).toBe(false);
    expect(provenanceOf(run.saves.at(-1))).toEqual({ region: REGION, versions: [V1] });
  });

  it('a plain singleton an older binary wrote (no attestation): sent', async () => {
    const run = await tagsOnlyDeploy(
      attestedRecord({ referenceProvenance: { [TOKEN]: { region: REGION, versions: [V1] } } })
    );
    expect(named(run)).toBe(false);
  });

  it('a v11 record (no provenance field): the first deploy sends, and its write attests', async () => {
    const { referenceProvenance: _none, ...v11 } = attestedRecord();
    const run = await tagsOnlyDeploy(v11);
    expect(named(run)).toBe(false);
    expect(provenanceOf(run.saves.at(-1))).toEqual({
      region: REGION,
      versions: [V1],
      versionsSent: true,
    });
  });

  it('the key unsettled by an earlier failed update: sent', async () => {
    const run = await tagsOnlyDeploy(attestedRecord({ unsettledProperties: ['Password'] }));
    expect(named(run)).toBe(false);
  });
});
