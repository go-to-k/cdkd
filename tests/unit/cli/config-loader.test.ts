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
  getLegacyStateBucketName,
} from '../../../src/cli/config-loader.js';
// `resolveStateBucketWithDefault` is intentionally imported dynamically inside
// each test below — it pulls in the AWS SDK which is mocked via `vi.doMock`,
// and `vi.doMock` only affects imports issued *after* it runs.

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
    it('should generate region-free format from account ID', () => {
      const result = getDefaultStateBucketName('123456789012');

      expect(result).toBe('cdkd-state-123456789012');
    });

    it('should not embed region (different account, same shape)', () => {
      const result = getDefaultStateBucketName('111122223333');

      expect(result).toBe('cdkd-state-111122223333');
    });
  });

  describe('getLegacyStateBucketName', () => {
    it('should generate the pre-v0.8 region-suffixed format', () => {
      const result = getLegacyStateBucketName('123456789012', 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012-us-east-1');
    });

    it('should handle non-us-east-1 regions', () => {
      const result = getLegacyStateBucketName('111122223333', 'ap-northeast-1');

      expect(result).toBe('cdkd-state-111122223333-ap-northeast-1');
    });
  });

  describe('resolveStateBucketWithDefault', () => {
    // Mocks for the dynamically-imported AWS SDK modules. The implementation
    // calls `await import('@aws-sdk/client-sts')` etc., so we mock both the
    // STS GetCallerIdentity command and the S3 HeadBucket existence probe.
    let stsSendMock: ReturnType<typeof vi.fn>;
    let s3SendMock: ReturnType<typeof vi.fn>;
    let s3DestroyMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      stsSendMock = vi.fn().mockResolvedValue({ Account: '123456789012' });
      s3SendMock = vi.fn();
      s3DestroyMock = vi.fn();

      // Hoisted mocks would be cleaner, but vi.doMock works mid-test and
      // matches the dynamic-import shape used in resolveStateBucketWithDefault.
      vi.doMock('@aws-sdk/client-sts', () => ({
        GetCallerIdentityCommand: class {},
      }));
      vi.doMock('@aws-sdk/client-s3', () => ({
        S3Client: class {
          send = s3SendMock;
          destroy = s3DestroyMock;
        },
        HeadBucketCommand: class {
          constructor(public input: { Bucket: string }) {}
        },
      }));
      vi.doMock('../../../src/utils/aws-clients.js', () => ({
        getAwsClients: () => ({
          sts: { send: stsSendMock },
        }),
      }));
    });

    afterEach(() => {
      vi.doUnmock('@aws-sdk/client-sts');
      vi.doUnmock('@aws-sdk/client-s3');
      vi.doUnmock('../../../src/utils/aws-clients.js');
    });

    it('should short-circuit on explicit --state-bucket value (skip lookup)', async () => {
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn('explicit-bucket', 'us-east-1');

      expect(result).toBe('explicit-bucket');
      expect(stsSendMock).not.toHaveBeenCalled();
      expect(s3SendMock).not.toHaveBeenCalled();
    });

    it('should short-circuit on CDKD_STATE_BUCKET env var', async () => {
      process.env['CDKD_STATE_BUCKET'] = 'env-bucket';
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('env-bucket');
      expect(stsSendMock).not.toHaveBeenCalled();
    });

    it('should short-circuit on cdk.json context.cdkd.stateBucket', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ context: { cdkd: { stateBucket: 'cdk-json-bucket' } } })
      );
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdk-json-bucket');
      expect(stsSendMock).not.toHaveBeenCalled();
    });

    it('should return the new region-free name when it exists', async () => {
      // First HeadBucket call (new name) succeeds.
      s3SendMock.mockResolvedValueOnce({});
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012');
      expect(s3SendMock).toHaveBeenCalledTimes(1);
      // Inspect the HeadBucket input to confirm we tried the NEW name first.
      expect(s3SendMock.mock.calls[0][0].input.Bucket).toBe('cdkd-state-123456789012');
    });

    it('should fall back to legacy name when new name returns NoSuchBucket', async () => {
      // First call (new name): NoSuchBucket. Second call (legacy): succeeds.
      const notFound = Object.assign(new Error('not found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      s3SendMock.mockRejectedValueOnce(notFound).mockResolvedValueOnce({});
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012-us-east-1');
      expect(s3SendMock).toHaveBeenCalledTimes(2);
      expect(s3SendMock.mock.calls[1][0].input.Bucket).toBe(
        'cdkd-state-123456789012-us-east-1'
      );
    });

    it('should treat 403 on the new name as "exists" (no legacy fallback)', async () => {
      // 403 means the bucket exists but we lack permission to head it. We
      // should still return the new name and let the downstream operation
      // surface the actual access-denied error.
      const accessDenied = Object.assign(new Error('access denied'), {
        name: 'Forbidden',
        $metadata: { httpStatusCode: 403 },
      });
      s3SendMock.mockRejectedValueOnce(accessDenied);
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012');
      expect(s3SendMock).toHaveBeenCalledTimes(1);
    });

    it('should treat 301 on the new name as "exists" (cross-region redirect)', async () => {
      // S3 returns 301 when the bucket is in a different region than the
      // probe client. The bucket exists; the real region is resolved later.
      const redirect = Object.assign(new Error('redirect'), {
        name: 'PermanentRedirect',
        $metadata: { httpStatusCode: 301 },
      });
      s3SendMock.mockRejectedValueOnce(redirect);
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012');
      expect(s3SendMock).toHaveBeenCalledTimes(1);
    });

    it('should throw a "run cdkd bootstrap" error when neither bucket exists', async () => {
      const notFound = Object.assign(new Error('not found'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      s3SendMock.mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound);
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );

      await expect(fn(undefined, 'us-east-1')).rejects.toThrow(/cdkd bootstrap/);
      expect(s3SendMock).toHaveBeenCalledTimes(2);
    });
  });
});
