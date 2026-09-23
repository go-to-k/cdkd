import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { refuseMalformedNestedTemplateTrees } from '../../../src/cli/commands/nested-template-preflight.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { SynthesisError } from '../../../src/utils/error-handler.js';

/**
 * Issue go-to-k/cdkd#3449: a cyclic (or otherwise malformed) nested-template
 * tree is refused by `cdkd deploy` BEFORE asset publishing, the lock and the
 * root engine, not only at the nested-stack row.
 *
 * The second describe drives the REAL commander command, because what can
 * break is the PLACEMENT: a call that exists but sits after the work graph is
 * built passes any test of the helper alone. So it asserts on the things that
 * must not have happened yet when the run exits.
 */

let dir: string;

function writeTemplate(name: string, rows: Record<string, string>): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const Resources: Record<string, unknown> = {
    Param: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: 'v' } },
  };
  for (const [logicalId, assetPath] of Object.entries(rows)) {
    Resources[logicalId] = {
      Type: 'AWS::CloudFormation::Stack',
      Metadata: { 'aws:asset:path': assetPath },
    };
  }
  fs.writeFileSync(file, JSON.stringify({ Resources }));
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-nested-preflight-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('refuseMalformedNestedTemplateTrees', () => {
  it('passes a stack with no nested-stack rows without reading anything', () => {
    expect(() => refuseMalformedNestedTemplateTrees([{ stackName: 'Plain' }])).not.toThrow();
  });

  it('passes an acyclic tree, including a diamond', () => {
    writeTemplate('leaf.json', {});
    const a = writeTemplate('a.json', { Leaf: 'leaf.json' });
    const b = writeTemplate('b.json', { Leaf: 'leaf.json' });
    expect(() =>
      refuseMalformedNestedTemplateTrees([{ stackName: 'Root', nestedTemplates: { A: a, B: b } }])
    ).not.toThrow();
  });

  it('refuses a cycle with a non-retryable SynthesisError naming the stack and the rows', () => {
    const a = writeTemplate('a.json', { ToB: 'b.json' });
    writeTemplate('b.json', { BackToA: 'a.json' });
    let caught: unknown;
    try {
      refuseMalformedNestedTemplateTrees([{ stackName: 'Root', nestedTemplates: { Child: a } }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SynthesisError);
    const message = (caught as Error).message;
    expect(message).toContain("under stack 'Root' contains a cycle");
    expect(message).toContain("'Child'");
    expect(message).toContain("'BackToA'");
    expect(message).toContain(
      'Refusing to start the deploy; nothing has been published or provisioned.'
    );
    expect(isMarkedNonRetryable(caught)).toBe(true);
  });

  it('stays non-retryable when a logical id spells a retryable AWS phrase', () => {
    // The classifier matches SUBSTRINGS and a logical id is template-controlled.
    const a = writeTemplate('a.json', { 'Rate exceeded': 'a.json' });
    let caught: unknown;
    try {
      refuseMalformedNestedTemplateTrees([{ stackName: 'Root', nestedTemplates: { Child: a } }]);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('Rate exceeded');
    expect(isMarkedNonRetryable(caught)).toBe(true);
  });

  it('refuses an absolute aws:asset:path below the top level', () => {
    const a = writeTemplate('a.json', { Abs: '/etc/passwd' });
    expect(() =>
      refuseMalformedNestedTemplateTrees([{ stackName: 'Root', nestedTemplates: { Child: a } }])
    ).toThrow(/Metadata\['aws:asset:path'\]='\/etc\/passwd' which is absolute/);
  });

  it('renders a template-controlled logical id display-safely', () => {
    const a = writeTemplate('a.json', { 'Evil\u001b[31m\nId': 'a.json' });
    let caught: unknown;
    try {
      refuseMalformedNestedTemplateTrees([{ stackName: 'Root', nestedTemplates: { Child: a } }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SynthesisError);
    expect((caught as Error).message).not.toContain('\u001b');
    expect((caught as Error).message).not.toContain('\n');
  });

  it('checks every selected stack, not only the first', () => {
    writeTemplate('leaf.json', {});
    const ok = writeTemplate('ok.json', { Leaf: 'leaf.json' });
    const bad = writeTemplate('bad.json', { Self: 'bad.json' });
    expect(() =>
      refuseMalformedNestedTemplateTrees([
        { stackName: 'First', nestedTemplates: { Ok: ok } },
        { stackName: 'Second', nestedTemplates: { Bad: bad } },
      ])
    ).toThrow(/under stack 'Second' contains a cycle/);
  });
});

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
  resolveApp: vi.fn(() => 'fake-app-cmd'),
  resolveCaptureObservedState: vi.fn(() => false),
  resolveAutoAssetStorage: vi.fn(() => false),
  resolveSkipPrefix: vi.fn(() => false),
  resolvePermissionsBoundary: vi.fn(() => undefined),
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
  LockManager: vi.fn().mockImplementation(() => {
    lockManagerCtorSpy();
    return { acquireLock: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() };
  }),
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
  DeployEngine: vi.fn().mockImplementation(() => {
    engineCtorSpy();
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

describe('cdkd deploy refuses a malformed nested-template tree pre-flight (issue #3449)', () => {
  beforeEach(() => {
    process.env['CDKD_NO_LIVE'] = '1';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['CDKD_NO_LIVE'];
  });

  // Every spy here fires exactly once on the well-formed path (asserted in the
  // last case), so none of these absences can pass by never being reachable.
  const expectNothingStarted = (): void => {
    expect(expandMacrosSpy).not.toHaveBeenCalled();
    expect(stsCtorSpy).not.toHaveBeenCalled();
    expect(assetPublisherCtorSpy).not.toHaveBeenCalled();
    expect(lockManagerCtorSpy).not.toHaveBeenCalled();
    expect(runRecorderSpy).not.toHaveBeenCalled();
    expect(engineCtorSpy).not.toHaveBeenCalled();
    expect(engineDeploySpy).not.toHaveBeenCalled();
  };

  it('exits 1 with the cycle named, before assets, the lock and the engine', async () => {
    const a = writeTemplate('a.json', { ToB: 'b.json' });
    writeTemplate('b.json', { BackToA: 'a.json' });
    synthStacks.value = [makeStack('Root', { nestedTemplates: { Child: a } })];

    const code = await runDeploy(['--yes']);

    expect(code).toBe(1);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain("under stack 'Root' contains a cycle");
    expect(message).toContain('nothing has been published or provisioned');
    expectNothingStarted();
  });

  it('refuses the whole run when only a later stack of the set is malformed', async () => {
    const bad = writeTemplate('bad.json', { Self: 'bad.json' });
    synthStacks.value = [
      makeStack('Clean'),
      makeStack('Cyclic', { nestedTemplates: { Bad: bad } }),
    ];

    const code = await runDeploy(['--all', '--yes', '--stack-concurrency', '2']);

    expect(code).toBe(1);
    expectNothingStarted();
  });

  it('does not judge a malformed stack that is outside the selection', async () => {
    const bad = writeTemplate('bad.json', { Self: 'bad.json' });
    synthStacks.value = [
      makeStack('Clean'),
      makeStack('Cyclic', { nestedTemplates: { Bad: bad } }),
    ];

    const code = await runDeploy(['Clean', '--yes']);

    expect(code).toBeUndefined();
    expect(engineDeploySpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a stack pulled in only as a dependency of the selection', async () => {
    const bad = writeTemplate('bad.json', { Self: 'bad.json' });
    synthStacks.value = [
      makeStack('Consumer', { dependencyNames: ['Producer'] }),
      makeStack('Producer', { nestedTemplates: { Bad: bad } }),
    ];

    const code = await runDeploy(['Consumer', '--yes']);

    expect(code).toBe(1);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain("under stack 'Producer' contains a cycle");
    expectNothingStarted();
  });

  it('refuses under --dry-run too, so the preview forecasts the refusal', async () => {
    const bad = writeTemplate('bad.json', { Self: 'bad.json' });
    synthStacks.value = [makeStack('Root', { nestedTemplates: { Bad: bad } })];

    const code = await runDeploy(['--yes', '--dry-run']);

    expect(code).toBe(1);
    expectNothingStarted();
  });

  it('lets a well-formed nested tree through to the engine', async () => {
    writeTemplate('leaf.json', {});
    const a = writeTemplate('a.json', { Leaf: 'leaf.json' });
    synthStacks.value = [makeStack('Root', { nestedTemplates: { Child: a } })];

    const code = await runDeploy(['--yes']);

    expect(code).toBeUndefined();
    for (const spy of [
      expandMacrosSpy,
      stsCtorSpy,
      assetPublisherCtorSpy,
      lockManagerCtorSpy,
      runRecorderSpy,
      engineCtorSpy,
      engineDeploySpy,
    ]) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });
});
