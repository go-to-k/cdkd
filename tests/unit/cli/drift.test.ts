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

import {
  createDriftCommand,
  collectNarrowedTopLevelKeys,
} from '../../../src/cli/commands/drift.js';

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

  // Issue #1643. These two pin the WIRING of `canonicalizeIpProtocols` into
  // this command — the pure module's own suite cannot, and deleting the call
  // in drift.ts left every other test green. The baseline is deliberately the
  // `properties` fallback: a fresh deploy captures `observedProperties` from
  // the same AWS read, so both sides already hold AWS's spelling and the pass
  // is a no-op there. The population this fix is FOR is the one whose baseline
  // is the user's template (state written before observed-capture, or a
  // provider with no readCurrentState).
  it('does not report drift when the template holds a numeric IpProtocol and AWS reports its name (#1643)', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Sg1: makeResource({
          physicalId: 'sg-1',
          resourceType: 'AWS::EC2::SecurityGroup',
          // Template spelling, no observedProperties -> properties fallback.
          properties: {
            SecurityGroupIngress: [{ IpProtocol: '6', FromPort: 443, ToPort: 443 }],
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443 }],
      }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
  });

  it('still reports a REAL protocol change on the same path (#1643 does not blanket-absorb)', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Sg1: makeResource({
          physicalId: 'sg-1',
          resourceType: 'AWS::EC2::SecurityGroup',
          properties: {
            SecurityGroupIngress: [{ IpProtocol: '6', FromPort: 443, ToPort: 443 }],
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // udp is a genuinely different protocol, not another spelling of tcp.
      readCurrentState: async () => ({
        SecurityGroupIngress: [{ IpProtocol: 'udp', FromPort: 443, ToPort: 443 }],
      }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeDefined();
    expect(output).toContain('SecurityGroupIngress');
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
    // Mirrors the REAL provider's contract, including the "no usable bag ->
    // compare" default. That default is what makes the `no drift detected`
    // assertion below revert-sensitive too: drop the argument in drift.ts and
    // this fake returns [], so TlsConfig is compared and drift IS reported.
    const getDriftUnknownPaths = vi.fn((_type: string, properties?: Record<string, unknown>) =>
      properties !== undefined &&
      Object.keys(properties).length > 0 &&
      properties['ConnectionType'] !== 'VPC_LINK'
        ? ['TlsConfig']
        : []
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

  // Issue #1783. Same rules as the #1096 block above: these drive the REAL
  // command path, so they exercise the provider call site AND the matcher.
  // The DynamoDB Table shape the leaf-only form exists for — the index LIST is
  // an unordered set keyed by IndexName, each index's KeySchema is
  // order-SIGNIFICANT (HASH before RANGE).
  const indexes = (order: 'ab' | 'ba', keySchema: 'hash-first' | 'range-first' = 'hash-first') => {
    const keys =
      keySchema === 'hash-first'
        ? [
            { AttributeName: 'author', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ]
        : [
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
            { AttributeName: 'author', KeyType: 'HASH' },
          ];
    const byAuthor = { IndexName: 'byAuthor', KeySchema: keys };
    const byStatus = {
      IndexName: 'byStatus',
      KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }],
    };
    return order === 'ab' ? [byAuthor, byStatus] : [byStatus, byAuthor];
  };

  it('sorts a leaf-only declared array without descending into its elements (issue #1783)', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Table1: makeResource({
          physicalId: 'table-1',
          resourceType: 'AWS::DynamoDB::Table',
          properties: { GlobalSecondaryIndexes: indexes('ab') },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // AWS returns the same two indexes in the other order.
      readCurrentState: async () => ({ GlobalSecondaryIndexes: indexes('ba') }),
      getDriftUnorderedPaths: () => ['GlobalSecondaryIndexes[]'],
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
  });

  it('still DETECTS a per-index KeySchema reorder under a leaf-only declaration (issue #1783)', async () => {
    // The load-bearing half: `KeySchema` is order-significant (HASH before
    // RANGE), so the declaration must not reach inside the elements. Swap the
    // subtree form back in and this drift is silently sorted away.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Table1: makeResource({
          physicalId: 'table-1',
          resourceType: 'AWS::DynamoDB::Table',
          properties: { GlobalSecondaryIndexes: indexes('ab') },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ GlobalSecondaryIndexes: indexes('ab', 'range-first') }),
      getDriftUnorderedPaths: () => ['GlobalSecondaryIndexes[]'],
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('GlobalSecondaryIndexes');
  });

  it('the SUBTREE form HIDES that KeySchema reorder — the behavior #1783 could not accept', async () => {
    // Negative control for the test above, and the reason the leaf-only form
    // had to exist: identical fixture, declaration spelled without `[]`.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Table1: makeResource({
          physicalId: 'table-1',
          resourceType: 'AWS::DynamoDB::Table',
          properties: { GlobalSecondaryIndexes: indexes('ab') },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ GlobalSecondaryIndexes: indexes('ab', 'range-first') }),
      getDriftUnorderedPaths: () => ['GlobalSecondaryIndexes'],
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('no drift detected');
  });

  // Issue #1784: the provider-declared BOTH-SIDES canonicalizer, for a
  // difference no ignore-path can express — a member of an ARRAY ELEMENT.
  it('applies canonicalizeDriftProperties to BOTH sides so an old baseline converges (issue #1784)', async () => {
    // The real shape: a pre-fix `observedProperties` record froze an
    // AWS-managed per-index member (`ItemCount`) that the readback no longer
    // emits. It sits inside an array element, so `ignorePaths` could only
    // suppress the WHOLE index list — i.e. never detect an index change again.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Table1: makeResource({
          physicalId: 'table-1',
          resourceType: 'AWS::DynamoDB::Table',
          properties: { GlobalSecondaryIndexes: [{ IndexName: 'byAuthor' }] },
          observedProperties: {
            GlobalSecondaryIndexes: [{ IndexName: 'byAuthor', ItemCount: 42 }],
          },
        }),
      })
    );
    const canonicalizeDriftProperties = vi.fn(
      (_type: string, properties: Record<string, unknown>) => {
        const list = properties['GlobalSecondaryIndexes'];
        if (!Array.isArray(list)) return properties;
        return {
          ...properties,
          GlobalSecondaryIndexes: list.map((index) => {
            const { ItemCount: _dropped, ...rest } = index as Record<string, unknown>;
            return rest;
          }),
        };
      }
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ GlobalSecondaryIndexes: [{ IndexName: 'byAuthor' }] }),
      canonicalizeDriftProperties,
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
    // BOTH sides, not just the readback — one-sided normalization is the
    // mistake drift-normalize.ts's header records.
    expect(canonicalizeDriftProperties).toHaveBeenCalledTimes(2);
    const bags = canonicalizeDriftProperties.mock.calls.map((call) => call[1]);
    expect(bags.some((bag) => JSON.stringify(bag).includes('ItemCount'))).toBe(true);
    expect(bags.some((bag) => !JSON.stringify(bag).includes('ItemCount'))).toBe(true);
  });

  it('reports that stranded array member as drift when the provider declares no canonicalizer', async () => {
    // Negative control: identical fixture minus the hook. Proves the clean
    // result above comes from the hook being threaded through both sides.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Table1: makeResource({
          physicalId: 'table-1',
          resourceType: 'AWS::DynamoDB::Table',
          properties: { GlobalSecondaryIndexes: [{ IndexName: 'byAuthor' }] },
          observedProperties: {
            GlobalSecondaryIndexes: [{ IndexName: 'byAuthor', ItemCount: 42 }],
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ GlobalSecondaryIndexes: [{ IndexName: 'byAuthor' }] }),
      // No canonicalizeDriftProperties.
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('GlobalSecondaryIndexes');
  });

  it('keeps a REAL index change visible through canonicalizeDriftProperties (issue #1784)', async () => {
    // The trade the hook exists to avoid: suppressing the whole array. Same
    // canonicalizer, but AWS also dropped an index — that must still report.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Table1: makeResource({
          physicalId: 'table-1',
          resourceType: 'AWS::DynamoDB::Table',
          properties: {
            GlobalSecondaryIndexes: [{ IndexName: 'byAuthor' }, { IndexName: 'byStatus' }],
          },
          observedProperties: {
            GlobalSecondaryIndexes: [
              { IndexName: 'byAuthor', ItemCount: 42 },
              { IndexName: 'byStatus', ItemCount: 7 },
            ],
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // Out-of-band: byStatus was deleted in the console.
      readCurrentState: async () => ({ GlobalSecondaryIndexes: [{ IndexName: 'byAuthor' }] }),
      canonicalizeDriftProperties: (_type: string, properties: Record<string, unknown>) => {
        const list = properties['GlobalSecondaryIndexes'];
        if (!Array.isArray(list)) return properties;
        return {
          ...properties,
          GlobalSecondaryIndexes: list.map((index) => {
            const { ItemCount: _dropped, ...rest } = index as Record<string, unknown>;
            return rest;
          }),
        };
      },
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('GlobalSecondaryIndexes');
  });

  it('--accept PERSISTS the canonicalized value, not the raw AWS one (issue #1784)', async () => {
    // Pins the asymmetry the seam's docs now state explicitly: `--revert`
    // diffs against the RAW `awsProperties`, but `--accept` writes each
    // change's `awsValue`, which comes from the CANONICALIZED bags. So on a
    // path that still drifts after canonicalization, the stripped shape is
    // what lands in observedProperties. The first cut of this PR documented
    // the opposite; a reviewer caught it, and this test is what stops the
    // claim from silently drifting back.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Table1: makeResource({
          physicalId: 'table-1',
          resourceType: 'AWS::DynamoDB::Table',
          properties: { GlobalSecondaryIndexes: [{ IndexName: 'byAuthor' }] },
          observedProperties: {
            GlobalSecondaryIndexes: [{ IndexName: 'byAuthor', ItemCount: 42 }],
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // A REAL change (the index was renamed out of band) alongside the
      // AWS-managed member the canonicalizer strips — so the path still
      // drifts and --accept has something to write.
      readCurrentState: async () => ({
        GlobalSecondaryIndexes: [{ IndexName: 'byEditor', ItemCount: 99 }],
      }),
      canonicalizeDriftProperties: (_type: string, properties: Record<string, unknown>) => {
        const list = properties['GlobalSecondaryIndexes'];
        if (!Array.isArray(list)) return properties;
        return {
          ...properties,
          GlobalSecondaryIndexes: list.map((index) => {
            const { ItemCount: _dropped, ...rest } = index as Record<string, unknown>;
            return rest;
          }),
        };
      },
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , savedState] = mockSaveState.mock.calls[0]!;
    const persisted = (
      savedState as {
        resources: Record<string, { observedProperties?: Record<string, unknown> }>;
      }
    ).resources['Table1']?.observedProperties?.['GlobalSecondaryIndexes'];
    // The real change landed ...
    expect(persisted).toEqual([{ IndexName: 'byEditor' }]);
    // ... and the stripped member did NOT come back with it.
    expect(JSON.stringify(persisted)).not.toContain('ItemCount');
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

  /**
   * The COUNT the report prints, which the `Custom::*` case above never
   * asserts: it checks only that the skipped resource is not NAMED, and
   * `no drift detected` stays true whether the counter says 2 or 3.
   *
   * The property is issue #323's other half -- a `Custom::*` resource is not
   * "checked", because no read happens for it at all, so counting it would
   * make the headline number claim coverage cdkd never had. Three resources on
   * record, two of them read: the number a user reads off this line must be
   * `2`, and it is the only place in the report where the difference is
   * visible.
   *
   * Asserted as the exact rendered fragment rather than as a `not.toContain`,
   * so it fails for the right reason: a report that stopped printing the count
   * entirely would satisfy "does not say 3" while saying nothing at all.
   */
  it('counts only resources it actually read: a skipped `Custom::*` is not "checked" (issue #323)', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        // Read, and matching -> `clean`, so both are `checked`.
        Bucket1: makeResource({
          physicalId: 'b1',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b1' },
        }),
        Bucket2: makeResource({
          physicalId: 'b2',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b2' },
        }),
        // Never read at all -> `skipped`, and the whole point of this case.
        AutoDelete: makeResource({
          physicalId: 'cr',
          resourceType: 'Custom::S3AutoDeleteObjects',
          properties: { ServiceToken: 'arn:aws:lambda:...:fn' },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async (physicalId: string) => ({ BucketName: physicalId }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    // THE ASSERTION: `2`, from a stack of three resources. The exact rendered
    // fragment rather than the absence of `3`, which a report that stopped
    // printing the count at all would also satisfy.
    expect(output).toContain('no drift detected (2 resources checked, 0 unsupported)');
    expect(output).not.toContain('3 resources checked');
    // Secondary only -- a resource silently DROPPED before the report would
    // satisfy this too, so on its own it cannot state the premise. It adds
    // just that the skipped resource is not rendered in the report body.
    expect(output).not.toContain('AutoDelete');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('states the premise positively: the uncounted resource is on record as skipped', async () => {
    // The positive half of the test above. `2 resources checked` is consistent
    // both with "the third was skipped" (correct) and with "the third never
    // reached the report at all" (a real defect that would look identical), so
    // the exclusion is only meaningful alongside evidence the resource WAS
    // seen and deliberately classified.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({ physicalId: 'b1', resourceType: 'AWS::S3::Bucket' }),
        AutoDelete: makeResource({
          physicalId: 'cr',
          resourceType: 'Custom::S3AutoDeleteObjects',
          properties: { ServiceToken: 'arn:aws:lambda:...:fn' },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async (physicalId: string) => ({ BucketName: physicalId }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as Array<{
      clean: Array<{ logicalId: string }>;
      skipped: Array<{ logicalId: string; type: string }>;
    }>;
    // Named in `skipped[]`, with its type -- so it was on record and reached
    // the classifier, rather than being dropped somewhere upstream.
    expect(payload[0]?.skipped).toEqual([
      { logicalId: 'AutoDelete', type: 'Custom::S3AutoDeleteObjects' },
    ]);
    // ...and it is NOT also in `clean`, which is what would let it be counted.
    expect(payload[0]?.clean?.map((c) => c.logicalId)).toEqual(['Bucket1']);
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
    // The EXACT rendered fragment, not just the `1 unsupported` half. Issue
    // #2135 moved `inspected` from `outcomes.length - skippedCount` to a
    // count accumulated inside the exhaustive pass, which turned the
    // `unsupported` contribution into its own branch; asserting only
    // `'1 unsupported'` left that branch unfenced (deleting its increment
    // kept every test in this directory green). Note the count says `1
    // resource checked` for a resource cdkd never READ -- that is main's
    // pre-existing arithmetic, preserved deliberately here rather than
    // changed under cover of a refactor, and tracked separately.
    expect(output).toContain('no drift detected (1 resource checked, 1 unsupported)');
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
      drifted: Array<{
        logicalId: string;
        type: string;
        changes: unknown[];
        referencesUnresolved: boolean;
      }>;
      clean: Array<{ logicalId: string; referencesUnresolved: boolean }>;
      notSupported: Array<{ logicalId: string }>;
      notCompared: Array<{ logicalId: string; type: string }>;
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
        // Issue #2108: every drifted / clean entry says whether the comparison
        // was COMPLETE. This resource has no dynamic reference at all, so it
        // was, and the roll-up below is empty.
        referencesUnresolved: false,
      },
    ]);
    expect(payload[0]?.notSupported.map((n) => n.logicalId)).toEqual(['Other']);
    expect(payload[0]?.notCompared).toEqual([]);
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

      // State is NOT updated by --revert when the provider delivered exactly
      // what it was handed (issue #1644 added the one exception: a provider
      // that answers with `effectiveProperties`).
      expect(mockSaveState).not.toHaveBeenCalled();

      expect(mockAcquireLock).toHaveBeenCalledWith(
        'TestStack',
        'us-east-1',
        expect.any(String),
        'drift-revert'
      );
      expect(mockReleaseLock).toHaveBeenCalledWith('TestStack', 'us-east-1');
    });

    // Issue #1819: the revert landed, but the provider left something behind
    // (a replacement whose old resource survives). The revert still SUCCEEDS --
    // the resource is at the desired state -- so this annotates the line rather
    // than failing it. Without a test the whole arm was deletable.
    it('--revert annotates the succeeded line when the provider reports a partial', async () => {
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Cert1: makeResource({
            physicalId: 'arn:aws:acm:us-east-1:0:certificate/new',
            resourceType: 'AWS::CertificateManager::Certificate',
            properties: { ValidationMethod: 'DNS' },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ ValidationMethod: 'EMAIL' }),
        update: vi.fn(async () => ({
          physicalId: 'arn:aws:acm:us-east-1:0:certificate/new',
          wasReplaced: true,
          outcome: 'partial' as const,
          reason: 'old certificate arn:aws:acm:us-east-1:0:certificate/old is still in use',
        })),
      });

      const { error } = await runDrift(['TestStack', '--revert', '--yes']);

      // A partial is NOT a failure: the revert happened, so this must not
      // become the exit-2 path the failing-update test below covers.
      expect(error).toBeUndefined();
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('partial (');
      expect(warned).toContain('is still in use');
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

    it('--revert REPORTS the AWS-authored values it leaves untouched when state has no observedProperties (issue #1478 / #1626)', async () => {
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
      expect(output).toContain('LEAVES 2 AWS-authored values untouched');
      expect(output).toContain('Parameters.table_type');
      expect(output).toContain('Parameters.metadata_location');
      expect(output).toContain("cdkd state refresh-observed TestStack");
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

    /**
     * Issue #1644: `--revert` discarded `provider.update()`'s return value, so
     * a narrowing the provider announced never reached state — the next
     * `cdkd drift` reported the same difference and `--revert` re-issued the
     * same call forever.
     */
    describe('provider-reported narrowing (issue #1644)', () => {
      it('records effectiveProperties into the observedProperties baseline the comparator reads', async () => {
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Ingress1: makeResource({
              physicalId: 'sgr-1',
              resourceType: 'AWS::EC2::SecurityGroupIngress',
              properties: { IpProtocol: 6, FromPort: 443 },
              observedProperties: { IpProtocol: 6, FromPort: 443 },
            }),
          })
        );
        const updateMock = vi.fn(async () => ({
          physicalId: 'sgr-1',
          wasReplaced: false,
          // What the provider ACTUALLY sent: the narrowed protocol.
          effectiveProperties: { IpProtocol: 'tcp', FromPort: 443 },
        }));
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({ IpProtocol: 6, FromPort: 8080 }),
          update: updateMock,
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        expect(mockSaveState).toHaveBeenCalledTimes(1);
        const [stackName, region, savedState, saveOptions] = mockSaveState.mock.calls[0]!;
        expect(stackName).toBe('TestStack');
        expect(region).toBe('us-east-1');
        // Written to `observedProperties` (the comparator's baseline), and
        // ONLY the key the provider narrowed.
        expect(savedState.resources['Ingress1']!.observedProperties).toEqual({
          IpProtocol: 'tcp',
          FromPort: 443,
        });
        // The template intent is untouched — a narrowing is an AWS-side fact.
        expect(savedState.resources['Ingress1']!.properties).toEqual({
          IpProtocol: 6,
          FromPort: 443,
        });
        // Optimistic locking is honoured, same as --accept.
        expect(saveOptions?.expectedEtag).toBe('"etag-1"');
        // The write happens while the stack lock is still held.
        expect(mockReleaseLock).toHaveBeenCalledWith('TestStack', 'us-east-1');
      });

      it('leaves `properties` alone for a VALUE narrowing when there is no observedProperties', async () => {
        // The template-only baseline case: `buildRevertNewProperties` ran in
        // `preserveUntemplated` mode, so a recorded VALUE would import
        // AWS-authored paths into the user's template intent. The loop stays
        // open for this shape by design; the sibling DROP test proves the half
        // that IS safe to record here.
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Ingress1: makeResource({
              physicalId: 'sgr-1',
              resourceType: 'AWS::EC2::SecurityGroupIngress',
              properties: { IpProtocol: 6, FromPort: 443 },
            }),
          })
        );
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({ IpProtocol: 6, FromPort: 8080 }),
          update: async () => ({
            physicalId: 'sgr-1',
            wasReplaced: false,
            effectiveProperties: { IpProtocol: 'tcp', FromPort: 443 },
          }),
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        expect(mockSaveState).not.toHaveBeenCalled();
      });

      /**
       * The bag handed to `update()` is `buildRevertNewProperties`'s output —
       * AWS-current values for every NON-drifted key. Writing it back
       * wholesale would import those AWS-authored values into state and turn
       * `--revert` into `--accept`. Only the keys the PROVIDER changed may
       * land. `FromPort` is drifted (443 in state, 8080 at AWS) and `Tags` is
       * an AWS-only addition the baseline never declared: neither may move.
       */
      it('persists ONLY the keys the provider changed, not the AWS-current bag it was handed', async () => {
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Ingress1: makeResource({
              physicalId: 'sgr-1',
              resourceType: 'AWS::EC2::SecurityGroupIngress',
              properties: { IpProtocol: 6, FromPort: 443 },
              observedProperties: { IpProtocol: 6, FromPort: 443 },
            }),
          })
        );
        const updateMock = vi.fn(
          async (
            _logicalId: string,
            _physicalId: string,
            _resourceType: string,
            newProperties: Record<string, unknown>
          ) => ({
            physicalId: 'sgr-1',
            wasReplaced: false,
            // Echo the bag back with ONLY the protocol narrowed, exactly as a
            // real provider does.
            effectiveProperties: { ...newProperties, IpProtocol: 'tcp' },
          })
        );
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({
            IpProtocol: 6,
            FromPort: 8080,
            Tags: [{ Key: 'aws:created-by', Value: 'console' }],
          }),
          update: updateMock,
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        const [, , savedState] = mockSaveState.mock.calls[0]!;
        expect(savedState.resources['Ingress1']!.observedProperties).toEqual({
          IpProtocol: 'tcp',
          FromPort: 443,
        });
      });

      it('drops a key the provider did not deliver at all', async () => {
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Route1: makeResource({
              physicalId: 'rtb-1|10.0.0.0/16',
              resourceType: 'AWS::EC2::Route',
              properties: { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'igw-1' },
              observedProperties: { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'igw-1' },
            }),
          })
        );
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({
            DestinationCidrBlock: '10.0.0.0/16',
            GatewayId: 'igw-2',
          }),
          update: async () => ({
            physicalId: 'rtb-1|10.0.0.0/16',
            wasReplaced: false,
            // The provider dropped `GatewayId` from what it sent.
            effectiveProperties: { DestinationCidrBlock: '10.0.0.0/16' },
          }),
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        const [, , savedState] = mockSaveState.mock.calls[0]!;
        const observed = savedState.resources['Route1']!.observedProperties!;
        expect('GatewayId' in observed).toBe(false);
        expect(observed).toEqual({ DestinationCidrBlock: '10.0.0.0/16' });
      });

      /**
       * The state write is a SECONDARY convergence step — AWS has already been
       * reverted by the time it runs — so a failure must not abort the command.
       * Under `--all` a throw here would skip every later stack's revert, a
       * regression against the pre-#1644 behavior of never writing at all.
       */
      it('warns instead of failing the run when the state write fails', async () => {
        // The drift MUST come from a key other than IpProtocol (issue #1643):
        // `6` and `tcp` are two spellings of ONE protocol — AWS renames the
        // number on write — so `canonicalizeIpProtocols` collapses that pair
        // and it is correctly no longer drift. Using it alone here made the
        // revert never run, so `saveState` was never reached. FromPort carries
        // the drift instead, exactly as the sibling test above does, which
        // leaves this test about what it is actually for: a FAILED state write
        // warns rather than failing the run.
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Ingress1: makeResource({
              physicalId: 'sgr-1',
              resourceType: 'AWS::EC2::SecurityGroupIngress',
              properties: { IpProtocol: 6, FromPort: 443 },
              observedProperties: { IpProtocol: 6, FromPort: 443 },
            }),
          })
        );
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({ IpProtocol: 6, FromPort: 8080 }),
          update: async () => ({
            physicalId: 'sgr-1',
            wasReplaced: false,
            effectiveProperties: { IpProtocol: 'tcp', FromPort: 443 },
          }),
        });
        mockSaveState.mockRejectedValueOnce(new Error('PreconditionFailed'));

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        // The revert itself still reports success (exit 0, no PartialFailureError).
        expect(error).toBeUndefined();
        expect(mockSaveState).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls.flat().join('\n')).toMatch(
          /could not record the value the provider actually applied: PreconditionFailed/
        );
        // The lock is still released.
        expect(mockReleaseLock).toHaveBeenCalledWith('TestStack', 'us-east-1');
      });

      /**
       * The bag sent to `update()` starts as the AWS-CURRENT snapshot, so it
       * carries keys the baseline never declared. A provider that echoes one
       * back in a changed shape must NOT get it inserted into state — that is
       * `--accept` behavior reached through the back door.
       */
      it('ignores a narrowed key the baseline never declared', async () => {
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Ingress1: makeResource({
              physicalId: 'sgr-1',
              resourceType: 'AWS::EC2::SecurityGroupIngress',
              properties: { IpProtocol: 6, FromPort: 443 },
              observedProperties: { IpProtocol: 6, FromPort: 443 },
            }),
          })
        );
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({
            IpProtocol: 6,
            FromPort: 8080,
            Description: 'added in the console',
          }),
          update: async (
            _l: string,
            _p: string,
            _t: string,
            newProperties: Record<string, unknown>
          ) => ({
            physicalId: 'sgr-1',
            wasReplaced: false,
            // The provider re-shapes an AWS-only key it was handed.
            effectiveProperties: {
              ...newProperties,
              IpProtocol: 'tcp',
              Description: 'ADDED IN THE CONSOLE',
            },
          }),
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        const [, , savedState] = mockSaveState.mock.calls[0]!;
        // `Description` is not in the baseline, so it must not be imported.
        expect(savedState.resources['Ingress1']!.observedProperties).toEqual({
          IpProtocol: 'tcp',
          FromPort: 443,
        });
      });

      /**
       * With no `observedProperties` the baseline is the raw TEMPLATE and
       * `buildRevertNewProperties` runs in `preserveUntemplated` mode, so the
       * value that was sent deliberately carries AWS-authored paths. Recording
       * such a VALUE into `properties` would make the desired baseline describe
       * AWS-side data and disable the #1160 removal derivation. A DROP is still
       * recorded — it removes, never imports.
       */
      it('records only DROPs, never a value, on a template-only baseline', async () => {
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Route1: makeResource({
              physicalId: 'rtb-1|10.0.0.0/16',
              resourceType: 'AWS::EC2::Route',
              properties: {
                DestinationCidrBlock: '10.0.0.0/16',
                DestinationIpv6CidrBlock: '::/0',
                GatewayId: 'igw-1',
              },
            }),
          })
        );
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({
            DestinationCidrBlock: '10.0.0.0/16',
            GatewayId: 'igw-2',
          }),
          update: async () => ({
            physicalId: 'rtb-1|10.0.0.0/16',
            wasReplaced: false,
            // Narrows one key away AND rewrites another.
            effectiveProperties: {
              DestinationCidrBlock: '10.0.0.0/16',
              GatewayId: 'igw-1-REWRITTEN',
            },
          }),
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        const [, , savedState] = mockSaveState.mock.calls[0]!;
        const props = savedState.resources['Route1']!.properties;
        // The DROP landed...
        expect('DestinationIpv6CidrBlock' in props).toBe(false);
        // ...but the VALUE rewrite did not.
        expect(props['GatewayId']).toBe('igw-1');
      });

      it('does not treat a key-order difference as a narrowing', async () => {
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Bucket1: makeResource({
              physicalId: 'phys-b',
              resourceType: 'AWS::S3::Bucket',
              properties: { Versioning: { Status: 'Enabled', MfaDelete: 'Disabled' } },
              observedProperties: { Versioning: { Status: 'Enabled', MfaDelete: 'Disabled' } },
            }),
          })
        );
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({
            Versioning: { Status: 'Suspended', MfaDelete: 'Disabled' },
          }),
          update: async (
            _l: string,
            _p: string,
            _t: string,
            newProperties: Record<string, unknown>
          ) => {
            const versioning = newProperties['Versioning'] as Record<string, unknown>;
            return {
              physicalId: 'phys-b',
              wasReplaced: false,
              // Same members, rebuilt in the opposite key order.
              effectiveProperties: {
                Versioning: {
                  MfaDelete: versioning['MfaDelete'],
                  Status: versioning['Status'],
                },
              },
            };
          },
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        expect(mockSaveState).not.toHaveBeenCalled();
      });

      it('writes ONCE per stack for two narrowed resources, and forwards migrateLegacy', async () => {
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce({
          ...makeState({
            Route1: makeResource({
              physicalId: 'rtb-1|10.0.0.0/16',
              resourceType: 'AWS::EC2::Route',
              properties: { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'igw-1' },
              observedProperties: { DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'igw-1' },
            }),
            Route2: makeResource({
              physicalId: 'rtb-2|10.1.0.0/16',
              resourceType: 'AWS::EC2::Route',
              properties: { DestinationCidrBlock: '10.1.0.0/16', GatewayId: 'igw-1' },
              observedProperties: { DestinationCidrBlock: '10.1.0.0/16', GatewayId: 'igw-1' },
            }),
          }),
          migrationPending: true,
        });
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({
            DestinationCidrBlock: '10.9.9.9/32',
            GatewayId: 'igw-drifted',
          }),
          update: async (
            _l: string,
            _p: string,
            _t: string,
            newProperties: Record<string, unknown>
          ) => ({
            physicalId: 'phys',
            wasReplaced: false,
            effectiveProperties: { ...newProperties, GatewayId: 'igw-NARROWED' },
          }),
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        // ONE write for the whole stack, not one per resource.
        expect(mockSaveState).toHaveBeenCalledTimes(1);
        const [, , savedState, saveOptions] = mockSaveState.mock.calls[0]!;
        expect(savedState.resources['Route1']!.observedProperties!['GatewayId']).toBe(
          'igw-NARROWED'
        );
        expect(savedState.resources['Route2']!.observedProperties!['GatewayId']).toBe(
          'igw-NARROWED'
        );
        expect(saveOptions?.migrateLegacy).toBe(true);
      });

      it('does NOT write state when effectiveProperties matches what was sent', async () => {
        mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
        mockGetState.mockResolvedValueOnce(
          makeState({
            Bucket1: makeResource({
              physicalId: 'phys-b',
              resourceType: 'AWS::S3::Bucket',
              properties: { VersioningConfiguration: { Status: 'Enabled' } },
              observedProperties: { VersioningConfiguration: { Status: 'Enabled' } },
            }),
          })
        );
        mockRegistryGetProvider.mockReturnValue({
          readCurrentState: async () => ({ VersioningConfiguration: { Status: 'Suspended' } }),
          update: async (
            _logicalId: string,
            _physicalId: string,
            _resourceType: string,
            newProperties: Record<string, unknown>
          ) => ({
            physicalId: 'phys-b',
            wasReplaced: false,
            effectiveProperties: { ...newProperties },
          }),
        });

        const { error } = await runDrift(['TestStack', '--revert', '--yes']);

        expect(error).toBeUndefined();
        expect(mockSaveState).not.toHaveBeenCalled();
      });
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

