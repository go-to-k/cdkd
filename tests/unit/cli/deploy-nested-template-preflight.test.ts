import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  refuseMalformedNestedTemplateTrees,
  refuseRemoteNestedStackRows,
} from '../../../src/cli/commands/nested-template-preflight.js';
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
    expect(message).toContain("under stack Root contains a cycle");
    expect(message).toContain('Child (');
    expect(message).toContain('BackToA (');
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
    ).toThrow(/Metadata\['aws:asset:path'\]=\/etc\/passwd which is absolute/);
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
    ).toThrow(/under stack Second contains a cycle/);
  });
});

/** The row the `AWS::SecretsManager-2024-09-16` transform expands a HostedRotation into. */
function hostedRotationTemplate(): Record<string, unknown> {
  return {
    Resources: {
      S509448A1: { Type: 'AWS::SecretsManager::Secret', Properties: {} },
      SRotF0CA8387: {
        Type: 'AWS::SecretsManager::RotationSchedule',
        Properties: {
          SecretId: { Ref: 'S509448A1' },
          RotationLambdaARN: {
            'Fn::GetAtt': ['SRotF0CA8387HostedRotationLambda', 'Outputs.RotationLambdaARN'],
          },
        },
      },
      SRotF0CA8387HostedRotationLambda: {
        Type: 'AWS::CloudFormation::Stack',
        Properties: { TemplateURL: 'https://example.s3.amazonaws.com/sam_template_v2.yml' },
        Metadata: { 'aws:cdk:path': 'Root/S/Rot/Resource' },
      },
    },
  };
}

function remoteRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Type: 'AWS::CloudFormation::Stack',
    Properties: { TemplateURL: 'https://example.com/t.yml' },
    ...extra,
  };
}

function caughtFrom(fn: () => void): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal');
}

