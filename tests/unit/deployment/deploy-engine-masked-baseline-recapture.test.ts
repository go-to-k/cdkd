import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  redactSecretsForState,
  STATE_SOURCED_BASELINE_RULES,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../src/types/state.js';

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
 * What the mocked resolver answers for each token, per test. A token absent
 * from the table THROWS, the way a deleted secret or a missing grant does.
 * `resolveCalls` records the context each call received.
 */
const resolution: { values: Record<string, string>; calls: Array<Record<string, unknown>> } = {
  values: {},
  calls: [],
};

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
    resolveDynamicReferences: vi
      .fn()
      .mockImplementation(async (token: string, ctx: Record<string, unknown>) => {
        resolution.calls.push(ctx);
        const plaintext = resolution.values[token];
        if (plaintext === undefined) throw new Error('ResourceNotFoundException');
        // A public parameter resolves without recording a pair, as the real
        // resolver does for a `String` ssm parameter.
        if (!token.startsWith('{{resolve:ssm:/public')) {
          (ctx['recordedSecretValues'] as Map<string, string>).set(plaintext, token);
        }
        return plaintext;
      }),
  })),
}));

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

/**
 * Issue #3595 item (1), through the engine: a NO_CHANGE deploy re-captures an
 * observed baseline that holds a #2852 fail-closed mask, at the positions the
 * record's own resolved references certify, and nowhere else.
 */
