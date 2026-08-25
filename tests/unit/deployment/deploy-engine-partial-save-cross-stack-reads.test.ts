import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type {
  ResourceChange,
  ResourceState,
  StackState,
  StateOutputReadEntry,
} from '../../../src/types/state.js';

/**
 * A FAILED deploy must persist the cross-stack reads it just made, and the
 * automatic rollback must see them (issue
 * [#2057](https://github.com/go-to-k/cdkd/issues/2057) review round 1).
 *
 * Every non-success save used to write `currentState.imports` /
 * `currentState.outputReads` — the PRE-deploy snapshot — beside the POST-deploy
 * `newResources`. Two things fell out of that, and this file pins both:
 *
 *  1. A rollback journal exists ONLY after a failed deploy, so on exactly the
 *     deploy that INTRODUCES a cross-region read the evidence list came back
 *     empty, `classifyReplaySecretRegion` answered `local`, and the replay
 *     re-resolved the producer's region-less expression in the consumer's
 *     region. The protection was inert where it matters.
 *  2. Independently of #2057, the persisted record denied a strong reference
 *     its own resources were built from — which is what
 *     `findActiveImportConsumers` scans before letting a producer be destroyed.
 *
 * The harness mirrors `deploy-engine-rollback-journal.test.ts`, with one
 * addition: the mocked resolver PUSHES into `context.recordedOutputReads`,
 * which is the same array instance the engine hands it, so this session's
 * records are populated exactly as production populates them.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

const PRODUCER_REGION = 'us-west-2';
const STACK_REGION = 'us-east-1';
/** The producer's region-less spelling, as #1934 records it downstream. */
const SECRET_EXPR = '{{resolve:secretsmanager:db-pw:SecretString:pw}}';
/** What a LOCAL re-resolution would produce — the wrong-region write. */
const LOCALLY_RESOLVED = 'RESOLVED-IN-THE-CONSUMER-REGION';
const OUTPUT_BOOM = 'BOOM-UNRESOLVABLE-OUTPUT';

const recordOutputRead = vi.hoisted(() => ({ enabled: true }));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown, context?: unknown) => {
      // The engine passes its OWN `recordedOutputReads` array by reference, so
      // pushing here is how a real `Fn::GetStackOutput` resolution records the
      // producer region it read from.
      const reads = (context as { recordedOutputReads?: StateOutputReadEntry[] } | undefined)
        ?.recordedOutputReads;
      if (recordOutputRead.enabled && reads && reads.length === 0) {
        reads.push({
          sourceStack: 'Producer',
          sourceRegion: PRODUCER_REGION,
          outputName: 'SharedSecret',
        });
      }
      // The sentinel an Outputs section uses to make `resolveOutputs` throw
      // under `--strict-getatt`, which is the ONLY way to reach
      // `persistStateAfterOutputFailure`.
      if (props === OUTPUT_BOOM) return Promise.reject(new Error('output resolution exploded'));
      return Promise.resolve(props);
    }),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    // Reached through `ReplayResolvers` on the rollback replay. Returning a
    // marker rather than the input is what makes a wrong-region resolution
    // VISIBLE in the provider call below.
    resolveDynamicReferences: vi.fn().mockResolvedValue(LOCALLY_RESOLVED),
  })),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const stackName = 'partial-save-test';

function makeCreate(logicalId: string): ResourceChange {
  return {
    logicalId,
    changeType: 'CREATE',
    resourceType: 'AWS::S3::Bucket',
    desiredProperties: {},
    propertyChanges: [],
  } as unknown as ResourceChange;
}

