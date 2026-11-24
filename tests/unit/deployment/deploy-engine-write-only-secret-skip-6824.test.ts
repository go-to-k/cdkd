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
  if (typeof value === 'string' && value.includes(TOKEN)) {
    if (ctx.recordedSecretValues !== undefined) {
      ctx.recordedSecretValues.set(PLAIN, TOKEN);
      recordReferenceResolution(ctx.recordedSecretValues, TOKEN, {
        region: REGION,
        version: served.version,
        route: 'literal',
      });
    }
    return value.split(TOKEN).join(PLAIN);
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
  IntrinsicFunctionResolver: vi.fn(() => ({
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
      create: vi.fn().mockResolvedValue({ physicalId: 'created-1', attributes: {} }),
      update: vi.fn().mockImplementation((logicalId: string, physicalId: string) => {
        order.push(`update:${logicalId}`);
        return Promise.resolve({ physicalId, wasReplaced: false });
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      // The live model: what the unsettled convergence reads before the update.
      readCurrentState: vi
        .fn()
        .mockResolvedValue({ EndpointType: 'source', Tags: TAGS_A }),
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

  interface DeployOptions {
    /** The template's Password spelling (default: the bare reference). */
    password?: string;
    /** The ETag the state read returns (`null`: none). */
    etag?: string | null;
    /** Extra template resources and their changes. */
    extra?: Array<{ id: string; type: string; change: 'CREATE' | 'UPDATE'; record?: ResourceState }>;
    /** Reuse this engine (a second deploy on the same instance). */
    engine?: DeployEngine;
  }

  /** A Tags-only deploy over `record`; returns the context the FIRST update of P got and every save. */
  async function tagsOnlyDeploy(
    record: ResourceState,
    options: DeployOptions = {}
  ): Promise<{
    context: { unchangedWriteOnlySecretProperties?: ReadonlySet<string> } | undefined;
    saves: StackState[];
    thrown: unknown;
    engine: DeployEngine;
  }> {
    const desired = { EndpointType: 'source', Password: options.password ?? TOKEN, Tags: TAGS_B };
    const template: CloudFormationTemplate = {
      Resources: {
        P: { Type: TYPE, Properties: desired },
        ...Object.fromEntries(
          (options.extra ?? []).map((e) => [e.id, { Type: e.type, Properties: { N: 'new' } }])
        ),
      },
    };
    const prior: StackState = {
      version: 17,
      region: REGION,
      stackName,
      resources: {
        P: structuredClone(record),
        ...Object.fromEntries(
          (options.extra ?? []).flatMap((e) => (e.record ? [[e.id, structuredClone(e.record)]] : []))
        ),
      },
      outputs: {},
      lastModified: 1,
    };
    mockStateBackend.getState!.mockResolvedValue({
      state: prior,
      etag: options.etag === null ? undefined : (options.etag ?? 'etag-1'),
    });
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
        ...(options.extra ?? []).map(
          (e) =>
            [
              e.id,
              {
                logicalId: e.id,
                changeType: e.change,
                resourceType: e.type,
                desiredProperties: { N: 'new' },
                ...(e.record && { currentProperties: e.record.properties }),
              },
            ] as [string, ResourceChange]
        ),
      ])
    );
    const engine =
      options.engine ??
      new DeployEngine(
        mockStateBackend as never,
        deps['lock'] as never,
        deps['dag'] as never,
        mockDiffCalculator as never,
        deps['registry'] as never,
        { dryRun: false },
        REGION
      );
    let thrown: unknown;
    try {
      await engine.deploy(stackName, template);
    } catch (error) {
      thrown = error;
    }
    const call = mockProvider.update!.mock.calls.find((c) => c[0] === 'P');
    return {
      context: call?.[5] as never,
      saves: mockStateBackend.saveState!.mock.calls.map((c) => structuredClone(c[2] as StackState)),
      thrown,
      engine,
    };
  }

  const named = (run: { context?: { unchangedWriteOnlySecretProperties?: ReadonlySet<string> } }) =>
    run.context?.unchangedWriteOnlySecretProperties?.has('Password') === true;
  const provenanceOf = (state: StackState | undefined) =>
    state?.resources['P']?.referenceProvenance?.[TOKEN];
  const updatesOfP = () => mockProvider.update!.mock.calls.filter((c) => c[0] === 'P');
  /** A "sent" case: the update ran once, without the name. */
  const expectSent = (run: { thrown: unknown; context?: unknown }) => {
    expect(run.thrown).toBeUndefined();
    expect(updatesOfP()).toHaveLength(1);
    expect(named(run as never)).toBe(false);
  };

  it('the attested version again: Password is named, and nothing is written ahead', async () => {
    const run = await tagsOnlyDeploy(attestedRecord());
    expect(run.thrown).toBeUndefined();
    expect(updatesOfP()).toHaveLength(1);
    expect(named(run)).toBe(true);
    expect(order[0]).toBe('update:P');
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
    expectSent(run);
    expect(order.slice(0, 2)).toEqual(['save', 'update:P']);
    expect(provenanceOf(run.saves[0])).toEqual({ region: REGION });
    expect(provenanceOf(run.saves.at(-1))).toEqual({
      region: REGION,
      versions: [V2],
      versionsSent: true,
    });
  });

  it('a literal added around the reference (x{{resolve:..}}) at the same version: written ahead and sent', async () => {
    const run = await tagsOnlyDeploy(attestedRecord(), { password: `x${TOKEN}` });
    expectSent(run);
    expect(order.slice(0, 2)).toEqual(['save', 'update:P']);
    expect(provenanceOf(run.saves[0])).toEqual({ region: REGION });
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

  it('a state read with no ETag: the write-ahead refuses, so the update is never sent', async () => {
    served.version = V2;
    const run = await tagsOnlyDeploy(attestedRecord(), { etag: null });
    expect(run.thrown).toBeDefined();
    expect(mockProvider.update).not.toHaveBeenCalled();
  });

  it('the write-ahead queues behind a save in flight and takes the ETag it returned', async () => {
    served.version = V2;
    deps['dag']!.getExecutionLevels!.mockReturnValue([['A'], ['P']]);
    deps['dag']!.getDirectDependencies!.mockImplementation((_g: unknown, id: string) =>
      id === 'P' ? ['A'] : []
    );
    let firstDone = false;
    mockStateBackend.saveState!.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            firstDone = true;
            resolve('etag-A');
          }, 30)
        )
    );
    let aheadStartedAfterFirst: boolean | undefined;
    mockStateBackend.saveState!.mockImplementationOnce(() => {
      aheadStartedAfterFirst = firstDone;
      return Promise.resolve('etag-ahead');
    });
    const queue: ResourceState = {
      physicalId: 'q-1',
      resourceType: 'AWS::SQS::Queue',
      provisionedBy: 'cc-api',
      properties: { N: 'old' },
    };
    const run = await tagsOnlyDeploy(attestedRecord(), {
      extra: [{ id: 'A', type: 'AWS::SQS::Queue', change: 'UPDATE', record: queue }],
    });
    expect(run.thrown).toBeUndefined();
    const calls = mockStateBackend.saveState!.mock.calls;
    // A's completion save, then P's write-ahead, which waited for it.
    expect(provenanceOf(calls[0]![2] as StackState)).toEqual(attestedRecord().referenceProvenance![TOKEN]);
    expect(provenanceOf(calls[1]![2] as StackState)).toEqual({ region: REGION });
    expect(aheadStartedAfterFirst).toBe(true);
    expect((calls[1]![3] as { expectedEtag?: string }).expectedEtag).toBe('etag-A');
    expect((calls[2]![3] as { expectedEtag?: string }).expectedEtag).toBe('etag-ahead');
  });

  it('partial apply then stage moved back: the record the kill left names no version, so V1 is sent', async () => {
    // Deploy 1: rotated to V2, written ahead, then the update fails after
    // AWS applied it (a kill leaves exactly the write-ahead on disk).
    served.version = V2;
    mockProvider.update!.mockImplementationOnce(() => {
      order.push('update:P');
      return Promise.reject(new Error('handler failed after ModifyEndpoint'));
    });
    const first = await tagsOnlyDeploy(attestedRecord());
    expect(first.thrown).toBeDefined();
    const onDisk = first.saves[0]!.resources['P']!;
    expect(onDisk.referenceProvenance?.[TOKEN]).toEqual({ region: REGION });
    // The failure path's own save keeps the record written ahead.
    expect(provenanceOf(first.saves.at(-1))).toEqual({ region: REGION });
    // The journaled pre-op record a rollback restores keeps its version (the
    // pin) but never the attestation.
    const journaled = JSON.stringify(mockStateBackend.appendRollbackJournalSegment!.mock.calls);
    expect(journaled).toContain(V1);
    expect(journaled).not.toContain('versionsSent');
    // Deploy 2: AWSCURRENT moved back to V1, no journal (the kill wrote none).
    vi.clearAllMocks();
    served.version = V1;
    const second = await tagsOnlyDeploy(onDisk);
    expectSent(second);
  });

  it('a rollback replay of the update passes no unchangedWriteOnlySecretProperties', async () => {
    deps['dag']!.getExecutionLevels!.mockReturnValue([['P'], ['F']]);
    deps['dag']!.getDirectDependencies!.mockImplementation((_g: unknown, id: string) =>
      id === 'F' ? ['P'] : []
    );
    mockProvider.create!.mockRejectedValueOnce(new Error('queue refused'));
    const run = await tagsOnlyDeploy(attestedRecord(), {
      extra: [{ id: 'F', type: 'AWS::SQS::Queue', change: 'CREATE' }],
    });
    expect(run.thrown).toBeDefined();
    // The forward update named it; the rollback's revert of P did not.
    expect(named(run)).toBe(true);
    const calls = updatesOfP();
    expect(calls).toHaveLength(2);
    expect(
      (calls[1]![5] as { unchangedWriteOnlySecretProperties?: unknown })
        .unchangedWriteOnlySecretProperties
    ).toBeUndefined();
  });

  it('a journal segment from an earlier run: sent', async () => {
    mockStateBackend.loadRollbackJournal!.mockResolvedValue({
      journalVersion: 1,
      segments: [{ reason: 'failed', operations: [], failedOperations: [] }],
    });
    expectSent(await tagsOnlyDeploy(attestedRecord()));
  });

  it("a nested child's pending-parent segment (a killed parent rollback): sent", async () => {
    mockStateBackend.loadRollbackJournal!.mockResolvedValue({
      journalVersion: 1,
      segments: [{ reason: 'nested-pending-parent', operations: [], runId: 'r' }],
    });
    expectSent(await tagsOnlyDeploy(attestedRecord()));
  });

  it('an unreadable journal: sent', async () => {
    mockStateBackend.loadRollbackJournal!.mockRejectedValue(new Error('AccessDenied'));
    expectSent(await tagsOnlyDeploy(attestedRecord()));
  });

  it('a reused engine earns the skip again each deploy: an unreadable journal the second time sends', async () => {
    const first = await tagsOnlyDeploy(attestedRecord());
    expect(named(first)).toBe(true);
    vi.clearAllMocks();
    mockStateBackend.loadRollbackJournal!.mockRejectedValue(new Error('AccessDenied'));
    const second = await tagsOnlyDeploy(attestedRecord(), { engine: first.engine });
    expectSent(second);
  });

  it('an SDK-written record: sent', async () => {
    expectSent(await tagsOnlyDeploy(attestedRecord({ provisionedBy: 'sdk' })));
  });

  it('an SDK route: sent, and its write attests nothing (a provider may leave a reference unsent)', async () => {
    route = 'sdk';
    const run = await tagsOnlyDeploy(attestedRecord());
    expectSent(run);
    expect(provenanceOf(run.saves.at(-1))).toEqual({ region: REGION, versions: [V1] });
  });

  it('a plain singleton an older binary wrote (no attestation): sent', async () => {
    expectSent(
      await tagsOnlyDeploy(
        attestedRecord({ referenceProvenance: { [TOKEN]: { region: REGION, versions: [V1] } } })
      )
    );
  });

  it('a v11 record (no provenance field): the first deploy sends, and its write attests', async () => {
    const { referenceProvenance: _none, ...v11 } = attestedRecord();
    const run = await tagsOnlyDeploy(v11);
    expectSent(run);
    expect(provenanceOf(run.saves.at(-1))).toEqual({
      region: REGION,
      versions: [V1],
      versionsSent: true,
    });
  });

  it('the key unsettled by an earlier failed update: sent', async () => {
    const run = await tagsOnlyDeploy(attestedRecord({ unsettledProperties: ['Password'] }));
    expectSent(run);
    expect(
      (run.context as { unsettledProperties?: ReadonlySet<string> }).unsettledProperties?.has(
        'Password'
      )
    ).toBe(true);
  });
});
