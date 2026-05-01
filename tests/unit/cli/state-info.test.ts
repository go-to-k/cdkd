import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
function scriptS3({
  region,
  keys,
  schemaVersion,
}: {
  region: string | null;
  keys: string[];
  schemaVersion?: number | 'malformed' | 'no-body';
}): void {
  mockS3Send.mockImplementation(async (command) => {
    if (command instanceof GetBucketLocationCommand) {
      if (region === null) {
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      }
      // S3 returns null/empty for us-east-1.
      if (region === 'us-east-1') return { LocationConstraint: undefined };
      return { LocationConstraint: region };
    }
    if (command instanceof ListObjectsV2Command) {
      return {
        Contents: keys.map((Key) => ({ Key })),
        NextContinuationToken: undefined,
      };
    }
    if (command instanceof GetObjectCommand) {
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
});
