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

  it('LEAK ROW 2: an array of plain strings the readback cannot pair takes the source', async () => {
    // No identity field on either side, and `descendArrays` is off for a
    // readback, so nothing paired and every element fell to the no-op scan.
    const observed = await refreshWith(
      { Command: ['--pw', SECRET_EXPR, '--verbose'] },
      { Command: ['--pw', SECRET_PLAINTEXT, '--verbose'] }
    );
    expect(observed).toEqual({ Command: ['--pw', SECRET_EXPR, '--verbose'] });
  });

  it('LEAK ROW 3: an array of objects with no Name/Key identity takes the source', async () => {
    // `identityKeyFor` tries `Name` then `Key`; an element keyed by neither
    // cannot pair, which is the same fall-through as row 2 one level down.
    const observed = await refreshWith(
      { Fields: [{ Field: 'pw', Val: SECRET_EXPR }] },
      { Fields: [{ Field: 'pw', Val: SECRET_PLAINTEXT }] }
    );
    expect(observed).toEqual({ Fields: [{ Field: 'pw', Val: SECRET_EXPR }] });
  });

  it('LEAK ROW 4 (RESIDUAL, issue #2012): a key the record lacks is persisted verbatim', async () => {
    // Pinned as the RESIDUAL it is, not as desired behavior. There is no source
    // leaf to take and no plaintext needle to match, so the position mechanism
    // has nothing to decide with — reachable when a provider's readback
    // normalises a key the template spells differently. A future fix (the real
    // home is `secret-redaction.ts`, beside issue #1935's span masking) must
    // flip this assertion DELIBERATELY rather than discover it.
    const observed = await refreshWith(
      { Other: 'x', Password: SECRET_EXPR },
      { Other: 'x', Password: SECRET_PLAINTEXT, MasterPassword: SECRET_PLAINTEXT }
    );
    // The positioned leaf IS protected...
    expect(observed['Password']).toBe(SECRET_EXPR);
    // ...while the unpositionable sibling is not. This is the residual.
    expect(observed['MasterPassword']).toBe(SECRET_PLAINTEXT);
  });

  it('does not disturb a keyed array the redaction pass already paired (#1915 preserved)', async () => {
    // The refusal must only ever REFUSE: where issue #1915's keyed descent
    // worked, AWS's own ordering and any AWS-added element survive. Without
    // this the second pass could quietly replace a live baseline with the
    // template's list and make drift blind to a console edit.
    const observed = await refreshWith(
      {
        Environment: [
          { Name: 'DB_PASSWORD', Value: SECRET_EXPR },
          { Name: 'LOG_LEVEL', Value: 'debug' },
        ],
      },
      {
        Environment: [
          { Name: 'LOG_LEVEL', Value: 'debug' },
          { Name: 'DB_PASSWORD', Value: SECRET_PLAINTEXT },
          { Name: 'AWS_ADDED', Value: 'by-aws' },
        ],
      }
    );
    expect(observed).toEqual({
      Environment: [
        { Name: 'LOG_LEVEL', Value: 'debug' },
        { Name: 'DB_PASSWORD', Value: SECRET_EXPR },
        { Name: 'AWS_ADDED', Value: 'by-aws' },
      ],
    });
  });

  it('tolerates a record with NO properties at all (the `?? {}` source)', async () => {
    // A resource record whose `properties` key is absent — reachable on hand-
    // edited or very old state. What this pins is that the new passes do not
    // THROW on it, which would turn a missing optional field into a
    // per-resource refresh failure.
    //
    // It does NOT pin the `?? {}` spelling: measured, replacing it with a bare
    // `properties!` keeps this green, because both passes treat an `undefined`
    // source and an empty one identically (the module returns the bag when
    // there are no secrets and no source; the second pass collects an empty
    // needle set). Said out loud so the equivalence is a known property rather
    // than a probe gap someone re-discovers.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    const withoutProperties = {
      physicalId: 'p',
      resourceType: 'AWS::S3::Bucket',
    } as unknown as ResourceState;
    mockGetState.mockResolvedValueOnce(makeState({ R: withoutProperties }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    const saved = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(saved.resources['R']?.observedProperties).toEqual({ BucketName: 'b' });
  });

  it('counts a redaction failure as a per-resource failure instead of aborting the run', async () => {
    // The redaction now runs INSIDE the same try/catch as `readCurrentState`,
    // so a throw from it must behave like a readback failure: that resource
    // keeps its previous observed bag, the others still refresh, and the run
    // reports a partial failure. A readback whose property is a throwing getter
    // is the reachable shape — both passes walk values with `Object.values`.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Good: makeResource({ physicalId: 'g', properties: { BucketName: 'g' } }),
        Bad: makeResource({
          physicalId: 'b',
          resourceType: 'AWS::Lambda::Function',
          properties: { Pw: SECRET_EXPR },
        }),
      })
    );
    mockRegistryGetProvider.mockImplementation((t: string) => {
      if (t === 'AWS::S3::Bucket') {
        return { readCurrentState: async () => ({ BucketName: 'g' }) };
      }
      return {
        readCurrentState: async () => {
          const hostile: Record<string, unknown> = {};
          Object.defineProperty(hostile, 'Pw', {
            enumerable: true,
            get() {
              throw new Error('exploding getter');
            },
          });
          return hostile;
        },
      };
    });

    const { error } = await runRefresh(['TestStack']);

    // PartialFailureError -> withErrorHandling -> process.exit(2), same as a
    // readback failure.
    expect((error as Error).message).toBe('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(2);
    const saved = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(saved.resources['Good']?.observedProperties).toEqual({ BucketName: 'g' });
    expect(saved.resources['Bad']?.observedProperties).toBeUndefined();
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
          properties: { BucketName: 'b' },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        BucketName: 'b',
        VersioningConfiguration: { Status: 'Enabled' },
        Tags: [{ Key: 'env', Value: 'prod' }],
      }),
    });

    const { error } = await runRefresh(['TestStack']);

    expect(error).toBeUndefined();
    const savedState = mockSaveState.mock.calls[0]?.[2] as StackState;
    expect(savedState.resources['Bucket1']?.observedProperties).toEqual({
      BucketName: 'b',
      VersioningConfiguration: { Status: 'Enabled' },
      Tags: [{ Key: 'env', Value: 'prod' }],
    });
  });
});
