import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const errorSpy = vi.hoisted(() => vi.fn());
// Hoisted so the issue-#1515 denial tests can read what the command WARNED.
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
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

// Issue #1515: the principal canonicalization resolves an IAM role/user ARN to
// its unique id via `iam:GetRole` / `GetUser`. The client is only touched when
// a policy actually carries a unique-id principal, so every other test in this
// file never reaches it.
const mockIamSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: mockIamSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
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
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
const mockRegistryShouldSkip = vi.fn<(resourceType: string) => boolean>().mockReturnValue(false);
const mockRegistrySetCustomBucket = vi.fn();
// #614: drift's new code path uses `getProviderFor({resourceType, provisionedBy})`
// instead of `getProvider(type)`. Wrap the existing `getProvider` mock so
// the routing-decision shape is returned with `provisionedBy: 'sdk'`
// (legacy default; the test fixtures don't set state.provisionedBy).
const mockRegistryGetProviderFor = vi
  .fn<(input: { resourceType: string }) => unknown>()
  .mockImplementation((input) => ({
    provider: mockRegistryGetProvider(input.resourceType),
    provisionedBy: 'sdk',
  }));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: mockRegistryGetProviderFor,
    shouldSkipResource: mockRegistryShouldSkip,
    setCustomResourceResponseBucket: mockRegistrySetCustomBucket,
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// PR J: drift falls back to Cloud Control API when an SDK provider does
// not implement `readCurrentState`. Mock the CC API readCurrentState so
// tests can simulate "fallback returns undefined" (drift unknown) by
// default; tests that exercise the fallback override per-call.
const mockCcReadCurrentState = vi
  .fn<(physicalId: string, logicalId: string, type: string) => Promise<Record<string, unknown> | undefined>>()
  .mockResolvedValue(undefined);
vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: mockCcReadCurrentState,
  })),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';

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
 * `createDriftCommand()` returns the `drift` subcommand directly. Pass the
 * args that would follow `cdkd drift ...` on the CLI — no leading `drift`.
 *
 * Returns `{ output, error }` so callers can inspect both the printed
 * report (`writeHumanReport` runs before any `DriftDetectedError` /
 * `process.exit` sentinel) and any thrown error in the same line.
 */
async function runDrift(
  args: string[]
): Promise<{ output: string; error: unknown }> {
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

function makeResource(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: overrides.physicalId ?? 'phys-id',
    resourceType: overrides.resourceType ?? 'AWS::S3::Bucket',
    properties: overrides.properties ?? {},
    ...(overrides.observedProperties && { observedProperties: overrides.observedProperties }),
    ...(overrides.attributes && { attributes: overrides.attributes }),
    ...(overrides.dependencies && { dependencies: overrides.dependencies }),
  };
}

