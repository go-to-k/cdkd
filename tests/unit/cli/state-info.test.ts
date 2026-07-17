import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  GetBucketLocationCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { ResolvedStateBucket } from '../../../src/cli/config-loader.js';

// Mock logger to suppress output during tests.
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
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

// Mock the resolver so we don't talk to STS. Tests override the return value
// per-case so they can probe each `Source:` branch.
const mockResolveWithSource =
  vi.fn<(cliBucket: string | undefined, region: string) => Promise<ResolvedStateBucket>>();
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveStateBucketWithDefaultAndSource: (
    cliBucket: string | undefined,
    region: string
  ): Promise<ResolvedStateBucket> => mockResolveWithSource(cliBucket, region),
}));

// Mock S3 client so its `send` returns scripted responses for each command type.
const mockS3Send =
  vi.fn<(command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>>();
const mockS3Destroy = vi.fn();

vi.mock('../../../src/utils/aws-clients.ts', () => {
  return {
    AwsClients: vi.fn().mockImplementation(() => ({
      get s3() {
        return { send: mockS3Send, destroy: mockS3Destroy };
      },
      destroy: vi.fn(),
    })),
    setAwsClients: vi.fn(),
    getAwsClients: vi.fn(),
  };
});

// Mock the region-corrected-client rebuild helper (issue #1054). Default is
// `null` ("bucket already in the client's region — keep the original client"),
// which preserves the pre-existing behavior for every test that doesn't care.
// The cross-region regression tests override it to return a sentinel client
// and assert the raw S3 traffic goes there instead of the original client.
const mockRebuildClientForBucketRegion =
  vi.fn<(client: unknown, bucket: string, opts: unknown) => Promise<unknown>>();
vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: (
    client: unknown,
    bucket: string,
    opts: unknown
  ): Promise<unknown> => mockRebuildClientForBucketRegion(client, bucket, opts),
}));

// Mock S3StateBackend so verifyBucketExists is the only relevant call.
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

// LockManager is imported by state.ts but unused by `state info`.
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: vi.fn(),
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

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