describe('DeployEngine - deploy-start re-capture of a fail-closed-masked baseline (#3595)', () => {
  const stackName = 'masked-recapture-stack';
  const ALPHA = '{{resolve:secretsmanager:s:SecretString:ambigAlpha}}';
  const BRAVO = '{{resolve:secretsmanager:s:SecretString:ambigBravo}}';
  const ALPHA_PT = 'alpha-plaintext-742';
  const BRAVO_PT = 'bravo-plaintext-743';

  const properties = { Family: 'fam', EntryPoint: ['-p', ALPHA, '-p', BRAVO] };
  const liveReadback = (): Record<string, unknown> => ({
    Family: 'fam',
    EntryPoint: ['-p', ALPHA_PT, '-p', BRAVO_PT],
    Tags: [],
  });
  const maskedBaseline = (): Record<string, unknown> =>
    JSON.parse(
      JSON.stringify(
        redactSecretsForState(liveReadback(), new Map(), properties, STATE_SOURCED_BASELINE_RULES)
      )
    ) as Record<string, unknown>;

  let mockProvider: Record<string, ReturnType<typeof vi.fn>>;
  let mockStateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  let mockDiffCalculator: Record<string, ReturnType<typeof vi.fn>>;

  const record = (over: Partial<ResourceState> = {}): ResourceState => ({
    physicalId: 'td-arn',
    resourceType: 'AWS::ECS::TaskDefinition',
    properties: { ...properties, EntryPoint: [...properties.EntryPoint] },
    observedProperties: maskedBaseline(),
    ...over,
  });

  const stateWith = (resources: Record<string, ResourceState>, extra: Partial<StackState> = {}) => ({
    version: 10,
    region: 'us-east-1',
    stackName,
    resources,
    outputs: {},
    lastModified: 0,
    ...extra,
  });

  const template: CloudFormationTemplate = {
    Resources: { TaskDef: { Type: 'AWS::ECS::TaskDefinition', Properties: properties } },
  };

  function makeEngine(opts: { dryRun?: boolean; captureObservedState?: boolean } = {}) {
    return new DeployEngine(
      mockStateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      mockDiffCalculator as never,
      {
        getProvider: vi.fn().mockReturnValue(mockProvider),
        getProviderFor: vi.fn().mockReturnValue({ provider: mockProvider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: opts.dryRun ?? false, captureObservedState: opts.captureObservedState ?? true },
      'us-east-1'
    );
  }

  const savedTaskDef = (): ResourceState | undefined => {
    const call = mockStateBackend.saveState.mock.calls.at(-1);
    return call ? (call[2] as StackState).resources['TaskDef'] : undefined;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resolution.values = { [ALPHA]: ALPHA_PT, [BRAVO]: BRAVO_PT };
    resolution.calls = [];
    mockProvider = {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockImplementation(async () => liveReadback()),
    };
    mockStateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
    mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(
        new Map<string, ResourceChange>([
          [
            'TaskDef',
            {
              logicalId: 'TaskDef',
              changeType: 'NO_CHANGE',
              resourceType: 'AWS::ECS::TaskDefinition',
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
  });

  it('unmasks every certified position on a NO_CHANGE deploy, persisting expressions only', async () => {
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({
        TaskDef: record(),
        Other: { physicalId: 'q-url', resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q' }, observedProperties: { QueueName: 'q' } },
      }),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    expect(mockProvider.readCurrentState).toHaveBeenCalledTimes(1);
    // The sibling context, minus the record being read.
    expect(mockProvider.readCurrentState.mock.calls[0]![4]).toEqual({
      siblings: { Other: { resourceType: 'AWS::SQS::Queue', properties: { QueueName: 'q' } } },
    });
    const saved = savedTaskDef()!;
    expect(saved.observedProperties?.['EntryPoint']).toEqual(['-p', ALPHA, '-p', BRAVO]);
    expect(saved.properties).toEqual(properties);
    const text = JSON.stringify(mockStateBackend.saveState.mock.calls);
    expect(text).not.toContain(ALPHA_PT);
    expect(text).not.toContain(BRAVO_PT);
  });

  it('keeps a position the map cannot certify (a rotated secret) masked', async () => {
    resolution.values = { [ALPHA]: ALPHA_PT, [BRAVO]: 'bravo-rotated-999' };
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({ TaskDef: record() }),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    expect(savedTaskDef()!.observedProperties?.['EntryPoint']).toEqual(['-p', ALPHA, '-p', '***']);
    const text = JSON.stringify(mockStateBackend.saveState.mock.calls);
    expect(text).not.toContain(BRAVO_PT);
    expect(text).not.toContain('bravo-rotated-999');
  });

  it('keeps the old baseline when a reference does not resolve (all or nothing)', async () => {
    resolution.values = { [ALPHA]: ALPHA_PT };
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({ TaskDef: record() }),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    // Refused BEFORE the readback: nothing was read, nothing persisted for it.
    expect(mockProvider.readCurrentState).not.toHaveBeenCalled();
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('keeps the old baseline when the resource no longer reads back as it (drift is not absorbed)', async () => {
    mockProvider.readCurrentState.mockResolvedValue({
      ...liveReadback(),
      Family: 'changed-in-the-console',
    });
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({ TaskDef: record() }),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    expect(mockProvider.readCurrentState).toHaveBeenCalledTimes(1);
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('passes the stack region evidence, so a region-less reference can refuse as ambiguous', async () => {
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith(
        { TaskDef: record() },
        {
          outputReads: [
            {
              sourceStack: 'Producer',
              sourceRegion: 'eu-west-1',
              outputName: 'O',
            },
          ],
        } as Partial<StackState>
      ),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    expect(resolution.calls.length).toBeGreaterThan(0);
    for (const ctx of resolution.calls) {
      expect(ctx['producerRegions']).toEqual(['eu-west-1']);
    }
  });

  it('skips the re-capture when the cross-stack evidence cannot be read', async () => {
    // A hand-edited `imports` element: resolving without the evidence would
    // verdict every region-less reference `local`, so nothing is resolved.
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({ TaskDef: record() }, {
        imports: [null],
      } as unknown as Partial<StackState>),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    expect(resolution.calls).toHaveLength(0);
    expect(mockProvider.readCurrentState).not.toHaveBeenCalled();
  });

  it('keeps the old baseline, and the deploy succeeds, when the readback rejects', async () => {
    mockProvider.readCurrentState.mockRejectedValue(new Error('AccessDeniedException'));
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({ TaskDef: record() }),
      etag: 'e',
    });
    await expect(makeEngine().deploy(stackName, template)).resolves.toBeDefined();
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('reads nothing back for a record whose references record no secret (public ssm only)', async () => {
    const pub = '{{resolve:ssm:/public/param}}';
    resolution.values = { [pub]: 'public-value' };
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({
        TaskDef: record({ properties: { Family: 'fam', EntryPoint: ['-p', pub] } }),
      }),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);
    expect(resolution.calls.length).toBe(1);
    expect(mockProvider.readCurrentState).not.toHaveBeenCalled();
  });

  it('never installs a re-captured bag on a record this deploy rebuilt', async () => {
    // Drives the drain directly: a pending re-capture task, then the record
    // replaced by one without a baseline (what a rebuild whose provider takes
    // no capture of its own leaves). The task must not land on it.
    const engine = makeEngine() as unknown as {
      kickOffMaskedBaselineRecapture: (...a: unknown[]) => void;
      drainObservedCaptures: (r: Record<string, ResourceState>) => Promise<number>;
    };
    const original = record();
    engine.kickOffMaskedBaselineRecapture(mockProvider, 'TaskDef', original, [], { siblings: {} });
    const { observedProperties: _gone, ...rebuilt } = original;
    const resources: Record<string, ResourceState> = { TaskDef: { ...rebuilt, physicalId: 'td-arn-2' } };
    await expect(engine.drainObservedCaptures(resources)).resolves.toBe(0);
    expect(resources['TaskDef']!.observedProperties).toBeUndefined();

    // ...while the same task over the untouched record installs.
    engine.kickOffMaskedBaselineRecapture(mockProvider, 'TaskDef', original, [], { siblings: {} });
    const kept: Record<string, ResourceState> = { TaskDef: original };
    await expect(engine.drainObservedCaptures(kept)).resolves.toBe(1);
    expect(kept['TaskDef']!.observedProperties?.['EntryPoint']).toEqual(['-p', ALPHA, '-p', BRAVO]);
  });

  it('a capture that cannot run still supersedes the pending refresh task', async () => {
    const engine = makeEngine() as unknown as {
      kickOffMaskedBaselineRecapture: (...a: unknown[]) => void;
      kickOffObservedCapture: (...a: unknown[]) => void;
      observedCaptureTasks: Map<string, unknown>;
    };
    engine.kickOffMaskedBaselineRecapture(mockProvider, 'TaskDef', record(), [], { siblings: {} });
    expect(engine.observedCaptureTasks.has('TaskDef')).toBe(true);
    engine.kickOffObservedCapture({ create: vi.fn() }, 'TaskDef', 'p2', 'Custom::X', {});
    expect(engine.observedCaptureTasks.has('TaskDef')).toBe(false);
  });

  it('leaves a NoEcho record (a mask in its properties) alone', async () => {
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({
        TaskDef: record({ properties: { ...properties, Secret: '***' } }),
      }),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    expect(resolution.calls).toHaveLength(0);
    expect(mockProvider.readCurrentState).not.toHaveBeenCalled();
  });

  it('issues no read under --dry-run or with the capture disabled', async () => {
    for (const opts of [{ dryRun: true }, { captureObservedState: false }]) {
      mockStateBackend.getState.mockResolvedValue({
        state: stateWith({ TaskDef: record() }),
        etag: 'e',
      });
      await makeEngine(opts).deploy(stackName, template);
    }
    expect(resolution.calls).toHaveLength(0);
    expect(mockProvider.readCurrentState).not.toHaveBeenCalled();
  });

  it('does not rewrite an unchanged state when a missing-baseline readback fails', async () => {
    const { observedProperties: _omit, ...missing } = record();
    mockProvider.readCurrentState.mockResolvedValue(undefined);
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({ TaskDef: missing }),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    expect(mockProvider.readCurrentState).toHaveBeenCalledTimes(1);
    expect(mockStateBackend.saveState).not.toHaveBeenCalled();
  });

  it('never resolves anything for a record whose baseline is missing', async () => {
    const { observedProperties: _omit, ...missing } = record();
    mockStateBackend.getState.mockResolvedValue({
      state: stateWith({ TaskDef: missing }),
      etag: 'e',
    });
    await makeEngine().deploy(stackName, template);

    // The missing-baseline arm keeps its empty-map capture, and so its masks.
    expect(resolution.calls).toHaveLength(0);
    expect(savedTaskDef()!.observedProperties?.['EntryPoint']).toEqual(['-p', '***', '-p', '***']);
  });
});