function makeState(
  resources: Record<string, ResourceState>
): { state: StackState; etag: string } {
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

describe('cdkd drift', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue(undefined);
    mockSaveState.mockReset();
    mockSaveState.mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    mockCcReadCurrentState.mockReset().mockResolvedValue(undefined);
    mockIamSend.mockReset();
    errorSpy.mockReset();
    warnSpy.mockReset();
    // Stub process.exit so DriftDetectedError -> exit(1) doesn't kill the test.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('prints "no drift detected" when every resource matches AWS', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    expect(output).toContain('1 resource checked');
    expect(output).toContain('0 unsupported');
    // No drift => no process.exit(1) — the command returns normally.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not report drift on a template-undeclared key captured empty and later sibling-populated (issue #1498)', async () => {
    // Live repro shape: ECS Cluster's observed snapshot was captured BEFORE
    // the sibling ClusterCapacityProviderAssociations resource ran, so
    // CapacityProviders landed in observedProperties as [] although the
    // template never declares it. The later drift read sees the sibling's
    // attach — which must NOT be drift (CFn only compares declared props).
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Cluster1: makeResource({
          physicalId: 'my-cluster',
          resourceType: 'AWS::ECS::Cluster',
          properties: { ClusterName: 'my-cluster' },
          observedProperties: { ClusterName: 'my-cluster', CapacityProviders: [] },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        ClusterName: 'my-cluster',
        CapacityProviders: ['MyCapacityProvider'],
      }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still reports drift on an undeclared key captured with a REAL value that later changed', async () => {
    // The observed baseline's extra power over CFn drift stays: an AWS-side
    // default captured with a real value at deploy time IS compared, so a
    // console-side change to it surfaces.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Cluster1: makeResource({
          physicalId: 'my-cluster',
          resourceType: 'AWS::ECS::Cluster',
          properties: { ClusterName: 'my-cluster' },
          observedProperties: {
            ClusterName: 'my-cluster',
            ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        ClusterName: 'my-cluster',
        ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
      }),
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('drift detected');
    expect(output).toContain('ClusterSettings');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('reports drifted properties with +/- diff lines and exits 1', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { VersioningConfiguration: { Status: 'Enabled' } },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
    });

    const { output, error } = await runDrift(['TestStack']);

    // Drift detected — error-handler called process.exit(1) which our
    // stub turned into a thrown sentinel.
    expect((error as Error).message).toBe('__exit__');
    expect(output).toContain('⚠ TestStack (us-east-1): drift detected on 1 resource');
    expect(output).toContain('~ Bucket1 (AWS::S3::Bucket)');
    expect(output).toContain('- VersioningConfiguration.Status: Enabled');
    expect(output).toContain('+ VersioningConfiguration.Status: Suspended');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('uses observedProperties as baseline when present (catches console-side changes to keys not in template)', async () => {
    // Simulates a v3 state record: deploy captured AWS-current
    // properties into observedProperties, including a `Tags` key the
    // user did not set in their CDK template. A console-side change
    // to that key must surface as drift even though `properties` has
    // no Tags key. NOTE (issue #1498): the captured value must be
    // NON-empty for the key to stay comparable — an undeclared key
    // captured EMPTY is treated as sibling-/AWS-managed and skipped
    // (see the dedicated #1498 tests above), matching CFn's
    // declared-properties-only comparison for that class.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
          observedProperties: { BucketName: 'b', Tags: [{ Key: 'env', Value: 'dev' }] },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        BucketName: 'b',
        Tags: [{ Key: 'env', Value: 'prod' }],
      }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect((error as Error | undefined)?.message).toBe('__exit__');
    expect(output).toContain('drift detected on 1 resource');
    expect(output).toContain('~ Bucket1 (AWS::S3::Bucket)');
    expect(output).toContain('Tags');
  });

  it('detects a console-side key add inside a map-shaped property (union-walk via observedProperties baseline)', async () => {
    // The headline regression case for the union-walk wiring: Lambda
    // `Environment.Variables` started with `{FOO: 'bar'}` at deploy
    // (observed records that). User adds `EXTRA` via the console.
    // observedProperties is present, so drift.ts passes
    // unionWalkObjects=true to calculateResourceDrift, which walks the
    // union of state+aws keys when descending into nested objects.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Fn1: makeResource({
          physicalId: 'fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { FOO: 'bar' } } },
          observedProperties: { Environment: { Variables: { FOO: 'bar' } } },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { FOO: 'bar', EXTRA: 'hacked' } },
      }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect((error as Error | undefined)?.message).toBe('__exit__');
    expect(output).toContain('drift detected on 1 resource');
    expect(output).toContain('Environment.Variables.EXTRA');
    expect(output).toContain('hacked');
  });

  it('does NOT detect a console-side key add when falling back to the properties baseline (v2 state semantics preserved)', async () => {
    // Symmetric guard: when observedProperties is absent (v2 fallback),
    // drift.ts must NOT pass unionWalkObjects=true — otherwise AWS-side
    // defaults the user did not template would fire false positives on
    // every clean run for v2-state stacks. The same map-key add that
    // surfaces in the previous test must stay invisible here.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Fn1: makeResource({
          physicalId: 'fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { FOO: 'bar' } } },
          // observedProperties intentionally omitted -> properties fallback.
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { FOO: 'bar', EXTRA: 'hacked' } },
      }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
  });

  it('falls back to properties baseline when observedProperties is absent (older state files)', async () => {
    // Pre-v3 state record (or a provider with no readCurrentState
    // capture): no observedProperties. Drift comparator must keep its
    // pre-v3 behaviour and only compare keys present in `properties`.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
          // observedProperties intentionally omitted.
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // AWS-side has tags now, but cdkd state has no Tags key in
      // properties — fallback baseline = properties = no Tags = no drift.
      readCurrentState: async () => ({
        BucketName: 'b',
        Tags: [{ Key: 'env', Value: 'prod' }],
      }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
  });

  it('skips state property paths declared by getDriftUnknownPaths so they never fire false drift', async () => {
    // Mirrors Lambda's `Code` problem: state holds the asset key, but
    // `GetFunction` returns a pre-signed URL — so without ignore-paths the
    // resource would always report drift on `Code`.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Fn1: makeResource({
          physicalId: 'fn',
          resourceType: 'AWS::Lambda::Function',
          properties: {
            Code: { S3Bucket: 'b', S3Key: 'k.zip' },
            MemorySize: 128,
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // AWS-side snapshot omits `Code` (matches the real Lambda provider).
      readCurrentState: async () => ({ MemorySize: 128 }),
      getDriftUnknownPaths: () => ['Code'],
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
    expect(output).not.toContain('Code');
  });

  it('passes the resource properties to getDriftUnknownPaths so a provider can scope the path per resource (issue #1602)', async () => {
    // The #1602 shape: API Gateway V2 `TlsConfig` is readable only on a
    // VPC_LINK integration, so the provider needs the resource's own
    // ConnectionType to decide. Deleting the `resource.properties` argument
    // in src/cli/commands/drift.ts must fail this test.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Int1: makeResource({
          physicalId: 'int-1',
          resourceType: 'AWS::ApiGatewayV2::Integration',
          properties: {
            ApiId: 'api',
            IntegrationType: 'HTTP_PROXY',
            ConnectionType: 'INTERNET',
            TlsConfig: { ServerNameToVerify: 'backend.example.com' },
          },
        }),
      })
    );
    const getDriftUnknownPaths = vi.fn((_type: string, properties?: Record<string, unknown>) =>
      properties?.['ConnectionType'] !== 'VPC_LINK' ? ['TlsConfig'] : []
    );
    mockRegistryGetProvider.mockReturnValue({
      // AWS never returns TlsConfig for a public integration.
      readCurrentState: async () => ({
        ApiId: 'api',
        IntegrationType: 'HTTP_PROXY',
        ConnectionType: 'INTERNET',
      }),
      getDriftUnknownPaths,
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(getDriftUnknownPaths).toHaveBeenCalledWith(
      'AWS::ApiGatewayV2::Integration',
      expect.objectContaining({ ConnectionType: 'INTERNET' })
    );
    expect(output).toContain('no drift detected');
    expect(output).not.toContain('TlsConfig');
  });

  // Issue #1096 item 1. These drive the REAL command path (runDriftForStack ->
  // calculateResourceDrift), not calculateResourceDrift directly, so they
  // actually exercise the `provider.getDriftUnorderedPaths` call site and the
  // `useObserved` baseline branch. Deleting either the provider call or the
  // `unorderedPaths` argument in src/cli/commands/drift.ts must fail these.
  it('sorts plain-string arrays declared by getDriftUnorderedPaths (observedProperties baseline)', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Fs1: makeResource({
          physicalId: 'fs-1',
          resourceType: 'AWS::FSx::FileSystem',
          properties: {
            WindowsConfiguration: { Aliases: ['a.example.com', 'b.example.com'] },
          },
          // Present => the observed baseline branch (unionWalkObjects: true).
          observedProperties: {
            WindowsConfiguration: { Aliases: ['a.example.com', 'b.example.com'] },
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // AWS returns the same set in a different order.
      readCurrentState: async () => ({
        WindowsConfiguration: { Aliases: ['b.example.com', 'a.example.com'] },
      }),
      getDriftUnorderedPaths: () => ['WindowsConfiguration.Aliases'],
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
  });

  it('sorts plain-string arrays declared by getDriftUnorderedPaths (properties-fallback baseline)', async () => {
    // The load-bearing case for putting the sort in the shared normalizer.
    // observedProperties is ABSENT, so the baseline is the user's TEMPLATE
    // order. Sorting only inside the provider's readCurrentState would
    // manufacture drift here instead of removing it.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Fs1: makeResource({
          physicalId: 'fs-1',
          resourceType: 'AWS::FSx::FileSystem',
          // Template order, deployed before observed-capture.
          properties: {
            WindowsConfiguration: { Aliases: ['b.example.com', 'a.example.com'] },
          },
          // observedProperties intentionally omitted.
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        WindowsConfiguration: { Aliases: ['a.example.com', 'b.example.com'] },
      }),
      getDriftUnorderedPaths: () => ['WindowsConfiguration.Aliases'],
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
  });

  it('still reports a reorder as drift when the provider declares no unordered paths', async () => {
    // Negative control for the two tests above: identical fixture minus the
    // getDriftUnorderedPaths declaration. Proves the clean result there comes
    // from the declaration being threaded through, not from some other
    // normalization pass swallowing the reorder.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Fs1: makeResource({
          physicalId: 'fs-1',
          resourceType: 'AWS::FSx::FileSystem',
          properties: {
            WindowsConfiguration: { Aliases: ['a.example.com', 'b.example.com'] },
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        WindowsConfiguration: { Aliases: ['b.example.com', 'a.example.com'] },
      }),
      // No getDriftUnorderedPaths.
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('WindowsConfiguration.Aliases');
  });

  it('silently skips `Custom::*` resource types (drift not applicable, issue #323)', async () => {
    // Originally: when a stack contains a `Custom::*` resource (e.g.
    // CDK's S3 auto-delete-objects helper), the provider has no
    // readCurrentState so drift falls back to the Cloud Control API,
    // which rejects the type pattern with `ValidationException`. The
    // first fix short-circuited Custom::* to "drift unknown" so the
    // user can still drift the rest of the stack.
    // Issue #323: "drift unknown" for Custom::* was actionable
    // noise — drift on a Custom Resource would require re-invoking
    // its handler Lambda (out of scope for `cdkd drift`), so the
    // outcome is now silent (`kind: 'skipped'`) and not surfaced in
    // the human report. CC API fallback is still bypassed.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        AutoDelete: makeResource({
          resourceType: 'Custom::S3AutoDeleteObjects',
          properties: { ServiceToken: 'arn:aws:lambda:...:fn' },
        }),
      })
    );
    // Provider lookup is bypassed entirely for Custom::* now.
    mockCcReadCurrentState.mockImplementation(() => {
      throw new Error('CC API should not be called for Custom::* types');
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
    // Custom::* is silently skipped — does NOT appear in the report.
    expect(output).not.toContain('? AutoDelete');
    expect(output).not.toContain('Custom::S3AutoDeleteObjects');
    expect(mockCcReadCurrentState).not.toHaveBeenCalled();
  });

  it('reports providers without readCurrentState as drift unknown', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        SomeRes: makeResource({
          resourceType: 'AWS::Lambda::Function',
          properties: { MemorySize: 128 },
        }),
      })
    );
    // Provider exists but does not implement readCurrentState yet (PR D
    // adds SDK-side support).
    mockRegistryGetProvider.mockReturnValue({});

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('? SomeRes (AWS::Lambda::Function)');
    expect(output).toContain('drift unknown');
    expect(output).toContain('1 unsupported');
    // Drift unknown is not drift -> exit 0.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--json emits a structured per-stack report', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { VersioningConfiguration: { Status: 'Enabled' } },
        }),
        Other: makeResource({
          resourceType: 'AWS::Lambda::Function',
          properties: { MemorySize: 128 },
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation((resourceType: string) => {
      if (resourceType === 'AWS::S3::Bucket') {
        return {
          readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
        };
      }
      return {};
    });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as Array<{
      stack: string;
      region: string;
      drifted: Array<{ logicalId: string; type: string; changes: unknown[] }>;
      clean: Array<{ logicalId: string }>;
      notSupported: Array<{ logicalId: string }>;
    }>;
    expect(payload).toHaveLength(1);
    expect(payload[0]?.stack).toBe('TestStack');
    expect(payload[0]?.region).toBe('us-east-1');
    expect(payload[0]?.drifted).toEqual([
      {
        logicalId: 'Bucket1',
        type: 'AWS::S3::Bucket',
        changes: [
          {
            path: 'VersioningConfiguration.Status',
            stateValue: 'Enabled',
            awsValue: 'Suspended',
          },
        ],
      },
    ]);
    expect(payload[0]?.notSupported.map((n) => n.logicalId)).toEqual(['Other']);
  });

  it('auto-selects the only stack in state when no name is given (mirrors deploy/destroy)', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { output, error } = await runDrift([]);
    expect(error).toBeUndefined();
    expect(output).toContain('TestStack');
    expect(output).toContain('no drift detected');
  });

  it('rejects with a multi-stack listing when no name is given and state has more than one stack', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'StackA', region: 'us-east-1' },
      { stackName: 'StackB', region: 'us-east-1' },
    ]);

    await runDrift([]);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/Multiple stacks found in state/);
    expect(messages).toMatch(/StackA/);
    expect(messages).toMatch(/StackB/);
  });

  it('rejects with a clear error when state is empty and no name is given', async () => {
    mockListStacks.mockResolvedValueOnce([]);

    await runDrift([]);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/No stacks found in state bucket/);
  });

  it('rejects with a clear error when the named stack has no state', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'OtherStack', region: 'us-east-1' },
    ]);

    await runDrift(['TestStack']);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/No state found for stack 'TestStack'/);
  });

  it('rejects --accept and --revert together at parse time', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    await runDrift(['TestStack', '--accept', '--revert', '--yes']);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/--accept and --revert are mutually exclusive/);
    // saveState / provider.update never run when the flags collide.
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  describe('--accept (state ← AWS)', () => {
    it('writes the AWS-current values into state', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: {
              BucketName: 'b',
              VersioningConfiguration: { Status: 'Enabled' },
            },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({
          BucketName: 'b',
          VersioningConfiguration: { Status: 'Suspended' },
        }),
      });

      const { error } = await runDrift(['TestStack', '--accept', '--yes']);
      expect(error).toBeUndefined();

      expect(mockAcquireLock).toHaveBeenCalledWith(
        'TestStack',
        'us-east-1',
        expect.any(String),
        'drift-accept'
      );
      expect(mockReleaseLock).toHaveBeenCalledWith('TestStack', 'us-east-1');

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const [stackName, region, savedState, opts] = mockSaveState.mock.calls[0]!;
      expect(stackName).toBe('TestStack');
      expect(region).toBe('us-east-1');
      expect(opts?.expectedEtag).toBe('"etag-1"');
      expect(savedState.resources['Bucket1']!.properties).toEqual({
        BucketName: 'b',
        VersioningConfiguration: { Status: 'Suspended' },
      });
    });

    it('--accept with --dry-run does NOT call saveState or acquire a lock', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
      });

      const { output, error } = await runDrift(['TestStack', '--accept', '--dry-run', '--yes']);

      expect(error).toBeUndefined();
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockAcquireLock).not.toHaveBeenCalled();
      expect(output).toContain('Plan (--accept)');
      expect(output).toContain('VersioningConfiguration.Status: Enabled -> Suspended');
    });

    it('--accept on a clean stack is a no-op', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: { BucketName: 'b' },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ BucketName: 'b' }),
      });

      const { error } = await runDrift(['TestStack', '--accept', '--yes']);

      expect(error).toBeUndefined();
      expect(mockAcquireLock).not.toHaveBeenCalled();
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('handles nested dotted paths when accepting', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: {
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                BlockPublicPolicy: true,
              },
            },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: false,
          },
        }),
      });

      await runDrift(['TestStack', '--accept', '--yes']);

      const [, , savedState] = mockSaveState.mock.calls[0]!;
      expect(savedState.resources['Bucket1']!.properties).toEqual({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: false,
        },
      });
    });
  });

  describe('--revert (AWS ← state)', () => {
    it('calls provider.update with stateProps as new and AWS-current as previous', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'phys-b',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
        })
      );
      const updateMock = vi.fn<
        (
          logicalId: string,
          physicalId: string,
          resourceType: string,
          newProperties: Record<string, unknown>,
          previousProperties: Record<string, unknown>
        ) => Promise<{ physicalId: string; wasReplaced: boolean }>
      >(async () => ({ physicalId: 'phys-b', wasReplaced: false }));
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
        update: updateMock,
      });

      const { error } = await runDrift(['TestStack', '--revert', '--yes']);

      expect(error).toBeUndefined();
      expect(updateMock).toHaveBeenCalledTimes(1);
      const [logicalId, physicalId, resourceType, newProps, previousProps] =
        updateMock.mock.calls[0]!;
      expect(logicalId).toBe('Bucket1');
      expect(physicalId).toBe('phys-b');
      expect(resourceType).toBe('AWS::S3::Bucket');
      expect(newProps).toEqual({ VersioningConfiguration: { Status: 'Enabled' } });
      expect(previousProps).toEqual({ VersioningConfiguration: { Status: 'Suspended' } });

      // State is NOT updated by --revert.
      expect(mockSaveState).not.toHaveBeenCalled();

      expect(mockAcquireLock).toHaveBeenCalledWith(
        'TestStack',
        'us-east-1',
        expect.any(String),
        'drift-revert'
      );
      expect(mockReleaseLock).toHaveBeenCalledWith('TestStack', 'us-east-1');
    });

    it('--revert with --dry-run does NOT call provider.update or acquire a lock', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
        })
      );
      const updateMock = vi.fn();
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
        update: updateMock,
      });

      const { output, error } = await runDrift([
        'TestStack',
        '--revert',
        '--dry-run',
        '--yes',
      ]);

      expect(error).toBeUndefined();
      expect(updateMock).not.toHaveBeenCalled();
      expect(mockAcquireLock).not.toHaveBeenCalled();
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(output).toContain('Plan (--revert)');
    });

    it('--revert WARNS about AWS-authored values it will drop when state has no observedProperties (issue #1478)', async () => {
      // End-to-end wiring, not just the pure helper: the warning has to reach
      // the PLAN, which is what the user sees before confirming and what
      // --dry-run prints.
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Table1: makeResource({
            physicalId: 't',
            resourceType: 'AWS::Glue::Table',
            // No observedProperties -> the baseline is the raw template.
            properties: { Parameters: { classification: 'parquet' } },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({
          Parameters: {
            classification: 'json',
            table_type: 'ICEBERG',
            metadata_location: 's3://b/metadata/00000.json',
          },
        }),
        update: vi.fn(),
      });

      const { output, error } = await runDrift(['TestStack', '--revert', '--dry-run', '--yes']);

      expect(error).toBeUndefined();
      expect(output).toContain('DROP 2 AWS-authored values');
      expect(output).toContain('Parameters.table_type');
      expect(output).toContain('Parameters.metadata_location');
      expect(output).toContain('Re-deploy the stack first');
    });

    it('--revert does NOT warn when state HAS observedProperties (issue #1478)', async () => {
      // The negative half, matching the shape the regression would take: with
      // an observed baseline the desired side already carries AWS-authored
      // fields, so dropping one is a legitimate revert of a real console
      // change. Warning there would fire on essentially every revert and
      // train the user to ignore it.
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Table1: makeResource({
            physicalId: 't',
            resourceType: 'AWS::Glue::Table',
            properties: { Parameters: { classification: 'parquet' } },
            observedProperties: {
              Parameters: { classification: 'parquet', table_type: 'ICEBERG' },
            },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({
          Parameters: { classification: 'json', table_type: 'ICEBERG' },
        }),
        update: vi.fn(),
      });

      const { output, error } = await runDrift(['TestStack', '--revert', '--dry-run', '--yes']);

      expect(error).toBeUndefined();
      expect(output).toContain('Plan (--revert)');
      expect(output).not.toContain('AWS-authored');
    });

    it('--revert on a clean stack is a no-op', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: { BucketName: 'b' },
          }),
        })
      );
      const updateMock = vi.fn();
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ BucketName: 'b' }),
        update: updateMock,
      });

      const { error } = await runDrift(['TestStack', '--revert', '--yes']);
      expect(error).toBeUndefined();
      expect(updateMock).not.toHaveBeenCalled();
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });

    it('--revert exits 2 (PartialFailureError) when one provider.update fails', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Bucket1: makeResource({
            physicalId: 'phys-1',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
          Bucket2: makeResource({
            physicalId: 'phys-2',
            resourceType: 'AWS::S3::Bucket',
            properties: { VersioningConfiguration: { Status: 'Enabled' } },
          }),
        })
      );
      const updateMock = vi.fn(async (logicalId: string) => {
        if (logicalId === 'Bucket1') {
          throw new Error('AccessDenied');
        }
        return { physicalId: 'phys-2', wasReplaced: false };
      });
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
        update: updateMock,
      });

      const { error } = await runDrift(['TestStack', '--revert', '--yes']);

      // PartialFailureError → handler triggers process.exit(2) which our
      // stub turns into an "__exit__" sentinel.
      expect((error as Error).message).toBe('__exit__');
      expect(exitSpy).toHaveBeenCalledWith(2);

      // Both updates were attempted; the second succeeded.
      expect(updateMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('CC API fallback (PR J)', () => {
    it('falls back to CC API readCurrentState when the SDK provider lacks it', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Topic1: makeResource({
            physicalId: 'arn:aws:sns:us-east-1:123:Topic1',
            resourceType: 'AWS::SNS::Topic',
            // The SNS provider has its own readCurrentState in real
            // life, but for this test the registry returns a stub
            // without one to drive the fallback path.
            properties: { TopicName: 'Topic1' },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({}); // no readCurrentState
      mockCcReadCurrentState.mockResolvedValueOnce({ TopicName: 'Topic1' });

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(mockCcReadCurrentState).toHaveBeenCalledTimes(1);
      // Clean: CC API answer matched state.
      expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    });

    it('strips AWS-managed fields from CC API response before comparison', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Topic1: makeResource({
            physicalId: 'arn:aws:sns:us-east-1:123:Topic1',
            resourceType: 'AWS::SNS::Topic',
            properties: { TopicName: 'Topic1' },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({});
      // CC API returns timestamps + status that cdkd state never set —
      // these must be stripped, not surfaced as drift.
      mockCcReadCurrentState.mockResolvedValueOnce({
        TopicName: 'Topic1',
        CreationDate: '2024-01-01T00:00:00Z',
        LastModifiedTime: '2024-06-01T00:00:00Z',
        Status: 'Active',
      });

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(output).toContain('✓ TestStack (us-east-1): no drift detected');
    });

    it('reports deny-listed types as drift unknown without calling CC API', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          // AWS::ApiGateway::RestApi is in the deny list (write-only Body field).
          RestApi1: makeResource({
            physicalId: 'rest-api-id',
            resourceType: 'AWS::ApiGateway::RestApi',
            properties: { Body: { swagger: '2.0' } },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({});

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(mockCcReadCurrentState).not.toHaveBeenCalled();
      expect(output).toContain('? RestApi1 (AWS::ApiGateway::RestApi)');
      expect(output).toContain('1 unsupported');
    });

    it('treats CC API ResourceNotFound (undefined) as drift unknown', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Foo: makeResource({
            physicalId: 'foo',
            resourceType: 'AWS::SomeService::SomeType',
            properties: { Bar: 1 },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({});
      // Default mock returns undefined — simulates "resource gone from AWS".

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(mockCcReadCurrentState).toHaveBeenCalledTimes(1);
      expect(output).toContain('? Foo (AWS::SomeService::SomeType)');
    });
  });

  it('--all checks every stack in the bucket', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'StackA', region: 'us-east-1' },
      { stackName: 'StackB', region: 'us-west-2' },
    ]);
    mockGetState.mockImplementation(async (stackName, region) => ({
      state: {
        version: 2,
        stackName,
        region,
        resources: {
          Bucket1: makeResource({
            physicalId: `${stackName}-b`,
            resourceType: 'AWS::S3::Bucket',
            properties: { BucketName: `${stackName}-b` },
          }),
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"etag-1"',
    }));
    mockRegistryGetProvider.mockImplementation(() => ({
      readCurrentState: async (physicalId: string) => ({ BucketName: physicalId }),
    }));

    const { output, error } = await runDrift(['--all']);

    expect(error).toBeUndefined();
    expect(output).toContain('✓ StackA (us-east-1): no drift detected');
    expect(output).toContain('✓ StackB (us-west-2): no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  /**
   * Issue #1515: `AWS::S3::BucketPolicy` reported permanent phantom drift on
   * `PolicyDocument.Statement[].Principal.AWS` because AWS renders an IAM role
   * principal as either its ARN or its `AROA…` unique id and re-canonicalizes on
   * write — so `--revert` reported success and the next `cdkd drift` reported the
   * identical difference. Two back-to-back runs of the `drift-revert` fixture on
   * 2026-08-10 differed for exactly this reason with no code change in between.
   */
  describe('cdkd drift: IAM principal ARN vs unique id (issue #1515)', () => {
    const ROLE_ARN =
      'arn:aws:iam::123456789012:role/CdkdDriftRevertExample-CustomS3AutoDeleteObjectsCustomR-30ff9234';
    const ROLE_UNIQUE_ID = 'AROAXXXJN2LNV2SMSFATO';

    const policyProps = (principal: string): Record<string, unknown> => ({
      Bucket: 'my-bucket',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: principal },
            Action: 's3:GetBucket*',
            Resource: 'arn:aws:s3:::my-bucket',
          },
        ],
      },
    });

    const arrangeBucketPolicy = (baselinePrincipal: string, awsPrincipal: string): void => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          DriftBucketPolicy: makeResource({
            physicalId: 'my-bucket',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(baselinePrincipal),
            observedProperties: policyProps(baselinePrincipal),
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => policyProps(awsPrincipal),
      });
    };

    it('reports no drift when the two sides hold two spellings of ONE principal', async () => {
      arrangeBucketPolicy(ROLE_UNIQUE_ID, ROLE_ARN);
      mockIamSend.mockResolvedValue({ Role: { Arn: ROLE_ARN, RoleId: ROLE_UNIQUE_ID } });

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(output).toContain('no drift detected');
      expect(mockIamSend).toHaveBeenCalledTimes(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('still reports drift when the unique id belongs to a DIFFERENT principal', async () => {
      arrangeBucketPolicy(ROLE_UNIQUE_ID, ROLE_ARN);
      mockIamSend.mockResolvedValue({ Role: { Arn: ROLE_ARN, RoleId: 'AROASOMEOTHERROLE99' } });

      const { output } = await runDrift(['TestStack']);

      expect(output).toContain('drift detected');
      expect(output).toContain('PolicyDocument');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('still reports drift when the lookup fails (deleted role / missing iam:GetRole)', async () => {
      arrangeBucketPolicy(ROLE_UNIQUE_ID, ROLE_ARN);
      mockIamSend.mockRejectedValue(new Error('NoSuchEntity'));

      const { output } = await runDrift(['TestStack']);

      expect(output).toContain('drift detected');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('makes no IAM call for a policy with no unique-id principal', async () => {
      arrangeBucketPolicy(ROLE_ARN, ROLE_ARN);

      const { output } = await runDrift(['TestStack']);

      expect(output).toContain('no drift detected');
      expect(mockIamSend).not.toHaveBeenCalled();
    });

    it('still reports drift when the lookup answers about a DIFFERENT entity', async () => {
      // `GetRole` is account-local and takes a NAME, so a cross-account ARN or
      // one under another IAM path resolves to THIS account's same-named role.
      // Without the response-ARN round-trip the pass would "prove" two
      // different principals equal and collapse a real change — the one way it
      // could hide drift.
      arrangeBucketPolicy(ROLE_UNIQUE_ID, ROLE_ARN);
      mockIamSend.mockResolvedValue({
        Role: {
          Arn: 'arn:aws:iam::999999999999:role/CdkdDriftRevertExample-CustomS3AutoDeleteObjectsCustomR-30ff9234',
          RoleId: ROLE_UNIQUE_ID,
        },
      });

      const { output } = await runDrift(['TestStack']);

      expect(output).toContain('drift detected');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('canonicalizes a USER principal through GetUser', async () => {
      const userArn = 'arn:aws:iam::123456789012:user/deployer';
      const userUniqueId = 'AIDAXXXJN2LNV2SMSFATO';
      arrangeBucketPolicy(userUniqueId, userArn);
      mockIamSend.mockResolvedValue({ User: { Arn: userArn, UserId: userUniqueId } });

      const { output, error } = await runDrift(['TestStack']);

      expect(error).toBeUndefined();
      expect(output).toContain('no drift detected');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('warns ONCE when the IAM lookup is denied, and stays quiet for a deleted role', async () => {
      // A missing `iam:GetRole` otherwise surfaces as unexplained permanent
      // drift, visible only under --verbose. The classification is on the
      // error NAME, never the message: IAM's NoSuchEntity text embeds the ROLE
      // NAME, so `The role with name AccessDeniedHandler cannot be found`
      // would otherwise be reported as a permission problem.
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          PolicyA: makeResource({
            physicalId: 'bucket-a',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(ROLE_UNIQUE_ID),
            observedProperties: policyProps(ROLE_UNIQUE_ID),
          }),
          PolicyB: makeResource({
            physicalId: 'bucket-b',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(ROLE_UNIQUE_ID.replace('FATO', 'FATX')),
            observedProperties: policyProps(ROLE_UNIQUE_ID.replace('FATO', 'FATX')),
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => policyProps(ROLE_ARN),
      });
      const denied = Object.assign(new Error('User is not authorized to perform: iam:GetRole'), {
        name: 'AccessDeniedException',
      });
      mockIamSend.mockRejectedValue(denied);

      await runDrift(['TestStack']);

      const denialWarnings = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('Cannot read IAM principals'));
      expect(denialWarnings).toHaveLength(1);
      // The raw AWS message names the CALLER's principal + account, so it must
      // not ride the warn line.
      expect(denialWarnings[0]).not.toContain('User is not authorized to perform');
    });

    it('does not warn about permissions when the role is simply GONE', async () => {
      arrangeBucketPolicy(ROLE_UNIQUE_ID, ROLE_ARN);
      mockIamSend.mockRejectedValue(
        Object.assign(
          new Error('The role with name AccessDeniedHandlerRole cannot be found.'),
          { name: 'NoSuchEntityException' }
        )
      );

      const { output } = await runDrift(['TestStack']);

      expect(output).toContain('drift detected');
      expect(
        warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('Cannot read IAM'))
      ).toBe(false);
    });

    it('caches a conclusive failure but NOT a throttle', async () => {
      // Caching a throttle would poison the rest of the run: every later
      // resource sharing the principal inherits the phantom drift, and
      // `--revert` then pushes the AROA form at S3, which rejects it.
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          PolicyA: makeResource({
            physicalId: 'bucket-a',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(ROLE_UNIQUE_ID),
            observedProperties: policyProps(ROLE_UNIQUE_ID),
          }),
          PolicyB: makeResource({
            physicalId: 'bucket-b',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(ROLE_UNIQUE_ID),
            observedProperties: policyProps(ROLE_UNIQUE_ID),
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => policyProps(ROLE_ARN),
      });
      mockIamSend.mockRejectedValue(
        Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
      );

      await runDrift(['TestStack']);

      // Both resources tried — the first failure was NOT cached.
      expect(mockIamSend).toHaveBeenCalledTimes(2);
    });

    it('caches a DEFINITIVE failure so a deleted role costs one call, not one per resource', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          PolicyA: makeResource({
            physicalId: 'bucket-a',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(ROLE_UNIQUE_ID),
            observedProperties: policyProps(ROLE_UNIQUE_ID),
          }),
          PolicyB: makeResource({
            physicalId: 'bucket-b',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(ROLE_UNIQUE_ID),
            observedProperties: policyProps(ROLE_UNIQUE_ID),
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => policyProps(ROLE_ARN),
      });
      mockIamSend.mockRejectedValue(
        Object.assign(new Error('Role not found'), { name: 'NoSuchEntityException' })
      );

      await runDrift(['TestStack']);

      expect(mockIamSend).toHaveBeenCalledTimes(1);
    });

    it('resolves one ARN ONCE across resources that share it', async () => {
      // The per-command cache is the reason the lookup is affordable at all;
      // a single-resource fixture would pass with no cache whatsoever.
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          PolicyA: makeResource({
            physicalId: 'bucket-a',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(ROLE_UNIQUE_ID),
            observedProperties: policyProps(ROLE_UNIQUE_ID),
          }),
          PolicyB: makeResource({
            physicalId: 'bucket-b',
            resourceType: 'AWS::S3::BucketPolicy',
            properties: policyProps(ROLE_UNIQUE_ID),
            observedProperties: policyProps(ROLE_UNIQUE_ID),
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => policyProps(ROLE_ARN),
      });
      mockIamSend.mockResolvedValue({ Role: { Arn: ROLE_ARN, RoleId: ROLE_UNIQUE_ID } });

      const { output } = await runDrift(['TestStack']);

      expect(output).toContain('no drift detected');
      expect(mockIamSend).toHaveBeenCalledTimes(1);
    });
  });
});

describe('buildRevertNewProperties (pure helper)', () => {
  it('top-level scalar drift: AWS-current base + desired overlay on drifted key', async () => {
    const { buildRevertNewProperties } = await import(
      '../../../src/cli/commands/drift.js'
    );
    const desired = {
      VisibilityTimeout: 30,
      DelaySeconds: 0,
      RedrivePolicy: {}, // always-emit placeholder
    };
    const aws = {
      VisibilityTimeout: 130,
      DelaySeconds: 0,
      RedrivePolicy: {},
    };
    const drifts = [
      { path: 'VisibilityTimeout', stateValue: 30, awsValue: 130 },
    ];
    // Non-drifted keys carry their AWS-current values (so a diff-based
    // update sees newVal === oldVal and is a no-op for them).
    expect(buildRevertNewProperties(drifts, desired, aws)).toEqual({
      VisibilityTimeout: 30,
      DelaySeconds: 0,
      RedrivePolicy: {},
    });
  });

  it('nested drift path: replaces the full top-level subtree from desired', async () => {
    const { buildRevertNewProperties } = await import(
      '../../../src/cli/commands/drift.js'
    );
    // S3 PutBucketVersioning takes the full VersioningConfiguration
    // sub-shape. The top-level key gets replaced by desired's whole
    // subtree.
    const desired = {
      BucketName: 'b',
      VersioningConfiguration: { Status: 'Enabled', MfaDelete: 'Disabled' },
      Tags: [{ Key: 'k', Value: 'v' }],
    };
    const aws = {
      BucketName: 'b',
      VersioningConfiguration: { Status: 'Suspended', MfaDelete: 'Disabled' },
      Tags: [{ Key: 'k', Value: 'v' }],
    };
    const drifts = [
      {
        path: 'VersioningConfiguration.Status',
        stateValue: 'Enabled',
        awsValue: 'Suspended',
      },
    ];
    expect(buildRevertNewProperties(drifts, desired, aws)).toEqual({
      BucketName: 'b',
      VersioningConfiguration: { Status: 'Enabled', MfaDelete: 'Disabled' },
      Tags: [{ Key: 'k', Value: 'v' }],
    });
  });

  it('multiple drifts on the same top-level key: subtree replaced once', async () => {
    const { buildRevertNewProperties } = await import(
      '../../../src/cli/commands/drift.js'
    );
    const desired = {
      VersioningConfiguration: { Status: 'Enabled', MfaDelete: 'Enabled' },
    };
    const aws = {
      VersioningConfiguration: { Status: 'Suspended', MfaDelete: 'Disabled' },
    };
    const drifts = [
      {
        path: 'VersioningConfiguration.Status',
        stateValue: 'Enabled',
        awsValue: 'Suspended',
      },
      {
        path: 'VersioningConfiguration.MfaDelete',
        stateValue: 'Enabled',
        awsValue: 'Disabled',
      },
    ];
    expect(buildRevertNewProperties(drifts, desired, aws)).toEqual({
      VersioningConfiguration: { Status: 'Enabled', MfaDelete: 'Enabled' },
    });
  });

  it('multiple drifts on different top-level keys: each subtree replaced', async () => {
    const { buildRevertNewProperties } = await import(
      '../../../src/cli/commands/drift.js'
    );
    const desired = {
      Description: 'wanted',
      MaxSessionDuration: 3600,
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/Foo'],
      Path: '/',
    };
    const aws = {
      Description: 'hacked',
      MaxSessionDuration: 7200,
      ManagedPolicyArns: [],
      Path: '/',
    };
    const drifts = [
      { path: 'Description', stateValue: 'wanted', awsValue: 'hacked' },
      { path: 'MaxSessionDuration', stateValue: 3600, awsValue: 7200 },
      { path: 'ManagedPolicyArns', stateValue: ['arn:aws:iam::aws:policy/Foo'], awsValue: [] },
    ];
    expect(buildRevertNewProperties(drifts, desired, aws)).toEqual({
      Description: 'wanted',
      MaxSessionDuration: 3600,
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/Foo'],
      Path: '/',
    });
  });

  it('drifted key absent from desired: AWS-current value retained (defensive)', async () => {
    const { buildRevertNewProperties } = await import(
      '../../../src/cli/commands/drift.js'
    );
    const desired = { OnlyKey: 1 };
    const aws = { OnlyKey: 1, GoneKey: 'aws-side' };
    const drifts = [{ path: 'GoneKey', stateValue: 'x', awsValue: 'aws-side' }];
    // Defensive — drift was computed against desired, so this case
    // shouldn't happen. Fall through to AWS-current value (which is
    // already in `result` from the spread).
    expect(buildRevertNewProperties(drifts, desired, aws)).toEqual({
      OnlyKey: 1,
      GoneKey: 'aws-side',
    });
  });

  it('empty drift list: returns the AWS-current snapshot unchanged', async () => {
    const { buildRevertNewProperties } = await import(
      '../../../src/cli/commands/drift.js'
    );
    const aws = { Anything: 1 };
    expect(buildRevertNewProperties([], { Anything: 1 }, aws)).toEqual({
      Anything: 1,
    });
  });
});

describe('cdkd drift --revert (placeholder isolation regression)', () => {
  it('passes AWS-current values for non-drifted keys (does not silently clear them on diff-based providers)', async () => {
    // Regression covering the audit finding: SNS / IAM Role / ELBv2
    // diff `JSON.stringify(newVal) !== JSON.stringify(oldVal)` and
    // treat `newVal === undefined` as "clear K on AWS". A
    // drifted-only partial would silently wipe non-drifted attrs.
    // The "AWS-current base + desired overlay" strategy keeps
    // newVal === oldVal for non-drifted keys.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        T1: makeResource({
          physicalId: 'arn:aws:sns:us-east-1:0:t',
          resourceType: 'AWS::SNS::Topic',
          properties: { DisplayName: 'wanted' },
          observedProperties: {
            DisplayName: 'wanted',
            KmsMasterKeyId: 'alias/aws/sns',
            ContentBasedDeduplication: false,
          },
        }),
      })
    );
    const updateMock = vi.fn<
      (
        logicalId: string,
        physicalId: string,
        resourceType: string,
        newProperties: Record<string, unknown>,
        previousProperties: Record<string, unknown>
      ) => Promise<{ physicalId: string; wasReplaced: boolean }>
    >(async () => ({
      physicalId: 'arn:aws:sns:us-east-1:0:t',
      wasReplaced: false,
    }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        DisplayName: 'hacked',
        KmsMasterKeyId: 'alias/aws/sns',
        ContentBasedDeduplication: false,
      }),
      update: updateMock,
    });

    const { error } = await runDrift(['TestStack', '--revert', '--yes']);

    expect(error).toBeUndefined();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const newProps = updateMock.mock.calls[0]![3];
    // Drifted: DisplayName overlaid from desired.
    expect(newProps).toMatchObject({ DisplayName: 'wanted' });
    // Non-drifted: AWS-current values preserved (so a diff-based
    // update sees newVal === oldVal and emits no SetTopicAttributes
    // call for them).
    expect(newProps).toMatchObject({
      KmsMasterKeyId: 'alias/aws/sns',
      ContentBasedDeduplication: false,
    });
  });
});