/** A real in-place UPDATE: the engine skips a change with no property delta. */
function makeUpdate(logicalId: string): ResourceChange {
  return {
    logicalId,
    changeType: 'UPDATE',
    resourceType: 'AWS::S3::Bucket',
    currentProperties: { Secret: SECRET_EXPR, Mode: 'a' },
    desiredProperties: { Secret: SECRET_EXPR, Mode: 'b' },
    propertyChanges: [{ path: 'Mode', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
  } as unknown as ResourceChange;
}

const PRE_EXISTING_IMPORT = {
  sourceStack: 'OtherProducer',
  sourceRegion: STACK_REGION,
  exportName: 'AlreadyOnRecord',
};

function buildEngine(
  overrides: { imports?: StackState['imports']; exportNames?: string[]; fresh?: boolean } = {}
) {
  const provider = {
    create: vi
      .fn()
      .mockImplementation((logicalId: string) =>
        logicalId === 'B'
          ? Promise.reject(new Error(`create failed: ${logicalId}`))
          : Promise.resolve({ physicalId: `phys-${logicalId}`, attributes: {} })
      ),
    update: vi.fn().mockResolvedValue({ physicalId: 'phys-A', wasReplaced: false }),
    delete: vi.fn().mockResolvedValue(undefined),
  };

  const currentState: StackState = {
    version: 8,
    stackName,
    region: STACK_REGION,
    resources: {
      A: {
        physicalId: 'phys-A',
        resourceType: 'AWS::S3::Bucket',
        // The redacted producer expression, region-less by construction.
        properties: { Secret: SECRET_EXPR, Mode: 'a' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    ...(overrides.exportNames !== undefined && { exportNames: overrides.exportNames }),
    imports: overrides.imports ?? [PRE_EXISTING_IMPORT],
    lastModified: Date.now(),
  };

  const saveState = vi.fn().mockResolvedValue('etag-1');
  const mockStateBackend = {
    // `fresh`: no record exists yet — the engine builds its in-memory
    // placeholder and the first save is unconditional (no ETag).
    getState: vi
      .fn()
      .mockResolvedValue(overrides.fresh ? null : { state: currentState, etag: 'e0' }),
    saveState,
    appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
  };

  const changes = new Map([
    ['A', makeUpdate('A')],
    ['B', makeCreate('B')],
  ]);

  const engine = new DeployEngine(
    mockStateBackend as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['A', 'B']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((c: Map<string, ResourceChange>, type: string) =>
          [...c.values()].filter((x) => x.changeType === type)
        ),
    } as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { concurrency: 4, roleArn: 'arn:aws:iam::1:role/r' },
    STACK_REGION
  );
  return { engine, provider, saveState };
}

const template: CloudFormationTemplate = {
  Resources: {
    A: { Type: 'AWS::S3::Bucket', Properties: {} },
    B: { Type: 'AWS::S3::Bucket', Properties: {} },
  },
};

function savedStates(saveState: ReturnType<typeof vi.fn>): StackState[] {
  return saveState.mock.calls.map((c) => c[2] as StackState);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordOutputRead.enabled = true;
});

describe('a failed deploy persists the cross-stack reads it just made (issue #2057)', () => {
  it('unions this session records with the pre-deploy snapshot on every failure-path save', async () => {
    const { engine, saveState } = buildEngine();
    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    const states = savedStates(saveState);
    expect(states.length).toBeGreaterThan(0);
    // EVERY save this failed deploy made must carry both sides of the union:
    // the pre-deploy import (dropping it would strip a live strong reference)
    // AND this session's outputRead (omitting it is the #2057 blocker, and the
    // strong-ref hole that `findActiveImportConsumers` inherits).
    for (const state of states) {
      expect(state.imports).toEqual([PRE_EXISTING_IMPORT]);
      expect(state.outputReads).toEqual([
        { sourceStack: 'Producer', sourceRegion: PRODUCER_REGION, outputName: 'SharedSecret' },
      ]);
    }
  });

  it('does not invent records when the session resolved nothing', async () => {
    recordOutputRead.enabled = false;
    const { engine, saveState } = buildEngine();
    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    for (const state of savedStates(saveState)) {
      expect(state.imports).toEqual([PRE_EXISTING_IMPORT]);
      // Absent, not an empty array — an omitted field and `[]` are different
      // records, and every one of these save sites omitted before.
      expect(state.outputReads).toBeUndefined();
    }
  });
});

describe('a failed deploy carries the export set with the bag it keeps (issue #2193)', () => {
  it('keeps a KNOWN set on every failure-path save', async () => {
    const { engine, saveState } = buildEngine({ exportNames: ['Kept'] });
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    const saves = savedStates(saveState);
    expect(saves.length).toBeGreaterThan(0);
    for (const s of saves) expect(s.exportNames).toEqual(['Kept']);
  });

  it('a FIRST deploy that fails persists a KNOWN-empty set, not "not known"', async () => {
    // No record existed, so the bag the failure-path save carries is the
    // engine's own empty placeholder — it exports nothing, and that is known.
    const { engine, saveState } = buildEngine({ fresh: true });
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    const saves = savedStates(saveState);
    expect(saves.length).toBeGreaterThan(0);
    for (const s of saves) expect(s.exportNames).toEqual([]);
  });

  it('does NOT invent a set for a pre-v9 record — absent stays absent, never `[]`', async () => {
    // `[]` would read as "exports nothing" and deny every consumer of this
    // producer after one failed deploy; absent keeps the legacy rule.
    const { engine, saveState } = buildEngine();
    await expect(engine.deploy(stackName, template)).rejects.toThrow();
    const saves = savedStates(saveState);
    expect(saves.length).toBeGreaterThan(0);
    for (const s of saves) expect('exportNames' in s).toBe(false);
  });
});

describe('a hand-edited state cannot break the save (issue #2057 fix-delta nit)', () => {
  it('drops a null element in persisted imports instead of throwing on it', async () => {
    // `parseState` CASTS the persisted JSON, it does not validate the element
    // shape, so the dedup key's property reads are the first thing to touch a
    // hand-edited `state.imports`. Pre-filter, a `null` element threw a
    // TypeError where the old code copied the array verbatim — and every union
    // site sits in a try/catch that only warns, so the visible symptom was a
    // silently SKIPPED save of a strong-reference record.
    const { engine, saveState } = buildEngine({
      // Deliberately malformed, the way a manual edit leaves it.
      imports: [null, PRE_EXISTING_IMPORT, 'nonsense'] as unknown as StackState['imports'],
    });
    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    const states = savedStates(saveState);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.imports).toEqual([PRE_EXISTING_IMPORT]);
    }
  });
});

describe('the automatic rollback sees this session cross-region read (issue #2057)', () => {
  it('REFUSES to re-resolve the region-less expression locally', async () => {
    const { engine, provider } = buildEngine();
    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    // One update: the forward UPDATE of A. The rollback's revert would be a
    // SECOND call, and its desired bag would carry the locally-resolved
    // marker — the wrong-region write this refusal exists to prevent.
    expect(provider.update).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(provider.update.mock.calls)).not.toContain(LOCALLY_RESOLVED);
  });

  it('reverts normally when NO foreign producer region was read (opposite polarity)', async () => {
    // Same failing deploy, no cross-region read on record — so the verdict is
    // `local` and the replay resolves, proving the refusal is not always-on.
    recordOutputRead.enabled = false;
    const { engine, provider } = buildEngine();
    await expect(engine.deploy(stackName, template)).rejects.toThrow();

    expect(provider.update).toHaveBeenCalledTimes(2);
    const revertProps = provider.update.mock.calls[1]![3] as Record<string, unknown>;
    expect(revertProps['Secret']).toBe(LOCALLY_RESOLVED);
  });
});