async function runStateInfo(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

/**
 * Helper to script S3 responses for the three command types issued by
 * `state info`: `GetBucketLocation`, `ListObjectsV2`, `GetObject`.
 */
function scriptS3(
  {
    region,
    keys,
    schemaVersion,
    markers = {},
  }: {
    region: string | null;
    keys: string[];
    schemaVersion?: number | 'malformed' | 'no-body';
    /** Bootstrap markers by region: body string returned for `cdkd-bootstrap/{region}.json`. */
    markers?: Record<string, string>;
  },
  sendMock: typeof mockS3Send = mockS3Send
): void {
  const markerKeys = Object.keys(markers).map((r) => `cdkd-bootstrap/${r}.json`);
  sendMock.mockImplementation(async (command) => {
    if (command instanceof GetBucketLocationCommand) {
      if (region === null) {
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      }
      // S3 returns null/empty for us-east-1.
      if (region === 'us-east-1') return { LocationConstraint: undefined };
      return { LocationConstraint: region };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = (command.input.Prefix as string | undefined) ?? '';
      return {
        Contents: [...keys, ...markerKeys]
          .filter((k) => k.startsWith(prefix))
          .map((Key) => ({ Key })),
        NextContinuationToken: undefined,
      };
    }
    if (command instanceof GetObjectCommand) {
      const key = command.input.Key as string;
      if (key.startsWith('cdkd-bootstrap/')) {
        const markerRegion = key.slice('cdkd-bootstrap/'.length, -'.json'.length);
        return {
          Body: { transformToString: async () => markers[markerRegion] ?? '' },
        };
      }
      if (schemaVersion === 'no-body') return {};
      if (schemaVersion === 'malformed') {
        return {
          Body: { transformToString: async () => '{ not json' },
        };
      }
      const v = typeof schemaVersion === 'number' ? schemaVersion : 2;
      return {
        Body: {
          transformToString: async () =>
            JSON.stringify({ version: v, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 }),
        },
      };
    }
    throw new Error(`Unexpected command: ${command.constructor.name}`);
  });
}

describe('cdkd state info', () => {
  beforeEach(() => {
    mockResolveWithSource.mockReset();
    mockS3Send.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    mockRebuildClientForBucketRegion.mockReset();
    // Default: bucket is in the client's region — no rebuild, keep original.
    mockRebuildClientForBucketRegion.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prints all five fields with the default-source label', async () => {
    mockResolveWithSource.mockResolvedValue({
      bucket: 'cdkd-state-123456789012-us-east-1',
      source: 'default',
    });
    scriptS3({
      region: 'us-east-1',
      keys: ['cdkd/StackA/state.json', 'cdkd/StackB/state.json'],
      schemaVersion: 2,
    });

    const out = await runStateInfo(['info']);

    expect(out).toContain('State bucket:    cdkd-state-123456789012-us-east-1');
    expect(out).toContain('Region:          us-east-1 (auto-detected via GetBucketLocation)');
    expect(out).toContain('Source:          default (account ID from STS)');
    expect(out).toContain('Schema version:  2');
    expect(out).toContain('Stacks:          2');
  });

  it('reports `--state-bucket flag` source when explicit bucket is passed', async () => {
    mockResolveWithSource.mockResolvedValue({
      bucket: 'cdkd-state-test',
      source: 'cli-flag',
    });
    scriptS3({ region: 'us-east-1', keys: ['cdkd/Only/state.json'] });

    const out = await runStateInfo(['info', '--state-bucket', 'cdkd-state-test']);

    expect(out).toContain('State bucket:    cdkd-state-test');
    expect(out).toContain('Source:          --state-bucket flag');
    expect(out).toContain('Stacks:          1');
    // Resolver received the explicit bucket.
    expect(mockResolveWithSource).toHaveBeenCalledWith('cdkd-state-test', 'us-east-1');
  });

  it('reports CDKD_STATE_BUCKET env source label', async () => {
    mockResolveWithSource.mockResolvedValue({ bucket: 'env-bucket', source: 'env' });
    scriptS3({ region: 'eu-west-1', keys: [] });

    const out = await runStateInfo(['info']);

    expect(out).toContain('Source:          CDKD_STATE_BUCKET env');
    expect(out).toContain('Region:          eu-west-1 (auto-detected via GetBucketLocation)');
  });

  it('reports cdk.json source label', async () => {
    mockResolveWithSource.mockResolvedValue({
      bucket: 'cdk-json-bucket',
      source: 'cdk.json',
    });
    scriptS3({ region: 'us-east-1', keys: [] });

    const out = await runStateInfo(['info']);

    expect(out).toContain('Source:          cdk.json (context.cdkd.stateBucket)');
  });

  it('reports schema version "unknown" and stack count 0 for an empty bucket', async () => {
    mockResolveWithSource.mockResolvedValue({
      bucket: 'cdkd-state-empty',
      source: 'default',
    });
    scriptS3({ region: 'us-east-1', keys: [] });

    const out = await runStateInfo(['info']);

    expect(out).toContain('Schema version:  unknown');
    expect(out).toContain('Stacks:          0');
  });

  it('counts state files across legacy and new layouts', async () => {
    mockResolveWithSource.mockResolvedValue({
      bucket: 'mixed-bucket',
      source: 'default',
    });
    scriptS3({
      region: 'us-east-1',
      keys: [
        // Legacy layout: <prefix>/<stackName>/state.json
        'cdkd/LegacyStack/state.json',
        // New layout: <prefix>/<stackName>/<region>/state.json
        'cdkd/NewStack/us-east-1/state.json',
        'cdkd/NewStack/eu-west-1/state.json',
        // Non-state keys must be ignored.
        'cdkd/NewStack/us-east-1/lock.json',
      ],
      schemaVersion: 2,
    });

    const out = await runStateInfo(['info']);

    // Three state.json files: 1 legacy + 2 new layout.
    expect(out).toContain('Stacks:          3');
  });

  it('falls back to "unknown" region when GetBucketLocation is denied', async () => {
    mockResolveWithSource.mockResolvedValue({
      bucket: 'no-access-bucket',
      source: 'cli-flag',
    });
    scriptS3({ region: null, keys: [] });

    const out = await runStateInfo(['info']);

    expect(out).toContain('Region:          unknown (GetBucketLocation failed or denied)');
  });

  it('emits a stable JSON shape with --json', async () => {
    mockResolveWithSource.mockResolvedValue({
      bucket: 'cdkd-state-123456789012-us-east-1',
      source: 'default',
    });
    scriptS3({
      region: 'us-east-1',
      keys: ['cdkd/A/state.json', 'cdkd/B/us-east-1/state.json'],
      schemaVersion: 2,
    });

    const out = await runStateInfo(['info', '--json']);

    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      bucket: 'cdkd-state-123456789012-us-east-1',
      region: 'us-east-1',
      regionSource: 'auto-detected',
      bucketSource: 'default',
      schemaVersion: 2,
      stackCount: 2,
      assetStorage: [],
    });
  });

  it('JSON shape sets region:null and regionSource:"unknown" on detection failure', async () => {
    mockResolveWithSource.mockResolvedValue({ bucket: 'b', source: 'cli-flag' });
    scriptS3({ region: null, keys: [] });

    const out = await runStateInfo(['info', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed.region).toBeNull();
    expect(parsed.regionSource).toBe('unknown');
    expect(parsed.schemaVersion).toBe('unknown');
    expect(parsed.stackCount).toBe(0);
  });

  it('returns "unknown" schema version when the first state file is malformed JSON', async () => {
    mockResolveWithSource.mockResolvedValue({ bucket: 'b', source: 'cli-flag' });
    scriptS3({
      region: 'us-east-1',
      keys: ['cdkd/Stack/state.json'],
      schemaVersion: 'malformed',
    });

    const out = await runStateInfo(['info']);
    expect(out).toContain('Schema version:  unknown');
    expect(out).toContain('Stacks:          1');
  });

  it('reports legacy asset storage when no bootstrap marker exists', async () => {
    mockResolveWithSource.mockResolvedValue({ bucket: 'b', source: 'cli-flag' });
    scriptS3({ region: 'us-east-1', keys: [] });

    const out = await runStateInfo(['info']);
    expect(out).toContain(
      'Asset storage:   legacy (CDK bootstrap) — run cdkd bootstrap to opt in'
    );
  });

  it('lists opted-in asset-storage regions from bootstrap markers (text + JSON)', async () => {
    mockResolveWithSource.mockResolvedValue({ bucket: 'b', source: 'cli-flag' });
    const marker = (region: string): string =>
      JSON.stringify({
        assetBucket: `cdkd-assets-123456789012-${region}`,
        containerRepo: `cdkd-container-assets-123456789012-${region}`,
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      });
    scriptS3({
      region: 'us-east-1',
      keys: [],
      markers: {
        'us-east-1': marker('us-east-1'),
        'ap-northeast-1': marker('ap-northeast-1'),
      },
    });

    const out = await runStateInfo(['info']);
    expect(out).toContain('Asset storage:   cdkd-assets mode in 2 region(s)');
    expect(out).toContain(
      '  ap-northeast-1: cdkd-assets-123456789012-ap-northeast-1 / cdkd-container-assets-123456789012-ap-northeast-1'
    );
    expect(out).toContain(
      '  us-east-1: cdkd-assets-123456789012-us-east-1 / cdkd-container-assets-123456789012-us-east-1'
    );

    // Same fixture through --json.
    scriptS3({
      region: 'us-east-1',
      keys: [],
      markers: { 'us-east-1': marker('us-east-1') },
    });
    const json = JSON.parse(await runStateInfo(['info', '--json']));
    expect(json.assetStorage).toEqual([
      {
        region: 'us-east-1',
        assetBucket: 'cdkd-assets-123456789012-us-east-1',
        containerRepo: 'cdkd-container-assets-123456789012-us-east-1',
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    ]);
  });

  it('skips a malformed bootstrap marker instead of crashing', async () => {
    mockResolveWithSource.mockResolvedValue({ bucket: 'b', source: 'cli-flag' });
    scriptS3({
      region: 'us-east-1',
      keys: [],
      markers: { 'us-east-1': '{ not json' },
    });

    const out = await runStateInfo(['info']);
    expect(out).toContain(
      'Asset storage:   legacy (CDK bootstrap) — run cdkd bootstrap to opt in'
    );
  });

  describe('cross-region state bucket (issue #1054)', () => {
    it('routes every raw S3 read through the region-corrected client and destroys only the replacement', async () => {
      mockResolveWithSource.mockResolvedValue({
        bucket: 'cdkd-state-other-region',
        source: 'cli-flag',
      });
      // Sentinel replacement client returned by rebuildClientForBucketRegion —
      // simulates the state bucket living in a different region than the
      // ambient AWS_REGION / --region client.
      const sentinelSend =
        vi.fn<
          (command: {
            constructor: { name: string };
            input: Record<string, unknown>;
          }) => Promise<unknown>
        >();
      const sentinelDestroy = vi.fn();
      mockRebuildClientForBucketRegion.mockResolvedValue({
        send: sentinelSend,
        destroy: sentinelDestroy,
      });
      const marker = JSON.stringify({
        assetBucket: 'cdkd-assets-123456789012-us-east-1',
        containerRepo: 'cdkd-container-assets-123456789012-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      });
      scriptS3(
        {
          region: 'us-east-1',
          keys: ['cdkd/StackA/us-east-1/state.json'],
          schemaVersion: 8,
          markers: { 'us-east-1': marker },
        },
        sentinelSend
      );

      const out = await runStateInfo(['info']);

      // All four helpers succeeded via the sentinel: GetBucketLocation
      // (region), ListObjectsV2 (stack count + markers), GetObject (schema
      // version + marker body).
      expect(out).toContain('Region:          us-east-1 (auto-detected via GetBucketLocation)');
      expect(out).toContain('Schema version:  8');
      expect(out).toContain('Stacks:          1');
      expect(out).toContain('Asset storage:   cdkd-assets mode in 1 region(s)');
      // The traffic went to the SENTINEL client — not the original
      // ambient-region client (which would 301 with PermanentRedirect on a
      // cross-region bucket).
      expect(sentinelSend).toHaveBeenCalled();
      expect(mockS3Send).not.toHaveBeenCalled();
      // The helper was invoked with the original shared client + the
      // ExportIndexStore-style options (never destroy the shared client).
      expect(mockRebuildClientForBucketRegion).toHaveBeenCalledTimes(1);
      expect(mockRebuildClientForBucketRegion).toHaveBeenCalledWith(
        expect.objectContaining({ send: mockS3Send }),
        'cdkd-state-other-region',
        expect.objectContaining({
          reuseClientCredentials: true,
          tolerateNonStandardClient: true,
        })
      );
      // Only the replacement is destroyed; the shared original is left to
      // awsClients.destroy().
      expect(sentinelDestroy).toHaveBeenCalledTimes(1);
      expect(mockS3Destroy).not.toHaveBeenCalled();
    });

    it('keeps using the original client when the helper returns null (same region)', async () => {
      mockResolveWithSource.mockResolvedValue({
        bucket: 'cdkd-state-same-region',
        source: 'cli-flag',
      });
      mockRebuildClientForBucketRegion.mockResolvedValue(null);
      scriptS3({
        region: 'us-east-1',
        keys: ['cdkd/StackA/us-east-1/state.json'],
        schemaVersion: 2,
      });

      const out = await runStateInfo(['info']);

      expect(out).toContain('Stacks:          1');
      // No rebuild — the original client carried all the traffic and was
      // never destroyed by the state-info flow itself.
      expect(mockS3Send).toHaveBeenCalled();
      expect(mockS3Destroy).not.toHaveBeenCalled();
    });
  });
});
