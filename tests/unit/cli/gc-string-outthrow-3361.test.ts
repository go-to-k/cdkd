import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the `cdkd gc`
 * slice: the custom-resource-response placeholder sweep stringified a caught
 * value with a bare `String()`, which throws
 * `TypeError: Cannot convert object to primitive value` for a value with no
 * prototype (`Object.create(null)`).
 *
 * Two sites, two failure shapes:
 * - the `deleteRawObjects` catch: the TypeError REPLACED the CdkdError it was
 *   building, so the caller lost the GC_DELETE_FAILED identity;
 * - the `finally`'s purge `.catch`: an out-throw there made the `finally`
 *   reject, failing a gc whose delete succeeded (or masking GC_DELETE_FAILED).
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION still
 * happens -- the identity survives, the run completes -- never merely "it did
 * not throw". The placeholder is asserted too, so a fix that swallowed the
 * failure without reporting it would not pass.
 */

const { mockS3Send, mockStsSend, mockEcrSend, mockQuestion, stateBackendMocks, loggerMocks } =
  vi.hoisted(() => ({
    mockS3Send: vi.fn(),
    mockStsSend: vi.fn(),
    mockEcrSend: vi.fn(),
    mockQuestion: vi.fn(),
    stateBackendMocks: {
      getRawObject: vi.fn(),
      listRawKeys: vi.fn(),
      listRawObjects: vi.fn(),
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
  }));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => loggerMocks,
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return { send: mockS3Send, config: { region: async () => REGION }, destroy: vi.fn() };
    },
    get sts() {
      return { send: mockStsSend, config: { region: async () => REGION }, destroy: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => stateBackendMocks),
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

// Region resolution constructs a REAL STSClient (see
// gc-custom-resource-responses.test.ts), so the package is mocked here too.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: mockStsSend,
      config: { region: async () => REGION },
      destroy: vi.fn(),
    })),
  };
});

vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: () => ({ question: mockQuestion, close: vi.fn() }),
  },
}));

const { createGcCommand } = await import('../../../src/cli/commands/gc.js');
const { CUSTOM_RESOURCE_RESPONSE_PREFIX } = await import('../../../src/state/state-prefix.js');
const { CdkdError } = await import('../../../src/utils/error-handler.js');

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const STATE_BUCKET = `cdkd-state-${ACCOUNT}`;
const MARKER_KEY = `cdkd-bootstrap/${REGION}.json`;
const MARKER_BODY = JSON.stringify({
  assetBucket: 'my-custom-asset-bucket',
  containerRepo: 'my-custom-container-repo',
  assetSupportVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const OLD = new Date(Date.now() - 90 * 24 * 3600_000);
/** A producer-shaped key, so the sweep really collects it. */
const ABANDONED_KEY = `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/cdkd-1756000000000-a1b2c3.json`;

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

async function runGc(args: string[]): Promise<void> {
  const cmd = createGcCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' });
}

const infoText = (): string => loggerMocks.info.mock.calls.map((c) => String(c[0])).join('\n');
const warnText = (): string => loggerMocks.warn.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
  stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
    key === MARKER_KEY ? MARKER_BODY : null
  );
  stateBackendMocks.listRawKeys.mockResolvedValue([]);
  stateBackendMocks.listRawObjects.mockResolvedValue([
    { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
  ]);
  stateBackendMocks.deleteRawObjects.mockResolvedValue(undefined);
  stateBackendMocks.purgeNoncurrentVersions.mockResolvedValue(undefined);
  mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });
  mockEcrSend.mockResolvedValue({ imageDetails: [] });
  mockQuestion.mockResolvedValue('y');
});

describe('cdkd gc: an unstringifiable rejection in the placeholder sweep (issue #3361)', () => {
  it('a delete rejecting with it still surfaces as GC_DELETE_FAILED, naming the placeholder', async () => {
    stateBackendMocks.deleteRawObjects.mockRejectedValue(unconvertible());

    const caught = await runGc(['--yes']).catch((e: unknown) => e);

    // The identity, not merely "something was thrown": before the fix the
    // TypeError from `String()` replaced the CdkdError being built.
    expect(caught).toBeInstanceOf(CdkdError);
    expect(caught).toMatchObject({ code: 'GC_DELETE_FAILED' });
    expect((caught as Error).message).toBe(
      `Failed to delete abandoned custom-resource response placeholder(s) ` +
        `from ${STATE_BUCKET}: ${PLACEHOLDER}`
    );
    // The purge in the `finally` still ran (and its success did not mask the throw).
    expect(stateBackendMocks.purgeNoncurrentVersions).toHaveBeenCalledTimes(1);
    expect(infoText()).not.toContain('gc completed');
  });

  it('a purge rejecting with it leaves a successful gc completing, and warns with the placeholder', async () => {
    stateBackendMocks.purgeNoncurrentVersions.mockRejectedValue(unconvertible());

    await expect(runGc(['--yes'])).resolves.toBeUndefined();

    expect(stateBackendMocks.deleteRawObjects).toHaveBeenCalledWith([ABANDONED_KEY]);
    expect(infoText()).toContain(
      `✓ Deleted 1 abandoned custom-resource response placeholder(s) (512 B) from ${STATE_BUCKET}`
    );
    expect(infoText()).toContain('✓ gc completed: 512 B reclaimed');
    expect(warnText()).toContain(
      `remain readable via GetObject with a VersionId. Underlying error: ${PLACEHOLDER}`
    );
  });

  it('both rejecting with it: the purge warns and the GC_DELETE_FAILED identity survives', async () => {
    stateBackendMocks.deleteRawObjects.mockRejectedValue(unconvertible());
    stateBackendMocks.purgeNoncurrentVersions.mockRejectedValue(unconvertible());

    const caught = await runGc(['--yes']).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(CdkdError);
    expect(caught).toMatchObject({ code: 'GC_DELETE_FAILED' });
    expect((caught as Error).message).toContain(PLACEHOLDER);
    expect(warnText()).toContain(`Underlying error: ${PLACEHOLDER}`);
  });
});
