import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

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

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
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
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: mockRegistryGetProviderFor,
    shouldSkipResource: mockRegistryShouldSkip,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
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

/**
 * The same driver WITHOUT the injected `--yes`, so the confirmation gate at
 * the top of `stateRefreshObservedCommand` is actually reached.
 *
 * NOTE this file mocks NO readline: with issue
 * [#2275](https://github.com/go-to-k/cdkd/issues/2275)'s guard the command
 * never creates an interface, so there is nothing to stub. That is also what
 * makes the case below discriminating in the production shape — remove the
 * guard and it reaches the REAL `node:readline/promises` against vitest's
 * EOF stdin and HANGS, which is the defect itself rather than a proxy for it.
 */
async function runRefreshUnconfirmed(
  args: string[]
): Promise<{ output: string; error: unknown }> {
  const cap = captureStdout();
  let error: unknown;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(['refresh-observed', ...args], { from: 'user' });
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

describe('cdkd state refresh-observed', () => {
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
    errorSpy.mockReset();
    infoSpy.mockReset();
    // Stub process.exit so PartialFailureError -> exit(2) doesn't kill the test.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  // Issue #2161: `acquireLock` reports contention by RESOLVING false (not
  // throwing). `state refresh-observed` must refuse rather than rewrite state
  // under the foreign lock and then release it. Fences the `!acquired` check.
  it('refuses when the lock is held (acquireLock resolves false)', async () => {
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
      readCurrentState: async () => ({ BucketName: 'b', Tags: [] }),
    });
    mockAcquireLock.mockResolvedValue(false);

    const { error } = await runRefresh(['TestStack']);

    // The LOCK error surfaced (not some other abort), and state was NOT written
    // / released under the foreign lock.
    expect(error).toBeDefined();
    expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toMatch(/Could not acquire lock/);
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  /**
   * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275), the ROUTING
   * half. `tests/unit/cli/non-interactive-confirm-guards.test.ts` probes this
   * command's prompt HELPER directly (the `NON_INTERACTIVE_CONFIRM` code, the
   * refusal wording, the never-settling-question hang fence); what a
   * helper-level probe cannot see is whether the COMMAND's own call site
   * still reaches it. This case drives the real command path with no `--yes`
   * and vitest's non-TTY stdin, and asserts the refusal surfaces with nothing
   * mutated.
   */
  it('REFUSES a non-interactive run without --yes, naming -y / --yes', async () => {
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

    const { error } = await runRefreshUnconfirmed(['TestStack']);

    expect(error).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    // `formatError` renders `<name>: <message>`, so the name pins that this is
    // a `CdkdError` rather than a bare `Error` — the shape CI branches on.
    expect(message).toContain('CdkdError');
    expect(message).toContain('The cdkd state refresh-observed confirmation prompt cannot run');
    expect(message).toContain('-y / --yes');
    // Refused before the lock and before any write.
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('DROPS the skipped-outputs record it was handed (issue #2740)', async () => {
    // The flat rule: every writer that rebuilds state outside a deploy drops
    // the record. This one writes only `observedProperties`, which no attribute
    // is built from — but that is a per-writer safety argument of exactly the
    // kind that was wrong three times for this field, so the rule is applied
    // rather than re-argued.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    const handed = makeState({
      Bucket1: makeResource({
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: 'b' },
      }),
    });
    handed.state.skippedOutputs = { Broken: 'digest-recorded-by-the-last-deploy' };
    mockGetState.mockResolvedValueOnce(handed);
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b', Tags: [] }),
    });

    const { error } = await runRefresh(['TestStack']);
    expect(error).toBeUndefined();

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , savedState] = mockSaveState.mock.calls[0] as unknown as [string, string, StackState];
    // The refresh itself still happened — the drop is targeted, not a rebuild.
    expect(savedState.resources['Bucket1']!.observedProperties).toBeDefined();
    expect('skippedOutputs' in savedState).toBe(false);
  });

  it('KEEPS the skipped-outputs record when it refreshed nothing (issue #2740, round 6 n15)', async () => {
    // The drop is gated on `refreshed > 0`: this command saves even when every
    // resource was unsupported, and `--all` is a diagnostic — a no-op run must
    // not reinstate the pre-#2740 phantom on every diff until a redeploy.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    const handed = makeState({
      Bucket1: makeResource({
        physicalId: 'b',
        resourceType: 'AWS::S3::Bucket',
        properties: { BucketName: 'b' },
      }),
    });
    handed.state.skippedOutputs = { Broken: 'digest-recorded-by-the-last-deploy' };
    mockGetState.mockResolvedValueOnce(handed);
    // No `readCurrentState` at all: the resource is UNSUPPORTED, so nothing
    // is refreshed.
    mockRegistryGetProvider.mockReturnValue({});

    const { error } = await runRefresh(['TestStack']);
    expect(error).toBeUndefined();
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , savedState] = mockSaveState.mock.calls[0] as unknown as [string, string, StackState];
    expect(savedState.skippedOutputs).toEqual({ Broken: 'digest-recorded-by-the-last-deploy' });
  });

  it('refreshes observedProperties on every resource and saves the updated state', async () => {
    // The headline use case: resource has no observedProperties (older
    // v2 state), refresh-observed populates it from
    // provider.readCurrentState and persists it under a stack lock.
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
      readCurrentState: async () => ({ BucketName: 'b', Tags: [] }),
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    expect(mockAcquireLock).toHaveBeenCalledWith(
      'TestStack',
      'us-east-1',
      expect.any(String),
      'state-refresh-observed'
    );
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const [, , savedState, saveOptions] = mockSaveState.mock.calls[0] as unknown as [
      string,
      string,
      StackState,
      { expectedEtag?: string },
    ];
    expect(saveOptions.expectedEtag).toBe('"etag-1"');
    expect(savedState.resources['Bucket1']?.observedProperties).toEqual({
      BucketName: 'b',
      Tags: [],
    });
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('counts providers without readCurrentState as unsupported, leaving observedProperties untouched', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        WithReader: makeResource({
          physicalId: 'a',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'a' },
        }),
        NoReader: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::Foo::Bar',
          properties: {},
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return { readCurrentState: async () => ({ BucketName: 'a' }) };
      }
      // Provider exists but no readCurrentState (incremental rollout).
      return {};
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    const savedState = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(savedState.resources['WithReader']?.observedProperties).toEqual({ BucketName: 'a' });
    expect(savedState.resources['NoReader']?.observedProperties).toBeUndefined();
  });

  it('does not abort when one resource\'s readCurrentState throws (per-resource error swallowed)', async () => {
    // Same per-resource defensive shape as deploy + import: a single
    // readCurrentState failure leaves that resource without observed
    // properties and is reported as a "failed" count; remaining
    // resources still get refreshed.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Good: makeResource({
          physicalId: 'g',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'g' },
        }),
        Bad: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::Foo::Bar',
          properties: {},
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return { readCurrentState: async () => ({ BucketName: 'g' }) };
      }
      return {
        readCurrentState: async () => {
          throw new Error('AccessDenied');
        },
      };
    });

    const { error } = await runRefresh(['TestStack']);

    // PartialFailureError caught by withErrorHandling -> process.exit(2).
    expect((error as Error).message).toBe('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(2);
    // Despite the per-resource failure, state was still saved with the
    // successful refresh; the failed resource just kept its
    // (undefined) observedProperties.
    const savedState = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(savedState.resources['Good']?.observedProperties).toEqual({ BucketName: 'g' });
    expect(savedState.resources['Bad']?.observedProperties).toBeUndefined();
  });

  it('--dry-run prints the planned counts without acquiring a lock or saving state', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({ resourceType: 'AWS::S3::Bucket' }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { error } = await runRefresh(['TestStack', '--dry-run']);

    expect(error).toBeUndefined();
    const messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toContain('1 resource(s) would be refreshed');
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('rejects when no stack name is given and --all is absent', async () => {
    mockListStacks.mockResolvedValueOnce([]);

    await runRefresh([]);
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toMatch(/Stack name is required/);
  });

  it('--all refreshes every stack in the bucket', async () => {
    mockListStacks.mockResolvedValueOnce([
      { stackName: 'StackA', region: 'us-east-1' },
      { stackName: 'StackB', region: 'us-east-1' },
    ]);
    mockGetState
      .mockResolvedValueOnce(
        makeState({ A: makeResource({ resourceType: 'AWS::S3::Bucket' }) })
      )
      .mockResolvedValueOnce(
        makeState({ B: makeResource({ resourceType: 'AWS::S3::Bucket' }) })
      );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'x' }),
    });

    const { error } = await runRefresh(['--all']);

    expect(error).toBeUndefined();
    expect(mockSaveState).toHaveBeenCalledTimes(2);
  });
});

