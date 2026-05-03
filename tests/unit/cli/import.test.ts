import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    get cloudFormation() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockRetireCloudFormationStack = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ outcome: string }>>()
);
const mockGetCfnResourceMapping = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<Map<string, string>>>()
);
vi.mock('../../../src/cli/commands/retire-cfn-stack.js', () => ({
  retireCloudFormationStack: mockRetireCloudFormationStack,
  getCloudFormationResourceMapping: mockGetCfnResourceMapping,
}));

const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockGetState = vi.fn<
  (
    s: string,
    r: string
  ) => Promise<{ state: unknown; etag: string; migrationPending?: boolean } | null>
>();
const mockSaveState = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mockVerifyBucketExists,
    getState: mockGetState,
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
    mockGetState.mockReset();
    mockGetState.mockResolvedValue(null);
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
    mockRetireCloudFormationStack.mockReset();
    mockRetireCloudFormationStack.mockResolvedValue({ outcome: 'retired' });
    mockGetCfnResourceMapping.mockReset();
    mockGetCfnResourceMapping.mockResolvedValue(new Map());
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

  it('rejects auto-mode import when state already exists without --force', async () => {
    const tmpl = template({
      MyBucket: { Type: 'AWS::S3::Bucket', Properties: {}, Metadata: { 'aws:cdk:path': 'S/MyBucket' } },
    });
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
    mockGetState.mockResolvedValueOnce({
      state: {
        version: 2,
        stackName: 'S',
        region: 'us-east-1',
        resources: {},
        outputs: {},
        lastModified: 0,
      },
      etag: '"existing-etag"',
    });

    // No --resource overrides → auto / whole-stack mode → destructive →
    // --force required.
    await expect(runImport(['import', '--app', 'x'])).rejects.toThrow();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/State already exists.*--force/);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/--resource <id>=<physicalId>/);
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

  describe('--resource-mapping-inline', () => {
    const oneResource = () =>
      template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });

    it('parses inline JSON and applies it as knownPhysicalId (selective mode)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: 'inline-bucket', attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource-mapping-inline',
        '{"MyBucket":"inline-bucket"}',
        '--yes',
      ]);

      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({ logicalId: 'MyBucket', knownPhysicalId: 'inline-bucket' })
      );
    });

    it('accepts an empty JSON object (no overrides) — falls back to auto mode', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: 'tagged-bucket', attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });

      await runImport(['import', '--app', 'x', '--resource-mapping-inline', '{}', '--yes']);

      // Empty object -> no overrides -> auto mode dispatches all resources
      // through tag-based lookup with no knownPhysicalId.
      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(importSpy.mock.calls[0]![0]).not.toHaveProperty('knownPhysicalId');
    });

    it('rejects malformed inline JSON with a clear error', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport([
          'import',
          '--app',
          'x',
          '--resource-mapping-inline',
          '{not valid json}',
          '--yes',
        ])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /Failed to parse --resource-mapping-inline as JSON/
      );
    });

    it('rejects inline JSON that is not an object (e.g. an array)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport(['import', '--app', 'x', '--resource-mapping-inline', '["a","b"]', '--yes'])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /--resource-mapping-inline must be a JSON object/
      );
    });

    it('rejects inline JSON with non-string values', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport([
          'import',
          '--app',
          'x',
          '--resource-mapping-inline',
          '{"MyBucket":123}',
          '--yes',
        ])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /--resource-mapping-inline: value for 'MyBucket' must be a string/
      );
    });

    it('rejects when both --resource-mapping and --resource-mapping-inline are passed', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);

      await expect(
        runImport([
          'import',
          '--app',
          'x',
          '--resource-mapping',
          'some-file.json',
          '--resource-mapping-inline',
          '{"MyBucket":"x"}',
          '--yes',
        ])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /--resource-mapping and --resource-mapping-inline are mutually exclusive/
      );
    });

    it('lets --resource override an entry from --resource-mapping-inline (CLI wins)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: 'cli-bucket', attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource-mapping-inline',
        '{"MyBucket":"inline-bucket"}',
        '--resource',
        'MyBucket=cli-bucket',
        '--yes',
      ]);

      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({ logicalId: 'MyBucket', knownPhysicalId: 'cli-bucket' })
      );
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
      expect.objectContaining({ stackName: 'OnlyOne', region: 'us-east-1' }),
      // saveState now also receives an options object — empty when no
      // existing state was found (no etag to forward, no migration pending).
      {}
    );
  });

  describe('--record-resource-mapping', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cdkd-record-mapping-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

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
        UntouchedUnsupported: {
          Type: 'AWS::Foo::Bar',
          Properties: {},
        },
      });

    it('writes the resolved mapping with only `imported` rows (skips not-found / unsupported / failed)', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::Foo::Bar');
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'my-bucket-name', attributes: {} })) };
        }
        if (t === 'AWS::Lambda::Function') {
          // skipped-not-found
          return { import: vi.fn(async () => null) };
        }
        return {};
      });

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file, '--yes']);

      const body = readFileSync(file, 'utf-8');
      // Pretty-printed (2-space indent) + trailing newline.
      expect(body.endsWith('\n')).toBe(true);
      expect(body).toContain('  "MyBucket": "my-bucket-name"');
      const parsed = JSON.parse(body) as Record<string, string>;
      expect(parsed).toEqual({ MyBucket: 'my-bucket-name' });
      // skipped / unsupported rows must NOT appear in the file.
      expect(parsed).not.toHaveProperty('MyFn');
      expect(parsed).not.toHaveProperty('UntouchedUnsupported');
    });

    it('writes `{}` when zero resources were imported (file is still produced)', async () => {
      const tmpl = template({
        OnlyUnsupported: { Type: 'AWS::Foo::Bar', Properties: {} },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(false);

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file, '--yes']);

      const body = readFileSync(file, 'utf-8');
      expect(body).toBe('{}\n');
    });

    it('writes the mapping even when the user says "no" to the confirmation prompt', async () => {
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
        import: vi.fn(async () => ({ physicalId: 'declined-but-still-recorded', attributes: {} })),
      });
      readlineQuestion.mockResolvedValue('n');

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file]);

      // State NOT written (user said no), but the record file IS — that's
      // the whole point: the resolved data should not be thrown away.
      expect(mockSaveState).not.toHaveBeenCalled();
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
      expect(parsed).toEqual({ MyBucket: 'declined-but-still-recorded' });
    });

    it('writes the mapping under --dry-run (state save still skipped)', async () => {
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

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file, '--dry-run']);

      expect(mockSaveState).not.toHaveBeenCalled();
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
      expect(parsed).toEqual({ MyBucket: 'b' });
    });

    it('logs an error but does NOT abort the import when the file path is unwritable', async () => {
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

      // Parent directory does not exist — writeFileSync raises ENOENT.
      const unwritable = join(tmpDir, 'does', 'not', 'exist', 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', unwritable, '--yes']);

      // The import itself completed and state was written — only the
      // record file write failed.
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const errorMessages = errorSpy.mock.calls.map((c) => String(c[0]));
      expect(errorMessages.some((m) => /Failed to write --record-resource-mapping/.test(m))).toBe(
        true
      );
    });

    it('records resolved physical IDs from --auto tag-based lookup (the typical use case)', async () => {
      // This is the user-facing scenario the flag exists for: cdkd looked
      // up the physical IDs via tags, and we want that resolved mapping
      // to disk so a non-interactive CI re-run can replay it via
      // --resource-mapping.
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl3())] });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::Foo::Bar');
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'auto-bucket', attributes: {} })) };
        }
        if (t === 'AWS::Lambda::Function') {
          return { import: vi.fn(async () => ({ physicalId: 'auto-fn', attributes: {} })) };
        }
        return {};
      });

      const file = join(tmpDir, 'mapping.json');
      await runImport(['import', '--app', 'x', '--record-resource-mapping', file, '--yes']);

      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
      expect(parsed).toEqual({ MyBucket: 'auto-bucket', MyFn: 'auto-fn' });
    });
  });

  describe('merge into existing state (selective mode)', () => {
    // The user reported regression: importing a single bucket into a stack
    // whose state already contained Queue + Topic dropped the Queue + Topic
    // entries from state. Selective mode is supposed to be non-destructive
    // for unlisted resources.
    function existingState(extra: Record<string, unknown> = {}) {
      return {
        version: 2 as const,
        stackName: 'S',
        region: 'us-east-1',
        resources: {
          MyQueue: {
            physicalId: 'queue-arn',
            resourceType: 'AWS::SQS::Queue',
            properties: { QueueName: 'q' },
            attributes: { Arn: 'queue-arn' },
            dependencies: [],
          },
          MyTopic: {
            physicalId: 'topic-arn',
            resourceType: 'AWS::SNS::Topic',
            properties: { TopicName: 't' },
            attributes: { TopicArn: 'topic-arn' },
            dependencies: [],
          },
          ...extra,
        },
        outputs: { ExistingOutput: 'preserved' },
        lastModified: 100,
      };
    }

    function templateWithBucket() {
      return template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        MyQueue: {
          Type: 'AWS::SQS::Queue',
          Properties: { QueueName: 'q' },
          Metadata: { 'aws:cdk:path': 'S/MyQueue' },
        },
        MyTopic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: 't' },
          Metadata: { 'aws:cdk:path': 'S/MyTopic' },
        },
      });
    }

    it('selective merge preserves unlisted existing resources without --force', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState(),
        etag: '"existing-etag"',
      });
      mockHasProvider.mockReturnValue(true);
      const bucketImport = vi.fn(async () => ({ physicalId: 'cdkd-test-my-bucket', attributes: {} }));
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') return { import: bucketImport };
        return { import: vi.fn(async () => null) };
      });

      // No --force: this is the user's bug-report scenario.
      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=cdkd-test-my-bucket',
        '--yes',
      ]);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [, , state, options] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        {
          resources: Record<string, { physicalId: string; resourceType: string }>;
          outputs: Record<string, string>;
        },
        { expectedEtag?: string; migrateLegacy?: boolean },
      ];

      // The bug we are fixing: all three logical IDs must be in state.
      expect(Object.keys(state.resources).sort()).toEqual(['MyBucket', 'MyQueue', 'MyTopic']);
      expect(state.resources['MyBucket']?.physicalId).toBe('cdkd-test-my-bucket');
      // Existing entries preserved verbatim — physical IDs still point at AWS.
      expect(state.resources['MyQueue']?.physicalId).toBe('queue-arn');
      expect(state.resources['MyTopic']?.physicalId).toBe('topic-arn');
      // Outputs inherited from existing state (the import flow never derives them).
      expect(state.outputs).toEqual({ ExistingOutput: 'preserved' });
      // Optimistic-lock etag is forwarded so a concurrent write loses cleanly.
      expect(options.expectedEtag).toBe('"existing-etag"');
    });

    it('logs the merge plan with the preserved-resource count', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState(),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })) };
        }
        return { import: vi.fn(async () => null) };
      });

      await runImport(['import', '--app', 'x', '--resource', 'MyBucket=b', '--yes']);

      const mergeLog = infoSpy.mock.calls.find((c) => /Merging into existing state/.test(String(c[0])));
      expect(mergeLog).toBeTruthy();
      expect(String(mergeLog?.[0])).toMatch(/preserving 2 unlisted resource/);
      // No "overwriting N listed entry(ies)" suffix when there are no conflicts.
      expect(String(mergeLog?.[0])).not.toMatch(/overwriting/);
    });

    it('rejects without --force when a listed override would overwrite an existing entry', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          MyBucket: {
            physicalId: 'old-bucket-name',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'new-bucket-name', attributes: {} })),
      });

      await expect(
        runImport(['import', '--app', 'x', '--resource', 'MyBucket=new-bucket-name', '--yes'])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(
        /would overwrite resource\(s\) already in state: MyBucket/
      );
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/--force/);
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('overwrites the listed entry and preserves unlisted ones with --force', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          MyBucket: {
            physicalId: 'old-bucket-name',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'new-bucket-name', attributes: {} })),
      });

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=new-bucket-name',
        '--force',
        '--yes',
      ]);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, { physicalId: string }> },
      ];
      // Listed entry overwritten; unlisted preserved.
      expect(state.resources['MyBucket']?.physicalId).toBe('new-bucket-name');
      expect(state.resources['MyQueue']?.physicalId).toBe('queue-arn');
      expect(state.resources['MyTopic']?.physicalId).toBe('topic-arn');
    });

    it('forwards migrateLegacy when the existing state was loaded from the v1 layout', async () => {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState(),
        etag: '"legacy-etag"',
        migrationPending: true,
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })) };
        }
        return { import: vi.fn(async () => null) };
      });

      await runImport(['import', '--app', 'x', '--resource', 'MyBucket=b', '--yes']);

      const [, , , options] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        unknown,
        { expectedEtag?: string; migrateLegacy?: boolean },
      ];
      expect(options.expectedEtag).toBe('"legacy-etag"');
      expect(options.migrateLegacy).toBe(true);
    });

    it('auto-mode --force on existing state still wipes unlisted entries (whole-stack semantics)', async () => {
      // This is the existing destructive-overwrite path; --force is the
      // user's acknowledgement that they want the state rebuilt from the
      // template. Selective merge is a separate path (see above).
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', templateWithBucket())] });
      mockGetState.mockResolvedValueOnce({
        state: existingState({
          DriftedResource: {
            physicalId: 'orphan',
            resourceType: 'AWS::Foo::Bar',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        }),
        etag: '"e"',
      });
      mockHasProvider.mockReturnValue(true);
      mockGetProvider.mockImplementation((t: string) => {
        if (t === 'AWS::S3::Bucket') {
          return { import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })) };
        }
        if (t === 'AWS::SQS::Queue') {
          return { import: vi.fn(async () => ({ physicalId: 'q', attributes: {} })) };
        }
        if (t === 'AWS::SNS::Topic') {
          return { import: vi.fn(async () => ({ physicalId: 't', attributes: {} })) };
        }
        return {};
      });

      await runImport(['import', '--app', 'x', '--force', '--yes']);

      const [, , state] = mockSaveState.mock.calls[0] as unknown as [
        string,
        string,
        { resources: Record<string, unknown>; outputs: Record<string, string> },
      ];
      // DriftedResource is NOT in the template, so auto-mode rebuild drops it.
      expect(Object.keys(state.resources).sort()).toEqual(['MyBucket', 'MyQueue', 'MyTopic']);
      expect(state.resources['DriftedResource']).toBeUndefined();
      // Outputs are still inherited (they are never derived from the import flow,
      // so the auto-mode rebuild has no reason to wipe them).
      expect(state.outputs).toEqual({ ExistingOutput: 'preserved' });
    });
  });

  describe('--migrate-from-cloudformation', () => {
    const oneResource = () =>
      template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
      });

    function setupHappyPath(cfnPhysical = 'cfn-resolved-bucket'): {
      importSpy: ReturnType<typeof vi.fn>;
    } {
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', oneResource())] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: cfnPhysical, attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });
      mockGetCfnResourceMapping.mockResolvedValue(new Map([['MyBucket', cfnPhysical]]));
      return { importSpy };
    }

    it('does not invoke either CFn helper when the flag is omitted', async () => {
      setupHappyPath();
      await runImport(['import', '--app', 'x', '--yes']);
      expect(mockGetCfnResourceMapping).not.toHaveBeenCalled();
      expect(mockRetireCloudFormationStack).not.toHaveBeenCalled();
    });

    it('resolves CFn physical IDs and retires using the cdkd stack name by default', async () => {
      const { importSpy } = setupHappyPath('cfn-bucket-physical');
      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      // Physical IDs resolved from CFn before the import loop.
      expect(mockGetCfnResourceMapping).toHaveBeenCalledTimes(1);
      expect(mockGetCfnResourceMapping.mock.calls[0]![0]).toBe('S');
      // Each provider import received the CFn-resolved physical id as
      // `knownPhysicalId` — without --resource on the CLI.
      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          logicalId: 'MyBucket',
          knownPhysicalId: 'cfn-bucket-physical',
        })
      );
      // Retirement runs with the same stack name and is given the
      // resolved cdkd state bucket so the >51,200-byte TemplateURL
      // fallback can write its transient template there.
      expect(mockRetireCloudFormationStack).toHaveBeenCalledTimes(1);
      const arg = mockRetireCloudFormationStack.mock.calls[0]![0] as {
        cfnStackName: string;
        yes: boolean;
        stateBucket: string;
      };
      expect(arg.cfnStackName).toBe('S');
      expect(arg.yes).toBe(true);
      expect(arg.stateBucket).toBeDefined();
      expect(arg.stateBucket.length).toBeGreaterThan(0);
    });

    it('uses the explicit value when --migrate-from-cloudformation <name> is given', async () => {
      setupHappyPath();
      await runImport([
        'import',
        '--app',
        'x',
        '--yes',
        '--migrate-from-cloudformation',
        'LegacyCfnName',
      ]);

      // Both CFn calls target the explicit name.
      expect(mockGetCfnResourceMapping.mock.calls[0]![0]).toBe('LegacyCfnName');
      const retireArg = mockRetireCloudFormationStack.mock.calls[0]![0] as {
        cfnStackName: string;
      };
      expect(retireArg.cfnStackName).toBe('LegacyCfnName');
    });

    it('user --resource overrides take precedence over CFn-derived physical IDs', async () => {
      const tmpl = oneResource();
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      const importSpy = vi.fn(async () => ({ physicalId: 'user-said', attributes: {} }));
      mockGetProvider.mockReturnValue({ import: importSpy });
      mockGetCfnResourceMapping.mockResolvedValue(new Map([['MyBucket', 'cfn-said']]));

      await runImport([
        'import',
        '--app',
        'x',
        '--resource',
        'MyBucket=user-said',
        '--migrate-from-cloudformation',
        '--yes',
      ]);

      // The provider gets the user-supplied id, not the CFn-derived one.
      expect(importSpy).toHaveBeenCalledWith(
        expect.objectContaining({ logicalId: 'MyBucket', knownPhysicalId: 'user-said' })
      );
    });

    it('does not flip into selective mode when only --migrate-from-cloudformation is set', async () => {
      // Two template resources, both resolved by CFn. Without selective-mode
      // suppression, the populated `overrides` would otherwise force
      // selective mode and skip everything as out-of-scope.
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        MyTopic: {
          Type: 'AWS::SNS::Topic',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyTopic' },
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockReturnValue(true);
      const bucketImport = vi.fn(async () => ({ physicalId: 'b', attributes: {} }));
      const topicImport = vi.fn(async () => ({ physicalId: 't', attributes: {} }));
      mockGetProvider.mockImplementation((type: string) => {
        if (type === 'AWS::S3::Bucket') return { import: bucketImport };
        if (type === 'AWS::SNS::Topic') return { import: topicImport };
        return {};
      });
      mockGetCfnResourceMapping.mockResolvedValue(
        new Map([
          ['MyBucket', 'b-physical'],
          ['MyTopic', 't-physical'],
        ])
      );

      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      // Both providers ran (auto mode), neither resource was reported
      // out-of-scope.
      expect(bucketImport).toHaveBeenCalledTimes(1);
      expect(topicImport).toHaveBeenCalledTimes(1);
      const summaryCall = infoSpy.mock.calls.find((c) =>
        String(c[0]).startsWith('Summary:')
      );
      expect(String(summaryCall?.[0])).toMatch(/0 out of scope/);
    });

    it('orders the calls correctly: CFn mapping → import → save → retire', async () => {
      const { importSpy } = setupHappyPath();
      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      const mapOrder = mockGetCfnResourceMapping.mock.invocationCallOrder[0]!;
      const importOrder = importSpy.mock.invocationCallOrder[0]!;
      const saveOrder = mockSaveState.mock.invocationCallOrder[0]!;
      const retireOrder = mockRetireCloudFormationStack.mock.invocationCallOrder[0]!;

      expect(mapOrder).toBeLessThan(importOrder);
      expect(importOrder).toBeLessThan(saveOrder);
      expect(saveOrder).toBeLessThan(retireOrder);
    });

    it('does not retire when state write was skipped (zero successful imports)', async () => {
      // Empty template ⇒ zero imports ⇒ no state write ⇒ no retirement.
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', template({}))] });
      mockHasProvider.mockReturnValue(false);

      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      // CFn mapping still resolved (we paid the round-trip), but neither
      // saveState nor retire ran.
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockRetireCloudFormationStack).not.toHaveBeenCalled();
    });

    it('warns when a partial import leaves resources unmanaged after retirement', async () => {
      // Two-resource template, only one provider; the unimported resource
      // becomes an AWS orphan once the CFn stack is retired.
      const tmpl = template({
        MyBucket: {
          Type: 'AWS::S3::Bucket',
          Properties: {},
          Metadata: { 'aws:cdk:path': 'S/MyBucket' },
        },
        Untouched: {
          Type: 'AWS::Foo::Bar', // no provider
          Properties: {},
        },
      });
      mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', tmpl)] });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::Foo::Bar');
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
      });
      mockGetCfnResourceMapping.mockResolvedValue(
        new Map([
          ['MyBucket', 'b-physical'],
          ['Untouched', 'u-physical'],
        ])
      );

      await runImport(['import', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/1 of 2 template resource\(s\) were NOT imported/)
      );
      // Retirement still runs (warning is informational, not a refusal).
      expect(mockRetireCloudFormationStack).toHaveBeenCalledTimes(1);
    });

    it('rejects --dry-run combined with --migrate-from-cloudformation', async () => {
      setupHappyPath();

      await expect(
        runImport(['import', '--app', 'x', '--migrate-from-cloudformation', '--dry-run'])
      ).rejects.toThrow();
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/not compatible with --dry-run/);
      // Reject at parse time — never hit AWS.
      expect(mockGetCfnResourceMapping).not.toHaveBeenCalled();
      expect(mockRetireCloudFormationStack).not.toHaveBeenCalled();
    });
  });
});