describe('findRevertUnbaselinedAwsKeys (pure helper, issue #1478)', () => {
  const load = async () =>
    (await import('../../../src/cli/commands/drift.js')).findRevertUnbaselinedAwsKeys;

  it('reports an AWS-authored sub-key the raw template does not declare', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
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
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([
      'Parameters.metadata_location',
      'Parameters.table_type',
    ]);
  });

  it('does NOT report a key present on both sides with a different value', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    // That is the drift the user explicitly asked to revert, not a silent
    // loss — warning about it would make the warning meaningless.
    const desired = { Parameters: { classification: 'parquet' } };
    const aws = { Parameters: { classification: 'json' } };
    const drifts = [
      { path: 'Parameters.classification', stateValue: 'parquet', awsValue: 'json' },
    ];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('ignores AWS-authored keys under a NON-drifted top-level key', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
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
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('ignores a drifted top-level key the desired side does not declare at all', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    // `buildRevertNewProperties` leaves the AWS-current value in place when
    // the key is absent from desired, so nothing is dropped.
    const desired = { Description: 'd' };
    const aws = { Description: 'd', Parameters: { table_type: 'ICEBERG' } };
    const drifts = [{ path: 'Parameters', stateValue: undefined, awsValue: {} }];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('recurses through nested objects', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
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
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([
      'StorageDescriptor.Compressed',
      'StorageDescriptor.SerdeInfo.SerializationLibrary',
    ]);
  });

  it('reports the containing path when desired has no object where AWS does', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    const desired = { Parameters: { nested: undefined } } as Record<string, unknown>;
    const aws = { Parameters: { nested: { table_type: 'ICEBERG' } } };
    const drifts = [{ path: 'Parameters.nested', stateValue: undefined, awsValue: {} }];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual(['Parameters.nested']);
  });

  it('compares a POSITIONAL array wholesale, never element-wise', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    // The drift comparator's paths never carry an array index, so an
    // element-wise walk here would report positions the rest of the revert
    // path cannot reason about. Only a KEYED list (below) is walked, because
    // its entries have identities rather than positions.
    const desired = { SubnetIds: ['subnet-a'] };
    const aws = { SubnetIds: ['subnet-a', 'subnet-b'] };
    const drifts = [{ path: 'SubnetIds', stateValue: [], awsValue: [] }];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('does NOT report a SERVICE-authored tag the revert preserves', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    // `mergeTagListForRevert` (issue #1501) keeps `aws:`-prefixed /
    // AmazonECSManaged entries, so they are not dropped and warning about
    // them would be a false alarm. This case predates the keyed-list walk and
    // must keep returning [] now that tag lists ARE walked.
    const desired = { Tags: [{ Key: 'a', Value: '1' }] };
    const aws = {
      Tags: [
        { Key: 'a', Value: '1' },
        { Key: 'aws:authored', Value: 'x' },
        { Key: 'AmazonECSManaged', Value: 'true' },
      ],
    };
    const drifts = [{ path: 'Tags', stateValue: [], awsValue: [] }];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('DOES report an ordinary console-added tag, which the revert strips', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    // The other half of #1501: a non-service tag IS stripped by the revert,
    // so the plan should say so.
    const desired = { Tags: [{ Key: 'a', Value: '1' }] };
    const aws = { Tags: [{ Key: 'a', Value: '1' }, { Key: 'owner', Value: 'alice' }] };
    const drifts = [{ path: 'Tags', stateValue: [], awsValue: [] }];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual(['Tags[owner]']);
  });

  it('reports every AWS-only entry of a KEYED attribute list (issue #1626)', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    // The motivating case. `readCurrentState` returns ELBv2's FULL attribute
    // set, so against a template declaring one key every other entry lands on
    // the provider's removal path — and before this walk the plan warned about
    // NONE of them, because the list is an array.
    const desired = {
      LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '120' }],
    };
    const aws = {
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '60' },
        { Key: 'deletion_protection.enabled', Value: 'false' },
        { Key: 'routing.http2.enabled', Value: 'true' },
      ],
    };
    const drifts = [
      { path: 'LoadBalancerAttributes', stateValue: [], awsValue: [] },
    ];
    // Bracket form, because an attribute key contains dots of its own and a
    // dotted path would be ambiguous with a nested object.
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([
      'LoadBalancerAttributes[deletion_protection.enabled]',
      'LoadBalancerAttributes[routing.http2.enabled]',
    ]);
  });

  it('enumerates every AWS entry against an EMPTY desired list (issue #1626)', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    // This inverts the pre-#1626 contract, deliberately. `[]` carries no
    // identities, so the old walk fell to the whole-list arm — which only
    // reports when the desired side is `undefined`, so an empty list reported
    // NOTHING at all.
    //
    // That is now wrong for the only caller this helper has: it is invoked
    // exclusively when `observedProperties` is absent, and on that baseline
    // `mergeUntemplatedValue` PRESERVES every entry of an empty-baseline list
    // (the #1501 regression arm). Reporting nothing would leave the plan
    // silently under-claiming what survives, which is the one direction the
    // correspondence fence exists to forbid.
    const desired = { LoadBalancerAttributes: [] };
    const aws = { LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'x' }] };
    const drifts = [{ path: 'LoadBalancerAttributes', stateValue: [], awsValue: [] }];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([
      'LoadBalancerAttributes[deletion_protection.enabled]',
    ]);
  });

  it('does not treat a list of plain objects without Key as keyed', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    const desired = { Rules: [{ Name: 'a' }] };
    const aws = { Rules: [{ Name: 'a' }, { Name: 'b' }] };
    const drifts = [{ path: 'Rules', stateValue: [], awsValue: [] }];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([]);
  });

  it('returns nothing when AWS authored nothing extra', async () => {
    const findRevertUnbaselinedAwsKeys = await load();
    const desired = { Parameters: { a: '1', b: '2' } };
    const aws = { Parameters: { a: '9', b: '2' } };
    const drifts = [{ path: 'Parameters.a', stateValue: '1', awsValue: '9' }];
    expect(findRevertUnbaselinedAwsKeys(drifts, desired, aws)).toEqual([]);
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

describe('buildRevertNewProperties preserveUntemplated (issue #1626 items 2 + 3)', () => {
  const load = async () =>
    (await import('../../../src/cli/commands/drift.js')).buildRevertNewProperties;
  const drifted = (path: string): Array<{ path: string; stateValue: unknown; awsValue: unknown }> => [
    { path, stateValue: 'x', awsValue: 'y' },
  ];

  it('keeps the untemplated entries of a KEYED list while still reverting the templated one', async () => {
    const buildRevertNewProperties = await load();
    // The motivating shape: ELBv2 `LoadBalancerAttributes`. `readCurrentState`
    // emits every attribute AWS reports; the template declares one.
    const desired = {
      LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
    };
    const aws = {
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '90' },
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'routing.http2.enabled', Value: 'false' },
      ],
    };
    expect(
      buildRevertNewProperties(drifted('LoadBalancerAttributes'), desired, aws, {
        preserveUntemplated: true,
      })
    ).toEqual({
      LoadBalancerAttributes: [
        // reverted to the baseline value
        { Key: 'idle_timeout.timeout_seconds', Value: '60' },
        // untemplated -> preserved at the AWS-current value
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'routing.http2.enabled', Value: 'false' },
      ],
    });
  });

  it('preserves an untemplated key at a NON-default value (item 2)', async () => {
    const buildRevertNewProperties = await load();
    // PR #1624's per-provider skip only covers a key sitting at its DOCUMENTED
    // DEFAULT. The one it cannot skip is an untemplated attribute someone
    // changed in the console; that is the residual write this closes.
    const desired = { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }] };
    const aws = {
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '60' },
        { Key: 'deletion_protection.enabled', Value: 'true' },
      ],
    };
    const out = buildRevertNewProperties(drifted('LoadBalancerAttributes'), desired, aws, {
      preserveUntemplated: true,
    }) as { LoadBalancerAttributes: Array<{ Key: string; Value: string }> };
    expect(out.LoadBalancerAttributes).toContainEqual({
      Key: 'deletion_protection.enabled',
      Value: 'true',
    });
  });

  it('preserves an untemplated NESTED object key while reverting the templated sibling', async () => {
    const buildRevertNewProperties = await load();
    const desired = { Parameters: { classification: 'parquet' } };
    const aws = {
      Parameters: {
        classification: 'json',
        table_type: 'ICEBERG',
        metadata_location: 's3://bucket/metadata/00000.json',
      },
    };
    expect(
      buildRevertNewProperties(drifted('Parameters.classification'), desired, aws, {
        preserveUntemplated: true,
      })
    ).toEqual({
      Parameters: {
        classification: 'parquet',
        table_type: 'ICEBERG',
        metadata_location: 's3://bucket/metadata/00000.json',
      },
    });
  });

  it('re-adds a baseline key AWS no longer reports (the revert is still a revert)', async () => {
    const buildRevertNewProperties = await load();
    expect(
      buildRevertNewProperties(
        drifted('Parameters'),
        { Parameters: { kept: '1', lost: '2' } },
        { Parameters: { kept: '9', aws_only: '3' } },
        { preserveUntemplated: true }
      )
    ).toEqual({ Parameters: { kept: '1', aws_only: '3', lost: '2' } });
    // Same for a keyed list.
    expect(
      buildRevertNewProperties(
        drifted('Attrs'),
        { Attrs: [{ Key: 'a', Value: '1' }] },
        { Attrs: [{ Key: 'b', Value: '2' }] },
        { preserveUntemplated: true }
      )
    ).toEqual({
      Attrs: [
        { Key: 'b', Value: '2' },
        { Key: 'a', Value: '1' },
      ],
    });
  });

  it('takes a POSITIONAL array and a scalar from the baseline wholesale', async () => {
    const buildRevertNewProperties = await load();
    // The drift comparator compares these wholesale, so merging would invent a
    // value nothing else can reason about.
    expect(
      buildRevertNewProperties(
        [
          { path: 'SubnetIds', stateValue: 1, awsValue: 2 },
          { path: 'Scalar', stateValue: 1, awsValue: 2 },
        ],
        { SubnetIds: ['subnet-a'], Scalar: 'baseline' },
        { SubnetIds: ['subnet-a', 'subnet-b'], Scalar: 'drifted' },
        { preserveUntemplated: true }
      )
    ).toEqual({ SubnetIds: ['subnet-a'], Scalar: 'baseline' });
  });

  it('is OFF by default, so the observed-capture baseline still strips out-of-band additions', async () => {
    const buildRevertNewProperties = await load();
    // This is the behavior the `drift-revert` integ's injected-tag assertion
    // depends on.
    expect(
      buildRevertNewProperties(
        drifted('Attrs'),
        { Attrs: [{ Key: 'a', Value: '1' }] },
        {
          Attrs: [
            { Key: 'a', Value: '9' },
            { Key: 'console-added', Value: 'x' },
          ],
        }
      )
    ).toEqual({ Attrs: [{ Key: 'a', Value: '1' }] });
  });

  it('subsumes the #1501 tag carve-out rather than competing with it', async () => {
    const buildRevertNewProperties = await load();
    // preserveUntemplated keeps EVERY untemplated tag, which is a superset of
    // the service-authored-only carve-out.
    const out = buildRevertNewProperties(
      drifted('Tags'),
      { Tags: [{ Key: 'env', Value: 'prod' }] },
      {
        Tags: [
          { Key: 'env', Value: 'dev' },
          { Key: 'AmazonECSManaged', Value: 'true' },
          { Key: 'console-added', Value: 'x' },
        ],
      },
      { preserveUntemplated: true }
    ) as { Tags: Array<{ Key: string; Value: string }> };
    expect(out.Tags).toEqual([
      { Key: 'env', Value: 'prod' },
      { Key: 'AmazonECSManaged', Value: 'true' },
      { Key: 'console-added', Value: 'x' },
    ]);
  });

  it('keeps every AWS tag when the baseline list is DECLARED but EMPTY (#1501 regression)', async () => {
    const buildRevertNewProperties = await load();
    // `isKeyedList` requires a NON-empty array, so without the empty-array arm
    // this falls through to the wholesale branch and hands AWS `[]` — stripping
    // `AmazonECSManaged`, the exact loss the #1501 carve-out exists to prevent.
    // A condition-collapsed `Tags: []` is a real template shape, and on a
    // template-only baseline it is reachable.
    const out = buildRevertNewProperties(
      drifted('Tags'),
      { Tags: [] },
      {
        Tags: [
          { Key: 'AmazonECSManaged', Value: 'true' },
          { Key: 'console-added', Value: 'x' },
        ],
      },
      { preserveUntemplated: true }
    ) as { Tags: Array<{ Key: string }> };
    expect(out.Tags.map((e) => e.Key)).toEqual(['AmazonECSManaged', 'console-added']);
  });

  it('never emits a DUPLICATE key when AWS reports one twice', async () => {
    const buildRevertNewProperties = await load();
    // `mergeTagListForRevert` dedupes for the same reason: AWS can return the
    // same key twice, and PutBucketTagging / ModifyLoadBalancerAttributes
    // REJECT a duplicate. First occurrence wins.
    const out = buildRevertNewProperties(
      drifted('Tags'),
      { Tags: [{ Key: 'dup', Value: 'baseline' }] },
      {
        Tags: [
          { Key: 'dup', Value: 'aws-1' },
          { Key: 'dup', Value: 'aws-2' },
          { Key: 'other', Value: 'y' },
        ],
      },
      { preserveUntemplated: true }
    ) as { Tags: Array<{ Key: string; Value: string }> };
    expect(out.Tags).toEqual([
      { Key: 'dup', Value: 'baseline' },
      { Key: 'other', Value: 'y' },
    ]);
  });

  it('preserves every path findRevertUnbaselinedAwsKeys reports, plus the service tags it omits', async () => {
    const mod = await import('../../../src/cli/commands/drift.js');
    // The plan tells the user which AWS-authored paths are left untouched; the
    // merge is what makes that true. If the two walks disagree the plan lies,
    // so pin the correspondence rather than trusting two copies of the same
    // structural rules.
    const desired = {
      Parameters: { classification: 'parquet' },
      LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      Positional: ['a'],
      Tags: [{ Key: 'env', Value: 'prod' }],
      // A DECLARED-but-EMPTY keyed list: the shape whose merge arm was added
      // as a #1501 regression fix, and which `collectMissingPaths` has to
      // mirror or the plan under-claims what the merge preserves.
      EmptyBaseline: [],
    };
    const aws = {
      Parameters: { classification: 'json', table_type: 'ICEBERG' },
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '90' },
        { Key: 'deletion_protection.enabled', Value: 'true' },
      ],
      Positional: ['a', 'b'],
      Tags: [
        { Key: 'env', Value: 'dev' },
        { Key: 'console-added', Value: 'x' },
        { Key: 'AmazonECSManaged', Value: 'true' },
      ],
      EmptyBaseline: [{ Key: 'aws-authored', Value: '1' }],
    };
    const drifts = [
      { path: 'Parameters.classification', stateValue: 'parquet', awsValue: 'json' },
      { path: 'LoadBalancerAttributes', stateValue: 'x', awsValue: 'y' },
      { path: 'Positional', stateValue: ['a'], awsValue: ['a', 'b'] },
      { path: 'Tags', stateValue: 'x', awsValue: 'y' },
      { path: 'EmptyBaseline', stateValue: 'x', awsValue: 'y' },
    ];
    const reported = mod.findRevertUnbaselinedAwsKeys(drifts, desired, aws);

    const paths = (value: unknown, prefix: string, out: Set<string>): void => {
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((e) => typeof (e as { Key?: unknown })?.Key === 'string')
      ) {
        for (const e of value as Array<{ Key: string }>) out.add(`${prefix}[${e.Key}]`);
        return;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out.add(prefix ? `${prefix}.${k}` : k);
        paths(v, prefix ? `${prefix}.${k}` : k, out);
      }
    };
    const inAws = new Set<string>();
    const withoutFlag = new Set<string>();
    const withFlag = new Set<string>();
    paths(aws, '', inAws);
    paths(mod.buildRevertNewProperties(drifts, desired, aws), '', withoutFlag);
    paths(
      mod.buildRevertNewProperties(drifts, desired, aws, { preserveUntemplated: true }),
      '',
      withFlag
    );

    // Paths the flag RESCUES = paths present on the AWS side, dropped by the
    // default overlay, and kept by the merge.
    const rescued = [...inAws].filter((p) => !withoutFlag.has(p) && withFlag.has(p)).sort();

    // Every path the plan names as preserved IS rescued by the flag, and the
    // flag rescues nothing the plan failed to name — so the plan can neither
    // over-promise nor silently touch something.
    expect(rescued).toEqual(reported);
    expect(rescued).toEqual([
      'EmptyBaseline[aws-authored]',
      'LoadBalancerAttributes[deletion_protection.enabled]',
      'Parameters.table_type',
      'Tags[console-added]',
    ]);
    // `Tags[AmazonECSManaged]` is absent from BOTH lists, and that is the
    // #1501 carve-out being consistent rather than a gap: it is preserved on
    // the DEFAULT path too, so it is not something this flag rescues, and
    // `isServiceManagedTagKey` omits it from the plan because reporting it
    // would warn about a loss that cannot happen. Pin that it survives under
    // BOTH settings — the property that actually matters.
    expect(withoutFlag.has('Tags[AmazonECSManaged]')).toBe(true);
    expect(withFlag.has('Tags[AmazonECSManaged]')).toBe(true);
    // ...while an ORDINARY console-added tag is stripped by default and kept
    // only under the flag, which is the whole behavior change.
    expect(withoutFlag.has('Tags[console-added]')).toBe(false);
    expect(withFlag.has('Tags[console-added]')).toBe(true);
  });
});

