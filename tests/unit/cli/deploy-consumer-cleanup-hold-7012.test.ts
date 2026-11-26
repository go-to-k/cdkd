import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeployCancelledError } from '../../../src/utils/error-handler.js';
import { NestedCleanupQueue } from '../../../src/deployment/nested-cleanup-scope.js';
import {
  ConsumerCleanupHold,
  runHeldProducerCleanup,
} from '../../../src/cli/commands/deploy/consumer-cleanup-hold.js';

/**
 * go-to-k/cdkd#7012: in a multi-stack `cdkd deploy`, a producer whose outputs
 * a stack of the same run imports holds its cleanup phase (the deletes of the
 * old copies its replacements left) until every such consumer deployed. A
 * consumer that fails and rolls back then still names a live old copy.
 * Command harness modeled on deploy-outputs-file.test.ts.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const runOutcomeSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({
    send: vi.fn(async () => ({ Account: '111122223333' })),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: vi.fn(() => null),
  resolveApp: vi.fn(() => 'fake-app-cmd'),
  resolveCaptureObservedState: vi.fn(() => false),
  // Identity, so the go-to-k/cdkd#6437 cases below see the CLI value reach the engine.
  resolveUpdatePolicy: vi.fn((cliValue?: boolean) => cliValue),
  resolveAutoAssetStorage: vi.fn(() => false),
  resolveSkipPrefix: vi.fn(() => false),
  resolveStateBucketWithDefaultAndSource: vi.fn(async () => ({
    bucket: 'test-bucket',
    source: 'default',
  })),
  stateBucketExistenceConfirmed: vi.fn(() => true),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
  warnDeprecatedNoPrefixCliFlag: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  // The per-stack scope is irrelevant here; run the stack body directly.
  runWithStackAwsClients: vi.fn((_clients: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    verifyBucketExists: vi.fn(async () => undefined),
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
  })),
}));

vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn(() => ({})),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn(),
    settleDeferredPurges: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    setCustomResourceResponseBucket: vi.fn(),
    getProvider: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/resource-timeout-registry.js', () => ({
  setResolvedResourceTimeouts: vi.fn(),
}));

vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../../src/analyzer/dag-builder.js', () => ({
  DagBuilder: vi.fn(() => ({})),
}));

vi.mock('../../../src/analyzer/diff-calculator.js', () => ({
  DiffCalculator: vi.fn(() => ({})),
}));

// Hoisted so the OPTIONS the command passes are observable, not just the
// returned node ids: the `assetOutdir` containment bound
// (go-to-k/cdkd#3489) is wired here and nowhere else on the deploy path.
const addAssetsToGraphMock = vi.hoisted(() => vi.fn(() => [] as string[]));
vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn(() => ({
    addAssetsToGraph: addAssetsToGraphMock,
    executeNode: vi.fn(async () => undefined),
  })),
}));

/**
 * Hoisted so the ARGUMENT is observable, not just the returned mode. Issue
 * #2065: `deploy.ts` must hand this resolver the user's RAW region spelling
 * (its second marker probe is what finds a key an unfolded `cdkd bootstrap`
 * wrote) while every other consumer gets the folded one.
 */
const modeResolveSpy = vi.hoisted(() => vi.fn(async () => ({ mode: 'legacy' })));
const loadPublishableManifestMock = vi.hoisted(() => vi.fn(() => null as unknown));

vi.mock('../../../src/assets/asset-storage.js', () => ({
  AssetModeResolver: vi.fn(() => ({ resolve: modeResolveSpy })),
}));

vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadPublishableAssetManifest: loadPublishableManifestMock };
});

vi.mock('../../../src/cli/commands/prefix-migration-check.js', () => ({
  createPrefixMigrationGate: vi.fn(() => undefined),
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: vi.fn(() => undefined),
  recordRunOutcome: runOutcomeSpy,
  recordRunFailed: vi.fn(),
}));

/** Stack names whose deploy should throw, for the failure-precedence case. */
const failingStacks = vi.hoisted(() => new Set<string>());

/** Stack names whose deploy should unwind as a user cancellation. */
const cancelledStacks = vi.hoisted(() => new Set<string>());

