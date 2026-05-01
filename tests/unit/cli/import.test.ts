import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'cdk-out'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockStateExists = vi.fn<(s: string, r: string) => Promise<boolean>>();
const mockSaveState = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mockVerifyBucketExists,
    stateExists: mockStateExists,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.fn<() => Promise<void>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
  })),
}));

const mockSynthesize = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// Provider registry: hoisted spies so each test can configure has/get + provider.import.
const mockHasProvider = vi.hoisted(() => vi.fn<(t: string) => boolean>());
const mockGetProvider = vi.hoisted(() => vi.fn<(t: string) => unknown>());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    hasProvider: mockHasProvider,
    getProvider: mockGetProvider,
  })),
}));

// readline confirmation prompt — scriptable via readlineQuestion.mockResolvedValue.
const readlineQuestion = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createImportCommand } from '../../../src/cli/commands/import.js';

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function runImport(args: string[]): Promise<string> {
  // When parseAsync is called directly on the import command (vs through the
  // parent program), the leading 'import' would be treated as the [stack]
  // positional arg. Drop it so the test args read naturally as the user
  // would type them.
  const realArgs = args[0] === 'import' ? args.slice(1) : args;
  const cap = captureStdout();
  try {
    const cmd = createImportCommand();
    cmd.exitOverride();
    await cmd.parseAsync(realArgs, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

function template(resources: CloudFormationTemplate['Resources']): CloudFormationTemplate {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: resources,
  };
}

function stackInfo(name: string, tmpl: CloudFormationTemplate, region = 'us-east-1') {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: tmpl,
    dependencyNames: [],
    region,
  };
}

describe('cdkd import', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    mockStateExists.mockReset();
    mockStateExists.mockResolvedValue(false);
    mockSaveState.mockReset();
    mockSaveState.mockResolvedValue('"new-etag"');
    mockAcquireLock.mockReset();
    mockAcquireLock.mockResolvedValue();
    mockReleaseLock.mockReset();
    mockReleaseLock.mockResolvedValue();
    mockSynthesize.mockReset();
    mockHasProvider.mockReset();
    mockGetProvider.mockReset();
    readlineQuestion.mockReset();
    readlineClose.mockReset();
    errorSpy.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('rejects when CDK app is not configured', async () => {
    // Override resolveApp to return undefined (no cdk.json).
    const cl = await import('../../../src/cli/config-loader.js');
    (cl.resolveApp as unknown as { mockReturnValueOnce: (v: undefined) => void }).mockReturnValueOnce(undefined);

    await expect(runImport(['import'])).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/requires a CDK app/);
  });

  it('rejects when state already exists without --force', async () => {
    const tmpl = template({
      MyBucket: { Type: 'AWS::S3::Bucket', Properties: {}, Metadata: { 'aws:cdk:path': 'S/MyBucket' } },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockStateExists.mockResolvedValueOnce(true);

    await expect(runImport(['import', '--app', 'x'])).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/State already exists.*--force/);
  });

  it('rejects when stack name is unknown', async () => {
    const tmpl = template({});
    mockSynthesize.mockResolvedValue({
      stacks: [stackInfo('A', tmpl), stackInfo('B', tmpl)],
    });

    await expect(runImport(['import', 'NonExistent', '--app', 'x'])).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/Stack 'NonExistent' not found/);
  });

  it('reports import outcomes per resource and writes state', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
      MyFn: {
        Type: 'AWS::Lambda::Function',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyFn' },
      },
      Untouched: {
        Type: 'AWS::Foo::Bar', // unsupported
        Properties: {},
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });

    mockHasProvider.mockImplementation((t: string) => t !== 'AWS::Foo::Bar');
    mockGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return { import: vi.fn(async () => ({ physicalId: 'my-bucket-name', attributes: {} })) };
      }
      if (t === 'AWS::Lambda::Function') {
        return { import: vi.fn(async () => null) }; // not found
      }
      return {};
    });

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , state] = mockSaveState.mock.calls[0] as unknown as [string, string, { resources: Record<string, unknown> }];
    expect(Object.keys(state.resources)).toEqual(['MyBucket']);

    // Summary line should reflect the 1/1/1 split.
    const summaryCall = infoSpy.mock.calls.find((c) => String(c[0]).startsWith('Summary:'));
    expect(String(summaryCall?.[0])).toMatch(/1 imported, 1 not found, 1 unsupported/);
  });

  it('passes --resource overrides through as knownPhysicalId', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    const importSpy = vi.fn(async () => ({ physicalId: 'manual-bucket', attributes: {} }));
    mockGetProvider.mockReturnValue({ import: importSpy });

    await runImport(['import', '--app', 'x', '--resource', 'MyBucket=manual-bucket', '--yes']);

    expect(importSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalId: 'MyBucket',
        knownPhysicalId: 'manual-bucket',
      })
    );
  });

  it('--dry-run skips state save and the confirmation prompt', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    });

    await runImport(['import', '--app', 'x', '--dry-run']);

    expect(mockSaveState).not.toHaveBeenCalled();
    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/--dry-run: state will NOT be written/)
    );
  });

  it('respects "n" at the confirmation prompt', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    });
    readlineQuestion.mockResolvedValue('n');

    await runImport(['import', '--app', 'x']);

    expect(mockSaveState).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('Import cancelled.');
  });

  it('does not write state when zero resources were successfully imported', async () => {
    const tmpl = template({
      OnlyUnsupported: {
        Type: 'AWS::Foo::Bar',
        Properties: {},
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(false);

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/No resources were successfully imported/)
    );
  });

  it('rejects malformed --resource values', async () => {
    const tmpl = template({});
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });

    await expect(
      runImport(['import', '--app', 'x', '--resource', 'badformat', '--yes'])
    ).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/expects 'logicalId=physicalId'/);
  });

  it('lock is released even when the import fails mid-flight', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => {
        throw new Error('AWS API blew up');
      }),
    });

    await runImport(['import', '--app', 'x', '--yes']);

    // Provider failure becomes a 'failed' row, not a thrown error — so the
    // command still completes. saveState is skipped (no successful imports).
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  describe('selective vs auto mode (CDK CLI parity)', () => {
    const tmpl3 = () =>
      template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        MyFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyFn' },
        },
        MyTable: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyTable' },
        },
      });

    it('selective mode: --resource imports ONLY listed resources, others go out-of-scope', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockReturnValue(true);

      const bucketImport = vi.fn(async () => ({ physicalId: 'manual-bucket', attributes: {} }));
      const fnImport = vi.fn(async () => ({ physicalId: 'tagged-fn', attributes: {} }));
      const tableImport = vi.fn(async () => ({ physicalId: 'tagged-table', attributes: {} }));
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') return { import: bucketImport };
        if (t === 'AWS::Lambda::Function') return { import: fnImport };
        if (t === 'AWS::DynamoDB::Table') return { import: tableImport };
        return {};
      });

      await runImport(['import', '--app', 'x', '--resource', 'MyBucket=manual-bucket', '--yes']);

      // Only MyBucket should have hit a provider — MyFn and MyTable are
      // skipped at the dispatcher, never reaching the provider.
      expect(bucketImport).toHaveBeenCalledTimes(1);
      expect(fnImport).not.toHaveBeenCalled();
      expect(tableImport).not.toHaveBeenCalled();

      // State carries only MyBucket.
      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, unknown> },
      ];
      expect(Object.keys(state.resources)).toEqual(['MyBucket']);

      // Summary calls out the out-of-scope count.
      const summaryCall = infoSpy.mock.calls.find((c) => String(c[0]).startsWith('Summary:'));
      expect(String(summaryCall?.[0])).toMatch(/2 out of scope/);
    });

    it('--auto with --resource: explicit ID for listed, tag-import for the rest', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockReturnValue(true);

      const bucketImport = vi.fn(async () => ({ physicalId: 'manual-bucket', attributes: {} }));
      const fnImport = vi.fn(async () => ({ physicalId: 'tagged-fn', attributes: {} }));
      const tableImport = vi.fn(async () => ({ physicalId: 'tagged-table', attributes: {} }));
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') return { import: bucketImport };
        if (t === 'AWS::Lambda::Function') return { import: fnImport };
        if (t === 'AWS::DynamoDB::Table') return { import: tableImport };
        return {};
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=manual-bucket',
        '--auto',
        '--yes',
      ]);

      // All three providers hit. MyBucket gets explicit knownPhysicalId; the
      // others go through tag-based lookup with no override.
      expect(bucketImport).toHaveBeenCalledWith(
        expect.objectContaining({ logicalId: 'MyBucket', knownPhysicalId: 'manual-bucket' })
      );
      // The other two have no `knownPhysicalId` key at all (the spread
      // omits it when no override exists) — they go through tag-based
      // lookup. Use `not.toHaveProperty` to assert absence.
      expect(fnImport).toHaveBeenCalledWith(expect.objectContaining({ logicalId: 'MyFn' }));
      expect(fnImport.mock.calls[0]![0]).not.toHaveProperty('knownPhysicalId');
      expect(tableImport).toHaveBeenCalledWith(expect.objectContaining({ logicalId: 'MyTable' }));
      expect(tableImport.mock.calls[0]![0]).not.toHaveProperty('knownPhysicalId');

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, unknown> },
      ];
      expect(Object.keys(state.resources).sort()).toEqual(['MyBucket', 'MyFn', 'MyTable']);
    });

    it('no flags: auto-imports every resource via tags (cdkd default)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockReturnValue(true);

      const bucketImport = vi.fn(async () => ({ physicalId: 'b', attributes: {} }));
      const fnImport = vi.fn(async () => ({ physicalId: 'f', attributes: {} }));
      const tableImport = vi.fn(async () => ({ physicalId: 't', attributes: {} }));
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') return { import: bucketImport };
        if (t === 'AWS::Lambda::Function') return { import: fnImport };
        if (t === 'AWS::DynamoDB::Table') return { import: tableImport };
        return {};
      });

      await runImport(['import', '--app', 'x', '--yes']);

      expect(bucketImport).toHaveBeenCalledTimes(1);
      expect(fnImport).toHaveBeenCalledTimes(1);
      expect(tableImport).toHaveBeenCalledTimes(1);
    });

    it('rejects --resource with a logical ID not in the template', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport(['import', '--app', 'x', '--resource', 'TypoLogicalId=foo', '--yes'])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/'TypoLogicalId'.*not in the synthesized template/);
    });
  });

  it('auto-selects the single stack when no positional arg is given', async () => {
    const tmpl = template({
      MyBucket: {
        Type: 'AWS::S3::Bucket',
        Properties: {},
        Metadata: { 'aws:cdk:path': 'S/MyBucket' },
      },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('OnlyOne', tmpl)] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    });

    await runImport(['import', '--app', 'x', '--yes']);

    expect(mockSaveState).toHaveBeenCalledWith(
      'OnlyOne',
      'us-east-1',
      expect.objectContaining({ stackName: 'OnlyOne', region: 'us-east-1' })
    );
  });
});