describe('cdkd drift --revert untemplated-value contract (issue #1626)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Same reset set as the main suite. `mockReset()` (not `clearAllMocks`)
    // is load-bearing: `runRevertAgainst` primes with `mockResolvedValueOnce`,
    // and clearing only call RECORDS would leave the queue for the next test.
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    mockCcReadCurrentState.mockReset().mockResolvedValue(undefined);
    mockIamSend.mockReset();
    errorSpy.mockReset();
    warnSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  const runRevertAgainst = async (
    resource: ResourceState,
    awsCurrent: Record<string, unknown>
  ): Promise<{
    calls: Array<[string, string, string, Record<string, unknown>, Record<string, unknown>]>;
    output: string;
  }> => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Lb: resource }));
    const updateMock = vi.fn(async () => ({ physicalId: 'phys-lb', wasReplaced: false }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsCurrent,
      update: updateMock,
    });
    const { output } = await runDrift(['TestStack', '--revert', '--yes']);
    return {
      calls: updateMock.mock.calls as unknown as Array<
        [string, string, string, Record<string, unknown>, Record<string, unknown>]
      >,
      output,
    };
  };

  const LB_TEMPLATE = {
    LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
  };
  const LB_AWS = {
    LoadBalancerAttributes: [
      { Key: 'idle_timeout.timeout_seconds', Value: '90' },
      { Key: 'deletion_protection.enabled', Value: 'true' },
      { Key: 'routing.http2.enabled', Value: 'false' },
    ],
  };

  it('with NO observedProperties, MERGES the untemplated attributes into the sent bag', async () => {
    const { calls } = await runRevertAgainst(
      makeResource({
        physicalId: 'phys-lb',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        properties: LB_TEMPLATE,
      }),
      LB_AWS
    );
    expect(calls).toHaveLength(1);
    const sent = calls[0]![3] as { LoadBalancerAttributes: Array<{ Key: string; Value: string }> };
    // The templated attribute is reverted...
    expect(sent.LoadBalancerAttributes).toContainEqual({
      Key: 'idle_timeout.timeout_seconds',
      Value: '60',
    });
    // ...and the two untemplated ones ride along at their AWS-current values,
    // so even a wholesale-replace provider cannot drop them.
    expect(sent.LoadBalancerAttributes).toContainEqual({
      Key: 'deletion_protection.enabled',
      Value: 'true',
    });
    expect(sent.LoadBalancerAttributes).toContainEqual({
      Key: 'routing.http2.enabled',
      Value: 'false',
    });
    // The previous side is still the FULL AWS snapshot — unchanged contract.
    expect(calls[0]![4]).toEqual(LB_AWS);
  });

  it('with observedProperties present, sends the baseline overlay unchanged', async () => {
    // The baseline is a deploy-time AWS snapshot, so a key AWS reports and the
    // baseline lacks WAS added out-of-band — removing it is the revert the user
    // asked for. This is the behavior the `drift-revert` integ depends on.
    const { calls } = await runRevertAgainst(
      makeResource({
        physicalId: 'phys-lb',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        properties: LB_TEMPLATE,
        observedProperties: LB_TEMPLATE,
      }),
      LB_AWS
    );
    expect(calls).toHaveLength(1);
    const sent = calls[0]![3] as { LoadBalancerAttributes: Array<{ Key: string }> };
    expect(sent.LoadBalancerAttributes.map((e) => e.Key)).toEqual([
      'idle_timeout.timeout_seconds',
    ]);
  });

  it('the plan says the untemplated values are LEFT UNTOUCHED, not dropped', async () => {
    const { output } = await runRevertAgainst(
      makeResource({
        physicalId: 'phys-lb',
        resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        properties: LB_TEMPLATE,
      }),
      LB_AWS
    );
    expect(output).toContain('LEAVES 2 AWS-authored values untouched');
    expect(output).toContain('LoadBalancerAttributes[deletion_protection.enabled]');
    expect(output).not.toContain('will DROP');
  });
});