/** What the run did, in order: each deploy, and each held pass's fate. */
const events = vi.hoisted(() => [] as string[]);
/** Runs inside a stack's deploy before it lands, by stack name. */
const deployHooks = vi.hoisted(() => new Map<string, () => Promise<void>>());
/** What a stack's held pass reports as left undeleted, by stack name. */
const heldLeft = vi.hoisted(() => new Map<string, number>());
/** Stacks whose deploy throws after queueing its cleanup. */
const failAfterQueueing = vi.hoisted(() => new Set<string>());
/** Each engine's options, by stack name. */
const engineOptions = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn((...args: unknown[]) => {
    const options = args[5] as Record<string, unknown>;
    return {
      interrupted: false,
      deploy: vi.fn(async (stackName: string) => {
        engineOptions.set(stackName, options);
        if (cancelledStacks.has(stackName)) {
          throw new DeployCancelledError(`cancelled ${stackName}`);
        }
        if (failingStacks.has(stackName)) {
          events.push(`fail ${stackName}`);
          throw new Error(`synthetic provisioning failure in ${stackName}`);
        }
        const hook = deployHooks.get(stackName);
        if (hook !== undefined) await hook();
        events.push(`deploy ${stackName}`);
        // As the engine does when it replaced something: its cleanup phase
        // goes to the queue the CLI handed it.
        const queue = options['consumerCleanupQueue'] as NestedCleanupQueue | undefined;
        queue?.enqueue({
          stackName,
          producer: true,
          run: async () => {
            events.push(`cleanup ${stackName}`);
            return { updatePartial: heldLeft.get(stackName) ?? 0 };
          },
          abandon: (why) => events.push(`abandon ${stackName} ${why}`),
          fail: () => ({ updatePartial: 0 }),
        });
        // A deploy that fails after its engine queued the pass (a final save).
        if (failAfterQueueing.has(stackName)) throw new Error(`final save failed in ${stackName}`);
        return {
          stackName,
          created: 1,
          updated: 0,
          deleted: 0,
          deleteSkipped: 0,
          updatePartial: 0,
          unchanged: 0,
          durationMs: 10,
          outputs: {},
          attributeFallbackCount: 0,
        };
      }),
    };
  }),
}));

const synthStacks = vi.hoisted(() => ({ value: [] as unknown[] }));
/** An error synthesis raises, e.g. a Stage that failed to load (go-to-k/cdkd#3507). */
const synthError = vi.hoisted(() => ({ value: undefined as Error | undefined }));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn(() => ({
    synthesize: vi.fn(async () => {
      if (synthError.value) throw synthError.value;
      return { stacks: synthStacks.value };
    }),
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: vi.fn((_app: string, msg: string) => msg),
}));

vi.mock('../../../src/synthesis/stack-messages.js', () => ({
  processStackMessages: vi.fn(),
}));

function makeStack(stackName: string, overrides: Record<string, unknown> = {}) {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    ...overrides,
  };
}
async function runDeploy(argv: string[]): Promise<{ exitCode?: number; error?: unknown }> {
  const { createDeployCommand } = await import('../../../src/cli/commands/deploy.js');
  let exitCode: number | undefined;
  let error: unknown;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as never);
  try {
    await createDeployCommand().parseAsync(['node', 'cdkd', ...argv]);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') error = err;
  } finally {
    exitSpy.mockRestore();
  }
  return { exitCode, error };
}

const producer = (name = 'Producer') =>
  makeStack(name, {
    template: {
      Resources: {},
      Outputs: { QueueUrl: { Value: 'u', Export: { Name: `${name}:QueueUrl` } } },
    },
  });
const consumer = (name: string, from = 'Producer') =>
  makeStack(name, {
    template: {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Environment: { QURL: { 'Fn::ImportValue': `${from}:QueueUrl` } } },
        },
      },
    },
  });
const infoLines = (): string[] => infoSpy.mock.calls.map((c) => String(c[0]));

