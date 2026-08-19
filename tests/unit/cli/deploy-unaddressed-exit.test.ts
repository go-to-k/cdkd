import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeployCancelledError } from '../../../src/utils/error-handler.js';

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
/** Observable so the RUN_FINISHED result can be asserted, not just the exit code. */
const runOutcomeSpy = vi.hoisted(() => vi.fn());
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
  recordRunOutcome: runOutcomeSpy,
  recordRunFailed: vi.fn(),
}));

/**
 * Per-stack deploy results the mocked engine hands back, keyed by stack name.
 * Set by each test before `runDeploy`.
 */
const engineResults = vi.hoisted(
  () => new Map<string, { deleteSkipped: number; updatePartial: number }>()
);

/** Stack names whose deploy should throw, for the failure-precedence case. */
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
    failingStacks.clear();
    cancelledStacks.clear();
    synthStacks.value = [makeStack('StackA')];
    errorSpy.mockClear();
    warnSpy.mockClear();
    infoSpy.mockClear();
    runOutcomeSpy.mockClear();
    process.env['CDKD_NO_LIVE'] = '1';
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Vitest reuses a worker across files; leaving this set would silently
    // disable the live renderer for whatever runs next in the same process.
    delete process.env['CDKD_NO_LIVE'];
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
    // Deliberately NOT a promise that the run "will exit 2": in a multi-stack
    // run a later stack can still FAIL, and a real failure takes precedence
    // with exit 1.
    expect(warned).toContain('counts toward a non-zero exit');
    expect(warned).toContain('--allow-unaddressed');
  });

  it('does not claim the deploy completed successfully when a resource survived', async () => {
    // The exit code was only half of what issue #1960 reported: this banner
    // said the run succeeded while an AWS resource cdkd owned was still alive.
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    await runDeploy(['--yes']);
    const printed = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // Positive anchor: without it, a mutation that threw BEFORE the summary
    // block would satisfy the absence assertion while printing nothing at all.
    expect(printed).toContain('Deployment Summary:');
    expect(printed).not.toContain('Deployment completed successfully');
  });

  it('suppresses the success banner under --allow-unaddressed too', async () => {
    // The flag opts out of the EXIT CODE. Restoring the "completed
    // successfully" banner alongside it would re-create the mis-report in the
    // one place the operator actually reads.
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    await runDeploy(['--yes', '--allow-unaddressed']);
    const printed = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Deployment Summary:');
    expect(printed).not.toContain('Deployment completed successfully');
  });

  it('lets a genuine deploy failure keep the exit code (1, not 2)', async () => {
    // Precedence: the unaddressed throw sits AFTER `workGraph.execute`, so a
    // stack that actually FAILED rejects out of execute first and exits 1.
    // Reporting 2 here would tell CI "completed, some resources survived" for a
    // run that did not complete — the opposite of what this change is for.
    // Mirrors destroy.ts, which checks `totalErrors` before `totalSkipped`.
    synthStacks.value = [makeStack('StackA'), makeStack('StackB')];
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    failingStacks.add('StackB');
    const code = await runDeploy(['--all', '--yes']);
    expect(code).toBe(1);
    // Pin that StackA actually contributed. Without this the case passes
    // vacuously if the counter never incremented -- exit 1 would then be
    // proving nothing about precedence.
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('1 resource(s) were left unaddressed');
  });

  it('keeps exit 1 for a failing stack even under --allow-unaddressed', async () => {
    // The flag opts out of the NEW throw only. If it were read as a blanket
    // "do not fail this deploy", a real provisioning failure would start
    // reporting success -- far worse than the mis-report this issue fixed.
    synthStacks.value = [makeStack('StackA'), makeStack('StackB')];
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    failingStacks.add('StackB');
    const code = await runDeploy(['--all', '--yes', '--allow-unaddressed']);
    expect(code).toBe(1);
  });

  it('reports the per-stack count, not the run total, in each stack banner', async () => {
    // TWO DIRTY stacks with DIFFERENT counts, deliberately. The obvious shape
    // -- one dirty stack plus one clean one -- cannot falsify the interpolation:
    // a clean stack never enters the warn arm at all (the guard reads
    // `stackUnaddressed`), so swapping the interpolated value for the run-level
    // `totalUnaddressed` would still print nothing over it and the assertion
    // would pass. With 1 and 2, the run total is 3 and neither banner may say
    // it.
    synthStacks.value = [makeStack('StackA'), makeStack('StackB')];
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    engineResults.set('StackB', { deleteSkipped: 0, updatePartial: 2 });
    const code = await runDeploy(['--all', '--yes']);
    expect(code).toBe(2);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('1 resource(s) were left unaddressed');
    expect(warned).toContain('2 resource(s) were left unaddressed');
    expect(warned).not.toContain('3 resource(s) were left unaddressed');
  });

  it('keeps a clean stack in a mixed run on its success banner', async () => {
    // The other half of the mixed-run case: the dirty stack must not drag the
    // clean one's verdict with it.
    synthStacks.value = [makeStack('StackA'), makeStack('StackB')];
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    const code = await runDeploy(['--all', '--yes']);
    expect(code).toBe(2);
    const printed = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Deployment completed successfully');
  });

  it('does not count unaddressed resources under --dry-run', async () => {
    // The engine hard-codes both counters to 0 on its dry-run returns, so this
    // pins the CLI-side guard rather than the engine's invariant: a future dry
    // run that PREVIEWED "would be skipped" must not make --dry-run exit 2.
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 1 });
    const code = await runDeploy(['--yes', '--dry-run']);
    expect(code).toBeUndefined();
  });

  it("records the run as FAILED in the events store, not SUCCEEDED", async () => {
    // The durable post-mortem must agree with the exit code. Recording
    // SUCCEEDED for a run that returned 2 is the same split verdict this issue
    // closed for the console banner. `cdkd destroy` already records FAILED for
    // the identical outcome.
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    await runDeploy(['--yes']);
    // Asserted positionally rather than with toHaveBeenCalledWith, so the case
    // pins the RESULT and the survivor count without also pinning the recorder
    // handle and duration, which belong to the mock rather than to this change.
    const [, stackName, result, counts] = runOutcomeSpy.mock.calls[0] ?? [];
    expect(stackName).toBe('StackA');
    expect(result).toBe('FAILED');
    expect(counts).toMatchObject({ skipped: 1 });
  });

  it('records FAILED under --allow-unaddressed too', async () => {
    // The flag opts out of the exit code, not out of what happened. An events
    // store that flipped to SUCCEEDED with the flag would make the durable
    // record depend on the caller's tolerance rather than on the run.
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    await runDeploy(['--yes', '--allow-unaddressed']);
    const [, , result, counts] = runOutcomeSpy.mock.calls[0] ?? [];
    expect(result).toBe('FAILED');
    expect(counts).toMatchObject({ skipped: 1 });
  });

  it('records a clean run as SUCCEEDED', async () => {
    // Positive control for the two cases above: without it, a mutation that
    // hard-coded FAILED everywhere would satisfy both.
    await runDeploy(['--yes']);
    const [, , result, counts] = runOutcomeSpy.mock.calls[0] ?? [];
    expect(result).toBe('SUCCEEDED');
    // A clean run must not carry the survivor counter at all — `skipped` is
    // omitted when zero, and an always-present `skipped: 0` would train the
    // reader of `cdkd events` to ignore the field.
    expect(counts).not.toHaveProperty('skipped');
  });

  it('says a cancelled stack never deployed instead of implying the rest applied', async () => {
    // A cancelled stack unwinds with a bare `return`, so its work-graph node
    // COMPLETES and the run reaches the unaddressed throw. A message naming
    // only the survivors would read as "everything else was applied".
    synthStacks.value = [makeStack('StackA'), makeStack('StackB')];
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    cancelledStacks.add('StackB');
    const code = await runDeploy(['--all', '--yes']);
    expect(code).toBe(2);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('1 stack(s) were also cancelled and never deployed');
  });

  it('omits the cancellation note when nothing was cancelled', async () => {
    engineResults.set('StackA', { deleteSkipped: 1, updatePartial: 0 });
    await runDeploy(['--yes']);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).not.toContain('never deployed');
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
