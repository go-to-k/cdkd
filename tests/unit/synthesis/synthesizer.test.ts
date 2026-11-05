import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Capture what AppExecutor.execute receives
const mockExecute = vi.fn();
const mockReadManifest = vi.fn();
const mockAssemblyStacks = vi.fn();
const mockContextStoreLoad = vi.fn();
const mockContextStoreSave = vi.fn();
const mockResolve = vi.fn();

// Mock AppExecutor
vi.mock('../../../src/synthesis/app-executor.js', () => ({
  AppExecutor: vi.fn().mockImplementation(() => ({
    execute: mockExecute,
  })),
}));

// Mock AssemblyReader
vi.mock('../../../src/synthesis/assembly-reader.js', () => ({
  AssemblyReader: vi.fn().mockImplementation(() => ({
    readManifest: mockReadManifest,
    // `Synthesizer` reads through `readAssembly`, which returns the stacks in
    // a record. `getAllStacks` is deliberately NOT stubbed: a production call
    // to it would fail loudly here rather than pass silently.
    readAssembly: (...args: unknown[]) => ({ stacks: mockAssemblyStacks(...args) }),
  })),
}));

// Mock ContextStore
vi.mock('../../../src/synthesis/context-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/synthesis/context-store.js')>()),
  ContextStore: vi.fn().mockImplementation(() => ({
    load: mockContextStoreLoad,
    save: mockContextStoreSave,
  })),
}));

// Mock ContextProviderRegistry
vi.mock('../../../src/synthesis/context-providers/index.js', () => ({
  ContextProviderRegistry: vi.fn().mockImplementation(() => ({
    resolve: mockResolve,
  })),
}));

// Mock config-loader
const mockLoadCdkJson = vi.fn();
const mockLoadUserCdkJson = vi.fn();
vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: () => mockLoadCdkJson(),
  loadUserCdkJson: () => mockLoadUserCdkJson(),
}));

// Mock STS
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '123456789012' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

// Mock node:fs
const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  statSync: (...args: unknown[]) => mockStatSync(...args),
}));

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { Synthesizer } from '../../../src/synthesis/synthesizer.js';
import { stageLoadError } from '../../../src/synthesis/failed-stages.js';

