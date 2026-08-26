import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const { mockSend, infoSpy, warnSpy, errorSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  infoSpy: vi.fn(),
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  // Issue #2230: DEFENSIVE here, unlike in the four `drift` suites that carry
  // the same line. This file drives `createDriftCommand` but passes `--json` in
  // no case, so `drift.ts` never reaches the call and the entry is unused
  // today. It is kept because the failure it prevents is silent in the wrong
  // direction: a missing export is `undefined`, the call throws before
  // `writeJsonReport`, and the first `--json` case added here would parse an
  // EMPTY stdout -- reading as a broken payload rather than as a broken mock.
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

// The REAL DynamoDBTableProvider runs against this client.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const mockGetState = vi.fn<
  (
    stackName: string,
    region: string
  ) => Promise<{ state: StackState; etag: string } | null>
>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockSaveState = vi.fn<() => Promise<string>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';
import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

/** The declared value; AWS has since GROWN past it. */
const DECLARED_WARM = { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000 };
const LIVE_WARM = { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000, Status: 'ACTIVE' };

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

async function runDrift(args: string[]): Promise<{ output: string; error: unknown }> {
  const cap = captureStdout();
  let error: unknown;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    cap.restore();
  }
  return { output: cap.output.join(''), error };
}

function makeState(resource: ResourceState): { state: StackState; etag: string } {
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { Table1: resource },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

/**
 * Issue #1768 at the CALLER, not at the provider seam.
 *
 * The provider-level tests prove `update()` skips the doomed `UpdateTable`.
 * What a user actually experiences is decided one layer up, and the repo's
 * skip-arm rule says not to take that by inspection: `cdkd drift --revert`
 * counts the resource as reverted, prints its success summary and exits 0 —
 * while the drift is still there, because the skip deliberately records
 * nothing. Every mock here is infrastructure (state backend, lock, registry);
 * the DynamoDB provider under test is the REAL one, driven by the REAL command.
 */
describe('cdkd drift --revert on an unrevertable WarmThroughput (issue #1768)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    exitSpy.mockRestore();
  });

  beforeEach(() => {
    // Stub process.exit so the drift run's DriftDetectedError -> exit(1) does
    // not kill the worker; the throw is what returns control to runDrift.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    mockSend.mockReset();
    vi.clearAllMocks();
    mockRegistryGetProvider.mockReturnValue(new DynamoDBTableProvider());
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof UpdateTableCommand) return Promise.resolve({});
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          TableArn: TABLE_ARN,
          TableStatus: 'ACTIVE',
          WarmThroughput: LIVE_WARM,
        },
      });
    });
  });

  it('reports the drift, then reverts everything else and exits 0 without a doomed call', async () => {
    const resource: ResourceState = {
      physicalId: TABLE_NAME,
      resourceType: RESOURCE_TYPE,
      properties: { TableName: TABLE_NAME, WarmThroughput: DECLARED_WARM },
      observedProperties: { TableName: TABLE_NAME, WarmThroughput: DECLARED_WARM },
      attributes: {},
      dependencies: [],
    };

    // 1. `cdkd drift` REPORTS the difference — the issue's step 1, which the
    //    fix deliberately preserves.
    mockGetState.mockResolvedValue(makeState(resource));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).toContain('WarmThroughput');
    expect(exitSpy).toHaveBeenCalledWith(1); // drift detected -> non-zero exit

    // 2. `--revert` used to issue an UpdateTable AWS rejects, failing the
    //    resource with `could not revert` (exit 2). Now: no WarmThroughput call
    //    at all, no error, and the summary counts the resource as reverted.
    vi.clearAllMocks();
    mockGetState.mockResolvedValue(makeState(resource));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);

    expect(revert.error).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    const warmCalls = mockSend.mock.calls
      .filter((c) => c[0] instanceof UpdateTableCommand)
      .map((c) => (c[0] as UpdateTableCommand).input)
      .filter((input) => input.WarmThroughput !== undefined);
    expect(warmCalls).toEqual([]);
    expect(infoSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('1 reverted');
    // The skip is ANNOUNCED at the provider, so "reverted" is never the only
    // thing the user sees.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'decreasing WarmThroughput is not supported'
    );

    // 3. Nothing was recorded, so the NEXT drift still reports it — which is
    //    what the provider's warning now says (and what makes `--revert`
    //    honest rather than silently converging).
    expect(mockSaveState).not.toHaveBeenCalled();
  });
});
