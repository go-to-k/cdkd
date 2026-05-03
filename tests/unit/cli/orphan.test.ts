import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  resolveApp: vi.fn(() => undefined),
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

const mockGetState = vi.hoisted(() => vi.fn());
const mockSaveState = vi.hoisted(() => vi.fn());
const mockListStacks = vi.hoisted(() => vi.fn());
const mockVerifyBucketExists = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    saveState: mockSaveState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn(async () => true));
const mockReleaseLock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
  })),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
}));

const mockRegisterAllProviders = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: mockRegisterAllProviders,
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: vi.fn(() => ({ getAttribute: vi.fn(async () => undefined) })),
  })),
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createOrphanCommand } from '../../../src/cli/commands/orphan.js';

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

async function runOrphan(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const cmd = createOrphanCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

function templateWith(
  metadata: Record<string, string>,
  extras: Record<string, { Type: string; cdkPath?: string }> = {}
): {
  Resources: Record<string, { Type: string; Metadata?: { 'aws:cdk:path': string } }>;
} {
  const Resources: Record<string, { Type: string; Metadata?: { 'aws:cdk:path': string } }> = {};
  for (const [logicalId, path] of Object.entries(metadata)) {
    Resources[logicalId] = {
      Type: 'AWS::S3::Bucket',
      Metadata: { 'aws:cdk:path': path },
    };
  }
  for (const [logicalId, { Type, cdkPath }] of Object.entries(extras)) {
    Resources[logicalId] = {
      Type,
      ...(cdkPath !== undefined && { Metadata: { 'aws:cdk:path': cdkPath } }),
    };
  }
  return { Resources };
}

describe('cdkd orphan (per-resource)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockSaveState.mockReset();
    mockSaveState.mockResolvedValue('"new-etag"');
    mockListStacks.mockReset();
    mockListStacks.mockResolvedValue([]);
    mockAcquireLock.mockReset();
    mockAcquireLock.mockResolvedValue(true);
    mockReleaseLock.mockReset();
    mockReleaseLock.mockResolvedValue(undefined);
    mockSynthesize.mockReset();
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

  it("hard-fails when given a stack name without a slash (no silent route to 'state orphan')", async () => {
    await expect(runOrphan(['MyStack', '--app', 'noop'])).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/cdkd orphan' now expects a construct path/);
    expect(message).toMatch(/cdkd state orphan MyStack/);
    expect(mockGetState).not.toHaveBeenCalled();
  });

  it('errors when paths reference different stacks', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'StackA',
          displayName: 'StackA',
          template: templateWith({ A: 'StackA/A' }),
          region: 'us-east-1',
        },
        {
          stackName: 'StackB',
          displayName: 'StackB',
          template: templateWith({ B: 'StackB/B' }),
          region: 'us-east-1',
        },
      ],
    });

    await expect(
      runOrphan(['StackA/A', 'StackB/B', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/All construct paths must reference the same stack/);
  });

  it('errors when no app is configured', async () => {
    await expect(runOrphan(['MyStack/MyTable'])).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/'cdkd orphan' requires a CDK app/);
  });

  it('aborts when path does not match any resource', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await expect(
      runOrphan(['MyStack/Missing', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Construct path 'MyStack\/Missing' not found/);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('succeeds, releases lock, and writes new state under --yes', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket', Other: 'MyStack/Other' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: {
          Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} },
          Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: {}, dependencies: ['Bucket'] },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockAcquireLock).toHaveBeenCalledWith('MyStack', 'us-east-1', expect.any(String), 'orphan');
    expect(mockReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [[stack, region, savedState]] = mockSaveState.mock.calls;
    expect(stack).toBe('MyStack');
    expect(region).toBe('us-east-1');
    expect(savedState.resources.Bucket).toBeUndefined();
    expect(savedState.resources.Other.dependencies).not.toContain('Bucket');
  });

  it('skips lock + save on --dry-run', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runOrphan(['MyStack/Bucket', '--app', 'noop', '--dry-run']);

    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('surfaces lock acquisition failure', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockAcquireLock.mockRejectedValue(new Error('locked by another process'));

    await expect(
      runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it('disambiguates with --stack-region when state has multiple regions', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
        },
      ],
    });
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-east-1' },
      { stackName: 'MyStack', region: 'us-west-2' },
    ]);

    // Without --stack-region: should error.
    await expect(
      runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/multiple regions/);

    // With --stack-region us-west-2: should target the right region.
    errorSpy.mockReset();
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-west-2',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });
    await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes', '--stack-region', 'us-west-2']);
    expect(mockGetState).toHaveBeenLastCalledWith('MyStack', 'us-west-2');
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(mockSaveState.mock.calls[0]?.[1]).toBe('us-west-2');
  });

  it('resolves an L2 construct path to the synthesized L1 child resource', async () => {
    // The user passes the L2 path (`MyStack/MyConstruct/MyBucket2`) but the
    // template's `aws:cdk:path` carries the synthesized L1 form
    // (`.../MyBucket2/Resource`). Mirrors `cdk orphan --unstable=orphan`.
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({
            Bucket1Resource: 'MyStack/MyConstruct/MyBucket1/Resource',
            Bucket2Resource: 'MyStack/MyConstruct/MyBucket2/Resource',
          }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: {
          Bucket1Resource: { physicalId: 'b1', resourceType: 'AWS::S3::Bucket', properties: {} },
          Bucket2Resource: { physicalId: 'b2', resourceType: 'AWS::S3::Bucket', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runOrphan(['MyStack/MyConstruct/MyBucket2', '--app', 'noop', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [[, , savedState]] = mockSaveState.mock.calls;
    expect(savedState.resources.Bucket2Resource).toBeUndefined();
    expect(savedState.resources.Bucket1Resource).toBeDefined();
  });

  it('orphans every child under an L2 wrapper construct in one call', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({
            Bucket1Resource: 'MyStack/MyConstruct/MyBucket1/Resource',
            Bucket2Resource: 'MyStack/MyConstruct/MyBucket2/Resource',
            Other: 'MyStack/Other',
          }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: {
          Bucket1Resource: { physicalId: 'b1', resourceType: 'AWS::S3::Bucket', properties: {} },
          Bucket2Resource: { physicalId: 'b2', resourceType: 'AWS::S3::Bucket', properties: {} },
          Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await runOrphan(['MyStack/MyConstruct', '--app', 'noop', '--yes']);

    const [[, , savedState]] = mockSaveState.mock.calls;
    expect(savedState.resources.Bucket1Resource).toBeUndefined();
    expect(savedState.resources.Bucket2Resource).toBeUndefined();
    expect(savedState.resources.Other).toBeDefined();
  });

  it('omits AWS::CDK::Metadata from the available-paths error and refuses to orphan it', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith(
            { Bucket: 'MyStack/Bucket' },
            {
              CDKMetadata: { Type: 'AWS::CDK::Metadata', cdkPath: 'MyStack/CDKMetadata/Default' },
            }
          ),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });

    await expect(
      runOrphan(['MyStack/CDKMetadata/Default', '--app', 'noop', '--yes'])
    ).rejects.toThrow();
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Construct path 'MyStack\/CDKMetadata\/Default' not found/);
    // Available-paths list must NOT mention the CDKMetadata path.
    const availableSection = message.split('Available paths:')[1] ?? '';
    expect(availableSection).not.toMatch(/CDKMetadata/);
    expect(availableSection).toMatch(/MyStack\/Bucket/);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('cancels when the user answers empty at the confirmation prompt', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: templateWith({ Bucket: 'MyStack/Bucket' }),
          region: 'us-east-1',
        },
      ],
    });
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'MyStack',
        region: 'us-east-1',
        resources: { Bucket: { physicalId: 'b', resourceType: 'AWS::S3::Bucket', properties: {} } },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });
    readlineQuestion.mockResolvedValue('');

    await runOrphan(['MyStack/Bucket', '--app', 'noop']);

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(mockSaveState).not.toHaveBeenCalled();
  });
});
