import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { STACK_REF_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';

// Logger / config-loader / aws-clients mocks: same pattern as the
// other state-* tests so the command boot path runs cleanly without
// real AWS or the AWS SDK side-effects.

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
// Issue #2944: the import-refusal SUMMARY is a `logger.warn`, deliberately not a
// fourth count on the `info` summary line, so reading it needs its own spy.
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

// The region of the per-stack AWS scope the code runs in (go-to-k/cdkd#4283).
const awsScope = vi.hoisted(() => ({
  region: undefined as string | undefined,
  providerRegion: undefined as string | undefined,
}));
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation((config?: { region?: string }) => ({
    configuredRegion: config?.region,
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (clients: { configuredRegion?: string }, fn: () => unknown) => {
    const previous = awsScope.region;
    awsScope.region = clients.configuredRegion;
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        awsScope.region = previous;
      });
    }
    awsScope.region = previous;
    return result;
  },
  getAwsClients: vi.fn(),
}));

const mockGetState =
  vi.fn<
    (
      stackName: string,
      region: string
    ) => Promise<{ state: StackState; etag: string; migrationPending?: boolean } | null>
  >();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockSaveState =
  vi.fn<
    (
      stackName: string,
      region: string,
      state: StackState,
      options?: { expectedEtag?: string; migrateLegacy?: boolean }
    ) => Promise<string>
  >();

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.fn<() => Promise<boolean>>();
// Issue #2170: production calls `getLockInfo` to name the holder. Without it
// on the mock the call THREW, the best-effort catch swallowed it, and the
// assertion below still matched the degraded wording — so the test certified
// nothing about this change.
const mockGetLockInfo = vi.fn<() => Promise<unknown>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: mockGetLockInfo,
    releaseLock: mockReleaseLock,
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
const mockRegistryShouldSkip = vi.fn<(resourceType: string) => boolean>().mockReturnValue(false);
// #614: state refresh-observed now calls `getProviderFor` (legacy
// `getProvider` is still used by other state subcommands).
const mockRegistryGetProviderFor = vi
  .fn<(input: { resourceType: string }) => unknown>()
  .mockImplementation((input) => ({
    provider: mockRegistryGetProvider(input.resourceType),
    provisionedBy: 'sdk',
  }));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  // Each registry remembers the AWS scope region it was CONSTRUCTED in — a
  // provider takes its clients at construction (go-to-k/cdkd#4283) — and
  // publishes it as `awsScope.providerRegion` when it hands out a provider.
  ProviderRegistry: vi.fn().mockImplementation(() => {
    const constructedIn = awsScope.region;
    return {
      getProvider: mockRegistryGetProvider,
      getProviderFor: (input: { resourceType: string }) => {
        awsScope.providerRegion = constructedIn;
        return mockRegistryGetProviderFor(input);
      },
      shouldSkipResource: mockRegistryShouldSkip,
      setCustomResourceResponseBucket: vi.fn(),
    };
  }),
}));

// Issue #2036: the per-stack `PublicSsmProver` the command builds. Faked so
// this file can pin the WIRING — which region and producer-region evidence it is
// built with, which bag it is asked about, and that the bag it returns is the
// one the redaction reads. The prover's own lookup (no-decryption
// `GetParameter`, region, error handling) runs unmocked in
// `tests/unit/deployment/public-ssm-proof.test.ts` and
// `tests/unit/cli/import-public-ssm-proof.test.ts`.
const publicSsmProof = vi.hoisted(() => ({
  proven: new Map<string, string>(),
  built: [] as Array<{
    region: string;
    loadEvidence: () => Promise<{ regions: readonly string[]; complete: boolean }>;
  }>,
  askedAbout: [] as unknown[],
}));
vi.mock('../../../src/deployment/public-ssm-proof.js', async () => {
  const { recordProvenPublicExpression } = await import(
    '../../../src/deployment/secret-redaction/mask-only.js'
  );
  return {
    PublicSsmProver: class {
      constructor(
        region: string,
        loadEvidence: () => Promise<{ regions: readonly string[]; complete: boolean }>
      ) {
        publicSsmProof.built.push({ region, loadEvidence });
      }
      async proofBagFor(source: unknown): Promise<Map<string, string>> {
        publicSsmProof.askedAbout.push(source);
        const bag = new Map<string, string>();
        for (const [token, value] of publicSsmProof.proven) {
          recordProvenPublicExpression(bag, token, value);
        }
        return bag;
      }
    },
  };
});

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
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