/**
 * GHSA-p5qg-v9gv-hc7w residual (issue #1926).
 *
 * `refresh-observed` used to assign the provider readback straight into the
 * record and save it, reaching the redaction module along NO path at all. A
 * resource deployed from a `{{resolve:secretsmanager:...}}` reference is
 * deployed with the RESOLVED value, so the readback IS the decrypted secret and
 * persisting it verbatim re-opens the advisory's disclosure inside
 * `state.json`.
 *
 * The redaction here has an EMPTY secrets map by construction (this command
 * neither synthesizes nor resolves), so every assertion below is really about
 * the PATH pass: the record's own `properties` position the observed bag, and a
 * source leaf holding the expression wins over the plaintext AWS echoes back.
 */
describe('cdkd state refresh-observed — secret redaction (issue #1926)', () => {
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
    errorSpy.mockReset();
    infoSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  const SECRET_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
  const SECRET_PLAINTEXT = 'hunter2-decrypted';
  /**
   * Spelled here rather than imported: this file mocks the CLI boot path and
   * imports nothing from `secret-redaction.ts`, and the mask is a persisted
   * user-visible constant — a literal is what makes a change to it show up as a
   * failure in the command's own test rather than track it silently.
   */
  const SECRET_MASK = '***';

  it('persists the EXPRESSION, not the decrypted value AWS reads back (scalar leaf)', async () => {
    // The advisory's own shape, and the one #1915 could not reach because this
    // writer had no redaction of any kind: a plain SCALAR leaf.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Fn: makeResource({
          physicalId: 'fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { DB_PASSWORD: SECRET_EXPR } } },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // What AWS actually holds: the resolved value, because the deploy sent it.
      readCurrentState: async () => ({
        Environment: { Variables: { DB_PASSWORD: SECRET_PLAINTEXT } },
      }),
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    const savedState = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(savedState.resources['Fn']?.observedProperties).toEqual({
      Environment: { Variables: { DB_PASSWORD: SECRET_EXPR } },
    });
    // Belt and braces: the plaintext must not survive ANYWHERE in the blob that
    // reaches S3, not merely at the leaf asserted above.
    expect(JSON.stringify(savedState)).not.toContain(SECRET_PLAINTEXT);
  });

  it('reaches a secret nested in an array AWS REORDERED (inherits #1915 keyed descent)', async () => {
    // `STATE_SOURCED_READBACK_RULES` sets `descendArrays: false` because AWS may
    // reorder a list, so the ONLY thing that can pair these elements is the
    // order-independent keyed descent issue #1915 added inside the pass. The
    // fixture reorders deliberately: with positional descent this would write
    // the expression onto the WRONG element and leave the real secret in
    // plaintext, so a green here also proves the pairing is by identity.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: makeResource({
          physicalId: 'task',
          resourceType: 'AWS::ECS::TaskDefinition',
          properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Environment: [
                  { Name: 'DB_PASSWORD', Value: SECRET_EXPR },
                  { Name: 'LOG_LEVEL', Value: 'debug' },
                ],
              },
            ],
          },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        ContainerDefinitions: [
          {
            Name: 'app',
            Environment: [
              { Name: 'LOG_LEVEL', Value: 'debug' },
              { Name: 'DB_PASSWORD', Value: SECRET_PLAINTEXT },
            ],
          },
        ],
      }),
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    const savedState = mockSaveState.mock.calls[0]?.[2] as StackState;
    const observed = savedState.resources['Task']?.observedProperties as {
      ContainerDefinitions: Array<{ Environment: Array<{ Name: string; Value: string }> }>;
    };
    const env = observed.ContainerDefinitions[0]!.Environment;
    // AWS's ORDER is preserved (this is a drift baseline, not a rewrite of the
    // readback's shape) while the secret leaf carries the expression.
    expect(env.map((e) => e.Name)).toEqual(['LOG_LEVEL', 'DB_PASSWORD']);
    expect(env.find((e) => e.Name === 'DB_PASSWORD')?.Value).toBe(SECRET_EXPR);
    expect(env.find((e) => e.Name === 'LOG_LEVEL')?.Value).toBe('debug');
    expect(JSON.stringify(savedState)).not.toContain(SECRET_PLAINTEXT);
  });

  /**
   * The four shapes the module's PATH pass cannot certify (issue #1926
   * review). It substitutes only where the source leaf is a WHOLE
   * `{{resolve:...}}` token, and with an EMPTY secrets map its value-scan
   * fallback is a no-op — so each of these persisted the plaintext. Executed
   * against `redactSecretsForState` directly before the fix: rows 1-3 and 4 all
   * printed LEAK, the whole-token control and the keyed array printed ok.
   */
  async function refreshWith(
    properties: Record<string, unknown>,
    observed: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        R: makeResource({ physicalId: 'r', resourceType: 'AWS::Lambda::Function', properties }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({ readCurrentState: async () => observed });
    const { error } = await runRefresh(['TestStack']);
    expect(error).toBeUndefined();
    const saved = mockSaveState.mock.calls[0]?.[2] as StackState;
    return saved.resources['R']?.observedProperties as Record<string, unknown>;
  }

  it('LEAK ROW 1: a MIXED source leaf takes the source, not the resolved value', async () => {
    // The dominant CDK shape — `Fn::Join` around `secret.secretValueFromJson`
    // renders a connection string with the reference EMBEDDED, so the leaf is
    // not a whole token and the path pass returned the bag leaf untouched.
    const mixed = `postgres://u:${SECRET_EXPR}@h:5432/db`;
    const observed = await refreshWith(
      { Environment: { Variables: { DB_URL: mixed } } },
      { Environment: { Variables: { DB_URL: `postgres://u:${SECRET_PLAINTEXT}@h:5432/db` } } }
    );
    expect(observed).toEqual({ Environment: { Variables: { DB_URL: mixed } } });
  });

  /**
   * ANCHOR PAIRING closed the first two of these rows (issue #2012).
   *
   * With an EMPTY secrets map there is no needle, so POSITION is the only
   * mechanism; where position cannot pair the two sides, nothing can tell a
   * resolved secret from an ordinary literal. A round of this lane tried to
   * close them by taking the SOURCE subtree whenever the bag could not be
   * vouched for, and the issue #1915 fences caught it as a REGRESSION: measured,
   * it rewrote `{Name:'', Value:'an-unrelated-literal'}` into the expression (a
   * false redaction of a value that was never secret) and turned an
   * AWS-reported `[{Value:'x'}]` into `[{Name:'db', Value:<expr>}]`, fabricating
   * baseline content AWS never reported — which `cdkd drift --revert` pushes to
   * the live resource. Fabricating a baseline is not an acceptable price for
   * redaction.
   *
   * What DID close them is corroboration rather than trust: two containers pair
   * positionally when their key sets / index counts match AND every position
   * the source does not spell as a reference is deep-equal on both sides, at
   * least one of them a non-empty string. Substitution then touches only the
   * reference-bearing positions, so nothing can be fabricated — see
   * `anchorsCorroboratePairing` and `secret-redaction-anchor-pairing.test.ts`.
   * The closure is a SUBSET of each row: one normalised sibling field, or a
   * reordered list, and the same shape refuses again.
   *
   * TWO rows stay open, and they are the ones with no position to anchor
   * against AT ALL rather than a position the anchors happened to reject:
   *
   *  - an UNPAIRED element beside a paired one. Some element pairs by identity,
   *    so `identityKeyFor` answers and the anchor arm never runs; the leftover
   *    element has no counterpart to take anything from.
   *  - an observed KEY the source does not carry. There is no source leaf to
   *    position against and no needle to match, and refusing every unpaired key
   *    would empty the drift baseline of every secret-bearing resource, because
   *    an extra key is the NORM in an AWS readback.
   *
   * Both are pinned below rather than asserted here, on fixtures the anchor arm
   * would answer DIFFERENTLY if it reached them — a comment claiming a row is
   * still open is worth nothing without a case that fails when it is not.
   */
  it('RAW intrinsic properties vs a STRING readback are MASKED, not persisted (issue #2846)', async () => {
    // `cdkd import`'s warn path deliberately persists the RAW intrinsic shape
    // when an intrinsic references a resource outside the importable set, and
    // says so in its warning — so a raw-shape record is a documented, ordinary
    // outcome, not a corruption. This command then read the DECRYPTED value back
    // and walked it against an `Fn::Join` OBJECT, which the position walk cannot
    // pair, and persisted the plaintext into `state.json`.
    //
    // Since issue #2852 the walk fails CLOSED at such a position: the leaf is
    // `SECRET_MASK`. The intrinsic is NOT written in its place — an `Fn::Join`
    // object in a drift baseline is a value AWS never reported.
    const raw = { 'Fn::Join': ['', ['postgres://u:', SECRET_EXPR, '@h']] };
    const observed = await refreshWith(
      { Url: raw },
      { Url: `postgres://u:${SECRET_PLAINTEXT}@h` }
    );
    expect(observed).toEqual({ Url: SECRET_MASK });
    expect(JSON.stringify(observed)).not.toContain(SECRET_PLAINTEXT);
    expect(observed['Url']).not.toEqual(raw);
  });

  it('an identity key AWS NORMALISED is MASKED rather than persisted (issue #2852)', async () => {
    // The keyed-array axis, through the command rather than the module: `DB`
    // finds no partner, the source element carrying the reference is left over,
    // and the plaintext it resolved to is somewhere in this remainder.
    const observed = await refreshWith(
      { Environment: [{ Name: 'db', Value: SECRET_EXPR }] },
      { Environment: [{ Name: 'DB', Value: SECRET_PLAINTEXT }] }
    );
    expect(observed).toEqual({ Environment: [{ Name: SECRET_MASK, Value: SECRET_MASK }] });
    expect(JSON.stringify(observed)).not.toContain(SECRET_PLAINTEXT);
    expect(JSON.stringify(observed)).not.toContain(SECRET_EXPR);
  });

  it('an array with no identity key is redacted once its literal elements anchor it', async () => {
    // `--pw` and `--verbose` are positions AWS did not rewrite, so their
    // equality is evidence the two argv lists are the same one. Before the
    // anchor arm this array had no identity field to key on and was refused
    // outright, persisting the decrypted value into the drift baseline.
    const observed = await refreshWith(
      { Command: ['--pw', SECRET_EXPR, '--verbose'] },
      { Command: ['--pw', SECRET_PLAINTEXT, '--verbose'] }
    );
    expect(observed).toEqual({ Command: ['--pw', SECRET_EXPR, '--verbose'] });
    expect(JSON.stringify(observed)).not.toContain(SECRET_PLAINTEXT);
  });

  it('an element with no Name/Key identity is redacted once its own literal field anchors it', async () => {
    // `Field` is NOT being added to ARRAY_IDENTITY_KEYS — it anchors a
    // positional pairing, which is a different mechanism with a different
    // failure mode: a wrong anchor refuses, where a wrong identity key would
    // mis-assign across a reorder.
    const observed = await refreshWith(
      { Fields: [{ Field: 'pw', Val: SECRET_EXPR }] },
      { Fields: [{ Field: 'pw', Val: SECRET_PLAINTEXT }] }
    );
    expect(observed).toEqual({ Fields: [{ Field: 'pw', Val: SECRET_EXPR }] });
    expect(JSON.stringify(observed)).not.toContain(SECRET_PLAINTEXT);
  });

  it('CLOSED (issue #2012): an UNPAIRED element beside a paired one is redacted BY VALUE', async () => {
    // The security review's case, and the first of the two rows the DERIVED
    // NEEDLE closes. It used to keep its plaintext: `DB` pairs by `Name` and is
    // redacted, while `DB_COPY` has no counterpart in the record, so the walk
    // has no source leaf to take and — with an empty secrets map — the value
    // scan it falls back to had no needles.
    //
    // It never lacked a VALUE. Certifying `DB` IS the assertion that
    // `hunter2-decrypted` is that expression's resolved form, so the same
    // assertion, read back out, is a needle. `DB_COPY` then matches it and
    // takes the same expression.
    //
    // The FLIP is deliberate and is the point of the change: this assertion
    // said `SECRET_PLAINTEXT` before, and a decrypted secret sitting in
    // `observedProperties` on the path a plain `cdkd deploy` reaches is the
    // GHSA class this lane exists to end.
    //
    // The ELEMENT is still not dropped or invented — only the leaf's value
    // changes — which is the property `--revert` depends on: AWS reported two
    // entries and the baseline still has two.
    const observed = await refreshWith(
      { Environment: [{ Name: 'DB', Value: SECRET_EXPR }] },
      {
        Environment: [
          { Name: 'DB', Value: SECRET_PLAINTEXT },
          { Name: 'DB_COPY', Value: SECRET_PLAINTEXT },
        ],
      }
    );
    expect(observed).toEqual({
      Environment: [
        { Name: 'DB', Value: SECRET_EXPR },
        { Name: 'DB_COPY', Value: SECRET_EXPR },
      ],
    });
    expect(JSON.stringify(observed)).not.toContain(SECRET_PLAINTEXT);
  });

  it('does NOT over-redact an AWS-added element holding an UNRELATED literal', async () => {
    // The complement of the case above, and it is what stops the derived needle
    // from becoming a blanket rewrite. `DB` pairs by `Name` and IS redacted, so
    // a needle EXISTS for this record; `EXTRA` is an element the record has no
    // counterpart for, exactly like `DB_COPY` — but its value is not the
    // learned plaintext, so it is left alone.
    //
    // Its assertion is UNCHANGED by issue #2012's fix, which is the claim being
    // made: the needle discriminates on VALUE, so a positionless element is
    // redacted when it holds the secret and untouched when it does not. A fix
    // that redacted every unpaired element would red this case, and that fix is
    // the FABRICATION the #1915 fences already rejected once.
    //
    // The fixture is also length-matched on purpose, and that was its original
    // job: it separates the identity arm from the anchor arm, which answer
    // differently here.
    //
    //  - identity (what actually runs): `DB` pairs by `Name` and IS redacted;
    //    `EXTRA` has no counterpart in the record.
    //  - anchors (what must NOT run): index 1's anchor is `GONE` against
    //    `EXTRA`, so the positions do not corroborate and the WHOLE array is
    //    refused — `DB` would keep its plaintext too.
    const observed = await refreshWith(
      {
        Environment: [
          { Name: 'DB', Value: SECRET_EXPR },
          { Name: 'GONE', Value: 'removed-from-the-template' },
        ],
      },
      {
        Environment: [
          { Name: 'DB', Value: SECRET_PLAINTEXT },
          { Name: 'EXTRA', Value: 'added-by-aws' },
        ],
      }
    );

    expect(observed).toEqual({
      Environment: [
        { Name: 'DB', Value: SECRET_EXPR },
        { Name: 'EXTRA', Value: 'added-by-aws' },
      ],
    });
  });

  it('CLOSED (issue #2012): an observed KEY the source does not carry, INSIDE the anchor arm', async () => {
    // The other surviving row, put where the anchor arm can actually reach it.
    // Its usual shape is a top-level object, which the arm never sees (it is
    // arrays-only), so that fixture proves nothing about this claim.
    //
    // Nested in a keyless array, this used to refuse TWICE OVER and both
    // refusals had to go for the row to close:
    //
    //  - `anchorsCorroboratePairing` compared key COUNTS, so the bag element's
    //    AWS-added `Extra` refused the whole element and `Val` kept its
    //    plaintext as well. It now requires only that every SOURCE key is
    //    present, which is the direction that guards fabrication; an extra bag
    //    key can neither be overwritten nor invented, because the walk maps
    //    over the BAG and takes a source leaf only where the source HAS one.
    //  - `Extra` itself has no source leaf, so nothing could be substituted for
    //    it. The DERIVED NEEDLE learned from `Val` — now that the element pairs
    //    — is what reaches it, by value rather than by position.
    //
    // Both flips are deliberate. What is NOT relaxed is the other direction: a
    // SOURCE key missing from the bag still refuses, and
    // `secret-redaction-anchor-pairing.test.ts`'s two ROW 4 cases pin it.
    const observed = await refreshWith(
      { Fields: [{ Field: 'pw', Val: SECRET_EXPR }] },
      { Fields: [{ Field: 'pw', Val: SECRET_PLAINTEXT, Extra: SECRET_PLAINTEXT }] }
    );

    expect(observed).toEqual({
      Fields: [{ Field: 'pw', Val: SECRET_EXPR, Extra: SECRET_EXPR }],
    });
    expect(JSON.stringify(observed)).not.toContain(SECRET_PLAINTEXT);
  });

  it('descends per identity-keyed element, reaching BOTH a MIXED leaf and an anchored array', async () => {
    // What the keyed descent buys, now on both of its inner shapes. The `app`
    // element pairs by `Name`, so the walk reaches its mixed `DB_URL` leaf and
    // refuses it — the row-1 fix working one level down inside an array.
    //
    // Its `Command` sibling used to be the counter-example on the same element:
    // no identity field, so it kept its plaintext while `DB_URL` was redacted.
    // The anchor arm reaches it now (`--pw` is a position AWS did not rewrite),
    // so both assertions say REDACTED and the element no longer carries a
    // decrypted value out of a walk that redacted its neighbour.
    const mixed = `postgres://u:${SECRET_EXPR}@h`;
    const observed = await refreshWith(
      {
        ContainerDefinitions: [
          { Name: 'app', Env: { DB_URL: mixed }, Command: ['--pw', SECRET_EXPR] },
        ],
      },
      {
        ContainerDefinitions: [
          {
            Name: 'app',
            Env: { DB_URL: `postgres://u:${SECRET_PLAINTEXT}@h` },
            Command: ['--pw', SECRET_PLAINTEXT],
          },
        ],
      }
    );
    const cd = (observed['ContainerDefinitions'] as Array<Record<string, unknown>>)[0]!;
    expect((cd['Env'] as Record<string, unknown>)['DB_URL']).toBe(mixed);
    expect(cd['Command']).toEqual(['--pw', SECRET_EXPR]);
    expect(JSON.stringify(observed)).not.toContain(SECRET_PLAINTEXT);
  });

  it('keeps an own __proto__ key in the readback as DATA (issue #1943 class)', async () => {
    // `JSON.parse` of an SDK response can produce an OWN `__proto__` key, and
    // the redaction walks rebuild the bag with `out[k] = ...` — on a normal
    // object that invokes the prototype setter instead of defining the key, so
    // it would vanish from `observedProperties` and read as phantom drift
    // forever after. The accumulators are null-prototype for that reason.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        R: makeResource({
          physicalId: 'r',
          resourceType: 'AWS::Lambda::Function',
          properties: { Pw: SECRET_EXPR },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () =>
        // The shape `JSON.parse` produces: an OWN, enumerable `__proto__`.
        JSON.parse('{"Pw":"' + SECRET_PLAINTEXT + '","__proto__":{"polluted":true}}') as Record<
          string,
          unknown
        >,
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    const saved = mockSaveState.mock.calls[0]?.[2] as StackState;
    const observed = saved.resources['R']?.observedProperties as Record<string, unknown>;
    expect(Object.hasOwn(observed, '__proto__')).toBe(true);
    expect(observed['Pw']).toBe(SECRET_EXPR);
    // Nothing reached the prototype of an ordinary object.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    // ...and it survives the JSON round-trip into S3 rather than being dropped.
    expect(JSON.stringify(saved)).toContain('__proto__');
  });

  it('leaves an ordinary readback untouched, including keys the record does not carry', async () => {
    // The other half, so the redaction cannot silently widen: with no
    // expression in the source, the observed bag must reach state verbatim —
    // including a key `properties` lacks entirely, which the pass reaches
    // through its "source has no such key" arm.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket1: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b', Tags: [{ Key: 'env', Value: 'prod' }] },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        BucketName: 'b',
        VersioningConfiguration: { Status: 'Enabled' },
        // An AWS-ADDED array element on a source array carrying no reference:
        // it must survive, which is what bounds the fail-closed drop above to
        // secret-bearing subtrees only.
        Tags: [
          { Key: 'env', Value: 'prod' },
          { Key: 'aws:cloudformation:stack-name', Value: 'added-by-aws' },
        ],
      }),
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    const savedState = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(savedState.resources['Bucket1']?.observedProperties).toEqual({
      BucketName: 'b',
      VersioningConfiguration: { Status: 'Enabled' },
      Tags: [
        { Key: 'env', Value: 'prod' },
        { Key: 'aws:cloudformation:stack-name', Value: 'added-by-aws' },
      ],
    });
  });
});

