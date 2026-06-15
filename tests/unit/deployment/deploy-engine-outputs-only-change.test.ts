import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

// Logger silenced (the no-change path may emit a warn we don't want in output).
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

// The resolver resolves every value to itself — so resolveOutputs() maps each
// Output.Value (a literal in these fixtures) straight through, and an
// Export.Name string is stored under both the output key and the export name.
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
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
  function makeState(outputs: Record<string, string>): StackState {
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

    // Exports index updated so a consumer's Fn::ImportValue resolves O(1).
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledTimes(1);
    expect(mockExportIndexStore.updateForStack).toHaveBeenCalledWith('producer-stack', 'us-east-1', {
      BucketArn: 'arn:aws:s3:::bucket-a',
      'producer:BucketArn': 'arn:aws:s3:::bucket-a',
    });

    // The returned display outputs reflect the freshly-resolved value.
    expect(result.outputs).toEqual({ BucketArn: 'arn:aws:s3:::bucket-a' });
  });

  it('does NOT save or touch the index when outputs are unchanged', async () => {
    // State already carries exactly what the template resolves to.
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
});