describe('deploy holds a producer cleanup for its in-run consumers (#7012)', () => {
  beforeEach(() => {
    events.length = 0;
    engineOptions.clear();
    deployHooks.clear();
    heldLeft.clear();
    failAfterQueueing.clear();
    failingStacks.clear();
    cancelledStacks.clear();
    synthError.value = undefined;
    process.env['CDKD_NO_LIVE'] = '1';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['CDKD_NO_LIVE'];
  });

  it('runs the held pass only after the consumer deployed', async () => {
    synthStacks.value = [producer(), consumer('Consumer')];
    const { error, exitCode } = await runDeploy(['--all', '--yes']);
    expect(error).toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(events).toEqual(['deploy Producer', 'deploy Consumer', 'cleanup Producer']);
    // Only the producer gets a queue.
    expect(engineOptions.get('Producer')?.['consumerCleanupQueue']).toBeInstanceOf(
      NestedCleanupQueue
    );
    expect(engineOptions.get('Consumer')?.['consumerCleanupQueue']).toBeUndefined();
  });

  it('keeps the old copies when the consumer fails, says so once, and exits 1', async () => {
    synthStacks.value = [producer(), consumer('Consumer')];
    failingStacks.add('Consumer');
    const { exitCode } = await runDeploy(['--all', '--yes']);
    expect(exitCode).toBe(1);
    expect(events).toEqual([
      'deploy Producer',
      'fail Consumer',
      'abandon Producer consumer-failed',
    ]);
    const kept = infoLines().filter((l) =>
      l.includes('Keeping the replaced resources of stack Producer')
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('Consumer (importing its outputs) did not deploy');
  });

  it('keeps the old copies when the consumer is cancelled before it deploys', async () => {
    synthStacks.value = [producer(), consumer('Consumer')];
    cancelledStacks.add('Consumer');
    await runDeploy(['--all', '--yes']);
    expect(events).toEqual(['deploy Producer', 'abandon Producer consumer-failed']);
  });

  it('waits for every consumer: one failing keeps the copies though the other deployed', async () => {
    synthStacks.value = [producer(), consumer('ConsumerA'), consumer('ConsumerB')];
    failingStacks.add('ConsumerB');
    await runDeploy(['--all', '--yes', '--stack-concurrency', '1']);
    expect(events[0]).toBe('deploy Producer');
    expect(events).toContain('deploy ConsumerA');
    expect(events).toContain('fail ConsumerB');
    expect(events.at(-1)).toBe('abandon Producer consumer-failed');
    expect(events).not.toContain('cleanup Producer');
  });

  it('keeps the old copies when the consumer never runs (another producer of it failed)', async () => {
    const both = consumer('Consumer');
    (both.template.Resources as Record<string, unknown>)['Other'] = {
      Type: 'AWS::SNS::Topic',
      Properties: { Name: { 'Fn::ImportValue': 'Broken:QueueUrl' } },
    };
    synthStacks.value = [producer(), producer('Broken'), both];
    failingStacks.add('Broken');
    const { exitCode } = await runDeploy(['--all', '--yes']);
    expect(exitCode).toBe(1);
    expect(events).not.toContain('deploy Consumer');
    expect(events).toContain('abandon Producer consumer-failed');
    expect(events).not.toContain('cleanup Producer');
  });

  it('abandons as soon as the consumer failed, not once the whole run ended', async () => {
    synthStacks.value = [
      producer(),
      consumer('Consumer'),
      makeStack('Late', { dependencyNames: ['Producer'] }),
    ];
    failingStacks.add('Consumer');
    let sawAbandon = false;
    // Still deploying while the consumer fails: the producer's decision must
    // not wait for it.
    deployHooks.set('Late', async () => {
      for (let i = 0; i < 100 && !sawAbandon; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        sawAbandon = events.includes('abandon Producer consumer-failed');
      }
    });
    await runDeploy(['--all', '--yes', '--stack-concurrency', '2']);
    expect(sawAbandon).toBe(true);
  });

  it('an old copy the held pass could not delete counts toward exit 2', async () => {
    synthStacks.value = [producer(), consumer('Consumer')];
    heldLeft.set('Producer', 1);
    const { exitCode } = await runDeploy(['--all', '--yes']);
    expect(events).toEqual(['deploy Producer', 'deploy Consumer', 'cleanup Producer']);
    expect(exitCode).toBe(2);
  });

  it('a producer whose deploy fails after queueing its pass abandons it', async () => {
    synthStacks.value = [producer(), consumer('Consumer')];
    failAfterQueueing.add('Producer');
    const { exitCode } = await runDeploy(['--all', '--yes']);
    expect(exitCode).toBe(1);
    expect(events).toEqual(['deploy Producer', 'abandon Producer failed']);
  });

  it('a single-stack deploy gets no queue: the engine cleans up at the end of its deploy', async () => {
    synthStacks.value = [producer(), consumer('Consumer')];
    await runDeploy(['Producer', '--yes']);
    expect(engineOptions.get('Producer')?.['consumerCleanupQueue']).toBeUndefined();
    expect(events).toEqual(['deploy Producer']);
  });

  it('a stack nobody in the run imports gets no queue', async () => {
    synthStacks.value = [producer(), makeStack('Other')];
    await runDeploy(['--all', '--yes']);
    expect(engineOptions.get('Producer')?.['consumerCleanupQueue']).toBeUndefined();
    expect(engineOptions.get('Other')?.['consumerCleanupQueue']).toBeUndefined();
  });

  it('a manifest-only dependency imports no value and gets no queue', async () => {
    synthStacks.value = [makeStack('Base'), makeStack('Top', { dependencyNames: ['Base'] })];
    await runDeploy(['--all', '--yes']);
    expect(engineOptions.get('Base')?.['consumerCleanupQueue']).toBeUndefined();
  });

  it('a chain: the middle stack is consumer and producer, and each pass waits for its own consumer', async () => {
    const middle = consumer('Middle');
    (middle.template as Record<string, unknown>)['Outputs'] = {
      QueueUrl: { Value: 'm', Export: { Name: 'Middle:QueueUrl' } },
    };
    synthStacks.value = [producer(), middle, consumer('Top', 'Middle')];
    const { error } = await runDeploy(['--all', '--yes']);
    expect(error).toBeUndefined();
    const at = (e: string): number => events.indexOf(e);
    expect(at('deploy Producer')).toBe(0);
    expect(at('deploy Top')).toBeGreaterThan(at('deploy Middle'));
    expect(events.indexOf('cleanup Producer')).toBeGreaterThan(events.indexOf('deploy Middle'));
    expect(events.indexOf('cleanup Middle')).toBeGreaterThan(events.indexOf('deploy Top'));
  });

  it('--dry-run builds no hold', async () => {
    synthStacks.value = [producer(), consumer('Consumer')];
    await runDeploy(['--all', '--yes', '--dry-run']);
    expect(engineOptions.get('Producer')?.['consumerCleanupQueue']).toBeUndefined();
  });
});

describe('ConsumerCleanupHold (#7012)', () => {
  type S = { stackName: string };
  const p: S = { stackName: 'P' };
  const a: S = { stackName: 'A' };
  const b: S = { stackName: 'B' };
  const out: S = { stackName: 'Out' };
  const imports = new Map<S, S[]>([
    [a, [p]],
    [b, [p, out, b]],
  ]);
  const build = () => ConsumerCleanupHold.build([p, a, b], (s) => imports.get(s) ?? [])!;

  it('is undefined when no stack of the run imports another stack of the run', () => {
    expect(ConsumerCleanupHold.build([p, out], (s) => (s === p ? [out, p] : []))).toBeDefined();
    expect(ConsumerCleanupHold.build([p], () => [p])).toBeUndefined();
    expect(ConsumerCleanupHold.build([b], () => [out])).toBeUndefined();
  });

  it('names producers only, ignoring a self-reference and a producer outside the run', () => {
    const hold = build();
    expect(hold.hasConsumers(p)).toBe(true);
    expect(hold.hasConsumers(b)).toBe(false);
    expect(hold.hasConsumers(out)).toBe(false);
    expect(hold.queueFor(p)).toBeInstanceOf(NestedCleanupQueue);
    expect(hold.queueFor(a)).toBeUndefined();
  });

  it('waits until every consumer settled and answers the ones that did not deploy', async () => {
    const hold = build();
    let released = false;
    void hold.released(p).then(() => (released = true));
    let answer: S[] | undefined;
    const waiting = hold.waitForConsumers(p).then((r) => (answer = r));
    await Promise.resolve();
    expect(released).toBe(true);
    hold.settle(a, true);
    await Promise.resolve();
    expect(answer).toBeUndefined();
    hold.settle(b, false);
    // The first settle wins.
    hold.settle(b, true);
    await waiting;
    expect(answer).toEqual([b]);
  });

  it('settleRest marks every consumer never settled as not deployed', async () => {
    const hold = build();
    hold.settle(a, true);
    const waiting = hold.waitForConsumers(p);
    hold.settleRest();
    expect(await waiting).toEqual([b]);
  });

  it('runHeldProducerCleanup runs the queue once all deployed', async () => {
    const hold = build();
    hold.settle(a, true);
    hold.settle(b, true);
    const queue = new NestedCleanupQueue();
    const run = vi.fn(async () => ({ updatePartial: 1 }));
    queue.enqueue({ stackName: 'P', producer: true, run, abandon: vi.fn(), fail: vi.fn() });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const outcome = await runHeldProducerCleanup(hold, queue, p, logger);
    expect(run).toHaveBeenCalledTimes(1);
    // A producer's own pass is not a nested stack's.
    expect(outcome).toEqual({ updatePartial: 1, nestedUpdatePartial: 0 });
  });

  it('runHeldProducerCleanup abandons the queue when one did not deploy', async () => {
    const hold = build();
    hold.settle(a, false);
    hold.settle(b, true);
    const queue = new NestedCleanupQueue();
    const run = vi.fn(async () => ({ updatePartial: 0 }));
    const abandon = vi.fn();
    queue.enqueue({ stackName: 'P', producer: true, run, abandon, fail: vi.fn() });
    const logger = { info: vi.fn(), warn: vi.fn() };
    await runHeldProducerCleanup(hold, queue, p, logger);
    expect(run).not.toHaveBeenCalled();
    expect(abandon).toHaveBeenCalledWith('consumer-failed');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(String(logger.info.mock.calls[0]![0])).toContain('A (importing its outputs) did not deploy');
  });
});
