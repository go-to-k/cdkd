import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  createMigrateCommand,
  migrateCommandAction,
  type MigrateCommandOptions,
} from '../../../../../src/cli/commands/migrate-command.js';
import { LocalMigrateError } from '../../../../../src/utils/error-handler.js';

/**
 * Mock the library + import + role-arn + retire helpers — every flag
 * the orchestrator threads through them should land in their argv. The
 * mocks let us assert the orchestrator's plumbing without spinning up
 * real AWS calls. Direct `migrateCommandAction` invocations bypass
 * Commander + `withErrorHandling`, so any throw bubbles back to the
 * test and the `expect(...).rejects.toBeInstanceOf(LocalMigrateError)`
 * assertion works against the typed error.
 */
const mocks = vi.hoisted(() => ({
  runMigrateLibrary: vi.fn(),
  runImport: vi.fn(),
  applyRoleArnIfSet: vi.fn(),
  retireCloudFormationStack: vi.fn(),
  writeMappingFile: vi.fn(),
  // T2: mock the readline `question(...)` call so the interactive
  // confirm prompt is exercised without a real TTY. Default 'y' (the
  // common path); tests override per-case for 'n' / 'yes' / 'no'.
  readlineQuestion: vi.fn().mockResolvedValue('y'),
  readlineClose: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: mocks.readlineQuestion,
    close: mocks.readlineClose,
  }),
}));

vi.mock('../../../../../src/cli/commands/migrate/index.js', () => ({
  runMigrateLibrary: mocks.runMigrateLibrary,
}));
vi.mock('../../../../../src/cli/commands/import.js', () => ({
  runImport: mocks.runImport,
}));
vi.mock('../../../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: mocks.applyRoleArnIfSet,
}));
vi.mock('../../../../../src/cli/commands/retire-cfn-stack.js', () => ({
  retireCloudFormationStack: mocks.retireCloudFormationStack,
}));
vi.mock('../../../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'cdkd-state-mocked'),
  resolveApp: vi.fn(() => undefined),
}));
vi.mock('../../../../../src/utils/aws-clients.js', () => ({
  AwsClients: class {
    cloudFormation = {};
    destroy = vi.fn();
  },
}));
vi.mock('../../../../../src/cli/commands/migrate/resource-mapping-file.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../../src/cli/commands/migrate/resource-mapping-file.js')
  >('../../../../../src/cli/commands/migrate/resource-mapping-file.js');
  return {
    ...actual,
    // Override writeMappingFile to no-op against the fake `/tmp/MyStack`
    // directory the runMigrateLibrary mock returns. Tests that exercise
    // the file's real contents go through the dedicated
    // `resource-mapping-file.test.ts` instead.
    writeMappingFile: (...args: unknown[]) => {
      mocks.writeMappingFile(...args);
      return '/tmp/MyStack/cdkd-resource-mapping.json';
    },
  };
});

/**
 * Stable RunMigrateLibraryResult fixture. Tests can clone and mutate
 * fields per-case rather than constructing from scratch.
 */
function defaultLibResult() {
  return {
    outputDir: '/tmp/MyStack',
    assemblyDir: '/tmp/MyStack/cdk.out',
    templateBody: {
      Resources: {
        SourceA: {
          Type: 'AWS::S3::Bucket',
          Properties: { BucketName: 'a' },
          Metadata: { 'aws:cdk:path': 'MyStack/SourceA' },
        },
      },
    },
    sourceCfnTemplate: {
      Resources: { SourceA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'a' } } },
    },
    sourceResources: [
      {
        LogicalResourceId: 'SourceA',
        PhysicalResourceId: 'phys-a',
        ResourceType: 'AWS::S3::Bucket',
      },
    ],
  };
}

function baseOptions(overrides: Partial<MigrateCommandOptions> = {}): MigrateCommandOptions {
  return {
    fromCfnStack: 'MyStack',
    yes: true,
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.runMigrateLibrary.mockResolvedValue(defaultLibResult());
  mocks.runImport.mockResolvedValue(undefined);
  mocks.applyRoleArnIfSet.mockResolvedValue(undefined);
  mocks.retireCloudFormationStack.mockResolvedValue(undefined);
  mocks.readlineQuestion.mockResolvedValue('y');
});

