import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

// Logger / config-loader / aws-clients mocks: same pattern as the
// other state-* tests so the command boot path runs cleanly without
// real AWS or the AWS SDK side-effects.

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
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
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
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
   * RESIDUALS, pinned rather than fixed — all one root cause (issue #2012).
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
   * redaction, so these stay open and honest.
   */
  it('RESIDUAL (issue #2012): an array with no identity key keeps its plaintext', async () => {
    const observed = await refreshWith(
      { Command: ['--pw', SECRET_EXPR, '--verbose'] },
      { Command: ['--pw', SECRET_PLAINTEXT, '--verbose'] }
    );
    expect(observed).toEqual({ Command: ['--pw', SECRET_PLAINTEXT, '--verbose'] });
  });

  it('RESIDUAL (issue #2012): an element with no Name/Key identity keeps its plaintext', async () => {
    const observed = await refreshWith(
      { Fields: [{ Field: 'pw', Val: SECRET_EXPR }] },
      { Fields: [{ Field: 'pw', Val: SECRET_PLAINTEXT }] }
    );
    expect(observed).toEqual({ Fields: [{ Field: 'pw', Val: SECRET_PLAINTEXT }] });
  });

  it('RESIDUAL (issue #2012): an UNPAIRED element beside a paired one keeps its plaintext', async () => {
    // The security review's case. The paired element IS redacted — that half
    // works — while the element the record has no counterpart for is returned
    // untouched, because dropping it would remove an element AWS genuinely
    // reported and `--revert` would then strip it from the live resource.
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
        { Name: 'DB_COPY', Value: SECRET_PLAINTEXT },
      ],
    });
  });

  it('descends per identity-keyed element, so a MIXED leaf inside a paired one is still refused', async () => {
    // What the keyed descent DOES buy once the array arm is descend-only: the
    // `app` element pairs by `Name`, so the walk reaches its mixed `DB_URL`
    // leaf and refuses it — the row-1 fix working one level down inside an
    // array. Its unpairable `Command` sibling keeps its plaintext (the residual
    // above), which is why both assertions are here rather than one.
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
    expect(cd['Command']).toEqual(['--pw', SECRET_PLAINTEXT]);
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