/**
 * Schema v10's `observedBaselineRefused` (issue
 * [#2944](https://github.com/go-to-k/cdkd/issues/2944)), read side.
 *
 * This command is the SECOND of the two writers the issue names, and the reason
 * it cannot decide for itself is structural: it positions its readback against
 * the record's own `properties` (the 4th argument to `readCurrentState`, and
 * the source bag handed to `redactSecretsForState`), and after an import
 * refusal those `properties` can hold the WRONG-BRANCH LITERAL the refusal
 * distrusted. A literal source leaf against a string readback PAIRS as an
 * ordinary drifted literal, so the redaction walk has nothing to refuse on and
 * the decrypted value is persisted — the `cdkd state refresh-observed` route
 * back into GHSA-p5qg-v9gv-hc7w. And it is the SYNTH-FREE half of the CLI by
 * construction, so the template evidence the refusal rested on is unavailable
 * to it. Reading the marker is the only thing it can do.
 *
 * EVERY case here carries an UNMARKED sibling that IS refreshed in the same
 * run. Without one, "the marked resource was not refreshed" is satisfied
 * equally by a command that aborted, by a provider with no read handler, and by
 * a fixture that never reached the task loop — so the assertion would pass with
 * the guard deleted.
 */
describe('cdkd state refresh-observed — import-refused baselines (issue #2944)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  /** The decrypted value AWS holds. It must reach no persisted bag. */
  const REFUSED_PLAINTEXT = 'THE-REAL-DECRYPTED-SECRET';
  /** What the refusal left in `properties`: an ordinary, unsuspicious string. */
  const WRONG_BRANCH_LITERAL = 'dev-placeholder';

  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockSaveState.mockReset().mockResolvedValue('"etag-2"');
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset().mockResolvedValue(undefined);
    mockRegistryGetProvider.mockReset();
    mockRegistryShouldSkip.mockReset().mockReturnValue(false);
    errorSpy.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('does NOT refresh a marked resource while an unmarked sibling IS refreshed', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Refused: makeResource({
          physicalId: 'refused',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'q', Password: WRONG_BRANCH_LITERAL },
          observedBaselineRefused: true,
        }),
        Sibling: makeResource({
          physicalId: 'sibling',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
        }),
      })
    );
    // The sibling's provider HAS a `readCurrentState`, which is the half that
    // makes "still absent" discriminating: were the marked record skipped for
    // want of a read handler instead, this sibling would be skipped too.
    const readFor: string[] = [];
    mockRegistryGetProvider.mockImplementation((resourceType: string) => ({
      readCurrentState: async (physicalId: string) => {
        readFor.push(physicalId);
        return resourceType === 'AWS::SQS::Queue'
          ? { QueueName: 'q', Password: REFUSED_PLAINTEXT }
          : { BucketName: 'b', Tags: [] };
      },
    }));

    const { error } = await runRefresh(['TestStack']);
    expect(error).toBeUndefined();

    // AWS was never asked about the refused resource — the skip is ahead of the
    // read, not a discard of one already taken.
    expect(readFor).toEqual(['sibling']);
    const saved = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(saved.resources['Refused']?.observedProperties).toBeUndefined();
    // The marker STANDS: this command holds no template, so it cannot discharge
    // a refusal, only honour it. A deploy that changes the resource does that.
    expect(saved.resources['Refused']?.observedBaselineRefused).toBe(true);
    // The sibling is the control: the run really did refresh.
    expect(saved.resources['Sibling']?.observedProperties).toEqual({
      BucketName: 'b',
      Tags: [],
    });
    // And the plaintext reached the persisted blob by no route at all — not the
    // baseline, not `properties`, not an attribute bag.
    expect(JSON.stringify(saved)).not.toContain(REFUSED_PLAINTEXT);
  });

  it('counts a refused resource in its OWN tally, not folded into `unsupported`', async () => {
    // `unsupported` means cdkd has no way to read the resource. A refused one IS
    // readable and WOULD have been refreshed, so reporting it there would render
    // a security refusal as missing provider coverage — and would hide it from
    // a user auditing why a resource stopped tracking drift.
    //
    // THE THIRD RESOURCE is what makes this a discrimination rather than a
    // spelling check: `NoReader` is a genuine `unsupported`, so the counts can
    // actually be confused with one another in this fixture.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Refused: makeResource({
          physicalId: 'refused',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'q', Password: WRONG_BRANCH_LITERAL },
          observedBaselineRefused: true,
        }),
        Sibling: makeResource({
          physicalId: 'sibling',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
        }),
        NoReader: makeResource({
          physicalId: 'no-reader',
          resourceType: 'AWS::Foo::Bar',
          properties: {},
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation((resourceType: string) => {
      if (resourceType === 'AWS::SQS::Queue') {
        return { readCurrentState: async () => ({ Password: REFUSED_PLAINTEXT }) };
      }
      if (resourceType === 'AWS::S3::Bucket') {
        return { readCurrentState: async () => ({ BucketName: 'b' }) };
      }
      // A provider with no read handler at all: the real `unsupported`.
      return {};
    });

    const { error } = await runRefresh(['TestStack']);
    expect(error).toBeUndefined();

    // ONE line carries all four counts, so a refusal folded into `unsupported`
    // (`2 unsupported`, no refused segment) reds this assertion, and so does a
    // refusal counted as a refresh.
    const messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toContain(
      '✓ TestStack (us-east-1): 1 refreshed, 1 unsupported, 0 failed, 1 refused (import baseline refusal)'
    );
    // The user-facing summary is a WARN on its own line, not a fourth count in
    // the `Done:` summary — a declined refresh they cannot see from the record.
    const warnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnings).toContain('1 resource(s) were NOT refreshed');
    // A refusal is not a failure: the command exits 0 and the state is saved.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--dry-run applies the SAME gate: a marked resource is not planned as a refresh', async () => {
    // The dry run has its own loop over the same entries, so it can silently
    // disagree with the real one — a plan that promises a refresh the run then
    // declines. Same fixture, same expected split, read off the plan line.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Refused: makeResource({
          physicalId: 'refused',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: 'q', Password: WRONG_BRANCH_LITERAL },
          observedBaselineRefused: true,
        }),
        Sibling: makeResource({
          physicalId: 'sibling',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
        }),
      })
    );
    // BOTH providers can read: the plan's `unsupported` column is 0, so the
    // refused resource has nowhere to hide but its own segment.
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { error } = await runRefresh(['TestStack', '--dry-run']);
    expect(error).toBeUndefined();

    const messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toContain(
      'Plan TestStack (us-east-1): 1 resource(s) would be refreshed, 0 unsupported, ' +
        '1 refused (import baseline refusal)'
    );
    // The sibling's `1 would be refreshed` above is the control; these two pin
    // that a dry run remains a dry run.
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });
});
