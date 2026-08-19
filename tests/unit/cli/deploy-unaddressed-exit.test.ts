import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue [#1960](https://github.com/go-to-k/cdkd/issues/1960) — `cdkd deploy`
 * must exit 2 when it finishes having left a resource unaddressed, matching
 * what `cdkd destroy` has done for the identical outcome since #1752.
 *
 * The test drives the REAL commander command through `parseAsync` and asserts
 * on `process.exit`, rather than unit-testing an extracted predicate. The
 * arithmetic here (sum two counters, compare to zero, honor a boolean) is
 * trivial and would pass in isolation even if nothing called it — the thing
 * that can actually break is the WIRING: that the counters are summed across
 * stacks, that the flag reaches the decision, and that the throw is placed
 * where a genuine deploy failure still wins. So the exit code is the
 * assertion.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
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
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
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
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    setCustomResourceResponseBucket: vi.fn(),
    getProvider: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
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
  AssetPublisher: vi.fn().mockImplementation(() => ({
    addAssetsToGraph: vi.fn(() => []),
    executeNode: vi.fn(async () => undefined),
  })),
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
  startRunRecorder: vi.fn(() => undefined),
  recordRunSucceeded: vi.fn(),
  recordRunFailed: vi.fn(),
}));

/**
 * Per-stack deploy results the mocked engine hands back, keyed by stack name.
 * Set by each test before `runDeploy`.
 */
const engineResults = vi.hoisted(
  () => new Map<string, { deleteSkipped: number; updatePartial: number }>()
);

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => ({
    deploy: vi.fn(async (stackName: string) => {
      const counts = engineResults.get(stackName) ?? { deleteSkipped: 0, updatePartial: 0 };
      return {
        stackName,
        created: 1,
        updated: 0,
        deleted: 0,
        deleteSkipped: counts.deleteSkipped,
        updatePartial: counts.updatePartial,
        unchanged: 0,
        durationMs: 10,
        outputs: {},
        attributeFallbackCount: 0,
      };
    }),
  })),
}));

const synthStacks = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn(async () => ({ stacks: synthStacks.value })),
    expandMacrosForStacks: vi.fn(async () => undefined),
  })),
  synthesisStatusMessage: vi.fn((_app: string, msg: string) => msg),
}));

vi.mock('../../../src/synthesis/stack-messages.js', () => ({
  processStackMessages: vi.fn(),
}));

function makeStack(stackName: string) {
  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
  };
}

/**
 * Drive the real deploy command and return the code it exited with.
 *
 * `process.exit` is replaced with a throw so the run unwinds at exactly the
 * point the real CLI would terminate; `undefined` means the command returned
 * without calling `process.exit` at all, which is the success path.
 */
async function runDeploy(argv: string[]): Promise<number | undefined> {
  const { createDeployCommand } = await import('../../../src/cli/commands/deploy.js');
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as never);
  try {
    // Commander's `parseAsync` expects argv WITHOUT the leading subcommand
    // name when the command object is parsed directly.
    await createDeployCommand().parseAsync(['node', 'cdkd', ...argv]);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__process_exit__') throw err;
  } finally {
    exitSpy.mockRestore();
  }
  return exitCode;
}

describe('deploy exit code when resources are left unaddressed (issue #1960)', () => {
  beforeEach(() => {
    engineResults.clear();
    synthStacks.value = [makeStack('StackA')];
    errorSpy.mockClear();
    warnSpy.mockClear();
    infoSpy.mockClear();
    process.env['CDKD_NO_LIVE'] = '1';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exits 0 on a clean deploy that leaves nothing unaddressed', async () => {
    const code = await runDeploy(['--yes']);
    expect(code).toBeUndefined();
  });

  it('exits 2 when a template DELETE was skipped by the provider', async () => {
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    const code = await runDeploy(['--yes']);
    expect(code).toBe(2);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('1 resource(s) unaddressed');
  });

  it('exits 2 when a replacement left an orphaned predecessor', async () => {
    engineResults.set('StackA', { deleteSkipped: 0, updatePartial: 1 });
    const code = await runDeploy(['--yes']);
    expect(code).toBe(2);
  });

  it('sums both cases across every stack in a multi-stack run', async () => {
    synthStacks.value = [makeStack('StackA'), makeStack('StackB')];
    engineResults.set('StackA', { deleteSkipped: 2, updatePartial: 1 });
    engineResults.set('StackB', { deleteSkipped: 0, updatePartial: 3 });
    const code = await runDeploy(['--all', '--yes']);
    expect(code).toBe(2);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // 2 + 1 + 0 + 3 — a per-stack throw would have reported 3 and never
    // reached StackB; a counter that only read one field would report 2 or 4.
    expect(message).toContain('6 resource(s) unaddressed');
  });

  it('exits 0 for the same run when --allow-unaddressed is passed', async () => {
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 1 });
    const code = await runDeploy(['--yes', '--allow-unaddressed']);
    expect(code).toBeUndefined();
  });

  it('still warns about the survivors under --allow-unaddressed', async () => {
    // The flag suppresses the EXIT CODE only. A run that silently dropped the
    // warning too would leave the user with no signal at all, which is the
    // failure mode the flag must not create.
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 1 });
    await runDeploy(['--yes', '--allow-unaddressed']);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('2 resource(s) were left unaddressed');
    expect(warned).toContain('--allow-unaddressed');
  });

  it('names the exit code in the per-stack warning when the flag is absent', async () => {
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    await runDeploy(['--yes']);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('will exit 2');
  });

  it('does not claim the deploy completed successfully when a resource survived', async () => {
    // The exit code was only half of what issue #1960 reported: this banner
    // said the run succeeded while an AWS resource cdkd owned was still alive.
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    await runDeploy(['--yes']);
    const printed = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('Deployment completed successfully');
  });

  it('suppresses the success banner under --allow-unaddressed too', async () => {
    // The flag opts out of the EXIT CODE. Restoring the "completed
    // successfully" banner alongside it would re-create the mis-report in the
    // one place the operator actually reads.
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    await runDeploy(['--yes', '--allow-unaddressed']);
    const printed = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('Deployment completed successfully');
  });

  it('still prints the success banner on a clean deploy', async () => {
    // Guards the assertions above from passing for the wrong reason — a
    // banner that never printed at all would satisfy both `not.toContain`s.
    const code = await runDeploy(['--yes']);
    expect(code).toBeUndefined();
    const printed = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Deployment completed successfully');
  });
});