/**
 * A deploy whose RESOURCES all succeed and whose OUTPUT resolution throws —
 * the only route to `persistStateAfterOutputFailure`, which needs
 * `--strict-getatt` to promote the failure instead of warn-and-skip.
 *
 * `recordedOutputReads` is deliberately EMPTY here (`recordOutputRead.enabled`
 * off): this models the deploy that no longer re-resolves a cross-stack read —
 * the reference moved, or the resource holding it had no diff this run — while
 * the previous record still carries both the producer region AND a
 * `properties.Value` holding the producer's region-less spelling.
 */
function buildOutputFailureEngine() {
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'phys-new', attributes: {} }),
    update: vi.fn().mockResolvedValue({ physicalId: 'phys-A', wasReplaced: false }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const currentState: StackState = {
    version: 8,
    stackName,
    region: STACK_REGION,
    resources: {
      A: {
        physicalId: 'phys-A',
        resourceType: 'AWS::S3::Bucket',
        properties: { Secret: SECRET_EXPR, Mode: 'a' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: {},
    imports: [PRE_EXISTING_IMPORT],
    // Recorded by an EARLIER deploy. This run records nothing.
    outputReads: [
      { sourceStack: 'Producer', sourceRegion: PRODUCER_REGION, outputName: 'SharedSecret' },
    ],
    lastModified: Date.now(),
  };
  const saveState = vi.fn().mockResolvedValue('etag-1');
  const appendRollbackJournalSegment = vi.fn().mockResolvedValue(undefined);
  const changes = new Map([['A', makeUpdate('A')]]);
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state: currentState, etag: 'e0' }),
      saveState,
      appendRollbackJournalSegment,
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    } as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['A']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(changes),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((c: Map<string, ResourceChange>, type: string) =>
          [...c.values()].filter((x) => x.changeType === type)
        ),
    } as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { concurrency: 4, strictGetAtt: true },
    STACK_REGION
  );
  return { engine, provider, saveState, appendRollbackJournalSegment };
}

