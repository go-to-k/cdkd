import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployCancelledError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#5819 — `cdkd deploy --outputs-file` wiring, driven through the
 * real commander command (harness modeled on deploy-unaddressed-exit.test.ts).
 * cdk.json is mocked to null so the developer's cwd cdk.json is never read.
 */

const errorSpy = vi.hoisted(() => vi.fn());
/** Observable so the RUN_FINISHED result can be asserted, not just the exit code. */
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
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async () => ({ Account: '111122223333' })),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: vi.fn(() => null),
  resolveApp: vi.fn(() => 'fake-app-cmd'),
  resolveCaptureObservedState: vi.fn(() => false),
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
  AwsClients: vi.fn().mockImplementation(() => ({
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
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    verifyBucketExists: vi.fn(async () => undefined),
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
  })),
}));

vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn(),
    settleDeferredPurges: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
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
  DagBuilder: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/analyzer/diff-calculator.js', () => ({
  DiffCalculator: vi.fn().mockImplementation(() => ({})),
}));

// Hoisted so the OPTIONS the command passes are observable, not just the
// returned node ids: the `assetOutdir` containment bound
// (go-to-k/cdkd#3489) is wired here and nowhere else on the deploy path.
const addAssetsToGraphMock = vi.hoisted(() => vi.fn(() => [] as string[]));
vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => ({
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
  AssetModeResolver: vi.fn().mockImplementation(() => ({ resolve: modeResolveSpy })),
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

/**
 * Per-stack deploy results the mocked engine hands back, keyed by stack name.
 * Set by each test before `runDeploy`.
 */
const engineResults = vi.hoisted(
  () =>
    new Map<
      string,
      {
        deleteSkipped: number;
        updatePartial: number;
        nestedUpdatePartial?: number;
        updated?: number;
        crossPrefixKept?: number;
      }
    >()
);

/** Stack names whose deploy should throw, for the failure-precedence case. */
const engineOutputs = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const failingStacks = vi.hoisted(() => new Set<string>());

/** Stack names whose deploy should unwind as a user cancellation. */
const cancelledStacks = vi.hoisted(() => new Set<string>());

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => ({
    deploy: vi.fn(async (stackName: string) => {
      if (cancelledStacks.has(stackName)) {
        throw new DeployCancelledError(`cancelled ${stackName}`);
      }
      if (failingStacks.has(stackName)) {
        throw new Error(`synthetic provisioning failure in ${stackName}`);
      }
      const counts = engineResults.get(stackName) ?? { deleteSkipped: 0, updatePartial: 0 };
      const outputs = engineOutputs.get(stackName) ?? {};
      return {
        stackName,
        created: 1,
        updated: counts.updated ?? 0,
        deleted: 0,
        deleteSkipped: counts.deleteSkipped,
        updatePartial: counts.updatePartial,
        ...(counts.nestedUpdatePartial !== undefined && {
          nestedUpdatePartial: counts.nestedUpdatePartial,
        }),
        ...(counts.crossPrefixKept !== undefined && { crossPrefixKept: counts.crossPrefixKept }),
        unchanged: 0,
        durationMs: 10,
        outputs,
        attributeFallbackCount: 0,
      };
    }),
  })),
}));

const synthStacks = vi.hoisted(() => ({ value: [] as unknown[] }));
/** An error synthesis raises, e.g. a Stage that failed to load (go-to-k/cdkd#3507). */
const synthError = vi.hoisted(() => ({ value: undefined as Error | undefined }));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
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

describe('deploy --outputs-file (#5819)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    engineResults.clear();
    engineOutputs.clear();
    errorSpy.mockClear();
    failingStacks.clear();
    cancelledStacks.clear();
    synthStacks.value = [makeStack('StackA'), makeStack('StackB')];
    synthError.value = undefined;
    process.env['CDKD_NO_LIVE'] = '1';
    dir = mkdtempSync(join(tmpdir(), 'cdkd-outputs-file-'));
    file = join(dir, 'nested', 'outputs.json');
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['CDKD_NO_LIVE'];
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes every stack keyed by physical name, including a stack with no outputs', async () => {
    engineOutputs.set('StackA', { Url: 'https://a.example', Count: 3 });
    // The display path and artifact id differ from the physical name, so a key
    // taken from either would fail the assertion.
    synthStacks.value = [
      makeStack('StackA', { displayName: 'Display/StackA', artifactId: 'ArtifactA' }),
      makeStack('StackB'),
    ];
    const { error } = await runDeploy(['--all', '--yes', '-O', file]);
    expect(error).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      StackA: { Url: 'https://a.example', Count: '3' },
      StackB: {},
    });
  });

  it('still writes the successful stacks when another stack fails, and surfaces the deploy error', async () => {
    engineOutputs.set('StackA', { Url: 'https://a.example' });
    failingStacks.add('StackB');
    const { exitCode } = await runDeploy(['--all', '--yes', '--stack-concurrency', '1', '-O', file]);
    expect(exitCode).toBe(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('synthetic provisioning failure in StackB');
    expect(logged).not.toContain('Failed to write stack outputs');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      StackA: { Url: 'https://a.example' },
    });
  });

  it('writes nothing under --dry-run', async () => {
    await runDeploy(['--all', '--yes', '--dry-run', '-O', file]);
    expect(existsSync(file)).toBe(false);
  });

  it('writes nothing when no outputs file is configured', async () => {
    const { loadCdkJson } = await import('../../../src/cli/config-loader.js');
    expect(vi.mocked(loadCdkJson)()).toBeNull();
    const { error } = await runDeploy(['--all', '--yes']);
    expect(error).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(dir, 'nested'))).toBe(false);
  });

  it('writes the file before the unaddressed-resources exit', async () => {
    engineOutputs.set('StackA', { Url: 'u' });
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    const { exitCode } = await runDeploy(['--all', '--yes', '-O', file]);
    expect(exitCode).toBe(2);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ StackA: { Url: 'u' }, StackB: {} });
  });
});
