import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/orphan.ts` slice: the lock-release handler stringified its
 * caught value with a bare `String()`, which turned a graceful degradation into
 * a hard failure when the value could not be converted --
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`.
 *
 * The case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the orphan is saved, the command resolves), never merely "it did not
 * throw". The placeholder is asserted too, so a fix that swallowed the failure
 * without reporting it would not pass.
 */

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
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
const mockSaveState = vi.hoisted(() => vi.fn(async () => '"new-etag"'));
const mockListStacks = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    saveState: mockSaveState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    rotateCreateTokenNonce: vi.fn(async () => undefined),
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn(async () => true));
const mockReleaseLock = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: vi.fn(async () => null),
    releaseLock: mockReleaseLock,
  })),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: vi.fn(() => ({ getAttribute: vi.fn(async () => undefined) })),
  })),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: vi.fn(async () => 'n'), close: vi.fn() })),
}));

import { createOrphanCommand } from '../../../src/cli/commands/orphan.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

async function runOrphan(args: string[]): Promise<{ error: unknown }> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let error: unknown;
  try {
    const cmd = createOrphanCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = original;
  }
  return { error };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockResolvedValue(undefined);
  mockSaveState.mockResolvedValue('"new-etag"');
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
});
afterEach(() => {
  exitSpy.mockRestore();
});

describe('cdkd orphan (#3361)', () => {
  it('saves the orphan and resolves when the lock release rejects with an unconvertible value', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'MyStack',
          displayName: 'MyStack',
          template: {
            Resources: {
              Bucket: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': 'MyStack/Bucket' } },
              Other: { Type: 'AWS::S3::Bucket', Metadata: { 'aws:cdk:path': 'MyStack/Other' } },
            },
          },
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
          Other: { physicalId: 'o', resourceType: 'AWS::S3::Bucket', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"e"',
    });
    mockReleaseLock.mockRejectedValueOnce(unconvertible());

    const { error } = await runOrphan(['MyStack/Bucket', '--app', 'noop', '--yes']);

    expect(error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const savedState = (mockSaveState.mock.calls[0] as unknown as unknown[])[2] as {
      resources: Record<string, unknown>;
    };
    expect(Object.keys(savedState.resources)).toEqual(['Other']);
    expect(mockReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    const line = warnings().find((w) => w.includes('Failed to release lock: '));
    expect(line).toBeDefined();
    expect(line).toContain(PLACEHOLDER);
  });
});