const templateWithBoomOutput: CloudFormationTemplate = {
  Resources: { A: { Type: 'AWS::S3::Bucket', Properties: { Secret: SECRET_EXPR, Mode: 'b' } } },
  Outputs: { Boom: { Value: OUTPUT_BOOM } },
} as unknown as CloudFormationTemplate;

describe('persistStateAfterOutputFailure keeps the snapshot too (issue #2057 fix-delta)', () => {
  it('preserves a producer region THIS run did not re-resolve', async () => {
    // The site used to write `[...this.recordedOutputReads]` WHOLESALE, copying
    // the success path's shape onto a path that writes a rollback journal
    // segment and rethrows. With nothing recorded this run, the field was
    // omitted and the producer region the previous record carried was erased —
    // from under a `properties.Value` that still holds the producer's
    // region-less spelling. `cdkd rollback` then replayed it with an empty
    // evidence list and resolved it in the consumer's region.
    recordOutputRead.enabled = false;
    const { engine, saveState, appendRollbackJournalSegment } = buildOutputFailureEngine();

    await expect(engine.deploy(stackName, templateWithBoomOutput)).rejects.toThrow(
      /output resolution|Failed to resolve output/
    );

    // This IS the rollback-reachable path: a journal segment is written and the
    // error rethrown, so `cdkd rollback` loads exactly the record saved below.
    expect(appendRollbackJournalSegment).toHaveBeenCalled();

    const states = savedStates(saveState);
    expect(states.length).toBeGreaterThan(0);
    // The LAST save is `persistStateAfterOutputFailure`'s. Asserting on it
    // specifically is what isolates this site: the per-resource save before it
    // wrote `currentState.outputReads` even pre-fix, so a whole-run assertion
    // would pass with the bug still in place.
    const last = states[states.length - 1]!;
    expect(last.outputReads).toEqual([
      { sourceStack: 'Producer', sourceRegion: PRODUCER_REGION, outputName: 'SharedSecret' },
    ]);
    expect(last.imports).toEqual([PRE_EXISTING_IMPORT]);
  });

  it('still records what this run DID resolve, alongside the snapshot', async () => {
    recordOutputRead.enabled = true;
    const { engine, saveState } = buildOutputFailureEngine();

    await expect(engine.deploy(stackName, templateWithBoomOutput)).rejects.toThrow();

    const states = savedStates(saveState);
    const last = states[states.length - 1]!;
    // Same single entry — the union deduplicates rather than doubling it.
    expect(last.outputReads).toEqual([
      { sourceStack: 'Producer', sourceRegion: PRODUCER_REGION, outputName: 'SharedSecret' },
    ]);
  });
});