describe('migrateCommandAction — argv plumbing through to runMigrateLibrary', () => {
  it('threads --from-cfn-stack into runMigrateLibrary', async () => {
    await migrateCommandAction(undefined, baseOptions());
    expect(mocks.runMigrateLibrary).toHaveBeenCalledTimes(1);
    const args = mocks.runMigrateLibrary.mock.calls[0]![0]! as Record<string, unknown>;
    expect(args.fromCfnStack).toBe('MyStack');
  });

  it('accepts the source stack as a positional argument when --from-cfn-stack is absent', async () => {
    await migrateCommandAction('MyStack', { yes: true });
    const args = mocks.runMigrateLibrary.mock.calls[0]![0]! as Record<string, unknown>;
    expect(args.fromCfnStack).toBe('MyStack');
  });

  it('threads --region / --account / --filter / --skip-install through to the library', async () => {
    await migrateCommandAction(
      undefined,
      baseOptions({
        region: 'us-west-2',
        account: '999999999999',
        filter: ['a=b', 'c=d'],
        skipInstall: true,
      })
    );
    const args = mocks.runMigrateLibrary.mock.calls[0]![0]! as Record<string, unknown>;
    expect(args).toMatchObject({
      region: 'us-west-2',
      account: '999999999999',
      filters: ['a=b', 'c=d'],
      skipInstall: true,
    });
  });

  it('--skip-synth returns early without invoking runImport', async () => {
    mocks.runMigrateLibrary.mockResolvedValueOnce({
      ...defaultLibResult(),
      templateBody: null, // library returns null when skipSynth is set
    });
    await migrateCommandAction(undefined, baseOptions({ skipSynth: true }));
    expect(mocks.runImport).not.toHaveBeenCalled();
  });
});

describe('migrateCommandAction — mutual-exclusion guards', () => {
  it('rejects --retire-cfn-stack + --skip-synth at parse time (before any AWS call)', async () => {
    await expect(
      migrateCommandAction(undefined, baseOptions({ retireCfnStack: true, skipSynth: true }))
    ).rejects.toBeInstanceOf(LocalMigrateError);
    await expect(
      migrateCommandAction(undefined, baseOptions({ retireCfnStack: true, skipSynth: true }))
    ).rejects.toThrow(/incompatible with --skip-synth/);
    // Bonus: no library call should have fired.
    expect(mocks.runMigrateLibrary).not.toHaveBeenCalled();
  });

  it('rejects --retire-cfn-stack + --dry-run', async () => {
    await expect(
      migrateCommandAction(undefined, baseOptions({ retireCfnStack: true, dryRun: true }))
    ).rejects.toThrow(/incompatible with --dry-run/);
  });

  it('rejects --retire-cfn-stack + --filter', async () => {
    await expect(
      migrateCommandAction(undefined, baseOptions({ retireCfnStack: true, filter: ['a=b'] }))
    ).rejects.toThrow(/incompatible with --filter/);
  });

  it('rejects missing --from-cfn-stack and missing positional', async () => {
    await expect(migrateCommandAction(undefined, { yes: true })).rejects.toThrow(
      /Missing required argument/
    );
  });
});