/**
 * Drive `createStateCommand()` with the refresh-observed subcommand
 * args. `--yes` is included by default so the confirmation prompt
 * doesn't block on stdin in tests.
 */
async function runRefresh(
  args: string[]
): Promise<{ output: string; error: unknown }> {
  const cap = captureStdout();
  let error: unknown;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(['refresh-observed', '--yes', ...args], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    cap.restore();
  }
  return { output: cap.output.join(''), error };
}

function makeResource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: overrides.physicalId ?? 'phys-id',
    resourceType: overrides.resourceType ?? 'AWS::S3::Bucket',
    properties: overrides.properties ?? {},
    ...(overrides.observedProperties && { observedProperties: overrides.observedProperties }),
    ...(overrides.attributes && { attributes: overrides.attributes }),
    ...(overrides.dependencies && { dependencies: overrides.dependencies }),
    // Schema v10 (issue #2944). Conditional like its siblings: the field must be
    // ABSENT from an unmarked record, not present-and-undefined, because the
    // reader tests `=== true` and the JSON a state file carries has no key.
    ...(overrides.observedBaselineRefused && {
      observedBaselineRefused: overrides.observedBaselineRefused,
    }),
    ...(overrides.observedBaselineRefusalReason && {
      observedBaselineRefusalReason: overrides.observedBaselineRefusalReason,
    }),
  };
}

function makeState(
  resources: Record<string, ResourceState>
): { state: StackState; etag: string; migrationPending?: boolean } {
  return {
    state: {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

/**
 * go-to-k/cdkd#4043 (schema v11, review BLOCK-1): a coordinate the record names
 * in `noEchoLeaves` holds `***` in `properties`, which positions nothing for the
 * baseline redaction, so `cdkd state refresh-observed` masks the readback there
 * first, through each list's identity field.
 */
describe('cdkd state refresh-observed on a v11 record with NoEcho coordinates', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('never writes the live value at a marked coordinate into observedProperties', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    const record = makeResource({
      physicalId: 'db',
      resourceType: 'AWS::RDS::DBInstance',
      properties: {
        Value: '***',
        Tags: [{ Key: 'k', Value: '***' }, { Key: 'plain', Value: 'visible' }],
        Port: '***',
        Name: 'kept',
      },
    });
    record.noEchoLeaves = [['Port'], ['Tags', 0, 'Value'], ['Value']];
    mockGetState.mockResolvedValueOnce(makeState({ Db: record }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Value: 'hunter2-secret',
        Tags: [
          { Key: 'plain', Value: 'visible' },
          { Key: 'k', Value: 'tagsecret' },
        ],
        Port: 5432,
        Name: 'kept',
      }),
    });

    const { error } = await runRefresh(['TestStack']);
    expect(error).toBeUndefined();
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , savedState] = mockSaveState.mock.calls[0] as unknown as [string, string, StackState];
    const observed = savedState.resources['Db']!.observedProperties!;
    expect(JSON.stringify(savedState)).not.toContain('hunter2-secret');
    expect(JSON.stringify(savedState)).not.toContain('tagsecret');
    expect(observed['Value']).toBe('***');
    expect(observed['Port']).toBe('***');
    // Paired through the `Key` identity field, never the bare index: the
    // reordered element is masked and its sibling stays.
    expect(observed['Tags']).toEqual([
      { Key: 'plain', Value: 'visible' },
      { Key: 'k', Value: '***' },
    ]);
    expect(observed['Name']).toBe('kept');
  });

  it('leaves a record with no coordinates as before (the control)', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Db: makeResource({
          physicalId: 'db',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { Port: 5432 },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({ readCurrentState: async () => ({ Port: 5432 }) });
    const { error } = await runRefresh(['TestStack']);
    expect(error).toBeUndefined();
    const [, , savedState] = mockSaveState.mock.calls[0] as unknown as [string, string, StackState];
    expect(savedState.resources['Db']!.observedProperties).toEqual({ Port: 5432 });
  });
});
