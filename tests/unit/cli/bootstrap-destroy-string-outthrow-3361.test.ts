import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/bootstrap-destroy.ts` slice: the bootstrap-marker listing's
 * fail-open arm built its warning with `x instanceof Error ? x.message :
 * String(x)`, which turned the "warn and continue" degradation into a hard
 * failure when the value could not be converted --
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`.
 *
 * The case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the teardown runs to the marker delete), never merely "it did not
 * throw". The placeholder is asserted too, so a fix that swallowed the failure
 * without reporting it would not pass.
 */

const { mockS3Send, mockStsSend, mockEcrSend, stateBackendMocks, loggerMocks } = vi.hoisted(
  () => ({
    mockS3Send: vi.fn(),
    mockStsSend: vi.fn(),
    mockEcrSend: vi.fn(),
    stateBackendMocks: {
      getRawObject: vi.fn(),
      listRawKeys: vi.fn(),
      deleteRawObjects: vi.fn(),
      purgeNoncurrentVersions: vi.fn(),
    },
    loggerMocks: {
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  })
);

vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: vi.fn(async () => null),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerMocks, child: () => loggerMocks }),
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

// `--region` is passed, but keep the SDK chain's own STS client off the
// developer's real `~/.aws/config` regardless.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      config: { region: async (): Promise<string> => 'us-east-1' },
      destroy: vi.fn(),
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation((config: { region?: string } = {}) => {
    const region = async (): Promise<string> => config.region ?? 'us-east-1';
    return {
      get s3() {
        return { send: mockS3Send, config: { region }, destroy: vi.fn() };
      },
      get sts() {
        return { send: mockStsSend, config: { region }, destroy: vi.fn() };
      },
      destroy: vi.fn(),
    };
  }),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    ...stateBackendMocks,
    destroyClient: vi.fn(),
  })),
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send, destroy: vi.fn() })),
  };
});

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn().mockImplementation(() => ({ send: mockEcrSend, destroy: vi.fn() })),
  };
});

// Let action errors propagate to parseAsync instead of process.exit-ing.
vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

import { DeleteBucketCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { DeleteRepositoryCommand } from '@aws-sdk/client-ecr';
import { createBootstrapCommand } from '../../../src/cli/commands/bootstrap.js';

const PLACEHOLDER = 'a value that could not be converted to text';
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const MARKER_KEY = `cdkd-bootstrap/${REGION}.json`;
const ASSET_BUCKET = 'my-custom-asset-bucket';
const CONTAINER_REPO = 'my-custom-container-repo';

beforeEach(() => {
  vi.clearAllMocks();
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
  stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
    key === MARKER_KEY
      ? JSON.stringify({
          assetBucket: ASSET_BUCKET,
          containerRepo: CONTAINER_REPO,
          assetSupportVersion: 1,
          createdAt: '2026-07-16T00:00:00.000Z',
        })
      : null
  );
  stateBackendMocks.deleteRawObjects.mockResolvedValue(undefined);
  stateBackendMocks.purgeNoncurrentVersions.mockResolvedValue(undefined);
  mockS3Send.mockImplementation(async (command: object) =>
    command instanceof ListObjectVersionsCommand ? { Versions: [], IsTruncated: false } : {}
  );
  mockEcrSend.mockResolvedValue({});
});

describe('cdkd bootstrap --destroy with an unconvertible marker-listing rejection (#3361)', () => {
  it('warns and carries the teardown through to the marker delete', async () => {
    stateBackendMocks.listRawKeys.mockImplementation(async (prefix: string) => {
      if (prefix === 'cdkd-bootstrap/') throw Object.create(null);
      return [];
    });

    const cmd = createBootstrapCommand();
    cmd.exitOverride();
    // `--force` reaches the teardown without the state-reference scan's own
    // listing, as in bootstrap-destroy.test.ts's fail-open case.
    await cmd.parseAsync(['--destroy', '--region', REGION, '--yes', '--force'], {
      from: 'user',
    });

    const deletedBuckets = mockS3Send.mock.calls
      .map((c) => c[0] as { input: { Bucket?: string } })
      .filter((c) => c instanceof DeleteBucketCommand)
      .map((c) => c.input.Bucket);
    expect(deletedBuckets).toEqual([ASSET_BUCKET]);
    expect(mockEcrSend.mock.calls.some((c) => c[0] instanceof DeleteRepositoryCommand)).toBe(true);
    expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([MARKER_KEY]);

    const warning = loggerMocks.warn.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes('Could not list bootstrap markers'));
    expect(warning).toContain(`(${PLACEHOLDER}). Continuing`);
  });
});