describe('migrateCommandAction — orchestration flow', () => {
  it('calls runImport with synth-id → physical-id map and yes:true (no double-prompt)', async () => {
    await migrateCommandAction(undefined, baseOptions());
    expect(mocks.runImport).toHaveBeenCalledTimes(1);
    const [stackArg, importOpts] = mocks.runImport.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(stackArg).toBe('MyStack');
    expect(importOpts.app).toBe('/tmp/MyStack/cdk.out');
    expect(importOpts.resourceMappingInline).toBe(JSON.stringify({ SourceA: 'phys-a' }));
    expect(importOpts.yes).toBe(true);
  });

  it('--dry-run skips runImport entirely', async () => {
    await migrateCommandAction(undefined, baseOptions({ dryRun: true }));
    expect(mocks.runImport).not.toHaveBeenCalled();
  });

  it('--retire-cfn-stack invokes retireCloudFormationStack after runImport', async () => {
    await migrateCommandAction(undefined, baseOptions({ retireCfnStack: true }));
    expect(mocks.runImport).toHaveBeenCalledTimes(1);
    expect(mocks.retireCloudFormationStack).toHaveBeenCalledTimes(1);
    const retireArgs = mocks.retireCloudFormationStack.mock.calls[0]![0]! as Record<
      string,
      unknown
    >;
    expect(retireArgs.cfnStackName).toBe('MyStack');
  });

  it('--role-arn calls applyRoleArnIfSet before runMigrateLibrary', async () => {
    await migrateCommandAction(
      undefined,
      baseOptions({ roleArn: 'arn:aws:iam::123456789012:role/MyMigrateRole' })
    );
    expect(mocks.applyRoleArnIfSet).toHaveBeenCalledTimes(1);
    const applyOrder = mocks.applyRoleArnIfSet.mock.invocationCallOrder[0]!;
    const libOrder = mocks.runMigrateLibrary.mock.invocationCallOrder[0]!;
    expect(applyOrder).toBeLessThan(libOrder);
  });

  it('errors as LocalMigrateError when unmatched resources remain after auto-mapping', async () => {
    mocks.runMigrateLibrary.mockResolvedValueOnce({
      ...defaultLibResult(),
      templateBody: {
        Resources: {
          // No synth resource matches SourceB at all.
          SourceA: {
            Type: 'AWS::S3::Bucket',
            Properties: { BucketName: 'a' },
            Metadata: { 'aws:cdk:path': 'MyStack/SourceA' },
          },
        },
      },
      sourceCfnTemplate: {
        Resources: {
          SourceA: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'a' } },
          SourceB: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 't' } },
        },
      },
      sourceResources: [
        {
          LogicalResourceId: 'SourceA',
          PhysicalResourceId: 'phys-a',
          ResourceType: 'AWS::S3::Bucket',
        },
        {
          LogicalResourceId: 'SourceB',
          PhysicalResourceId: 'phys-b',
          ResourceType: 'AWS::SNS::Topic',
        },
      ],
    });
    await expect(migrateCommandAction(undefined, baseOptions())).rejects.toBeInstanceOf(
      LocalMigrateError
    );
    expect(mocks.runImport).not.toHaveBeenCalled();
  });
});

describe('createMigrateCommand — Commander registration', () => {
  it('registers a `migrate` subcommand', () => {
    const cmd = createMigrateCommand();
    expect(cmd.name()).toBe('migrate');
  });

  it('declares every documented flag (T4)', () => {
    // Extended in T4 from the prior 5-flag spot-check to assert every
    // long-form Option the design doc commits to. A removal here is a
    // CLI-surface regression — bumps semantic-release MAJOR.
    const cmd = createMigrateCommand();
    const optNames = cmd.options.map((o) => o.long);
    const expectedLongFlags = [
      '--from-cfn-stack',
      '--output-dir',
      '--language',
      '--region',
      '--account',
      '--retire-cfn-stack',
      '--filter',
      '--skip-install',
      '--skip-synth',
      '--dry-run',
      '--yes',
      '--cdk-bin',
      '--resource-mapping',
      '--state-bucket',
      '--state-prefix',
      '--profile',
      '--role-arn',
      '--verbose',
    ];
    for (const flag of expectedLongFlags) {
      expect(optNames, `expected --${flag.replace(/^--/, '')} to be declared`).toContain(flag);
    }
  });

  it('declares the -y short alias on --yes (T4)', () => {
    const cmd = createMigrateCommand();
    const yesOpt = cmd.options.find((o) => o.long === '--yes');
    expect(yesOpt?.short).toBe('-y');
  });

  it('parseAsync pipeline routes through migrateCommandAction (T3)', async () => {
    // T3: invoke the full Commander parseAsync pipeline (not just the
    // action handler directly) so the option-parse layer is exercised
    // alongside the orchestrator. Stub `.action` to a synchronous
    // recorder per memory rule `feedback_cmd_parse_action_stub.md` —
    // Node 24 escalates the real handler's process.exit() chain to a
    // process-level unhandled rejection AFTER the assertion passes.
    let receivedArgs: unknown[] | undefined;
    const cmd = createMigrateCommand();
    cmd.action((...args: unknown[]) => {
      receivedArgs = args;
    });
    // `from: 'user'` parses the array verbatim (no node/script-name pair
    // to skip), so the positional arg goes first.
    await cmd.parseAsync(['PositionalStack', '--dry-run', '--yes'], { from: 'user' });
    expect(receivedArgs).toBeDefined();
    // Commander passes (positionalArg, options, command) to .action.
    expect(receivedArgs![0]).toBe('PositionalStack');
    const options = receivedArgs![1] as Record<string, unknown>;
    expect(options['dryRun']).toBe(true);
    expect(options['yes']).toBe(true);
  });

  it('--from-cfn-stack flag parses correctly via parseAsync (T3 b)', async () => {
    // T3 b: prove the long-form flag actually lands on `options.fromCfnStack`
    // (Commander camelCases). Catches a future regression where the
    // flag is renamed but the option key stays.
    let receivedOptions: Record<string, unknown> | undefined;
    const cmd = createMigrateCommand();
    cmd.action((_arg: unknown, options: Record<string, unknown>) => {
      receivedOptions = options;
    });
    await cmd.parseAsync(['--from-cfn-stack', 'MyStack', '--yes'], { from: 'user' });
    expect(receivedOptions?.['fromCfnStack']).toBe('MyStack');
  });
});