describe('refuseRemoteNestedStackRows (issue #6385)', () => {
  it('refuses the hosted-rotation row with a non-retryable SynthesisError naming the alternative', () => {
    const err = caughtFrom(() =>
      refuseRemoteNestedStackRows([{ stackName: 'Root', template: hostedRotationTemplate() }])
    );
    expect(err).toBeInstanceOf(SynthesisError);
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(err.message).toContain(
      'AWS::CloudFormation::Stack SRotF0CA8387HostedRotationLambda in stack Root has no template'
    );
    expect(err.message).toContain('A nested stack with a remote TemplateURL is not supported.');
    expect(err.message).toContain('AWS::SecretsManager::RotationSchedule SRotF0CA8387');
    expect(err.message).toContain("addRotationSchedule's rotationLambda");
    expect(err.message).toContain(
      'Refusing to start the deploy; nothing has been published or provisioned.'
    );
  });

  it('refuses a plain remote-URL row without the hosted-rotation remedy', () => {
    const err = caughtFrom(() =>
      refuseRemoteNestedStackRows([
        // The suffix alone is not the shape: no rotation schedule of that id.
        { stackName: 'Root', template: { Resources: { XHostedRotationLambda: remoteRow() } } },
      ])
    );
    expect(err.message).toContain(
      "XHostedRotationLambda in stack Root has no template in the cloud assembly (no Metadata['aws:asset:path'])"
    );
    expect(err.message).not.toContain('rotationLambda');
    // Judged by the missing metadata only, so it names BOTH causes and both remedies.
    expect(err.message).toContain(
      'If it is a cdk.NestedStack synthesized with asset metadata disabled (the context ' +
        'aws:cdk:enable-asset-metadata set to false, or an assembly from cdk synth ' +
        '--no-asset-metadata), re-enable asset metadata and deploy again.'
    );
    expect(err.message).toContain(
      'If its TemplateURL is a remote template, that is not supported: deploy this stack with the AWS CDK CLI.'
    );
    expect(err.message).not.toContain('its TemplateURL points at');
  });

  it('passes a row that has a local template, and a stack with no nested rows', () => {
    const child = writeTemplate('child.json', {});
    expect(() =>
      refuseRemoteNestedStackRows([
        {
          stackName: 'Root',
          template: { Resources: { Child: { Type: 'AWS::CloudFormation::Stack' } } },
          nestedTemplates: { Child: child },
        },
        { stackName: 'Plain', template: { Resources: { P: { Type: 'AWS::SNS::Topic' } } } },
      ])
    ).not.toThrow();
  });

  it('leaves a conditional row to the provider: a false condition never creates it', () => {
    const notes: string[] = [];
    expect(() =>
      refuseRemoteNestedStackRows(
        [{ stackName: 'Root', template: { Resources: { R: remoteRow({ Condition: 'IsProd' }) } } }],
        (m) => notes.push(m)
      )
    ).not.toThrow();
    expect(notes).toEqual([
      'AWS::CloudFormation::Stack R in stack Root has no local template and a Condition; ' +
        'left to the deploy; a real deploy refuses it if the condition is true.',
    ]);
  });

  it('says nothing about a conditional row that has a local template', () => {
    const child = writeTemplate('child.json', {});
    const notes: string[] = [];
    refuseRemoteNestedStackRows(
      [
        {
          stackName: 'Root',
          template: {
            Resources: { C: { Type: 'AWS::CloudFormation::Stack', Condition: 'IsProd' } },
          },
          nestedTemplates: { C: child },
        },
      ],
      (m) => notes.push(m)
    );
    expect(notes).toEqual([]);
  });

  it('does not descend below a conditional local row: a false condition creates nothing under it', () => {
    const childFile = path.join(dir, 'child.json');
    fs.writeFileSync(childFile, JSON.stringify({ Resources: { Remote: remoteRow() } }));
    expect(() =>
      refuseRemoteNestedStackRows([
        {
          stackName: 'Root',
          template: {
            Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Condition: 'No' } },
          },
          nestedTemplates: { Child: childFile },
        },
      ])
    ).not.toThrow();
  });

  it('still walks a child reached first through a conditional row, then an unconditional one', () => {
    const childFile = path.join(dir, 'child.json');
    fs.writeFileSync(childFile, JSON.stringify({ Resources: { Remote: remoteRow() } }));
    const err = caughtFrom(() =>
      refuseRemoteNestedStackRows([
        {
          stackName: 'Root',
          template: {
            Resources: {
              A: { Type: 'AWS::CloudFormation::Stack', Condition: 'No' },
              B: { Type: 'AWS::CloudFormation::Stack' },
            },
          },
          nestedTemplates: { A: childFile, B: childFile },
        },
      ])
    );
    expect(err.message).toContain('Remote in nested stack Root~B');
  });

  it('refuses a remote-URL row inside a nested child, naming the owning nested stack', () => {
    const childFile = path.join(dir, 'child.json');
    fs.writeFileSync(childFile, JSON.stringify({ Resources: { Remote: remoteRow() } }));
    const err = caughtFrom(() =>
      refuseRemoteNestedStackRows([
        {
          stackName: 'Root',
          template: { Resources: { Child: { Type: 'AWS::CloudFormation::Stack' } } },
          nestedTemplates: { Child: childFile },
        },
      ])
    );
    expect(err.message).toContain(
      'AWS::CloudFormation::Stack Remote in nested stack Root~Child (under stack Root)'
    );
  });

  it('follows a child row by its aws:asset:path, two levels down', () => {
    fs.writeFileSync(
      path.join(dir, 'leaf.json'),
      JSON.stringify({ Resources: { Deep: remoteRow() } })
    );
    const mid = writeTemplate('mid.json', { Leaf: 'leaf.json' });
    const err = caughtFrom(() =>
      refuseRemoteNestedStackRows([
        {
          stackName: 'Root',
          template: { Resources: { Mid: { Type: 'AWS::CloudFormation::Stack' } } },
          nestedTemplates: { Mid: mid },
        },
      ])
    );
    expect(err.message).toContain('Deep in nested stack Root~Mid~Leaf');
  });

  it('renders a template-controlled logical id display-safely', () => {
    const err = caughtFrom(() =>
      refuseRemoteNestedStackRows([
        { stackName: 'Root', template: { Resources: { 'Evil\u001b[31m\nId': remoteRow() } } },
      ])
    );
    expect(err.message).not.toContain('\u001b');
    expect(err.message).not.toContain('\n');
    expect(isMarkedNonRetryable(err)).toBe(true);
  });
});

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
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
    info: infoSpy,
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  // Counted on `send` (the account lookup), not on construction: since
  // go-to-k/cdkd#2100 the region resolution builds a throwaway STS client
  // that only reads `config.region` and never sends, before any pre-flight.
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async () => {
      stsCtorSpy();
      return { Account: '111122223333' };
    }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: vi.fn(() => null),
  resolveApp: vi.fn(() => 'fake-app-cmd'),
  resolveCaptureObservedState: vi.fn(() => false),
  resolveUpdatePolicy: vi.fn(() => undefined),
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
  // last case, with the account lookup), so none of these absences can pass by
  // never being reachable.
  const expectNothingStarted = (): void => {
    expect(expandMacrosSpy).not.toHaveBeenCalled();
    // Not `stsCtorSpy`: the account lookup is a read that runs beside
    // synthesis (go-to-k/cdkd#5200), so it may start before the refusal.
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
    expect(message).toContain("under stack Root contains a cycle");
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
    expect(message).toContain("under stack Producer contains a cycle");
    expectNothingStarted();
  });

  it('refuses under --dry-run too, so the preview forecasts the refusal', async () => {
    const bad = writeTemplate('bad.json', { Self: 'bad.json' });
    synthStacks.value = [makeStack('Root', { nestedTemplates: { Bad: bad } })];

    const code = await runDeploy(['--yes', '--dry-run']);

    expect(code).toBe(1);
    expectNothingStarted();
  });

  it('tells the synthesizer it checks annotations itself (go-to-k/cdkd#5805)', async () => {
    // A failed context lookup reaches deploy as the app's error annotation,
    // which `--ignore-errors` may waive; without the flag the synthesizer
    // would refuse it first.
    synthStacks.value = [makeStack('Root')];
    const { Synthesizer } = await import('../../../src/synthesis/synthesizer.js');
    const synthesize = vi.fn(async (_options: unknown) => ({ stacks: synthStacks.value }));
    vi.mocked(Synthesizer).mockImplementationOnce(
      () => ({ synthesize, expandMacrosForStacks: expandMacrosSpy }) as never
    );

    await runDeploy(['--yes', '--dry-run']);

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0]![0]).toMatchObject({ failedLookupsCheckedByCaller: true });
  });

  it('forwards --no-lookups to the synthesizer (go-to-k/cdkd#6883)', async () => {
    synthStacks.value = [makeStack('Root')];
    const { Synthesizer } = await import('../../../src/synthesis/synthesizer.js');
    const synthesize = vi.fn(async (_options: unknown) => ({ stacks: synthStacks.value }));
    vi.mocked(Synthesizer).mockImplementationOnce(
      () => ({ synthesize, expandMacrosForStacks: expandMacrosSpy }) as never
    );

    await runDeploy(['--yes', '--dry-run', '--no-lookups']);

    expect(synthesize.mock.calls[0]![0]).toMatchObject({ lookups: false });
  });

  async function runWithLookups(stacks: unknown[], argv: string[]): Promise<number | undefined> {
    const { Synthesizer } = await import('../../../src/synthesis/synthesizer.js');
    const synthesize = vi.fn(async () => ({
      stacks,
      failedLookups: [{ key: 'ssm:k', error: 'AccessDenied' }],
    }));
    vi.mocked(Synthesizer).mockImplementationOnce(
      () => ({ synthesize, expandMacrosForStacks: expandMacrosSpy }) as never
    );
    return runDeploy(argv);
  }

  it('refuses a failed lookup no stack carries, before any deploy side effect (go-to-k/cdkd#5807)', async () => {
    const code = await runWithLookups([makeStack('Root')], ['--yes']);

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Context lookup failed: ssm:k: AccessDenied'
    );
    expectNothingStarted();
  });

  it('does not refuse a failed lookup an unselected stack carries (go-to-k/cdkd#5807)', async () => {
    const asking = makeStack('Asking', {
      messages: [{ level: 'error', path: '/Asking', message: 'AccessDenied' }],
    });
    const code = await runWithLookups([makeStack('Root'), asking], ['Root', '--yes', '--dry-run']);

    expect(code).toBeUndefined();
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'Context lookup failed'
    );
    expect(expandMacrosSpy).toHaveBeenCalled();
  });

  it('asks for the account id while synthesis runs, not after it (#5200)', async () => {
    synthStacks.value = [makeStack('Root')];
    const { Synthesizer } = await import('../../../src/synthesis/synthesizer.js');
    let stsSentDuringSynth = false;
    vi.mocked(Synthesizer).mockImplementationOnce(
      () =>
        ({
          synthesize: vi.fn(async () => {
            for (let i = 0; i < 50 && stsCtorSpy.mock.calls.length === 0; i++) {
              await new Promise((r) => setTimeout(r, 2));
            }
            stsSentDuringSynth = stsCtorSpy.mock.calls.length > 0;
            return { stacks: synthStacks.value };
          }),
          expandMacrosForStacks: expandMacrosSpy,
        }) as never
    );

    const code = await runDeploy(['--yes']);

    expect(code).toBeUndefined();
    expect(stsSentDuringSynth).toBe(true);
    expect(stsCtorSpy).toHaveBeenCalledTimes(1);
  });

  it('a failing account lookup fails the run where it is used, and a run refused first leaves no unhandled rejection', async () => {
    const { STSClient } = await import('@aws-sdk/client-sts');
    const failingSts = () =>
      ({
        send: vi.fn(async () => {
          stsCtorSpy();
          throw new Error('The security token included in the request is expired');
        }),
        destroy: vi.fn(),
      }) as never;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let restoreSts = (): void => undefined;
    try {
      // Refused before the lookup is read.
      const bad = writeTemplate('bad.json', { Self: 'bad.json' });
      synthStacks.value = [makeStack('Root', { nestedTemplates: { Bad: bad } })];
      // Every STS client fails: the region resolution's throwaway one never sends.
      const previous = vi.mocked(STSClient).getMockImplementation();
      vi.mocked(STSClient).mockImplementation(failingSts);
      restoreSts = () => vi.mocked(STSClient).mockImplementation(previous!);
      expect(await runDeploy(['--yes'])).toBe(1);
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'under stack Root contains a cycle'
      );

      // Read: the lookup's own error fails the run, before any asset or engine.
      errorSpy.mockClear();
      synthStacks.value = [makeStack('Root')];
      expect(await runDeploy(['--yes'])).toBe(1);
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'security token included in the request is expired'
      );
      expect(engineCtorSpy).not.toHaveBeenCalled();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      restoreSts();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('refuses a HostedRotation row the macro expansion creates, before assets, the lock and the engine (#6385)', async () => {
    // The row exists only AFTER expansion, as with the real transform: a check
    // placed before `expandMacrosForStacks` sees a template without it.
    synthStacks.value = [makeStack('Root', { template: { Resources: {} } })];
    expandMacrosSpy.mockImplementationOnce((async (stacks: Array<{ template: unknown }>) => {
      for (const s of stacks) s.template = hostedRotationTemplate();
    }) as never);

    const code = await runDeploy(['--yes']);

    expect(code).toBe(1);
    const message = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('SRotF0CA8387HostedRotationLambda in stack Root has no template');
    expect(message).toContain('nothing has been published or provisioned');
    expect(expandMacrosSpy).toHaveBeenCalledTimes(1);
    expect(assetPublisherCtorSpy).not.toHaveBeenCalled();
    expect(lockManagerCtorSpy).not.toHaveBeenCalled();
    expect(runRecorderSpy).not.toHaveBeenCalled();
    expect(engineCtorSpy).not.toHaveBeenCalled();
    expect(engineDeploySpy).not.toHaveBeenCalled();
  });

  it('logs a conditional row with no local template and lets the deploy run (#6385)', async () => {
    synthStacks.value = [
      makeStack('Root', {
        template: { Resources: { R: remoteRow({ Condition: 'IsProd' }) } },
      }),
    ];

    const code = await runDeploy(['--yes']);

    expect(code).toBeUndefined();
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContain(
      'AWS::CloudFormation::Stack R in stack Root has no local template and a Condition; ' +
        'left to the deploy; a real deploy refuses it if the condition is true.'
    );
    expect(engineDeploySpy).toHaveBeenCalledTimes(1);
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
