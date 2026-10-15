import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/publish-assets.ts` slice: the per-stack catch wrapped a
 * non-`Error` with `new Error(String(err))` and moved on to the next stack,
 * which turned "publish stack B even if stack A fails" into a hard failure when
 * the value could not be converted -- `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`.
 *
 * The case rejects stack A's asset-mode lookup with exactly that value and
 * asserts the DEGRADATION still happens (stack B is published, the run ends in
 * the partial-failure exit 2), never merely "it did not throw". The placeholder
 * is asserted too, so a fix that swallowed the failure without reporting it
 * would not pass.
 */

const {
  mockSynthesize,
  mockAddAssetsToGraph,
  mockExecuteNode,
  mockModeResolve,
  mockLoggerError,
  mockLoggerInfo,
} = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockSynthesize: vi.fn(),
  mockAddAssetsToGraph: vi.fn(),
  mockExecuteNode: vi.fn(),
  mockModeResolve: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => ({
    addAssetsToGraph: mockAddAssetsToGraph,
    executeNode: mockExecuteNode,
  })),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: vi.fn(() => 'node app.ts'),
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(async () => ({ Account: '111111111111' })),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

// A publishable manifest for every stack, so each one reaches the marker read.
vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/assets/asset-redirect.js')>()),
  loadPublishableAssetManifest: () => ({ version: '38.0.0', files: {}, dockerImages: {} }),
}));
vi.mock('../../../src/assets/asset-storage.js', () => ({
  AssetModeResolver: vi.fn().mockImplementation(() => ({ resolve: mockModeResolve })),
}));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  getAwsClients: vi.fn(() => ({})),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: mockLoggerError,
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { createPublishAssetsCommand } from '../../../src/cli/commands/publish-assets.js';

const PLACEHOLDER = 'a value that could not be converted to text';

function makeStack(stackName: string): StackInfo {
  return {
    stackName,
    artifactId: stackName,
    displayName: stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
    assetManifestPath: `/tmp/cdk.out/${stackName}.assets.json`,
  };
}

async function runCmd(args: string[]): Promise<number | undefined> {
  const cmd = createPublishAssetsCommand();
  cmd.exitOverride();
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process.exit__');
  }) as never);
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch {
    // The exit spy's throw; the code is what is asserted.
  } finally {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  }
  return exitCode;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteNode.mockResolvedValue(undefined);
  mockAddAssetsToGraph.mockImplementation(
    (graph: { addNode: (n: unknown) => void }, _manifest: string, opts: { nodePrefix: string }) => {
      const id = `asset-publish:${opts.nodePrefix}file:default`;
      graph.addNode({ id, type: 'asset-publish', dependencies: new Set(), state: 'pending', data: {} });
      return [id];
    }
  );
});

describe('cdkd publish-assets with an unconvertible per-stack rejection (#3361)', () => {
  it('records the failing stack and still publishes the next one', async () => {
    mockSynthesize.mockResolvedValue({
      stacks: [makeStack('StackA'), makeStack('StackB')],
      manifest: {},
      assemblyDir: '/tmp/cdk.out',
    });
    mockModeResolve
      .mockRejectedValueOnce(Object.create(null))
      .mockResolvedValueOnce({ mode: 'legacy' });

    const exitCode = await runCmd(['--all']);

    expect(mockAddAssetsToGraph.mock.calls.map((c) => c[2].nodePrefix)).toEqual(['StackB:']);
    expect(mockExecuteNode).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(2);
    expect(mockLoggerError.mock.calls.map((c) => String(c[0]))).toContain(
      `  ✗ StackA: ${PLACEHOLDER}`
    );
    expect(mockLoggerInfo.mock.calls.map((c) => String(c[0]))).toContain(
      `  ✗ StackA — failed: ${PLACEHOLDER}`
    );
  });
});