describe('migrateCommandAction — prompt confirmation flow (T1, T2)', () => {
  it('rejects with LocalMigrateError when stdin is non-TTY and --yes is absent (T1)', async () => {
    // T1: force the non-TTY rejection branch by overriding the stdin
    // descriptor. The full pipeline should reject BEFORE writing state.
    const original = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      await expect(
        migrateCommandAction(undefined, baseOptions({ yes: false }))
      ).rejects.toBeInstanceOf(LocalMigrateError);
      expect(mocks.runImport).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });

  it('exits cleanly (no state written) when user answers "n" at the prompt (T2)', async () => {
    // T2: simulate an interactive shell where the user rejects the
    // confirm. The orchestrator should log a cancellation and skip the
    // import + retire calls entirely. The `node:readline/promises`
    // mock at the top of this file routes the question() result through
    // mocks.readlineQuestion.
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mocks.readlineQuestion.mockResolvedValueOnce('n');

    try {
      await migrateCommandAction(
        undefined,
        baseOptions({ yes: false, retireCfnStack: false })
      );
      expect(mocks.runImport).not.toHaveBeenCalled();
      expect(mocks.retireCloudFormationStack).not.toHaveBeenCalled();
      expect(mocks.readlineQuestion).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });
});

describe('migrateCommandAction — --resource-mapping load path (t6)', () => {
  it('loads explicit overrides from a temp file via --resource-mapping', async () => {
    // t6: write a temp mapping file, point --resource-mapping at it,
    // assert the runImport call receives the override-applied
    // resourceMappingInline payload.
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'cdkd-mapping-'));
    const tmpFile = join(tmp, 'mapping.json');
    writeFileSync(
      tmpFile,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-05-22T00:00:00.000Z',
        sourceStack: 'MyStack',
        outputStack: 'MyStack',
        mapping: { SourceA: 'SourceA' },
      })
    );

    await migrateCommandAction(undefined, baseOptions({ resourceMapping: tmpFile }));

    expect(mocks.runImport).toHaveBeenCalledTimes(1);
    const importOpts = mocks.runImport.mock.calls[0]![1]! as Record<string, unknown>;
    // The default fixture's SourceA still maps to phys-a; --resource-mapping
    // here is a no-op override (same target) but exercises the load path.
    expect(importOpts.resourceMappingInline).toBe(JSON.stringify({ SourceA: 'phys-a' }));
  });

  it('hard-errors when --resource-mapping points to a missing file (t6 b)', async () => {
    await expect(
      migrateCommandAction(
        undefined,
        baseOptions({ resourceMapping: '/tmp/does-not-exist-cdkd-migrate-fixture.json' })
      )
    ).rejects.toBeInstanceOf(LocalMigrateError);
  });
});

describe('migrateCommandAction — retire ordering (t7)', () => {
  it('runImport completes BEFORE retireCloudFormationStack on --retire-cfn-stack', async () => {
    // t7: ordering assertion using invocation-call-order (same shape
    // as the existing applyOrder < libOrder assertion above). A
    // regression where retire fires before import would leave the
    // source CFn stack DELETED without cdkd state being written.
    await migrateCommandAction(undefined, baseOptions({ retireCfnStack: true }));
    expect(mocks.runImport).toHaveBeenCalledTimes(1);
    expect(mocks.retireCloudFormationStack).toHaveBeenCalledTimes(1);
    const importOrder = mocks.runImport.mock.invocationCallOrder[0]!;
    const retireOrder = mocks.retireCloudFormationStack.mock.invocationCallOrder[0]!;
    expect(importOrder).toBeLessThan(retireOrder);
  });
});
