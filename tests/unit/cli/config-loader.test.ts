import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs before importing the module under test
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock logger to avoid console output in tests
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

import { existsSync, readFileSync } from 'node:fs';
import {
  loadCdkJson,
  loadUserCdkJson,
  resolveApp,
  resolveStateBucket,
  getDefaultStateBucketName,
} from '../../../src/cli/config-loader.js';

describe('config-loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    // Clone env so mutations don't leak between tests
    process.env = { ...originalEnv };
    delete process.env['CDKD_APP'];
    delete process.env['CDKD_STATE_BUCKET'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadCdkJson', () => {
    it('should return null when no cdk.json exists', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = loadCdkJson('/some/dir');

      expect(result).toBeNull();
      expect(existsSync).toHaveBeenCalledWith('/some/dir/cdk.json');
    });

    it('should parse valid cdk.json', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          app: 'npx ts-node bin/app.ts',
          output: 'cdk.out',
          context: { foo: 'bar' },
        })
      );

      const result = loadCdkJson('/project');

      expect(result).toEqual({
        app: 'npx ts-node bin/app.ts',
        output: 'cdk.out',
        context: { foo: 'bar' },
      });
    });

    it('should return null when cdk.json contains invalid JSON', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{ invalid json !!!');

      const result = loadCdkJson('/project');

      expect(result).toBeNull();
    });

    it('should use process.cwd() when no cwd argument is provided', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      loadCdkJson();

      // Should have been called with a path ending in cdk.json based on cwd
      expect(existsSync).toHaveBeenCalledTimes(1);
      const calledPath = vi.mocked(existsSync).mock.calls[0][0] as string;
      expect(calledPath).toMatch(/cdk\.json$/);
    });
  });

  describe('resolveApp', () => {
    it('should return CLI value when provided', () => {
      const result = resolveApp('npx ts-node bin/app.ts');

      expect(result).toBe('npx ts-node bin/app.ts');
    });

    it('should fall back to CDKD_APP env var when CLI value is not provided', () => {
      process.env['CDKD_APP'] = 'npx ts-node bin/env-app.ts';

      const result = resolveApp();

      expect(result).toBe('npx ts-node bin/env-app.ts');
    });

    it('should fall back to cdk.json app field when CLI and env are not set', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ app: 'npx ts-node bin/cdk-app.ts' })
      );

      const result = resolveApp();

      expect(result).toBe('npx ts-node bin/cdk-app.ts');
    });

    it('should return undefined when no source provides a value', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = resolveApp();

      expect(result).toBeUndefined();
    });

    it('should prioritize CLI over env var', () => {
      process.env['CDKD_APP'] = 'env-app';

      const result = resolveApp('cli-app');

      expect(result).toBe('cli-app');
    });

    it('should prioritize env var over cdk.json', () => {
      process.env['CDKD_APP'] = 'env-app';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ app: 'cdk-json-app' }));

      const result = resolveApp();

      expect(result).toBe('env-app');
    });
  });

  describe('resolveStateBucket', () => {
    it('should return CLI value when provided', () => {
      const result = resolveStateBucket('my-cli-bucket');

      expect(result).toBe('my-cli-bucket');
    });

    it('should fall back to CDKD_STATE_BUCKET env var when CLI value is not provided', () => {
      process.env['CDKD_STATE_BUCKET'] = 'my-env-bucket';

      const result = resolveStateBucket();

      expect(result).toBe('my-env-bucket');
    });

    it('should fall back to cdk.json context when CLI and env are not set', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          app: 'npx ts-node bin/app.ts',
          context: {
            cdkd: {
              stateBucket: 'my-cdk-json-bucket',
            },
          },
        })
      );

      const result = resolveStateBucket();

      expect(result).toBe('my-cdk-json-bucket');
    });

    it('should return undefined when no source provides a value', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = resolveStateBucket();

      expect(result).toBeUndefined();
    });

    it('should prioritize CLI over env var', () => {
      process.env['CDKD_STATE_BUCKET'] = 'env-bucket';

      const result = resolveStateBucket('cli-bucket');

      expect(result).toBe('cli-bucket');
    });

    it('should prioritize env var over cdk.json', () => {
      process.env['CDKD_STATE_BUCKET'] = 'env-bucket';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          context: { cdkd: { stateBucket: 'cdk-json-bucket' } },
        })
      );

      const result = resolveStateBucket();

      expect(result).toBe('env-bucket');
    });

    it('should return undefined when cdk.json context.cdkd.stateBucket is not a string', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          context: { cdkd: { stateBucket: 12345 } },
        })
      );

      const result = resolveStateBucket();

      expect(result).toBeUndefined();
    });

    it('should return undefined when cdk.json has no cdkd context', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          app: 'npx ts-node bin/app.ts',
          context: { someOtherKey: 'value' },
        })
      );

      const result = resolveStateBucket();

      expect(result).toBeUndefined();
    });
  });

  describe('loadUserCdkJson', () => {
    it('should load ~/.cdk.json when it exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ context: { 'user-key': 'user-value' } })
      );

      const result = loadUserCdkJson();

      expect(result).toEqual({ context: { 'user-key': 'user-value' } });
      const calledPath = vi.mocked(existsSync).mock.calls[0]![0] as string;
      expect(calledPath).toMatch(/\.cdk\.json$/);
    });

    it('should return null when ~/.cdk.json does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = loadUserCdkJson();

      expect(result).toBeNull();
    });
  });

  describe('getDefaultStateBucketName', () => {
    it('should generate correct format with account ID and region', () => {
      const result = getDefaultStateBucketName('123456789012', 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012-us-east-1');
    });

    it('should handle different regions', () => {
      const result = getDefaultStateBucketName('111122223333', 'ap-northeast-1');

      expect(result).toBe('cdkd-state-111122223333-ap-northeast-1');
    });
  });
});