describe('Synthesizer', () => {
  let synthesizer: Synthesizer;

  beforeEach(() => {
    vi.clearAllMocks();
    synthesizer = new Synthesizer();

    // Default: no missing context, return empty stacks
    mockReadManifest.mockReturnValue({ version: '38.0.0', artifacts: {} });
    mockAssemblyStacks.mockReturnValue([]);
    mockExecute.mockResolvedValue(undefined);
    mockContextStoreLoad.mockReturnValue({});
    mockResolve.mockResolvedValue({});
    mockLoadCdkJson.mockReturnValue(null);
    mockLoadUserCdkJson.mockReturnValue(null);
    // Default: --app is treated as a shell command (no existing directory)
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ isDirectory: () => false });
  });

  describe('missing-context loop (go-to-k/cdkd#5805)', () => {
    const ssmKey = 'ssm:account=123456789012:parameterName=/ecr/repo/latest-image-tag:region=us-east-1';
    const manifestMissing = (keys: readonly string[]) => ({
      version: '38.0.0',
      artifacts: {},
      missing: keys.map((key) => ({ key, provider: 'ssm', props: {} })),
    });

    it('uses the assembly when the app reports the SAME missing key again (AWS CDK CLI parity)', async () => {
      // A construct that calls `reportMissingContextKey` unconditionally: the
      // key is in `missing` after every synth, resolved or not.
      mockReadManifest.mockReturnValue(manifestMissing([ssmKey]));
      mockAssemblyStacks.mockReturnValue([{ stackName: 'App' }]);

      const result = await synthesizer.synthesize({ app: 'node app.ts' });

      expect(result.stacks).toEqual([{ stackName: 'App' }]);
      // One lookup round, then the re-synth that reported the same key.
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockContextStoreSave).toHaveBeenCalledTimes(1);
    });

    it('keeps resolving while the missing keys change', async () => {
      mockReadManifest
        .mockReturnValueOnce(manifestMissing(['a']))
        .mockReturnValueOnce(manifestMissing(['a', 'b']))
        .mockReturnValueOnce(manifestMissing(['a', 'b']));

      await synthesizer.synthesize({ app: 'node app.ts' });

      expect(mockExecute).toHaveBeenCalledTimes(3);
      expect(mockContextStoreSave).toHaveBeenCalledTimes(2);
    });

    it("hands a failed lookup's unsaved $providerError to the app's next run", async () => {
      // The app turns `$providerError` into an error annotation; dropping it
      // (it is never written to cdk.context.json) would leave the app only
      // reporting the key missing again, and the failure would vanish.
      const failed = { $providerError: 'SSM parameter not found: /p', $dontSaveContext: true };
      mockReadManifest.mockReturnValue(manifestMissing([ssmKey]));
      mockResolve.mockResolvedValueOnce({ [ssmKey]: failed });

      await synthesizer.synthesize({
        app: 'node app.ts',
        context: { other: 'cli' },
        annotationsCheckedByCaller: true,
      });

      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockExecute.mock.calls[0]![0].context[ssmKey]).toBeUndefined();
      expect(mockExecute.mock.calls[1]![0].context[ssmKey]).toEqual(failed);
      expect(mockExecute.mock.calls[1]![0].context['other']).toBe('cli');
    });

    it('refuses a failed lookup that stays missing for a caller that does not read annotations', async () => {
      // diff / import / local-* never read error annotations, so the dummy
      // value the app falls back to would otherwise be used silently.
      const failed = { $providerError: 'AccessDenied: ec2:DescribeVpcs', $dontSaveContext: true };
      mockReadManifest.mockReturnValue(manifestMissing([ssmKey]));
      mockResolve.mockResolvedValueOnce({ [ssmKey]: failed });

      await expect(synthesizer.synthesize({ app: 'node app.ts' })).rejects.toThrow(
        `Context lookup failed: ${ssmKey}: AccessDenied: ec2:DescribeVpcs`
      );
    });

    it('leaves a failed lookup to the annotations when the caller checks them (synth / deploy)', async () => {
      const failed = { $providerError: 'AccessDenied', $dontSaveContext: true };
      mockReadManifest.mockReturnValue(manifestMissing([ssmKey]));
      mockResolve.mockResolvedValueOnce({ [ssmKey]: failed });
      mockAssemblyStacks.mockReturnValue([{ stackName: 'App' }]);

      const result = await synthesizer.synthesize({
        app: 'node app.ts',
        annotationsCheckedByCaller: true,
      });

      expect(result.stacks).toEqual([{ stackName: 'App' }]);
    });

    it('lets CLI -c win over an unsaved lookup failure for the same key', async () => {
      const failed = { $providerError: 'AccessDenied', $dontSaveContext: true };
      mockReadManifest
        .mockReturnValueOnce(manifestMissing([ssmKey]))
        .mockReturnValueOnce({ version: '38.0.0', artifacts: {} });
      mockResolve.mockResolvedValueOnce({ [ssmKey]: failed });

      await synthesizer.synthesize({ app: 'node app.ts', context: { [ssmKey]: 'from-cli' } });

      expect(mockExecute.mock.calls[1]![0].context[ssmKey]).toBe('from-cli');
    });

    it('lets a later successful lookup replace an earlier unsaved failure', async () => {
      const failed = { $providerError: 'throttled', $dontSaveContext: true };
      mockReadManifest
        .mockReturnValueOnce(manifestMissing([ssmKey]))
        .mockReturnValueOnce(manifestMissing([ssmKey, 'b']))
        .mockReturnValueOnce({ version: '38.0.0', artifacts: {} });
      mockResolve
        .mockResolvedValueOnce({ [ssmKey]: failed })
        .mockResolvedValueOnce({ [ssmKey]: 'v1', b: 'x' });
      // What `ContextStore.save` would have written by the third run.
      mockContextStoreLoad
        .mockReturnValueOnce({})
        .mockReturnValueOnce({})
        .mockReturnValueOnce({ [ssmKey]: 'v1', b: 'x' });

      await synthesizer.synthesize({ app: 'node app.ts' });

      expect(mockExecute).toHaveBeenCalledTimes(3);
      expect(mockExecute.mock.calls[2]![0].context[ssmKey]).toBe('v1');
    });

    it('re-runs the app after a lookup round that cleared every key', async () => {
      mockReadManifest
        .mockReturnValueOnce(manifestMissing([ssmKey]))
        .mockReturnValueOnce({ version: '38.0.0', artifacts: {} });

      await synthesizer.synthesize({ app: 'node app.ts' });

      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockContextStoreSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('context merge order', () => {
    it('should include CDK default context values (bundling-stacks, metadata flags)', async () => {
      await synthesizer.synthesize({ app: 'node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['aws:cdk:enable-path-metadata']).toBe(true);
      expect(passedContext['aws:cdk:enable-asset-metadata']).toBe(true);
      expect(passedContext['aws:cdk:version-reporting']).toBe(true);
      expect(passedContext['aws:cdk:bundling-stacks']).toEqual(['**']);
    });

    it('should merge ~/.cdk.json context', async () => {
      mockLoadUserCdkJson.mockReturnValue({
        context: { 'user-default': 'from-home' },
      });

      await synthesizer.synthesize({ app: 'node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['user-default']).toBe('from-home');
    });

    it('should merge cdk.json context over ~/.cdk.json', async () => {
      mockLoadUserCdkJson.mockReturnValue({
        context: { shared: 'from-home', 'home-only': 'value' },
      });
      mockLoadCdkJson.mockReturnValue({
        context: { shared: 'from-project', 'project-only': 'value' },
      });

      await synthesizer.synthesize({ app: 'node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['shared']).toBe('from-project');
      expect(passedContext['home-only']).toBe('value');
      expect(passedContext['project-only']).toBe('value');
    });

    it('should merge cdk.context.json over cdk.json', async () => {
      mockLoadCdkJson.mockReturnValue({
        context: { key: 'from-cdk-json' },
      });
      mockContextStoreLoad.mockReturnValue({
        key: 'from-cdk-context-json',
      });

      await synthesizer.synthesize({ app: 'node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['key']).toBe('from-cdk-context-json');
    });

    it('should merge CLI -c context over everything', async () => {
      mockLoadUserCdkJson.mockReturnValue({ context: { key: 'home' } });
      mockLoadCdkJson.mockReturnValue({ context: { key: 'project' } });
      mockContextStoreLoad.mockReturnValue({ key: 'cached' });

      await synthesizer.synthesize({
        app: 'node app.ts',
        context: { key: 'cli' },
      });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['key']).toBe('cli');
    });

    it('should apply full priority: defaults < ~/.cdk.json < cdk.json < cdk.context.json < CLI', async () => {
      mockLoadUserCdkJson.mockReturnValue({
        context: { a: 'home', b: 'home', c: 'home', d: 'home' },
      });
      mockLoadCdkJson.mockReturnValue({
        context: { b: 'project', c: 'project', d: 'project' },
      });
      mockContextStoreLoad.mockReturnValue({
        c: 'cached',
        d: 'cached',
      });

      await synthesizer.synthesize({
        app: 'node app.ts',
        context: { d: 'cli' },
      });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['a']).toBe('home');
      expect(passedContext['b']).toBe('project');
      expect(passedContext['c']).toBe('cached');
      expect(passedContext['d']).toBe('cli');
      // CDK defaults should still be present
      expect(passedContext['aws:cdk:bundling-stacks']).toEqual(['**']);
    });

    it('should allow cdk.json to override CDK default context values', async () => {
      mockLoadCdkJson.mockReturnValue({
        context: { 'aws:cdk:enable-path-metadata': false },
      });

      await synthesizer.synthesize({ app: 'node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['aws:cdk:enable-path-metadata']).toBe(false);
    });

    it('should skip subprocess execution when --app points at an existing directory', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockReadManifest.mockReturnValue({ version: '38.0.0', artifacts: {} });
      mockAssemblyStacks.mockReturnValue([]);

      const result = await synthesizer.synthesize({ app: 'cdk.out' });

      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockReadManifest).toHaveBeenCalledTimes(1);
      expect(result.assemblyDir).toMatch(/cdk\.out$/);
    });

    // Issue go-to-k/cdkd#3507: a Stage that failed to load is fatal. The
    // reader raises it, and neither `synthesize` path swallows it.
    it('propagates a Stage load failure out of the pre-synthesized assembly path', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockReadManifest.mockReturnValue({ version: '38.0.0', artifacts: {} });
      const failure = stageLoadError('MyStage', 'ENOENT');
      mockAssemblyStacks.mockImplementation(() => {
        throw failure;
      });

      // The SAME error, not a re-wrap: `cdkd destroy` keys on its class.
      await expect(synthesizer.synthesize({ app: 'cdk.out' })).rejects.toBe(failure);
    });

    it('propagates a Stage load failure out of the synthesis path', async () => {
      const failure = stageLoadError('MyStage', 'ENOENT');
      mockAssemblyStacks.mockImplementation(() => {
        throw failure;
      });

      await expect(synthesizer.synthesize({ app: 'node app.ts' })).rejects.toBe(failure);
      expect(mockExecute).toHaveBeenCalled();
    });

    it('should pass through pre-synthesized assembly even when manifest reports missing context (CDK CLI parity)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockReadManifest.mockReturnValue({
        version: '38.0.0',
        artifacts: {},
        missing: [{ key: 'foo', provider: 'availability-zones', props: {} }],
      });
      mockAssemblyStacks.mockReturnValue([]);

      await expect(synthesizer.synthesize({ app: 'cdk.out' })).resolves.toBeDefined();
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('should pass cdk.json feature flags to CDK app', async () => {
      mockLoadCdkJson.mockReturnValue({
        context: {
          '@aws-cdk/aws-lambda:recognizeLayerVersion': true,
          '@aws-cdk/core:newStyleStackSynthesis': true,
          '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true,
        },
      });

      await synthesizer.synthesize({ app: 'node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['@aws-cdk/aws-lambda:recognizeLayerVersion']).toBe(true);
      expect(passedContext['@aws-cdk/core:newStyleStackSynthesis']).toBe(true);
      expect(passedContext['@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy']).toBe(true);
    });
  });
});
