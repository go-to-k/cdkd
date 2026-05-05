import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

// --- Mocks --------------------------------------------------------------

// Synthesizer — only synthesize() is called.
const mockSynthesize = vi.fn();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: mockSynthesize,
  })),
}));

// AssetPublisher — addAssetsToGraph + executeNode are the surface the command
// interacts with. addAssetsToGraph is responsible for populating the supplied
// WorkGraph; the default mock implementation creates one asset-publish node
// per id it returns so executeNode actually fires during graph.execute(...).
// Tests that need to override the populated nodes can mockReturnValue /
// mockImplementation themselves.
const mockAddAssetsToGraph = vi.fn();
const mockExecuteNode = vi.fn();
vi.mock('../../../src/assets/asset-publisher.js', () => ({
  AssetPublisher: vi.fn().mockImplementation(() => ({
    addAssetsToGraph: mockAddAssetsToGraph,
    executeNode: mockExecuteNode,
  })),
}));

// config-loader so we don't read real cdk.json.
const mockResolveApp = vi.fn();
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: (cliApp?: string) => mockResolveApp(cliApp),
}));

// STS — accountId resolution.
const mockStsSend = vi.fn();
const mockStsDestroy = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: mockStsDestroy,
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({
    ...input,
    _type: 'GetCallerIdentity',
  })),
}));

// Logger — silence during tests.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { createPublishAssetsCommand } from '../../../src/cli/commands/publish-assets.js';
import { PartialFailureError } from '../../../src/utils/error-handler.js';

/**
 * Helper to build a StackInfo with sane defaults.
 */
function makeStack(overrides: Partial<StackInfo> & { stackName: string }): StackInfo {
  return {
    artifactId: overrides.stackName,
    displayName: overrides.displayName ?? overrides.stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
    assetManifestPath: `/tmp/cdk.out/${overrides.stackName}.assets.json`,
    ...overrides,
  };
}

/**
 * Run the publish-assets command via Commander and capture stdout / stderr.
 *
 * Mirrors the helper in tests/unit/cli/list.test.ts so error handling and
 * exit-code interception behave the same way across CLI tests.
 */
async function runCmd(
  args: string[]
): Promise<{ stdout: string; stderr: string; error?: Error; exitCode?: number }> {
  const cmd = createPublishAssetsCommand();
  cmd.exitOverride();

  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderrChunks: string[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  let exitCode: number | undefined;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__process.exit__');
  }) as never);
  const errorLogSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  let error: Error | undefined;
  try {
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e as Error;
  }

  const stdout = writeSpy.mock.calls.map((c) => String(c[0])).join('');
  const stderr = stderrChunks.join('');

  writeSpy.mockRestore();
  process.stderr.write = originalStderrWrite;
  exitSpy.mockRestore();
  errorLogSpy.mockRestore();

  return {
    stdout,
    stderr,
    ...(error && { error }),
    ...(exitCode !== undefined && { exitCode }),
  };
}

