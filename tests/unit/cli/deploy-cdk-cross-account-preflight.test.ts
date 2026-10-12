import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vite-plus/test';
import type { ProducerLookup } from '../../../src/deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import {
  CONSUMER_ACCOUNT,
  PRODUCER_ACCOUNT,
  synthesizeCrossAccountApp,
  type SynthesizedApp,
} from '../deployment/cdk-cross-account-fixture.js';

/**
 * `cdkd deploy` refuses an aws-cdk-lib-generated cross-account
 * `Fn::GetStackOutput` it can already tell it cannot read BEFORE the lock, the
 * assets and the engine (the resolver would otherwise refuse it mid-
 * provisioning), and hands every engine the assembly's producer lookup. Drives
 * the REAL commander command over stacks aws-cdk-lib synthesized.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const stsCtorSpy = vi.hoisted(() => vi.fn());
const assetPublisherCtorSpy = vi.hoisted(() => vi.fn());
const lockManagerCtorSpy = vi.hoisted(() => vi.fn());
const engineCtorSpy = vi.hoisted(() => vi.fn());
const engineDeploySpy = vi.hoisted(() => vi.fn());
const expandMacrosSpy = vi.hoisted(() => vi.fn(async () => undefined));
const runRecorderSpy = vi.hoisted(() => vi.fn(() => undefined));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => {
    stsCtorSpy();
    return { send: vi.fn(async () => ({ Account: '111122223333' })), destroy: vi.fn() };
  }),
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

vi.mock('../../../src/utils/role-arn.js', async () => ({
  ...(await vi.importActual<typeof import('../../../src/utils/role-arn.js')>(
    '../../../src/utils/role-arn.js'
  )),
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
  LockManager: vi.fn().mockImplementation(() => {
    lockManagerCtorSpy();
    return {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
      settleDeferredPurges: vi.fn().mockResolvedValue(undefined),
    };
  }),
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

vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => {
    assetPublisherCtorSpy();
    return { addAssetsToGraph: vi.fn(() => []), executeNode: vi.fn(async () => undefined) };
  }),
}));

vi.mock('../../../src/assets/asset-storage.js', () => ({
  AssetModeResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(async () => ({ mode: 'legacy' })),
  })),
}));

vi.mock('../../../src/cli/commands/prefix-migration-check.js', () => ({
  createPrefixMigrationGate: vi.fn(() => undefined),
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: runRecorderSpy,
  recordRunOutcome: vi.fn(),
  recordRunFailed: vi.fn(),
}));

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation((...args: unknown[]) => {
    engineCtorSpy(...args);
    return {
      deploy: engineDeploySpy.mockImplementation(async (stackName: string) => ({
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
      })),
    };
  }),
}));

const synthStacks = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn(async () => ({ stacks: synthStacks.value })),
    expandMacrosForStacks: expandMacrosSpy,
  })),
  synthesisStatusMessage: vi.fn((_app: string, msg: string) => msg),
}));

vi.mock('../../../src/synthesis/stack-messages.js', async () => ({
  ...(await vi.importActual<typeof import('../../../src/synthesis/stack-messages.js')>(
    '../../../src/synthesis/stack-messages.js'
  )),
  processStackMessages: vi.fn(),
}));

/** Drive the real deploy command; `undefined` means it never called `process.exit`. */
async function runDeploy(argv: string[]): Promise<number | undefined> {
  const { createDeployCommand } = await import('../../../src/cli/commands/deploy.js');
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as never);
  try {
    await createDeployCommand().parseAsync(['node', 'cdkd', ...argv]);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    exitSpy.mockRestore();
  }
  return exitCode;
}

let app: SynthesizedApp;

beforeAll(() => {
  app = synthesizeCrossAccountApp('generated');
}, 120_000);

describe('cdkd deploy and the aws-cdk-lib-generated cross-account reference', () => {
  beforeEach(() => {
    process.env['CDKD_NO_LIVE'] = '1';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['CDKD_NO_LIVE'];
  });

  it('refuses a producer naming no lookup role before the lock, the assets and the engine', async () => {
    synthStacks.value = app.stacks.map((s) =>
      s.stackName === 'Producer' ? { ...s, lookupRoleArn: undefined } : s
    );

    const code = await runDeploy(['Consumer', '--yes']);

    expect(code).toBe(1);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('names no CDK lookup role');
    expect(message).toContain(`--trust-for-lookup ${CONSUMER_ACCOUNT}'`);
    for (const spy of [
      expandMacrosSpy,
      stsCtorSpy,
      assetPublisherCtorSpy,
      lockManagerCtorSpy,
      runRecorderSpy,
      engineCtorSpy,
      engineDeploySpy,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('does not judge a reference of a stack outside the deploy set', async () => {
    synthStacks.value = app.stacks.map((s) =>
      s.stackName === 'Producer' ? { ...s, lookupRoleArn: undefined } : s
    );

    const code = await runDeploy(['Producer', '--yes']);

    expect(code).toBeUndefined();
    expect(engineDeploySpy).toHaveBeenCalledTimes(1);
  });

  it('lets a readable reference through and hands the engine the producer lookup', async () => {
    synthStacks.value = app.stacks;

    const code = await runDeploy(['Consumer', '--yes']);

    expect(code).toBeUndefined();
    expect(engineCtorSpy).toHaveBeenCalledTimes(1);
    const options = engineCtorSpy.mock.calls[0]![5] as {
      producerLookup?: ProducerLookup;
      consumerAccount?: string;
    };
    expect(options.consumerAccount).toBe(CONSUMER_ACCOUNT);
    expect(options.producerLookup?.('Producer', PRODUCER_ACCOUNT, 'us-east-1')?.stackName).toBe(
      'Producer'
    );
  });
});