describe('collectNarrowedTopLevelKeys (issue #1644)', () => {
  it('returns an empty delta when the provider delivered exactly what it was handed', () => {
    const sent = { A: 1, B: { c: [1, 2] } };
    expect(collectNarrowedTopLevelKeys(sent, { ...sent })).toEqual({});
  });

  it('reports a changed value', () => {
    expect(collectNarrowedTopLevelKeys({ A: 6 }, { A: 'tcp' })).toEqual({ A: 'tcp' });
  });

  it('reports a DROP as an explicit undefined the caller can turn into a delete', () => {
    const delta = collectNarrowedTopLevelKeys({ A: 1, B: 2 }, { A: 1 });
    expect('B' in delta).toBe(true);
    expect(delta['B']).toBeUndefined();
    expect(Object.keys(delta)).toEqual(['B']);
  });

  it('treats an explicitly-undefined delivered value as a DROP, same as an omitted key', () => {
    expect(collectNarrowedTopLevelKeys({ A: 1 }, { A: undefined })).toEqual({ A: undefined });
  });

  it('does NOT treat a null value present on both sides as a change', () => {
    expect(collectNarrowedTopLevelKeys({ A: null }, { A: null })).toEqual({});
  });

  it('reports a DROP of a null-valued key (the `?? null` conflation guard)', () => {
    const delta = collectNarrowedTopLevelKeys({ A: null }, {});
    expect('A' in delta).toBe(true);
    expect(delta['A']).toBeUndefined();
  });

  it('reports a key the provider ADDED', () => {
    expect(collectNarrowedTopLevelKeys({}, { A: 'added' })).toEqual({ A: 'added' });
  });

  it('ignores object key ORDER', () => {
    const delta = collectNarrowedTopLevelKeys(
      { A: { p: 1, q: [{ x: 1, y: 2 }] } },
      { A: { q: [{ y: 2, x: 1 }], p: 1 } }
    );
    expect(delta).toEqual({});
  });

  it('still reports a genuine nested change', () => {
    expect(collectNarrowedTopLevelKeys({ A: { p: 1 } }, { A: { p: 2 } })).toEqual({ A: { p: 2 } });
  });

  it('respects array ORDER (a reorder is a real change)', () => {
    expect(collectNarrowedTopLevelKeys({ A: [1, 2] }, { A: [2, 1] })).toEqual({ A: [2, 1] });
  });
});
