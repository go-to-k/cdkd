import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { skippedOutputDigest } from '../../../src/analyzer/skipped-outputs.js';

// Logger silenced (the no-change path may emit a warn we don't want in output).
// Shared spies, so a case can assert what the engine WARNED (issue #2771's
// keep-whole warnings name their reason).
const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

// The resolver resolves every value to itself — so resolveOutputs() maps each
// Output.Value (a literal in these fixtures) straight through, and an
// Export.Name string is stored under both the output key and the export name.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * Issue #875: an Outputs-only change (a new Export added because a downstream
 * stack now references this one, with NO resource diff) must still be
 * persisted on the no-change deploy path. Otherwise the new export is never
 * written to state / the exports index and the consumer's subsequent
 * Fn::ImportValue resolution fails.
 */
describe('DeployEngine - Outputs-only change on a no-resource-diff deploy (#875)', () => {
  const stackName = 'producer-stack';

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
      // Single NO_CHANGE resource → hasChanges=false.
      calculateDiff: vi.fn().mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'BucketA',
            { logicalId: 'BucketA', changeType: 'NO_CHANGE', resourceType: 'AWS::S3::Bucket' },
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
   * `observedProperties` already present on every resource → the auto-refresh
   * path stays dormant, isolating the Outputs-only persistence under test.
   */
  function makeState(outputs: Record<string, string>, exportNames?: string[]): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        BucketA: {
          physicalId: 'phys-bucket-a',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'bucket-a' },
          observedProperties: { BucketName: 'bucket-a' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs,
      // Omitted = a pre-v9 record (issue #2193), which the no-change path now
      // BACKFILLS with a save; the "no save" cases below therefore hand in a
      // record that already carries its set.
      ...(exportNames !== undefined && { exportNames }),
      lastModified: 0,
    };
  }

  function makeEngine(opts: { dryRun?: boolean } = {}) {
    return new DeployEngine(
      mockStateBackend as never,
      mockLockManager as never,
      mockDagBuilder as never,
      mockDiffCalculator as never,
      mockProviderRegistry as never,
      { dryRun: opts.dryRun ?? false },
      'us-east-1',
      mockExportIndexStore as never
    );
  }

  it('persists a newly-added Export and updates the exports index (no resource diff)', async () => {
    // State has no outputs yet; the template now declares an Output with an
    // Export — the classic "downstream stack started referencing me" case.
    mockStateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: {
        BucketArn: { Value: 'arn:aws:s3:::bucket-a', Export: { Name: 'producer:BucketArn' } },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(1);

    // State persisted once, carrying both the output key and the export-name key.
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs).toEqual({
      BucketArn: 'arn:aws:s3:::bucket-a',
      'producer:BucketArn': 'arn:aws:s3:::bucket-a',
    });

    // The bag records which of its keys are exports (issue #2193) ...
    expect(saved.exportNames).toEqual(['producer:BucketArn']);
    // ... and the exports index is fed ONLY those, so a consumer's
    // Fn::ImportValue resolves O(1) against the export and cannot bind to the
    // plain `BucketArn` output name.
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledTimes(1);
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {
      'producer:BucketArn': 'arn:aws:s3:::bucket-a',
    });

    // The returned display outputs reflect the freshly-resolved value.
    expect(result.outputs).toEqual({ BucketArn: 'arn:aws:s3:::bucket-a' });
  });

  it('does NOT save or touch the index when outputs are unchanged', async () => {
    // State already carries exactly what the template resolves to, export set
    // included.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState(
        {
          BucketArn: 'arn:aws:s3:::bucket-a',
          'producer:BucketArn': 'arn:aws:s3:::bucket-a',
        },
        ['producer:BucketArn']
      ),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: {
        BucketArn: { Value: 'arn:aws:s3:::bucket-a', Export: { Name: 'producer:BucketArn' } },
      },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    expect(mockExportIndexStore.updateForStack).not.toHaveBeenCalled();
  });

  it('persists removal of an Output and drops it from the exports index', async () => {
    // State has an export; the template no longer declares any Outputs.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState({
        BucketArn: 'arn:aws:s3:::bucket-a',
        'producer:BucketArn': 'arn:aws:s3:::bucket-a',
      }),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      // Outputs removed.
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs).toEqual({});
    // updateForStack with {} drops the stack's stale entries (it loads the
    // index and removes them — the empty-outputs case the store documents).
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith(
      'producer-stack',
      'us-east-1',
      {}
    );
  });

  it('does nothing under --dry-run even when outputs differ', async () => {
    mockStateBackend.getState.mockResolvedValue({ state: makeState({}), etag: 'etag-old' });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: {
        BucketArn: { Value: 'arn:aws:s3:::bucket-a', Export: { Name: 'producer:BucketArn' } },
      },
    };

    const engine = makeEngine({ dryRun: true });
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    expect(mockExportIndexStore.updateForStack).not.toHaveBeenCalled();
  });

  it('preserves imports[] / outputReads[] when persisting an Outputs-only change', async () => {
    const base = makeState({});
    base.imports = [
      { sourceStack: 'upstream', sourceRegion: 'us-east-1', exportName: 'upstream:Thing' },
    ];
    base.outputReads = [
      { sourceStack: 'upstream', sourceRegion: 'us-east-1', outputName: 'ReadThing' },
    ];
    mockStateBackend.getState.mockResolvedValue({ state: base, etag: 'etag-old' });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: {
        BucketArn: { Value: 'arn:aws:s3:::bucket-a', Export: { Name: 'producer:BucketArn' } },
      },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.imports).toEqual([
      { sourceStack: 'upstream', sourceRegion: 'us-east-1', exportName: 'upstream:Thing' },
    ]);
    expect(saved.outputReads).toEqual([
      { sourceStack: 'upstream', sourceRegion: 'us-east-1', outputName: 'ReadThing' },
    ]);
  });

  it('carries BOTH a refreshed observedProperties baseline AND the new outputs in one save', async () => {
    // The novel thing this path does: merge the pre-existing observed-properties
    // auto-refresh (a resource lacking observedProperties triggers a
    // readCurrentState capture that the no-change path drains) with the new
    // Outputs-only persistence into a SINGLE saveState. Build a state whose
    // resource has NO observedProperties so the auto-refresh fires, AND a
    // template that adds an export, and assert one save carries both.
    const noObsState: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: 'us-east-1',
      stackName,
      resources: {
        BucketA: {
          physicalId: 'phys-bucket-a',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'bucket-a' },
          // observedProperties intentionally absent → auto-refresh kicks off.
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    };
    mockStateBackend.getState.mockResolvedValue({ state: noObsState, etag: 'etag-old' });
    mockProvider.readCurrentState.mockResolvedValue({ BucketName: 'bucket-a', refreshed: true });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: {
        BucketArn: { Value: 'arn:aws:s3:::bucket-a', Export: { Name: 'producer:BucketArn' } },
      },
    };

    const engine = makeEngine();
    const result = await engine.deploy(stackName, template);

    expect(mockProvider.readCurrentState).toHaveBeenCalledTimes(1);
    // Exactly one save carrying BOTH the refreshed observedProperties AND the
    // newly-resolved outputs (not one or the other).
    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.resources['BucketA']!.observedProperties).toEqual({
      BucketName: 'bucket-a',
      refreshed: true,
    });
    expect(saved.outputs).toEqual({
      BucketArn: 'arn:aws:s3:::bucket-a',
      'producer:BucketArn': 'arn:aws:s3:::bucket-a',
    });
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledTimes(1);
    expect(result.outputs).toEqual({ BucketArn: 'arn:aws:s3:::bucket-a' });
  });

  it('REMOVES a stored output the template no longer declares even when another output cannot be resolved, and republishes the index (#2771 rule 3)', async () => {
    // resolveOutputs stores `undefined` for any output it could not resolve
    // (e.g. a Fn::If → AWS::NoValue). Before issue #2771 that kept the whole
    // previous bag, so `Existing` — declared by no template any more — stayed
    // in state for as long as the other output kept failing, and the diff
    // showed its REMOVE forever. The partial persist drops it, exactly as the
    // changed-resources path does. The #2740 record is written in the same
    // save.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState({ Existing: 'keep-me' }, []),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      // An Output whose Value resolves to undefined (resolver returns it as-is).
      Outputs: {
        Unresolvable: { Value: undefined as unknown as string },
      },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs).toEqual({});
    expect(saved.skippedOutputs).toEqual({
      // From a FRESH copy: the digest must equal what a re-parse produces.
      Unresolvable: skippedOutputDigest(structuredClone(template), 'Unresolvable'),
    });
    expect(saved.exportNames).toEqual([]);
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledTimes(1);
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {});
  });

  describe('a resolvable Output beside one that keeps failing (issue #2771)', () => {
    const resources: CloudFormationTemplate['Resources'] = {
      BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } },
    };

    it('persists the NEW resolvable output, keeps the failed one absent, and still writes the #2740 record', async () => {
      // The issue's own shape: `NeverResolves` never landed in state, and
      // `Plain2` is added beside it. Pre-fix nothing was persisted, so
      // `cdkd diff --fail` showed `[+] Plain2` on every run.
      mockStateBackend.getState.mockResolvedValue({
        state: makeState({ Plain: 'p' }, []),
        etag: 'etag-old',
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          NeverResolves: { Value: undefined as unknown as string },
          Plain: { Value: 'p' },
          Plain2: { Value: 'x' },
        },
      };

      await makeEngine().deploy(stackName, template);

      expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual({ Plain: 'p', Plain2: 'x' });
      expect(Object.prototype.hasOwnProperty.call(saved.outputs, 'NeverResolves')).toBe(false);
      expect(saved.skippedOutputs).toEqual({
        NeverResolves: skippedOutputDigest(structuredClone(template), 'NeverResolves'),
      });
      expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {});
    });

    it('a STILL-DECLARED failing output keeps its stored value while a sibling change lands (the #875 guard, re-pinned)', async () => {
      mockStateBackend.getState.mockResolvedValue({
        state: makeState({ Existing: 'keep-me', Other: 'old' }, []),
        etag: 'etag-old',
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          Existing: { Value: undefined as unknown as string },
          Other: { Value: 'new' },
        },
      };

      await makeEngine().deploy(stackName, template);

      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      // Never overwritten with nothing, never dropped...
      expect(saved.outputs).toEqual({ Existing: 'keep-me', Other: 'new' });
      // ...and still recorded as skipped, because this deploy did skip it.
      expect(Object.keys(saved.skippedOutputs ?? {})).toEqual(['Existing']);
    });

    it('carries a failed output\x27s LITERAL export alias and its export membership, so the index keeps serving it', async () => {
      mockStateBackend.getState.mockResolvedValue({
        state: makeState({ Api: 'api-v1', 'producer:Api': 'api-v1' }, ['producer:Api']),
        etag: 'etag-old',
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          Api: { Value: undefined as unknown as string, Export: { Name: 'producer:Api' } },
          Added: { Value: 'added', Export: { Name: 'producer:Added' } },
        },
      };

      await makeEngine().deploy(stackName, template);

      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual({
        Api: 'api-v1',
        'producer:Api': 'api-v1',
        Added: 'added',
        'producer:Added': 'added',
      });
      expect([...(saved.exportNames ?? [])].sort()).toEqual(['producer:Added', 'producer:Api']);
      expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {
        'producer:Api': 'api-v1',
        'producer:Added': 'added',
      });
    });

    it('does NOT carry an alias the previous record never published', async () => {
      // `producer:Api` is in the stored bag but NOT in the stored export set,
      // so nothing proves it is this output's alias; it is not carried.
      mockStateBackend.getState.mockResolvedValue({
        state: makeState({ Api: 'api-v1', 'producer:Api': 'stale' }, []),
        etag: 'etag-old',
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          Api: { Value: undefined as unknown as string, Export: { Name: 'producer:Api' } },
        },
      };

      await makeEngine().deploy(stackName, template);

      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual({ Api: 'api-v1' });
      expect(saved.exportNames).toEqual([]);
    });

    it('keeps the WHOLE previous bag when a failed output declares an intrinsic Export.Name, and warns why', async () => {
      const previous = { Api: 'api-v1', 'producer-Api': 'api-v1', Gone: 'gone' };
      mockStateBackend.getState.mockResolvedValue({
        state: makeState(previous, ['producer-Api']),
        etag: 'etag-old',
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          Api: {
            Value: undefined as unknown as string,
            Export: { Name: { 'Fn::Sub': 'producer-Api' } as unknown as string },
          },
          Added: { Value: 'added' },
        },
      };

      await makeEngine().deploy(stackName, template);

      // The save still happens — for the #2740 record — but carries the bag
      // and its set verbatim, and republishes nothing.
      expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual(previous);
      expect(saved.exportNames).toEqual(['producer-Api']);
      expect(mockExportIndexStore.updateForStack).not.toHaveBeenCalled();
      // ...and the warning says the bag was kept, and why.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/keeping the previously persisted outputs\..*intrinsic Export\.Name/)
      );
    });

    it('persists an EXPORT-SET change on the merged path even when no value changed', async () => {
      // `A` becomes a self-named export while `F` keeps failing and its record
      // is unchanged: the bag is byte-equal, so only the export-set comparison
      // can save it (the #2193 shape, now reached beside a failure).
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          A: { Value: 'a', Export: { Name: 'A' } },
          F: { Value: undefined as unknown as string },
        },
      };
      const state = makeState({ A: 'a', F: 'f' }, []);
      state.skippedOutputs = { F: skippedOutputDigest(structuredClone(template), 'F') };
      mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });

      await makeEngine().deploy(stackName, template);

      expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual({ A: 'a', F: 'f' });
      expect(saved.exportNames).toEqual(['A']);
      expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {
        A: 'a',
      });
    });

    it('decides the bag AFTER the observed-capture drain and re-checks it as the save redacts it, so a needle recorded during the drain cannot slip past', async () => {
      // A needle a released outputs-pass part records late lands in the pass
      // map while the engine awaits the observed-capture drain. Here the
      // pending capture itself records it, after the outputs pass has been
      // redacted: waiting for `skippedOutputs` (set at the end of that pass)
      // plus a run of microtask yields puts the write inside the drain. With the drain
      // moved back BELOW the check, or the save-time re-check removed, the
      // merge would pass on a bag with no expression and the save would write
      // `Plain2`'s expression beside the carried `Old`.
      const SEC = '{{resolve:secretsmanager:late:SecretString:k}}';
      const LATE = 'late-needle-plaintext';
      const previous = { Old: 'maybe-a-pre-ghsa-plaintext' };
      const state = makeState(previous, []);
      delete state.resources['BucketA']!.observedProperties;
      mockStateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
      const engine = makeEngine();
      const internals = engine as unknown as {
        skippedOutputs: Record<string, string> | undefined;
        outputsPassSecretMaps: Map<string, string>[];
        redactOutputs: (outputs: Record<string, unknown>) => Record<string, unknown>;
      };
      // The outputs pass redacts its bag ONCE before the drain; the save-time
      // re-check and the save itself redact again after it. Counting the calls
      // at the moment the needle is written pins the needle AFTER that first
      // redaction, which is what makes the save-time re-check the only thing
      // standing between the needle and the saved bag. Without this premise, an
      // `await` inserted between the outputs pass and the drain would let the
      // merge's own gate refuse first, and the case would keep passing on the
      // safe verdict it also wants.
      const redactSpy = vi.spyOn(internals, 'redactOutputs');
      let redactCallsWhenNeedleLanded = -1;
      // MICROTASK yields only: a timer yield would also run whatever timer an
      // EARLIER test in this file left pending, inside this test's window. The
      // extra yields after `skippedOutputs` appears let the engine finish
      // redacting this pass's bag and reach the drain await, where it then
      // waits on this very capture, so over-yielding is harmless.
      mockProvider.readCurrentState.mockImplementation(async () => {
        for (let i = 0; internals.skippedOutputs === undefined; i += 1) {
          if (i > 100_000) throw new Error('outputs pass never finished');
          await Promise.resolve();
        }
        for (let i = 0; i < 200; i += 1) await Promise.resolve();
        redactCallsWhenNeedleLanded = redactSpy.mock.calls.length;
        internals.outputsPassSecretMaps[0]!.set(LATE, SEC);
        return { BucketName: 'bucket-a' };
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          Old: { Value: undefined as unknown as string },
          Plain2: { Value: LATE },
        },
      };

      await engine.deploy(stackName, template);

      // PREMISE: the capture ran, so the needle really arrived during the
      // drain — and AFTER the outputs pass had redacted its bag (exactly one
      // `redactOutputs` call by then), so only the save-time re-check saw it.
      expect(mockProvider.readCurrentState).toHaveBeenCalledTimes(1);
      expect(redactCallsWhenNeedleLanded).toBe(1);
      expect(redactSpy.mock.calls.length).toBeGreaterThan(1);
      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual(previous);
      expect(JSON.stringify(saved)).not.toContain(LATE);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/redacted secret reference/));
    });

    it('keeps the WHOLE previous bag rather than carry a value into a bag it would give its FIRST secret expression', async () => {
      // The mixed-generation refusal. `Old` may be pre-GHSA plaintext; writing
      // `Sec`'s expression beside it would let `cdkd diff` read that one
      // expression as proof every stored value is redacted.
      const previous = { Old: 'maybe-a-pre-ghsa-plaintext' };
      mockStateBackend.getState.mockResolvedValue({
        state: makeState(previous, []),
        etag: 'etag-old',
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          Old: { Value: undefined as unknown as string },
          Sec: { Value: '{{resolve:secretsmanager:db:SecretString:password}}' },
        },
      };

      await makeEngine().deploy(stackName, template);

      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual(previous);
      expect(mockExportIndexStore.updateForStack).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/keeping the previously persisted outputs\..*redacted secret reference/)
      );
    });

    it('...but MERGES when the previous bag already held a secret expression (the refusal is only against giving a bag its FIRST one)', async () => {
      const previous = {
        Old: 'ordinary',
        Prev: '{{resolve:secretsmanager:prev:SecretString:password}}',
      };
      mockStateBackend.getState.mockResolvedValue({
        state: makeState(previous, []),
        etag: 'etag-old',
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          Old: { Value: undefined as unknown as string },
          Prev: { Value: previous.Prev },
          Sec: { Value: '{{resolve:secretsmanager:db:SecretString:password}}' },
        },
      };

      await makeEngine().deploy(stackName, template);

      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual({
        ...previous,
        Sec: '{{resolve:secretsmanager:db:SecretString:password}}',
      });
    });

    it('...and MERGES when nothing is carried, even into a bag with no expression yet', async () => {
      // No carried value, so no generation can mix: the failed key had nothing
      // stored. Refusing here would re-open the issue for its most common shape.
      mockStateBackend.getState.mockResolvedValue({
        state: makeState({ Plain: 'p' }, []),
        etag: 'etag-old',
      });
      const template: CloudFormationTemplate = {
        Resources: resources,
        Outputs: {
          Broken: { Value: undefined as unknown as string },
          Plain: { Value: 'p' },
          Sec: { Value: '{{resolve:secretsmanager:db:SecretString:password}}' },
        },
      };

      await makeEngine().deploy(stackName, template);

      const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
      expect(saved.outputs).toEqual({
        Plain: 'p',
        Sec: '{{resolve:secretsmanager:db:SecretString:password}}',
      });
    });
  });

  it('treats key-reordered and deep-equal output maps as unchanged (no save)', async () => {
    // outputMapsEqual is key-order-insensitive and deep — a resolved map that
    // matches the persisted one only by reordered keys / nested structure must
    // NOT trigger a save.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState(
        {
          Alpha: 'a',
          Beta: 'b',
        } as Record<string, string>,
        []
      ),
      etag: 'etag-old',
    });

    // Template declares the same two outputs in the OPPOSITE order; the resolver
    // returns each Value as-is, so the resolved map has the same entries with a
    // different insertion order.
    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: {
        Beta: { Value: 'b' },
        Alpha: { Value: 'a' },
      },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    expect(mockExportIndexStore.updateForStack).not.toHaveBeenCalled();
  });

  it('BACKFILLS exportNames on a no-change deploy of a pre-v9 record and re-indexes with the exports only (#2193)', async () => {
    // A record written before v9 carries no export set, so the exports index
    // was fed its whole bag — plain `BucketArn` included — and keeps serving it
    // until this stack is re-indexed. Nothing about the template changed, so
    // without the backfill that could take forever: the no-change path writes
    // the set it just resolved and re-feeds the index with the exports only,
    // which is what evicts the stale plain-name entry.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState({
        BucketArn: 'arn:aws:s3:::bucket-a',
        'producer:BucketArn': 'arn:aws:s3:::bucket-a',
      }),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: {
        BucketArn: { Value: 'arn:aws:s3:::bucket-a', Export: { Name: 'producer:BucketArn' } },
      },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    // The bag itself is untouched; only its export set is written.
    expect(saved.outputs).toEqual({
      BucketArn: 'arn:aws:s3:::bucket-a',
      'producer:BucketArn': 'arn:aws:s3:::bucket-a',
    });
    expect(saved.exportNames).toEqual(['producer:BucketArn']);
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledTimes(1);
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {
      'producer:BucketArn': 'arn:aws:s3:::bucket-a',
    });
  });

  it('does NOT backfill a pre-v9 record with NO plain output name to suppress (#2193)', async () => {
    // The backfill exists to stop plain Output NAMES being served as exports.
    // A record whose bag is empty (or whose every key is already an export)
    // has nothing to suppress, so writing `exportNames: []` would be a state
    // write with no effect — the no-change path must stay a no-op there.
    mockStateBackend.getState.mockResolvedValue({
      // Pre-v9 (no exportNames) AND no outputs at all.
      state: makeState({}),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      // No Outputs → nothing resolves, nothing to suppress.
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    expect(mockExportIndexStore.updateForStack).not.toHaveBeenCalled();
  });

  it('a pre-v9 record whose bag resolved clean but exports NOTHING is backfilled with an EMPTY set (#2193)', async () => {
    // `[]` and absent are different records to the readers (absent = "every
    // key is importable"), so a stack with plain outputs only must get its
    // `[]` written — that is what stops its plain names being served as exports.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState({ Alpha: 'a' }),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: { Alpha: { Value: 'a' } },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.exportNames).toEqual([]);
    expect(JSON.stringify(saved)).toContain('"exportNames":[]');
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {});
  });

  it('ADDING a self-named Export.Name on a v9 record (unchanged bag) saves the set + indexes it (#2194 review)', async () => {
    // The blocker: a v9 record has a plain output `Foo` (exportNames: []). The
    // user adds `Export: { Name: 'Foo' }` — self-named, so `isExportAliasCollision`
    // returns false and the alias write hits the SAME key with the SAME value.
    // The bag is byte-equal, so `outputsChanged` is false and the old `undefined`
    // backfill never fired — nothing saved, the consumer's Fn::ImportValue Foo
    // hard-failed. The effective-set comparison must catch it.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState({ Foo: 'foo-value' }, []),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: { Foo: { Value: 'foo-value', Export: { Name: 'Foo' } } },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    // The bag is unchanged; only its export set flips to include Foo.
    expect(saved.outputs).toEqual({ Foo: 'foo-value' });
    expect(saved.exportNames).toEqual(['Foo']);
    // And the index now serves the export.
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {
      Foo: 'foo-value',
    });
  });

  it('REMOVING a self-named Export.Name on a v9 record evicts the phantom export from state + index (#2194 review)', async () => {
    // Reverse direction: exportNames: ['Foo'] but the template no longer exports
    // it. The bag is byte-equal (Foo is still a plain output), so without the
    // effective-set comparison exportNames: ['Foo'] would be carried forever and
    // the index would keep serving a template-unbacked export.
    mockStateBackend.getState.mockResolvedValue({
      state: makeState({ Foo: 'foo-value' }, ['Foo']),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: { Foo: { Value: 'foo-value' } }, // no Export anymore
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).toHaveBeenCalledTimes(1);
    const saved = mockStateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.outputs).toEqual({ Foo: 'foo-value' });
    expect(saved.exportNames).toEqual([]);
    // The index is re-fed with the exports only ({} now), evicting the phantom.
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {});
  });

  it('an unchanged v9 export set on a no-change deploy neither saves nor re-indexes', async () => {
    // Guard against over-firing: exportNames already correct, bag unchanged,
    // nothing to do. (Fences the set-comparison against a mutation that always
    // reports "changed".)
    mockStateBackend.getState.mockResolvedValue({
      state: makeState({ Foo: 'foo-value', 'ex:Foo': 'foo-value' }, ['ex:Foo']),
      etag: 'etag-old',
    });

    const template: CloudFormationTemplate = {
      Resources: { BucketA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'bucket-a' } } },
      Outputs: { Foo: { Value: 'foo-value', Export: { Name: 'ex:Foo' } } },
    };

    const engine = makeEngine();
    await engine.deploy(stackName, template);

    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
    expect(mockExportIndexStore.updateForStack).not.toHaveBeenCalled();
  });
});
