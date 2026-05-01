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
  resolveStateBucketWithSource,
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

  describe('resolveStateBucketWithSource', () => {
    it('reports cli-flag source when CLI value is provided', () => {
      const result = resolveStateBucketWithSource('my-cli-bucket');

      expect(result).toEqual({ bucket: 'my-cli-bucket', source: 'cli-flag' });
    });

    it('reports env source when CDKD_STATE_BUCKET is set', () => {
      process.env['CDKD_STATE_BUCKET'] = 'my-env-bucket';

      const result = resolveStateBucketWithSource();

      expect(result).toEqual({ bucket: 'my-env-bucket', source: 'env' });
    });

    it('reports cdk.json source when context provides the bucket', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          context: { cdkd: { stateBucket: 'my-cdk-json-bucket' } },
        })
      );

      const result = resolveStateBucketWithSource();

      expect(result).toEqual({ bucket: 'my-cdk-json-bucket', source: 'cdk.json' });
    });

    it('returns undefined when no source provides a value', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = resolveStateBucketWithSource();

      expect(result).toBeUndefined();
    });

    it('prioritizes cli-flag over env and cdk.json', () => {
      process.env['CDKD_STATE_BUCKET'] = 'env-bucket';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ context: { cdkd: { stateBucket: 'cdk-json' } } })
      );

      const result = resolveStateBucketWithSource('cli-bucket');

      expect(result).toEqual({ bucket: 'cli-bucket', source: 'cli-flag' });
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
        HeadBucketCommand: class HeadBucketCommand {
          static __cmd = 'HeadBucket' as const;
          constructor(public input: { Bucket: string }) {}
        },
        ListObjectsV2Command: class ListObjectsV2Command {
          static __cmd = 'ListObjectsV2' as const;
          constructor(public input: { Bucket: string; Prefix?: string; MaxKeys?: number }) {}
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

    /**
     * Drive the s3SendMock by command-class name. Cleaner than chaining
     * `mockResolvedValueOnce` — the resolution flow now probes both
     * buckets and may also list objects, so positional mocking is fragile.
     */
    function planS3({
      newHead,
      legacyHead,
      newList,
      legacyList,
    }: {
      newHead: 'ok' | '404' | '403' | '301';
      legacyHead: 'ok' | '404' | '403' | '301';
      newList?: 'empty' | 'has-state' | 'error';
      legacyList?: 'empty' | 'has-state' | 'error';
    }) {
      const headResult = (kind: 'ok' | '404' | '403' | '301') => {
        if (kind === 'ok') return Promise.resolve({});
        const status = kind === '404' ? 404 : kind === '403' ? 403 : 301;
        const name = kind === '404' ? 'NotFound' : kind === '403' ? 'Forbidden' : 'PermanentRedirect';
        return Promise.reject(
          Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
        );
      };
      const listResult = (kind: 'empty' | 'has-state' | 'error') => {
        if (kind === 'empty') return Promise.resolve({ KeyCount: 0 });
        if (kind === 'has-state') return Promise.resolve({ KeyCount: 1 });
        return Promise.reject(new Error('list failed'));
      };

      s3SendMock.mockImplementation((cmd: { constructor: { __cmd?: string }; input: { Bucket: string } }) => {
        const kind = (cmd.constructor as unknown as { __cmd?: string }).__cmd;
        const bucket = cmd.input.Bucket;
        const isNew = bucket === 'cdkd-state-123456789012';
        if (kind === 'HeadBucket') {
          return headResult(isNew ? newHead : legacyHead);
        }
        if (kind === 'ListObjectsV2') {
          const which = isNew ? newList : legacyList;
          if (!which) {
            return Promise.reject(new Error(`Unexpected ListObjectsV2 on ${bucket} (no plan)`));
          }
          return listResult(which);
        }
        return Promise.reject(new Error(`Unexpected command ${kind ?? '?'}`));
      });
    }

    it('returns the new region-free name when it exists and legacy does not', async () => {
      planS3({ newHead: 'ok', legacyHead: '404' });
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012');
    });

    it('falls back to legacy name when new returns NoSuchBucket', async () => {
      planS3({ newHead: '404', legacyHead: 'ok' });
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012-us-east-1');
    });

    it('treats 403 on the new name as "exists" and uses it (legacy not present)', async () => {
      planS3({ newHead: '403', legacyHead: '404' });
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012');
    });

    it('treats 301 on the new name as "exists" and uses it (legacy not present)', async () => {
      planS3({ newHead: '301', legacyHead: '404' });
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toBe('cdkd-state-123456789012');
    });

    it('throws a "run cdkd bootstrap" error when neither bucket exists', async () => {
      planS3({ newHead: '404', legacyHead: '404' });
      const { resolveStateBucketWithDefault: fn } = await import(
        '../../../src/cli/config-loader.js'
      );

      await expect(fn(undefined, 'us-east-1')).rejects.toThrow(/cdkd bootstrap/);
    });

    it('both buckets exist + new has state -> use new (legacy is probably stale)', async () => {
      planS3({
        newHead: 'ok',
        legacyHead: 'ok',
        newList: 'has-state',
      });
      const { resolveStateBucketWithDefaultAndSource: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toEqual({ bucket: 'cdkd-state-123456789012', source: 'default' });
    });

    it('both buckets exist + new EMPTY + legacy has state -> fall back to legacy with warning', async () => {
      // The upgrade-from-v0.7.0 case: legacy has state, a partial migration
      // / probe / bootstrap left an empty new bucket behind. The previous
      // code picked new and silently lost track of the existing stack;
      // now we detect it and route to legacy.
      planS3({
        newHead: 'ok',
        legacyHead: 'ok',
        newList: 'empty',
        legacyList: 'has-state',
      });
      const { resolveStateBucketWithDefaultAndSource: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toEqual({
        bucket: 'cdkd-state-123456789012-us-east-1',
        source: 'default-legacy',
      });
    });

    it('both buckets exist + both empty -> use new (no state to preserve)', async () => {
      planS3({
        newHead: 'ok',
        legacyHead: 'ok',
        newList: 'empty',
        legacyList: 'empty',
      });
      const { resolveStateBucketWithDefaultAndSource: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toEqual({ bucket: 'cdkd-state-123456789012', source: 'default' });
    });

    it('both buckets exist + new ListObjectsV2 errors -> conservatively use new', async () => {
      // bucketHasAnyState's catch-all returns true so we don't silently
      // route to legacy when we couldn't tell whether new is empty.
      planS3({
        newHead: 'ok',
        legacyHead: 'ok',
        newList: 'error',
      });
      const { resolveStateBucketWithDefaultAndSource: fn } = await import(
        '../../../src/cli/config-loader.js'
      );
      const result = await fn(undefined, 'us-east-1');

      expect(result).toEqual({ bucket: 'cdkd-state-123456789012', source: 'default' });
    });
  });
});