describe('cdkd publish-assets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveApp.mockReset();
    mockResolveApp.mockReturnValue('npx ts-node app.ts');
    mockStsSend.mockResolvedValue({ Account: '111111111111' });
    mockExecuteNode.mockResolvedValue(undefined);

    // Default `addAssetsToGraph` impl: actually populate the supplied graph
    // so a subsequent `graph.execute(...)` runs `executeNode`. Tests can
    // override this with mockReturnValue / mockImplementationOnce.
    mockAddAssetsToGraph.mockImplementation(
      (graph: { addNode: (n: unknown) => void }, _manifest: string, opts: { nodePrefix?: string }) => {
        const id = `asset-publish:${opts.nodePrefix ?? ''}file:default`;
        graph.addNode({
          id,
          type: 'asset-publish',
          dependencies: new Set(),
          state: 'pending',
          data: {},
        });
        return [id];
      }
    );
  });

  describe('synth + publish', () => {
    it('rejects --path (path-mode was removed; use -a <cdk.out> for pre-synthesized assemblies)', async () => {
      const { error } = await runCmd(['--path', '/tmp/foo.assets.json']);

      // Commander rejects unknown options before reaching the action body.
      expect(error).toBeDefined();
      expect(error?.message ?? '').toMatch(/unknown option|--path/i);
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it('forwards --asset-publish-concurrency and --image-build-concurrency to WorkGraph', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [makeStack({ stackName: 'StackA' })],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });

      const { error } = await runCmd([
        '--asset-publish-concurrency',
        '2',
        '--image-build-concurrency',
        '1',
      ]);
      expect(error).toBeUndefined();
      // The default addAssetsToGraph mock populates one node, so executeNode
      // is called via WorkGraph.execute(...) — verifies the concurrency knobs
      // reached the graph runner without exploding.
      expect(mockExecuteNode).toHaveBeenCalledTimes(1);
    });

    it('synthesizes the CDK app, then publishes assets for the auto-detected single stack', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [makeStack({ stackName: 'StackA' })],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });
      // Use the default addAssetsToGraph mock (populates graph with one node).

      const { error } = await runCmd([]);

      expect(error).toBeUndefined();
      expect(mockSynthesize).toHaveBeenCalledTimes(1);
      // Asset graph populated for the single stack.
      expect(mockAddAssetsToGraph).toHaveBeenCalledTimes(1);
      const call = mockAddAssetsToGraph.mock.calls[0]!;
      expect(call[1]).toBe('/tmp/cdk.out/StackA.assets.json');
      expect(call[2]).toEqual(
        expect.objectContaining({
          accountId: '111111111111',
          region: 'us-east-1',
          nodePrefix: 'StackA:',
        })
      );
      // executeNode is called for the single asset-publish node.
      expect(mockExecuteNode).toHaveBeenCalledTimes(1);
    });

    it('errors when --app cannot be resolved', async () => {
      mockResolveApp.mockReturnValue(undefined);

      const { error, exitCode } = await runCmd([]);
      expect(error).toBeDefined();
      expect(exitCode).toBe(1);
      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it('errors with helpful message when multiple stacks but none specified', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [makeStack({ stackName: 'StackA' }), makeStack({ stackName: 'StackB' })],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });

      const { error, exitCode } = await runCmd([]);
      expect(error).toBeDefined();
      expect(exitCode).toBe(1);
      // Synthesizer ran (we needed to know there were multiple stacks).
      expect(mockSynthesize).toHaveBeenCalledTimes(1);
      // But no asset work happened.
      expect(mockAddAssetsToGraph).not.toHaveBeenCalled();
    });

    it('selects all stacks with --all', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [
          makeStack({ stackName: 'StackA' }),
          makeStack({ stackName: 'StackB' }),
        ],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });
      // Override: each stack contributes zero assets — early return path.
      mockAddAssetsToGraph.mockReturnValue([]);

      await runCmd(['--all']);

      // addAssetsToGraph called once per stack (each with no assets in this case)
      expect(mockAddAssetsToGraph).toHaveBeenCalledTimes(2);
      const stacksHit = mockAddAssetsToGraph.mock.calls.map((c) => c[2].nodePrefix);
      expect(stacksHit).toEqual(['StackA:', 'StackB:']);
    });

    it('filters by a positional pattern', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [
          makeStack({ stackName: 'MyStage-Api', displayName: 'MyStage/Api' }),
          makeStack({ stackName: 'MyStage-Db', displayName: 'MyStage/Db' }),
          makeStack({ stackName: 'OtherStage-Api', displayName: 'OtherStage/Api' }),
        ],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });
      mockAddAssetsToGraph.mockReturnValue([]); // No assets needed for this test

      await runCmd(['MyStage/*']);

      const prefixes = mockAddAssetsToGraph.mock.calls.map((c) => c[2].nodePrefix);
      expect(prefixes).toEqual(['MyStage-Api:', 'MyStage-Db:']);
    });

    it('errors when no stacks match the positional pattern', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [makeStack({ stackName: 'StackA' })],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });

      const { error, exitCode } = await runCmd(['DoesNotExist']);
      expect(error).toBeDefined();
      expect(exitCode).toBe(1);
      expect(mockAddAssetsToGraph).not.toHaveBeenCalled();
    });

    it('skips stacks without an asset manifest path silently', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [makeStack({ stackName: 'StackA', assetManifestPath: undefined })],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });

      const { error } = await runCmd([]);
      expect(error).toBeUndefined();
      // No graph work since no manifest.
      expect(mockAddAssetsToGraph).not.toHaveBeenCalled();
    });

    it('throws PartialFailureError (exit 2) when an asset node fails', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [makeStack({ stackName: 'StackA' })],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });
      // Default addAssetsToGraph mock populates one node; reject the
      // executeNode call so the WorkGraph rejects.
      mockExecuteNode.mockRejectedValueOnce(new Error('S3 upload failed'));

      const { error, exitCode } = await runCmd([]);

      // withErrorHandling intercepts PartialFailureError and uses its
      // exitCode (2). Our exit spy throws after recording the code.
      expect(error).toBeDefined();
      expect(exitCode).toBe(2);
      expect(mockExecuteNode).toHaveBeenCalled();
    });

    it('PartialFailureError is the exception class chosen for partial failures', async () => {
      // Sanity check that we are not accidentally throwing a plain Error.
      // PartialFailureError exit code is verified above; here we just ensure
      // it remains the canonical class so import refactors don't drift.
      expect(new PartialFailureError('x').exitCode).toBe(2);
    });

    it('emits the --region deprecation warning to stderr (PR 5)', async () => {
      mockSynthesize.mockResolvedValue({
        stacks: [makeStack({ stackName: 'StackA' })],
        manifest: {},
        assemblyDir: '/tmp/cdk.out',
      });
      mockAddAssetsToGraph.mockReturnValue([]); // shortcut: no assets

      const { stderr, error } = await runCmd(['--region', 'us-east-1']);
      expect(error).toBeUndefined();
      expect(stderr).toMatch(/--region is deprecated for this command and has no effect/);
    });
  });
});