describe('findRevertDroppedAwsKeys (pure helper, issue #1478)', () => {
  const load = async () =>
    (await import('../../../src/cli/commands/drift.js')).findRevertDroppedAwsKeys;

  it('reports an AWS-authored sub-key the raw template does not declare', async () => {
    const findRevertDroppedAwsKeys = await load();
    // The motivating case: a Glue Iceberg table. AWS writes `table_type` /
    // `metadata_location` into Parameters; the template declares neither, so
    // reverting the drifted `Parameters` subtree wholesale wipes them.
    const desired = { Parameters: { classification: 'parquet' } };
    const aws = {
      Parameters: {
        classification: 'json',
        table_type: 'ICEBERG',
        metadata_location: 's3://bucket/metadata/00000.json',
      },
    };
    const drifts = [
      { path: 'Parameters.classification', stateValue: 'parquet', awsValue: 'json' },
    ];
    expect(findRevertDroppedAwsKeys(drifts, desired, aws)).toEqual([
      'Parameters.metadata_location',
      'Parameters.table_type',
    ]);
  });

  it('does NOT report a key present on both sides with a different value', async () => {
    const findRevertDroppedAwsKeys = await load();
    // That is the drift the user explicitly asked to revert, not a silent
    // loss — warning about it would make the warning meaningless.
    const desired = { Parameters: { classification: 'parquet' } };
    const aws = { Parameters: { classification: 'json' } };
    const drifts = [
      { path: 'Parameters.classification', stateValue: 'parquet', awsValue: 'json' },
    ];
    expect(findRevertDroppedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('ignores AWS-authored keys under a NON-drifted top-level key', async () => {
    const findRevertDroppedAwsKeys = await load();
    // `buildRevertNewProperties` only overwrites drifted top-level keys, so
    // nothing under an undrifted one is at risk. Reporting it would be a
    // false alarm on essentially every revert.
    const desired = { Parameters: { classification: 'parquet' }, Description: 'd' };
    const aws = {
      Parameters: { classification: 'json' },
      Description: 'd',
      StorageDescriptor: { SerdeInfo: { aws_authored: 'x' } },
    };
    const drifts = [
      { path: 'Parameters.classification', stateValue: 'parquet', awsValue: 'json' },
    ];
    expect(findRevertDroppedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('ignores a drifted top-level key the desired side does not declare at all', async () => {
    const findRevertDroppedAwsKeys = await load();
    // `buildRevertNewProperties` leaves the AWS-current value in place when
    // the key is absent from desired, so nothing is dropped.
    const desired = { Description: 'd' };
    const aws = { Description: 'd', Parameters: { table_type: 'ICEBERG' } };
    const drifts = [{ path: 'Parameters', stateValue: undefined, awsValue: {} }];
    expect(findRevertDroppedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('recurses through nested objects', async () => {
    const findRevertDroppedAwsKeys = await load();
    const desired = { StorageDescriptor: { SerdeInfo: { Name: 'n' } } };
    const aws = {
      StorageDescriptor: {
        SerdeInfo: { Name: 'n2', SerializationLibrary: 'org.apache.iceberg' },
        Compressed: false,
      },
    };
    const drifts = [
      { path: 'StorageDescriptor.SerdeInfo.Name', stateValue: 'n', awsValue: 'n2' },
    ];
    expect(findRevertDroppedAwsKeys(drifts, desired, aws)).toEqual([
      'StorageDescriptor.Compressed',
      'StorageDescriptor.SerdeInfo.SerializationLibrary',
    ]);
  });

  it('reports the containing path when desired has no object where AWS does', async () => {
    const findRevertDroppedAwsKeys = await load();
    const desired = { Parameters: { nested: undefined } } as Record<string, unknown>;
    const aws = { Parameters: { nested: { table_type: 'ICEBERG' } } };
    const drifts = [{ path: 'Parameters.nested', stateValue: undefined, awsValue: {} }];
    expect(findRevertDroppedAwsKeys(drifts, desired, aws)).toEqual(['Parameters.nested']);
  });

  it('compares arrays wholesale, never element-wise', async () => {
    const findRevertDroppedAwsKeys = await load();
    // The drift comparator's paths never carry an array index, so an
    // element-wise walk here would report positions the rest of the revert
    // path cannot reason about.
    const desired = { Tags: [{ Key: 'a', Value: '1' }] };
    const aws = { Tags: [{ Key: 'a', Value: '1' }, { Key: 'aws:authored', Value: 'x' }] };
    const drifts = [{ path: 'Tags', stateValue: [], awsValue: [] }];
    expect(findRevertDroppedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('returns nothing when AWS authored nothing extra', async () => {
    const findRevertDroppedAwsKeys = await load();
    const desired = { Parameters: { a: '1', b: '2' } };
    const aws = { Parameters: { a: '9', b: '2' } };
    const drifts = [{ path: 'Parameters.a', stateValue: '1', awsValue: '9' }];
    expect(findRevertDroppedAwsKeys(drifts, desired, aws)).toEqual([]);
  });
});

describe('tag-list revert preserves SERVICE-authored tags (pure helpers, issue #1501)', () => {
  const loadDrift = async () => await import('../../../src/cli/commands/drift.js');

  // The live case: ECS attaches `AmazonECSManaged` to an ASG when a capacity
  // provider binds it, and managed scaling breaks without it. `Tags` is
  // template-DECLARED (every CDK ASG carries at least `Name`), so the #1498
  // undeclared-and-captured-empty carve-out does not apply, and the tag list is
  // an array, which the #1478 walk compares wholesale.
  const baseline = [{ Key: 'Name', Value: 'my-asg' }];
  const awsCurrent = [
    { Key: 'Name', Value: 'renamed-in-console' },
    { Key: 'AmazonECSManaged', Value: 'true' },
  ];
  const drifts = [{ path: 'Tags', stateValue: baseline, awsValue: awsCurrent }];

  it('keeps the service-authored tag while reverting the changed one', async () => {
    const { buildRevertNewProperties } = await loadDrift();

    const result = buildRevertNewProperties(drifts, { Tags: baseline }, { Tags: awsCurrent });

    expect(result['Tags']).toEqual([
      { Key: 'Name', Value: 'my-asg' },
      { Key: 'AmazonECSManaged', Value: 'true' },
    ]);
  });

  // THE BOUND, and the reason this is the issue's option 2 rather than option 1.
  // A blanket "preserve every AWS-only tag" was implemented first and FAILED the
  // `drift-revert` integ, whose fixture injects an `IntegInjected` tag and
  // requires --revert to strip it. Removing a user/console-added tag is an
  // established contract with a test behind it; only the service-managed
  // carve-out is new.
  it('still STRIPS an ordinary console-added tag, as revert always has', async () => {
    const { buildRevertNewProperties } = await loadDrift();

    const injected = [
      { Key: 'Name', Value: 'my-asg' },
      { Key: 'IntegInjected', Value: 'yes' },
    ];
    const result = buildRevertNewProperties(
      [{ path: 'Tags', stateValue: baseline, awsValue: injected }],
      { Tags: baseline },
      { Tags: injected }
    );

    expect(result['Tags']).toEqual([{ Key: 'Name', Value: 'my-asg' }]);
  });

  it('preserves an `aws:`-prefixed reserved key, which cdkd can never have authored', async () => {
    const { mergeTagListForRevert } = await loadDrift();

    expect(
      mergeTagListForRevert(baseline, [
        { Key: 'Name', Value: 'my-asg' },
        { Key: 'aws:cloudformation:stack-name', Value: 'legacy' },
        { Key: 'HandAdded', Value: '1' },
      ])
    ).toEqual([
      { Key: 'Name', Value: 'my-asg' },
      { Key: 'aws:cloudformation:stack-name', Value: 'legacy' },
    ]);
  });

  it('re-adds a baseline tag AWS lost', async () => {
    const { mergeTagListForRevert } = await loadDrift();

    expect(
      mergeTagListForRevert(
        [
          { Key: 'Name', Value: 'my-asg' },
          { Key: 'Env', Value: 'prod' },
        ],
        [{ Key: 'Name', Value: 'my-asg' }]
      )
    ).toEqual([
      { Key: 'Name', Value: 'my-asg' },
      { Key: 'Env', Value: 'prod' },
    ]);
  });

  it('the baseline VALUE wins for a tag both sides carry', async () => {
    const { mergeTagListForRevert } = await loadDrift();

    expect(
      mergeTagListForRevert([{ Key: 'Env', Value: 'prod' }], [{ Key: 'Env', Value: 'dev' }])
    ).toEqual([{ Key: 'Env', Value: 'prod' }]);
  });

  it('a baseline entry for a service tag still wins, so a real revert of it works', async () => {
    const { mergeTagListForRevert } = await loadDrift();

    expect(
      mergeTagListForRevert(
        [{ Key: 'AmazonECSManaged', Value: 'true' }],
        [{ Key: 'AmazonECSManaged', Value: 'tampered' }]
      )
    ).toEqual([{ Key: 'AmazonECSManaged', Value: 'true' }]);
  });

  it('a non-tag list still reverts WHOLESALE, so the merge cannot leak into other keys', async () => {
    const { buildRevertNewProperties } = await loadDrift();

    const desired = { SecurityGroups: ['sg-1'] };
    const aws = { SecurityGroups: ['sg-1', 'sg-added-in-console'] };
    const result = buildRevertNewProperties(
      [{ path: 'SecurityGroups', stateValue: desired.SecurityGroups, awsValue: aws.SecurityGroups }],
      desired,
      aws
    );

    expect(result['SecurityGroups']).toEqual(['sg-1']);
  });

  // Corrected after review: the first version of this test pinned "an EMPTY
  // baseline reverts wholesale" as intended, which strips `AmazonECSManaged` —
  // the exact failure this carve-out exists to prevent. There IS something to
  // diff against (the AWS side), and a template that DECLARES `Tags` with a
  // condition-collapsed empty list reaches exactly this path. The commoner
  // UNDECLARED + captured-empty shape never gets here: #1498 ignores the key.
  it('an EMPTY baseline tag list still preserves the service tag', async () => {
    const { buildRevertNewProperties } = await loadDrift();

    const result = buildRevertNewProperties(
      [{ path: 'Tags', stateValue: [], awsValue: awsCurrent }],
      { Tags: [] },
      { Tags: awsCurrent }
    );

    expect(result['Tags']).toEqual([{ Key: 'AmazonECSManaged', Value: 'true' }]);
  });

  it('an EMPTY baseline still strips an ordinary tag, so the carve-out stays narrow', async () => {
    const { buildRevertNewProperties } = await loadDrift();

    const result = buildRevertNewProperties(
      [{ path: 'Tags', stateValue: [], awsValue: [{ Key: 'HandAdded', Value: '1' }] }],
      { Tags: [] },
      { Tags: [{ Key: 'HandAdded', Value: '1' }] }
    );

    expect(result['Tags']).toEqual([]);
  });

  // The shape `[{ Key, Value }]` is NOT tag-exclusive at top level:
  // `LoadBalancerAttributes`, `TargetGroupAttributes` and SSM
  // `Association.Targets` all match it. Borrowing the sort heuristic for a
  // WRITE decision needs the name gate — a sort false positive is harmless,
  // an append is not.
  it('does not touch a non-Tags property that happens to have the same shape', async () => {
    const { buildRevertNewProperties } = await loadDrift();

    const desired = { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }] };
    const aws = {
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '4000' },
        { Key: 'aws:something', Value: 'x' },
      ],
    };
    const result = buildRevertNewProperties(
      [
        {
          path: 'LoadBalancerAttributes',
          stateValue: desired.LoadBalancerAttributes,
          awsValue: aws.LoadBalancerAttributes,
        },
      ],
      desired,
      aws
    );

    expect(result['LoadBalancerAttributes']).toEqual([
      { Key: 'idle_timeout.timeout_seconds', Value: '60' },
    ]);
  });

  it('preserves a duplicate AWS key only once, so merge and plan agree', async () => {
    const { mergeTagListForRevert, findRevertPreservedTagKeys } = await loadDrift();

    const dupes = [
      { Key: 'AmazonECSManaged', Value: 'true' },
      { Key: 'AmazonECSManaged', Value: 'true' },
    ];
    expect(mergeTagListForRevert(baseline, dupes)).toEqual([
      { Key: 'Name', Value: 'my-asg' },
      { Key: 'AmazonECSManaged', Value: 'true' },
    ]);
    expect(
      findRevertPreservedTagKeys(
        [{ path: 'Tags', stateValue: baseline, awsValue: dupes }],
        { Tags: baseline },
        { Tags: dupes }
      )
    ).toEqual(['Tags.AmazonECSManaged']);
  });

  it('names every preserved service tag so the plan can surface it before the prompt', async () => {
    const { findRevertPreservedTagKeys } = await loadDrift();

    expect(findRevertPreservedTagKeys(drifts, { Tags: baseline }, { Tags: awsCurrent })).toEqual([
      'Tags.AmazonECSManaged',
    ]);
  });

  it('does NOT name an ordinary AWS-only tag, which the revert removes anyway', async () => {
    const { findRevertPreservedTagKeys } = await loadDrift();

    const injected = [
      { Key: 'Name', Value: 'my-asg' },
      { Key: 'IntegInjected', Value: 'yes' },
    ];
    expect(
      findRevertPreservedTagKeys(
        [{ path: 'Tags', stateValue: baseline, awsValue: injected }],
        { Tags: baseline },
        { Tags: injected }
      )
    ).toEqual([]);
  });

  it('reports nothing for a non-drifted tag list, since revert never touches it', async () => {
    const { findRevertPreservedTagKeys } = await loadDrift();

    expect(
      findRevertPreservedTagKeys(
        [{ path: 'MinSize', stateValue: 1, awsValue: 2 }],
        { Tags: baseline, MinSize: 1 },
        { Tags: awsCurrent, MinSize: 2 }
      )
    ).toEqual([]);
  });
});
