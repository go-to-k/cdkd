import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture what AppExecutor.execute receives
const mockExecute = vi.fn();
const mockReadManifest = vi.fn();
const mockGetAllStacks = vi.fn();
const mockContextStoreLoad = vi.fn();
const mockContextStoreSave = vi.fn();

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
    getAllStacks: mockGetAllStacks,
  })),
}));

// Mock ContextStore
vi.mock('../../../src/synthesis/context-store.js', () => ({
  ContextStore: vi.fn().mockImplementation(() => ({
    load: mockContextStoreLoad,
    save: mockContextStoreSave,
  })),
}));

// Mock ContextProviderRegistry
vi.mock('../../../src/synthesis/context-providers/index.js', () => ({
  ContextProviderRegistry: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({}),
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

describe('Synthesizer', () => {
  let synthesizer: Synthesizer;

  beforeEach(() => {
    vi.clearAllMocks();
    synthesizer = new Synthesizer();

    // Default: no missing context, return empty stacks
    mockReadManifest.mockReturnValue({ version: '38.0.0', artifacts: {} });
    mockGetAllStacks.mockReturnValue([]);
    mockExecute.mockResolvedValue(undefined);
    mockContextStoreLoad.mockReturnValue({});
    mockLoadCdkJson.mockReturnValue(null);
    mockLoadUserCdkJson.mockReturnValue(null);
    // Default: --app is treated as a shell command (no existing directory)
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ isDirectory: () => false });
  });

  describe('context merge order', () => {
    it('should include CDK default context values (bundling-stacks, metadata flags)', async () => {
      await synthesizer.synthesize({ app: 'npx ts-node app.ts' });

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

      await synthesizer.synthesize({ app: 'npx ts-node app.ts' });

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

      await synthesizer.synthesize({ app: 'npx ts-node app.ts' });

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

      await synthesizer.synthesize({ app: 'npx ts-node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['key']).toBe('from-cdk-context-json');
    });

    it('should merge CLI -c context over everything', async () => {
      mockLoadUserCdkJson.mockReturnValue({ context: { key: 'home' } });
      mockLoadCdkJson.mockReturnValue({ context: { key: 'project' } });
      mockContextStoreLoad.mockReturnValue({ key: 'cached' });

      await synthesizer.synthesize({
        app: 'npx ts-node app.ts',
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
        app: 'npx ts-node app.ts',
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

      await synthesizer.synthesize({ app: 'npx ts-node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['aws:cdk:enable-path-metadata']).toBe(false);
    });

    it('should skip subprocess execution when --app points at an existing directory', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockReadManifest.mockReturnValue({ version: '38.0.0', artifacts: {} });
      mockGetAllStacks.mockReturnValue([]);

      const result = await synthesizer.synthesize({ app: 'cdk.out' });

      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockReadManifest).toHaveBeenCalledTimes(1);
      expect(result.assemblyDir).toMatch(/cdk\.out$/);
    });

    it('should pass through pre-synthesized assembly even when manifest reports missing context (CDK CLI parity)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockReadManifest.mockReturnValue({
        version: '38.0.0',
        artifacts: {},
        missing: [{ key: 'foo', provider: 'availability-zones', props: {} }],
      });
      mockGetAllStacks.mockReturnValue([]);

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

      await synthesizer.synthesize({ app: 'npx ts-node app.ts' });

      const passedContext = mockExecute.mock.calls[0]![0].context as Record<string, unknown>;
      expect(passedContext['@aws-cdk/aws-lambda:recognizeLayerVersion']).toBe(true);
      expect(passedContext['@aws-cdk/core:newStyleStackSynthesis']).toBe(true);
      expect(passedContext['@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy']).toBe(true);
    });
  });
});
