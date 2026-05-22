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

  it('declares the --from-cfn-stack option', () => {
    const cmd = createMigrateCommand();
    const optNames = cmd.options.map((o) => o.long);
    expect(optNames).toContain('--from-cfn-stack');
    expect(optNames).toContain('--retire-cfn-stack');
    expect(optNames).toContain('--dry-run');
    expect(optNames).toContain('--yes');
    expect(optNames).toContain('--resource-mapping');
  });
});
