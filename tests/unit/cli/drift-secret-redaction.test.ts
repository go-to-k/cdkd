import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * Issue #1914 — `cdkd drift` and the GHSA-p5qg-v9gv-hc7w redaction.
 *
 * State stores a secret dynamic reference as its unresolved `{{resolve:...}}`
 * expression while a provider's `readCurrentState` snapshot holds the resolved
 * plaintext, and `runDriftForStack` reconciled nothing. Three coupled defects
 * fell out of that one gap, and each gets its own test here:
 *
 *   1. `--revert` handed the expression-bearing baseline straight to
 *      `provider.update`, setting the LIVE resource to the literal token.
 *   2. The comparison compared an expression against a plaintext. PR #1899 had
 *      already stopped the phantom drift half of that by making
 *      `calculateResourceDrift` SKIP any state leaf holding a `{{resolve:...}}`
 *      string — which bought quiet at the price of never detecting drift on a
 *      secret-bearing property at all. Resolving the baseline replaces the skip
 *      with a real like-for-like comparison, so a console edit of such a
 *      property is reported (and revertible) again.
 *   3. `--accept` persisted that plaintext back into `state.json`.
 *
 * The resolver is the REAL one (the AWS sends are mocked), matching
 * `rollback-executor-secret-redaction.test.ts`: it is the component that
 * decides what counts as a secret, so stubbing it would make every assertion
 * here agree with a stub rather than with the shipped rule.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
// The retry logger's channel: `withRetry` echoes the failing AWS error here on
// every attempt, and the payload it describes carries resolved secrets.
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: debugSpy,
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

const SECRET_EXPR = '{{resolve:secretsmanager:cdkd-test-secret:SecretString:password::}}';
const SECRET_PLAINTEXT = 'cdkd-known-pw-123';
// A SECOND reference, to a different secret, so a test can tell "positioned
// against the right bag" from "positioned against a bag that happens to agree".
const OTHER_EXPR = '{{resolve:secretsmanager:cdkd-other-secret:SecretString:password::}}';
const OTHER_PLAINTEXT = 'cdkd-other-pw-777';
// Issue #1901's half: a PLAIN `ssm:` reference is a secret only when the
// parameter turns out to be a `SecureString`, so the drift paths have to
// inherit the resolver's TYPE-based verdict rather than any spelling rule.
const SECURE_EXPR = '{{resolve:ssm:/cdkd/test/secure}}';
const SECURE_PLAINTEXT = 'cdkd-known-secure-value-456';
// ...and its discriminator: an ssm reference of the SAME spelling whose
// parameter is a plain `String` is public config, must stay RESOLVED, and must
// never mark its path secret-bearing.
const PUBLIC_SSM_EXPR = '{{resolve:ssm:/cdkd/test/public}}';
// A spelling cdkd deliberately does NOT resolve: the resolver's
// unsupported-service arm warns and returns the literal, and `cdkd deploy` does
// the same, so AWS holds this string verbatim.
const UNSUPPORTED_EXPR = '{{resolve:ssm-secure:/cdkd/test/secure}}';
const PUBLIC_SSM_VALUE = 'cdkd-known-ssm-value';

// The drift command constructs its own `AwsClients` (s3 + iam), while the
// resolver reaches for the ambient one (secretsManager / ssm). Both come from
// this module, so one mock has to answer for both.
// Routed by SecretId so a fixture can hold TWO references resolving to
// different values — the shape a position source has to keep apart.
const mockSecretsManagerSend = vi.hoisted(() =>
  vi.fn(async (command: { input?: { SecretId?: string } }) =>
    command?.input?.SecretId === 'cdkd-other-secret'
      ? { SecretString: JSON.stringify({ password: 'cdkd-other-pw-777' }) }
      : { SecretString: JSON.stringify({ password: 'cdkd-known-pw-123' }) }
  )
);
const mockSsmSend = vi.hoisted(() =>
  vi.fn(async (command: { input?: { Name?: string } }) =>
    command?.input?.Name === '/cdkd/test/public'
      ? { Parameter: { Value: 'cdkd-known-ssm-value', Type: 'String' } }
      : { Parameter: { Value: 'cdkd-known-secure-value-456', Type: 'SecureString' } }
  )
);
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
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: mockSsmSend },
  }),
}));

const mockGetState =
  vi.fn<
    (
      stackName: string,
      region: string
    ) => Promise<{ state: StackState; etag: string; migrationPending?: boolean } | null>
  >();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
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

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn().mockImplementation(() => ({
    readCurrentState: vi.fn(async () => undefined),
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

const LAMBDA_TYPE = 'AWS::Lambda::Function';

/**
 * The consumer-Lambda shape the `secrets-dynamic-ref` integ deploys: one env
 * var carrying a secretsmanager reference beside a plain one. `properties` and
 * `observedProperties` BOTH hold the expression, which is what the deploy-time
 * redaction leaves behind (`scrubResourceRecord`).
 */
function lambdaResource(observedOverride?: Record<string, unknown>): ResourceState {
  const templateBag = {
    FunctionName: 'fn',
    Environment: { Variables: { SECRET_PASSWORD: SECRET_EXPR, PLAIN: 'ok' } },
  };
  return {
    physicalId: 'fn',
    resourceType: LAMBDA_TYPE,
    properties: JSON.parse(JSON.stringify(templateBag)) as Record<string, unknown>,
    observedProperties:
      observedOverride ?? (JSON.parse(JSON.stringify(templateBag)) as Record<string, unknown>),
  };
}

function makeState(resources: Record<string, ResourceState>): {
  state: StackState;
  etag: string;
} {
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources,
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

/** The live readback: AWS holds the RESOLVED value, never the expression. */
function awsEnv(extra: Record<string, string> = {}): Record<string, unknown> {
  return {
    FunctionName: 'fn',
    Environment: {
      Variables: { SECRET_PASSWORD: SECRET_PLAINTEXT, PLAIN: 'ok', ...extra },
    },
  };
}

describe('cdkd drift — secret dynamic references (issue #1914)', () => {
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
    mockSecretsManagerSend.mockClear();
    mockSecretsManagerSend.mockImplementation(async (command: { input?: { SecretId?: string } }) =>
      command?.input?.SecretId === 'cdkd-other-secret'
        ? { SecretString: JSON.stringify({ password: OTHER_PLAINTEXT }) }
        : { SecretString: JSON.stringify({ password: SECRET_PLAINTEXT }) }
    );
    // Re-IMPLEMENTED, not merely cleared: a test that calls
    // `mockSsmSend.mockImplementation(...)` replaces the Name-routed default
    // PERMANENTLY, so every later case inherits it and the #1901
    // SecureString/String split silently stops discriminating. `mockClear`
    // resets calls, never the implementation. Proven by re-running the
    // SecureString case after the needle-floor one: it fails.
    mockSsmSend.mockClear();
    mockSsmSend.mockImplementation(async (command: { input?: { Name?: string } }) =>
      command?.input?.Name === '/cdkd/test/public'
        ? { Parameter: { Value: PUBLIC_SSM_VALUE, Type: 'String' } }
        : { Parameter: { Value: SECURE_PLAINTEXT, Type: 'SecureString' } }
    );
    errorSpy.mockReset();
    warnSpy.mockReset();
    infoSpy.mockReset();
    debugSpy.mockReset();
    // The resolved-value cache is module-global; clearing it keeps each test's
    // `mockSecretsManagerSend` call-count assertion honest.
    resetAccountInfoCache();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  // --- Defect 2: the comparison -------------------------------------------

  it('reports NO drift when the only difference is expression-vs-resolved-plaintext', async () => {
    // A REGRESSION GUARD, not a discriminator, and the distinction is worth
    // stating because the title reads like one. The pre-fix binary also
    // reported "no drift" here — its blanket skip suppressed the leaf — so
    // this case cannot tell the fix from the bug, and its
    // `not.toContain(PLAINTEXT)` is vacuous because a clean run prints no
    // values at all. What it DOES pin is that resolving the baseline did not
    // introduce phantom drift on the clean path (a resolution returning
    // ciphertext, or failing open, would red it) and that the resolution
    // actually happened, which the `toHaveBeenCalledTimes` line asserts
    // directly. The discriminating cases are the two below it.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({ readCurrentState: async () => awsEnv() });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
  });

  it('detects a console-side change to a secret-bearing property, and MASKS the AWS side', async () => {
    // Two things at once, because they are one behaviour.
    //
    // Detection is the half PR #1899's blanket skip gave up: with the state
    // leaf holding an expression the comparator returned early, so a changed
    // secret env var was invisible to `cdkd drift` and unreachable by
    // `--revert`. Resolving the baseline makes the two sides comparable again.
    //
    // Masking is what detection then requires. cdkd cannot tell an out-of-band
    // edit from the PREVIOUS version of a rotated secret — both are "a value at
    // a path known to carry a secret that is not what the reference resolves to
    // today" — so it prints neither. Only the expression itself may be shown.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ SECRET_PASSWORD: 'tampered-in-the-console' }),
    });

    const { output } = await runDrift(['TestStack']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output).toContain('Environment.Variables.SECRET_PASSWORD');
    expect(output).toContain(SECRET_MASK);
    expect(output).not.toContain('tampered-in-the-console');
    // The baseline side is shown as the expression it is stored as, never as
    // the value it resolves to.
    expect(output).toContain(SECRET_EXPR);
    expect(output).not.toContain(SECRET_PLAINTEXT);
  });

  it('MASKS the previous version of a rotated secret instead of printing it', async () => {
    // The shape that refutes "a value the map does not know is not a secret".
    // The map is built by resolving the reference NOW, so it holds the CURRENT
    // secret; a rotation leaves the deployed resource carrying the previous
    // one, which matches no key in it. That value is a real secret, it drifts
    // by construction, and a value-scan-only redaction prints it verbatim.
    const ROTATED_AWAY = 'cdkd-previous-pw-000';
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ SECRET_PASSWORD: ROTATED_AWAY }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(ROTATED_AWAY);
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ path: string; awsValue: unknown }> }>;
    }>;
    // Guard before the index: a change that stops DETECTING drift must red on
    // this line, not as a `TypeError` on the next one.
    expect(payload[0]!.drifted).toHaveLength(1);
    const change = payload[0]!.drifted[0]!.changes.find(
      (c) => c.path === 'Environment.Variables.SECRET_PASSWORD'
    );
    expect(change?.awsValue).toBe(SECRET_MASK);
  });

  it('does not mask a NON-secret property that merely sits beside a secret one', async () => {
    // The other side of the position rule: masking is keyed on the PATH, so a
    // sibling key with no reference must still report its real values or the
    // report stops being useful the moment a resource holds one secret.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: 'edited-in-the-console' }),
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('Environment.Variables.PLAIN');
    expect(output).toContain('edited-in-the-console');
    expect(output).not.toContain(SECRET_MASK);
  });

  it('treats a SecureString ssm reference as secret and a String one as public (issue #1901)', async () => {
    // Both references have the SAME spelling, so nothing but the resolver's
    // TYPE verdict can separate them — and drift has to inherit it on both
    // sides: mask the SecureString path, leave the String path alone.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: {
            Environment: {
              Variables: { SSM_SECURE: SECURE_EXPR, SSM_PUBLIC: PUBLIC_SSM_EXPR },
            },
          },
          observedProperties: {
            Environment: {
              Variables: { SSM_SECURE: SECURE_EXPR, SSM_PUBLIC: PUBLIC_SSM_VALUE },
            },
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: {
          Variables: { SSM_SECURE: 'rotated-away-secure', SSM_PUBLIC: 'changed-in-console' },
        },
      }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain('rotated-away-secure');
    expect(output).not.toContain(SECURE_PLAINTEXT);
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ path: string; awsValue: unknown }> }>;
    }>;
    expect(payload[0]!.drifted).toHaveLength(1);
    const changes = payload[0]!.drifted[0]!.changes;
    expect(
      changes.find((c) => c.path === 'Environment.Variables.SSM_SECURE')?.awsValue
    ).toBe(SECRET_MASK);
    // The String parameter is public config: its real value is reported, and
    // the baseline side stays the RESOLVED value state stores for it.
    expect(
      changes.find((c) => c.path === 'Environment.Variables.SSM_PUBLIC')?.awsValue
    ).toBe('changed-in-console');
  });

  it('masks a secret nested in an ARRAY element, against the array path the comparator emits', async () => {
    // `calculateResourceDrift` compares arrays wholesale, so a secret at
    // `Tags[0].Value` surfaces as a drift on `Tags`. The secret-path walk has
    // to record it under that name or the mask misses it entirely.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Tags: [{ Key: 'secret', Value: SECRET_EXPR }] },
          observedProperties: { Tags: [{ Key: 'secret', Value: SECRET_EXPR }] },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Tags: [{ Key: 'secret', Value: 'rotated-away-tag-value' }],
      }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain('rotated-away-tag-value');
    expect(output).not.toContain(SECRET_PLAINTEXT);
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ path: string; awsValue: unknown }> }>;
    }>;
    expect(payload[0]!.drifted).toHaveLength(1);
    expect(payload[0]!.drifted[0]!.changes[0]!.path).toBe('Tags');
    expect(payload[0]!.drifted[0]!.changes[0]!.awsValue).toBe(SECRET_MASK);
  });

  it('masks a secret that arrives as an object KEY in the readback', async () => {
    // `redactSecretsForState` walks values and never object keys, so a readback
    // whose map is KEYED by a secret renders the plaintext straight into the
    // path segment of every printer. Masked here rather than assumed
    // impossible — and a masked path also marks the change secret-bearing, so
    // `--accept` will not write a key it can no longer name.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ [SECRET_PLAINTEXT]: 'anything' }),
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).not.toContain(SECRET_PLAINTEXT);
    expect(output).toContain(`Environment.Variables.${SECRET_MASK}`);
  });

  it('makes no SecretsManager call for a stack that references no secret', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Bucket: {
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
          observedProperties: { BucketName: 'b' },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ BucketName: 'b' }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
    expect(mockSecretsManagerSend).not.toHaveBeenCalled();
  });

  it('redacts the resolved plaintext out of the human drift REPORT', async () => {
    // A console-side copy of the secret into a second env var: the path drifts
    // for a real reason, and its AWS-current value IS the plaintext — so the
    // report has something to leak that the comparison fix alone cannot hide.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ COPY_OF_SECRET: SECRET_PLAINTEXT }),
    });

    const { output } = await runDrift(['TestStack']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output).toContain('drift detected');
    expect(output).toContain('Environment.Variables.COPY_OF_SECRET');
    // The drifted path is shown, but carrying the expression rather than the
    // value it resolves to.
    expect(output).toContain(SECRET_EXPR);
    expect(output).not.toContain(SECRET_PLAINTEXT);
    // The untouched secret env var is NOT phantom drift.
    expect(output).not.toContain('Environment.Variables.SECRET_PASSWORD');
  });

  it('redacts the resolved plaintext out of the --json drift REPORT', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ COPY_OF_SECRET: SECRET_PLAINTEXT }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(SECRET_PLAINTEXT);
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ path: string; awsValue: unknown }> }>;
    }>;
    // Guard before the index: without it a change that stops DETECTING drift
    // reds as `TypeError: cannot read '0' of undefined`, which reads as a
    // broken test rather than as the assertion this case is making.
    expect(payload[0]!.drifted).toHaveLength(1);
    const change = payload[0]!.drifted[0]!.changes.find(
      (c) => c.path === 'Environment.Variables.COPY_OF_SECRET'
    );
    expect(change?.awsValue).toBe(SECRET_EXPR);
  });

  // --- Defect 3: --accept --------------------------------------------------

  it('--accept persists the {{resolve:...}} expression, never the AWS-current plaintext', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ COPY_OF_SECRET: SECRET_PLAINTEXT }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    // Guarded before the index so a change that stops detecting drift reds on
    // THIS assertion rather than on a `TypeError` two lines down.
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    const observed = saved.resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    // The accepted key landed in state — the write is not a no-op — but holding
    // the expression the secret came from.
    expect(observed.Environment.Variables['COPY_OF_SECRET']).toBe(SECRET_EXPR);
    // ...and the pre-existing secret leaf was not disturbed.
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
  });

  it('--accept redacts a secret the OBSERVED baseline never captured', async () => {
    // Issue #1900's shape reached through the observed capture: the deploy-time
    // readback did not report the key, so nothing in the drift baseline holds
    // an expression for it and a baseline-only resolution learns no plaintext
    // — while the live readback returns the real secret. The record's own
    // `properties` still names the reference, which is what makes the value
    // knowable at all.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: lambdaResource({
          FunctionName: 'fn',
          Environment: { Variables: { PLAIN: 'ok' } },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({ readCurrentState: async () => awsEnv() });

    const { output } = await runDrift(['TestStack', '--accept', '--yes']);

    expect(output).not.toContain(SECRET_PLAINTEXT);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    const observed = saved.resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
  });

  it('--accept REFUSES a secret-bearing path whose AWS value it could not identify', async () => {
    // The value the report had to mask is not a value — it is the statement
    // that cdkd cannot say what AWS holds there. Persisting `***` would corrupt
    // the baseline and make the next deploy push the literal mask at AWS, so
    // the path is left as state has it and the user is told which one and why.
    // The drift keeps being reported, which is honest: `--revert` can fix it,
    // `--accept` cannot.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ SECRET_PASSWORD: 'tampered-in-the-console' }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    const observed = saved.resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
    expect(JSON.stringify(saved)).not.toContain(SECRET_MASK);
    expect(JSON.stringify(saved)).not.toContain('tampered-in-the-console');
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('not accepting') && c[0].includes('SECRET_PASSWORD')
      )
    ).toBe(true);
  });

  it('--accept still records the NON-secret paths in the same run', async () => {
    // The refusal is per-PATH, not per-resource: a resource carrying one
    // unidentifiable secret must not become un-acceptable in every other
    // respect, or the flag stops working the moment a stack holds a reference.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () =>
        awsEnv({ SECRET_PASSWORD: 'tampered-in-the-console', PLAIN: 'edited' }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls[0]![2].resources['Consumer']!
      .observedProperties as { Environment: { Variables: Record<string, unknown> } };
    expect(observed.Environment.Variables['PLAIN']).toBe('edited');
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
  });

  it('--accept re-redacts a plaintext an OLDER binary already wrote into the baseline', async () => {
    // The state a user has TODAY after running `cdkd drift --accept` on a
    // pre-fix binary: `observedProperties` holds the resolved secret while
    // `properties` still holds the expression. Accepting an UNRELATED key
    // re-persists that whole bag, so the plaintext round-trips unless the write
    // is redacted — and it is not reachable through `changes`, which is why
    // redacting the drift entries alone does not cover it.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: lambdaResource({
          FunctionName: 'fn',
          Environment: { Variables: { SECRET_PASSWORD: SECRET_PLAINTEXT, PLAIN: 'ok' } },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: 'edited-in-the-console' }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    const observed = saved.resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
    // The unrelated accept still happened — the redaction is not a veto.
    expect(observed.Environment.Variables['PLAIN']).toBe('edited-in-the-console');
  });

  it('--accept re-redacts a ROTATED-AWAY plaintext the secrets map cannot name', async () => {
    // The same pre-fix state, one rotation later: the stored plaintext is last
    // week's secret, so it is a key in NO map built by resolving the reference
    // today. Only the POSITION — `properties` holding the expression at that
    // leaf — can name it, which is what makes the positioned form of the
    // `--accept` redaction load-bearing rather than a duplicate of the value
    // scan.
    mockSecretsManagerSend.mockImplementation(async () => ({
      SecretString: JSON.stringify({ password: 'cdkd-rotated-in-pw-999' }),
    }));
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: lambdaResource({
          FunctionName: 'fn',
          Environment: { Variables: { SECRET_PASSWORD: SECRET_PLAINTEXT, PLAIN: 'ok' } },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        FunctionName: 'fn',
        Environment: {
          Variables: { SECRET_PASSWORD: SECRET_PLAINTEXT, PLAIN: 'edited-in-the-console' },
        },
      }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    const observed = saved.resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
  });

  // --- Defect 1: --revert --------------------------------------------------

  it('--revert hands provider.update the RESOLVED secret, not the literal expression', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ SECRET_PASSWORD: 'tampered-in-the-console' }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(sent.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_PLAINTEXT);
    expect(JSON.stringify(sent)).not.toContain('{{resolve:');
  });

  // Issue #1932 item 3. `--revert` is the THIRD caller that hands a provider a
  // bag re-resolved back to plaintext (the other two are the deploy engine and
  // the rollback executor), so it must offer the same masking capability or a
  // provider warning naming a mis-shaped property value prints the secret --
  // on the one command a user reaches for when something is already wrong.
  // The bag is provably plaintext here: the test above asserts exactly that.
  it('--revert hands provider.update a WORKING secret masker (issue #1932 item 3)', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ SECRET_PASSWORD: 'tampered-in-the-console' }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    const context = update.mock.calls[0]![5] as {
      desiredFromAwsReadback?: boolean;
      maskSecrets?: (text: string) => string;
    };
    expect(typeof context?.maskSecrets).toBe('function');
    // Bound to the bag THIS revert resolved into, not merely present: a masker
    // built from an empty map would satisfy a presence check and mask nothing,
    // which is the likeliest way this threading regresses.
    expect(context.maskSecrets!(`AWS rejected "${SECRET_PLAINTEXT}"`)).toBe(
      `AWS rejected "${SECRET_MASK}"`
    );
    expect(context.maskSecrets!('AWS rejected "PLAIN"')).toBe('AWS rejected "PLAIN"');
    // The masker rides ALONGSIDE the readback flag rather than replacing it --
    // dropping that flag would change which arm a provider takes on a revert.
    expect(context.desiredFromAwsReadback).toBe(true);
  });

  it('--revert does not persist the plaintext a provider echoes back in effectiveProperties', async () => {
    // A narrowing (#1644): the provider drops the env var it was not able to
    // deliver and echoes the rest — including the secret cdkd had just resolved
    // for it. That echo is WRITTEN to state, so it is a redaction site.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      effectiveProperties: {
        FunctionName: 'fn',
        Environment: { Variables: { SECRET_PASSWORD: SECRET_PLAINTEXT } },
      },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ SECRET_PASSWORD: 'tampered-in-the-console' }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    const observed = saved.resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    // The narrowing WAS recorded (PLAIN dropped) — otherwise the redaction
    // assertion above would hold vacuously.
    expect(observed.Environment.Variables['PLAIN']).toBeUndefined();
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
  });

  it('--revert records the narrowing against the baseline it RESOLVED, not against properties', async () => {
    // The two bags disagree at the secret leaf: `properties` names one
    // reference and the observed baseline (which is what a revert resolves and
    // sends) names another. Positioning the provider's echo against
    // `properties` writes the WRONG expression into state — the #1904
    // wrong-reference class on a write path, and the next deploy then pushes a
    // secret nobody asked for.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      effectiveProperties: {
        Environment: { Variables: { SECRET_PASSWORD: OTHER_PLAINTEXT } },
      },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Environment: { Variables: { SECRET_PASSWORD: SECRET_EXPR, PLAIN: 'ok' } } },
          observedProperties: {
            Environment: { Variables: { SECRET_PASSWORD: OTHER_EXPR, PLAIN: 'ok' } },
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { SECRET_PASSWORD: OTHER_PLAINTEXT, PLAIN: 'edited' } },
      }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls[0]![2].resources['Consumer']!
      .observedProperties as { Environment: { Variables: Record<string, unknown> } };
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(OTHER_EXPR);
    expect(JSON.stringify(mockSaveState.mock.calls[0]![2])).not.toContain(OTHER_PLAINTEXT);
  });

  it('the --revert PLAN masks a secret-carrying key in the PRESERVED-tag list', async () => {
    // The sibling of the unbaselined-key list, printed on the OTHER branch
    // (issue #1501, observed-capture baseline) and built from `awsProperties`
    // in the same way. Fencing only one of the two leaves the other free to
    // regress.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Tags: [{ Key: 'a', Value: SECRET_EXPR }] },
          observedProperties: { Tags: [{ Key: 'a', Value: SECRET_EXPR }] },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Tags: [
          { Key: 'a', Value: 'drifted' },
          { Key: `aws:${SECRET_PLAINTEXT}`, Value: 'service-authored' },
        ],
      }),
      update: vi.fn().mockResolvedValue({ physicalId: 'fn' }),
    });

    const { output } = await runDrift(['TestStack', '--revert', '--dry-run']);

    expect(output).not.toContain(SECRET_PLAINTEXT);
    // BOTH polarities of the withhold flag (the repo's "pin both polarities of
    // a threaded flag" rule): this resource resolves cleanly, so the #1501
    // pre-confirmation warning must still PRINT. Without this, hard-wiring the
    // predicate to "withhold" suppresses that advisory for every user, with CI
    // green.
    expect(output).toContain('reverting this tag list KEEPS');
    expect(output).toContain('ECS needs AmazonECSManaged');
    expect(output).not.toContain('withheld');
  });

  it('masks the AWS error text a failed revert reports', async () => {
    // The update payload carries the RESOLVED secret, and AWS routinely quotes
    // the offending property value back in a validation error. Same fence
    // `deploy-engine.ts` puts on its own provider calls.
    const update = vi
      .fn()
      .mockRejectedValue(
        new Error(`ValidationException: invalid value '${SECRET_PLAINTEXT}' for SECRET_PASSWORD`)
      );
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: 'edited' }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    const reported = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(reported).toContain('AWS update failed');
    expect(reported).not.toContain(SECRET_PLAINTEXT);
    expect(reported).toContain(SECRET_MASK);
  });

  it('--accept refuses a key it cannot NAME, and does not insert a `***` key', async () => {
    // The path half of the refusal, which the value check alone cannot reach:
    // `redactDriftValue` lets `undefined` through unmasked (an absent key
    // discloses nothing), so at a MASKED path with an absent AWS value
    // `setAtPath` would create a key literally named `***` rather than removing
    // the real one.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: lambdaResource({
          FunctionName: 'fn',
          Environment: { Variables: { [SECRET_PLAINTEXT]: 'was-here', PLAIN: 'ok' } },
        }),
      })
    );
    // AWS no longer has the secret-named key, so `awsValue` is `undefined`.
    mockRegistryGetProvider.mockReturnValue({ readCurrentState: async () => awsEnv() });

    const { output } = await runDrift(['TestStack', '--accept', '--yes']);

    // Nothing PRINTED carries the plaintext...
    expect(output).not.toContain(SECRET_PLAINTEXT);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    const observed = saved.resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    // ...no `***`-named key was invented...
    expect(Object.keys(observed.Environment.Variables)).not.toContain(SECRET_MASK);
    // ...and the pre-existing key is left exactly as state already had it.
    // NOTE the accepted limitation this pins: accepting would have REMOVED that
    // key (AWS no longer reports it), so refusing keeps a plaintext KEY in
    // state that a write could have cleared. Refusing is still the right side
    // of the trade — the alternative is inventing a `***` key — and no
    // redaction pass can help, since they all walk values and never keys.
    expect(Object.keys(observed.Environment.Variables)).toContain(SECRET_PLAINTEXT);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('cannot name the key')
      )
    ).toBe(true);
  });

  it('--accept --dry-run prints the SAME refusal the real run will make', async () => {
    // A plan that promises a write the run refuses is worse than either
    // behaviour on its own, so both ask one predicate.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ SECRET_PASSWORD: 'tampered-in-the-console' }),
    });

    const { output } = await runDrift(['TestStack', '--accept', '--dry-run']);

    expect(output).toContain('Environment.Variables.SECRET_PASSWORD: SKIPPED');
    expect(output).not.toContain('tampered-in-the-console');
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('the --revert PLAN masks an AWS-authored key that carries a secret', async () => {
    // `findRevertUnbaselinedAwsKeys` builds its path names straight from
    // `awsProperties`, the one bag on this path deliberately left unredacted —
    // so the secret-as-object-key case leaks through the plan rather than
    // through the diff lines.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          // No observedProperties: that is what puts `--revert` on the
          // raw-TEMPLATE baseline and makes the plan print the unbaselined-key
          // block at all (issue #1626).
          properties: { Environment: { Variables: { SECRET_PASSWORD: SECRET_EXPR } } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { SECRET_PASSWORD: 'tampered', [SECRET_PLAINTEXT]: 'v' } },
      }),
      update: vi.fn().mockResolvedValue({ physicalId: 'fn' }),
    });

    const { output } = await runDrift(['TestStack', '--revert', '--dry-run']);

    expect(output).not.toContain(SECRET_PLAINTEXT);
  });

  it('--accept does not descend arrays positionally when redacting the persisted bag', async () => {
    // `STATE_SOURCED_READBACK_RULES` turns array descent OFF because the bag is
    // an AWS readback and AWS does not preserve list order. With it ON, these
    // two REVERSED lists line up index-for-index and each element is persisted
    // holding the OTHER reference's expression — the #1904 wrong-reference
    // class, arriving through the accept write.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: {
            Tags: [{ Value: SECRET_EXPR }, { Value: OTHER_EXPR }],
            Timeout: 3,
          },
          // Pre-fix shape (plaintext), and in the OPPOSITE order.
          observedProperties: {
            Tags: [{ Value: OTHER_PLAINTEXT }, { Value: SECRET_PLAINTEXT }],
            Timeout: 3,
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Tags: [{ Value: OTHER_PLAINTEXT }, { Value: SECRET_PLAINTEXT }],
        Timeout: 10,
      }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    const observed = saved.resources['Consumer']!.observedProperties as {
      Tags: Array<{ Value: string }>;
      Timeout: number;
    };
    // Each element keeps ITS OWN expression, matched by value, not by index.
    expect(observed.Tags[0]!.Value).toBe(OTHER_EXPR);
    expect(observed.Tags[1]!.Value).toBe(SECRET_EXPR);
    // ...and the unrelated accept still happened.
    expect(observed.Timeout).toBe(10);
  });

  it('--revert positions the narrowing on a value the secrets map cannot name', async () => {
    // The provider echoes a value that is neither what cdkd sent nor anything
    // in the map — the rotated-away class on the narrowing path. Only the
    // POSITION (the resolved baseline holding the expression at that leaf) can
    // name it; a value scan persists the stale string verbatim.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      effectiveProperties: {
        Environment: { Variables: { SECRET_PASSWORD: 'stale-echo-not-in-the-map' } },
      },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: 'edited' }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls[0]![2].resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
    expect(JSON.stringify(mockSaveState.mock.calls[0]![2])).not.toContain(
      'stale-echo-not-in-the-map'
    );
  });

  it('--revert does not descend arrays positionally when redacting the narrowing', async () => {
    // The narrowing delta descends from `buildRevertNewProperties`'s merge with
    // the AWS-CURRENT snapshot, so a top-level key that did not drift comes
    // back from AWS and may be REORDERED. `STATE_DERIVED_RULES` (what the
    // rollback executor uses on its own echo, where the whole bag really was
    // produced by resolving the source) would line these two equal-length lists
    // up index-for-index and persist each element holding the OTHER
    // reference's expression.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      // Reordered relative to the baseline, which is exactly what an AWS
      // readback is entitled to do.
      effectiveProperties: {
        Tags: [{ Value: OTHER_PLAINTEXT }, { Value: SECRET_PLAINTEXT }],
      },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Tags: [{ Value: SECRET_EXPR }, { Value: OTHER_EXPR }] },
          observedProperties: { Tags: [{ Value: SECRET_EXPR }, { Value: OTHER_EXPR }] },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Tags: [{ Value: 'drifted-a' }, { Value: 'drifted-b' }] }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls[0]![2].resources['Consumer']!
      .observedProperties as { Tags: Array<{ Value: string }> };
    // Each element keeps ITS OWN expression, matched by value rather than index.
    expect(observed.Tags[0]!.Value).toBe(OTHER_EXPR);
    expect(observed.Tags[1]!.Value).toBe(SECRET_EXPR);
  });

  it('masks the AWS error text of an update-not-supported revert', async () => {
    const err = new ResourceUpdateNotSupportedError(
      LAMBDA_TYPE,
      'Consumer',
      `the current value '${SECRET_PLAINTEXT}' is immutable`
    );
    const update = vi.fn().mockRejectedValue(err);
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: 'edited' }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('could not revert');
    expect(warned).not.toContain(SECRET_PLAINTEXT);
    expect(warned).toContain(SECRET_MASK);
  });

  it('does not mark a PUBLIC reference secret-bearing on a sub-threshold substring match', async () => {
    // `carriesRecordedSecret`'s substring branch applies the same 4-character
    // needle floor `redactSecretsForState` uses when it builds needles, and
    // this is what the floor buys. A secret resolving to `ok` is recorded
    // first; the PUBLIC ssm reference beside it then resolves to a value that
    // merely CONTAINS those two characters. Without the floor that public path
    // is marked secret-bearing, so its real value is masked out of the report
    // and `--accept` refuses it — for a plaintext `redactSecretsForState` would
    // not have substituted anyway, since its own needle builder skips it.
    mockSecretsManagerSend.mockImplementation(async () => ({
      SecretString: JSON.stringify({ password: 'ok' }),
    }));
    mockSsmSend.mockImplementation(async () => ({
      Parameter: { Value: 'looks ok here', Type: 'String' },
    }));
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          // TINY first: the secret must be in the map before the public
          // reference resolves, or there is nothing for it to collide with.
          properties: {
            Environment: { Variables: { TINY: SECRET_EXPR, PUB: PUBLIC_SSM_EXPR } },
          },
          observedProperties: {
            Environment: { Variables: { TINY: SECRET_EXPR, PUB: PUBLIC_SSM_EXPR } },
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { TINY: 'ok', PUB: 'looks ok here EDITED' } },
      }),
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('looks ok here EDITED');
    expect(output).not.toContain(SECRET_MASK);
  });

  it('--revert completes its secrets map from `properties`, not only from the baseline', async () => {
    // The narrowing echo carries a secret the OBSERVED baseline never captured,
    // so the position source (that same baseline) has no leaf to copy and the
    // redaction falls to the value scan — which only knows the plaintext
    // because `properties` were resolved into the map as well.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      effectiveProperties: {
        Environment: { Variables: { PLAIN: 'ok', SECRET_PASSWORD: SECRET_PLAINTEXT } },
      },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: {
            Environment: { Variables: { SECRET_PASSWORD: SECRET_EXPR, PLAIN: 'ok' } },
          },
          observedProperties: { Environment: { Variables: { PLAIN: 'ok' } } },
          },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Environment: { Variables: { PLAIN: 'edited' } } }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
    const observed = saved.resources['Consumer']!.observedProperties as {
      Environment: { Variables: Record<string, unknown> };
    };
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
  });

  it('does not report — or ERASE — a write-only credential AWS never returns', async () => {
    // A record with no `observedProperties` (pre-v3 state, or an import whose
    // observed capture was swallowed) whose `properties` hold a templated
    // credential. RDS / DocDB / Neptune / ElastiCache / Cognito declare no
    // `getDriftUnknownPaths`, so nothing suppresses the path — and no readback
    // returns a write-only password, so `awsValue` is absent.
    //
    // Before the fix this was three bugs at once, all introduced by resolving
    // the baseline: `calculateResourceDrift`'s `{{resolve:` skip stopped firing
    // (the state side is no longer a token), so drift was reported forever;
    // `--accept` wrote `undefined`, which `setAtPath` turns into a DELETED key,
    // erasing the reference from `properties`; and `--revert` re-pushed the
    // credential on every run.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceClass: 'db.t3.micro', MasterUserPassword: SECRET_EXPR },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // The readback simply has no MasterUserPassword.
      readCurrentState: async () => ({ DBInstanceClass: 'db.t3.micro' }),
    });

    const { output, error } = await runDrift(['TestStack']);

    expect(error).toBeUndefined();
    expect(output).toContain('no drift detected');
    expect(output).not.toContain('MasterUserPassword');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports the same write-only credential as CLEAN in --json', async () => {
    // The `--json` side of the clean arm. The human report pins it above, but
    // the machine payload is what CI gates on, and deciding clean/drifted on
    // the RAW change list produced `drifted: [{changes: []}]` there — a
    // consumer counting drifted entries would gate on a resource with nothing
    // wrong with it.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceClass: 'db.t3.micro', MasterUserPassword: SECRET_EXPR },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ DBInstanceClass: 'db.t3.micro' }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    const payload = JSON.parse(output) as Array<{
      drifted: unknown[];
      clean: Array<{ logicalId: string }>;
    }>;
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.clean.map((c) => c.logicalId)).toContain('Db');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('REPORTS a whole subtree vanishing from AWS, rather than dropping it as unreadable', async () => {
    // `isSecretBearingPath` matches ANCESTORS on purpose, so the drop had to be
    // narrowed to an EXACT leaf: the console's "remove all environment
    // variables" makes the readback return no `Environment` at all, and that is
    // exactly the drift a user wants to see. Pre-#1914 it WAS reported, because
    // the `{{resolve:` skip only ever covered leaf strings — so "restores the
    // pre-PR behaviour" is only true at leaf granularity.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ FunctionName: 'fn' }),
    });

    const { output } = await runDrift(['TestStack']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output).toContain('Environment');
    expect(output).not.toContain(SECRET_PLAINTEXT);
  });

  it('--accept REFUSES a vanished subtree rather than deleting the reference with it', async () => {
    // Reported, but not acceptable: `setAtPath(bag, path, undefined)` deletes
    // the key, which at or above a secret position erases the
    // `{{resolve:...}}` reference out of `properties`. That is blocker 1's
    // erasure arriving through the ancestor path instead of the leaf.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ FunctionName: 'fn' }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls[0]![2].resources['Consumer']!
      .observedProperties as { Environment: { Variables: Record<string, unknown> } };
    expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('accepting an absence DELETES')
      )
    ).toBe(true);
  });

  it('--accept does not erase a write-only credential reference from state', async () => {
    // The write half of the same shape: an UNRELATED key drifts, so `--accept`
    // runs and rewrites the whole bag. The reference must survive it.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceClass: 'db.t3.micro', MasterUserPassword: SECRET_EXPR },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ DBInstanceClass: 'db.t3.small' }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = mockSaveState.mock.calls[0]![2];
    const props = saved.resources['Db']!.properties;
    expect(props['MasterUserPassword']).toBe(SECRET_EXPR);
    expect(props['DBInstanceClass']).toBe('db.t3.small');
    expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
  });

  it('--revert registers the live value it pins, so an ARRAY-nested one never reaches state', async () => {
    // `preserveLiveValuesAtUnresolvedTokens` deliberately moves the LIVE
    // plaintext into the bag being sent — and `secrets` is empty by
    // construction on this path, since nothing was recorded. Unless the moved
    // value is registered, the narrowing delta's `descendArrays: false` rules
    // cannot position an array-nested leaf and the (empty) value scan cannot
    // find it, so it lands in `state.json`. ECS
    // `ContainerDefinitions[].Environment[]` is the shape.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'td',
      effectiveProperties: {
        // A NARROWING: the provider dropped `Name` while echoing the rest, so
        // this subtree differs from what was sent and therefore lands in the
        // #1644 delta — with the pinned plaintext still in it. Echoing the sent
        // bag verbatim would make the whole case vacuous, since
        // `collectNarrowedTopLevelKeys` only reports keys that CHANGED.
        ContainerDefinitions: [{ Environment: [{ Name: 'DB', Value: SECURE_PLAINTEXT }] }],
        Cpu: '512',
      },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'td',
          resourceType: 'AWS::ECS::TaskDefinition',
          properties: {
            ContainerDefinitions: [
              { Name: 'app', Environment: [{ Name: 'DB', Value: UNSUPPORTED_EXPR }] },
            ],
            Cpu: '256',
          },
          observedProperties: {
            ContainerDefinitions: [
              { Name: 'app', Environment: [{ Name: 'DB', Value: UNSUPPORTED_EXPR }] },
            ],
            Cpu: '256',
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        ContainerDefinitions: [
          { Name: 'app', Environment: [{ Name: 'DB', Value: SECURE_PLAINTEXT }] },
        ],
        Cpu: '1024',
      }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    // The live value really was pinned into the payload — otherwise the
    // registration this test is about would have nothing to register.
    const sent = update.mock.calls[0]![3] as {
      ContainerDefinitions: Array<{ Environment: Array<{ Value: string }> }>;
    };
    expect(sent.ContainerDefinitions[0]!.Environment[0]!.Value).toBe(SECURE_PLAINTEXT);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockSaveState.mock.calls[0]![2])).not.toContain(SECURE_PLAINTEXT);
  });

  it('--revert does not register a MIXED leaf, whose send string carries resolved plaintext', async () => {
    // The send leaf at a mixed position is already PARTIALLY resolved — the
    // secretsmanager half became its plaintext before the ssm-secure half was
    // left standing. Registering the whole leaf as the replacement expression
    // would substitute THAT into state: the GHSA class, through the mechanism
    // that exists to prevent it.
    //
    // The ssm-secure token comes FIRST on purpose: with it second,
    // `isSecretBySpelling` blocks the leaf on its own and this case cannot tell
    // the two guards apart — which is what a mutation probe showed about the
    // first version of it.
    const mixed = UNSUPPORTED_EXPR + ':' + SECRET_EXPR;
    const liveDsn = SECURE_PLAINTEXT + ':' + SECRET_PLAINTEXT;
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      effectiveProperties: { Env: { DSN: liveDsn, LEVEL: 'x' } },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Env: { DSN: mixed, LEVEL: 'info' } },
          observedProperties: { Env: { DSN: mixed, LEVEL: 'info' } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Env: { DSN: liveDsn, LEVEL: 'debug' } }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const saved = JSON.stringify(mockSaveState.mock.calls[0]![2]);
    // The secretsmanager half must not land in state. Registering the send leaf
    // whole would put it there verbatim, because that leaf IS the substitution
    // `redactSecretsForState` writes in.
    expect(saved).not.toContain(SECRET_PLAINTEXT);
    // The PAYLOAD no longer carries the ssm-secure half either — the
    // whole-token preservation gate declines to copy the live value into a
    // mixed leaf, so the mechanism cannot create an exposure it is unable to
    // mask.
    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as { Env: Record<string, unknown> };
    expect(String(sent.Env['DSN'])).not.toContain(SECURE_PLAINTEXT);
    expect(String(sent.Env['DSN'])).toContain(UNSUPPORTED_EXPR);
    // Deliberately NOT asserted on `saved`: the ssm-secure plaintext still
    // reaches state here, by a route that is NOT this mechanism — the provider
    // echoed its own readback in `effectiveProperties`, and the #1644 narrowing
    // persists that. cdkd cannot mask a value for a reference it never
    // resolved, so no pass covers it; before this PR that delta was persisted
    // with no redaction at all. See the note in `runRevert` and
    // docs/cli-reference.md.
  });

  it('does not carry an unresolvable reference plaintext into the payload OR the logs', async () => {
    // The two surfaces the preservation gate does close, kept apart from the
    // provider-echo route above so a regression in either is attributable.
    const update = vi
      .fn()
      .mockRejectedValue(new Error('ValidationException: rejected the DSN value'));
    const mixed2 = UNSUPPORTED_EXPR + ':' + SECRET_EXPR;
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Env: { DSN: mixed2, LEVEL: 'info' } },
          observedProperties: { Env: { DSN: mixed2, LEVEL: 'info' } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Env: { DSN: SECURE_PLAINTEXT + ':' + SECRET_PLAINTEXT, LEVEL: 'debug' },
      }),
      update,
    });

    const { output } = await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as { Env: Record<string, unknown> };
    expect(String(sent.Env['DSN'])).not.toContain(SECURE_PLAINTEXT);
    expect(output).not.toContain(SECURE_PLAINTEXT);
  });

  it('--revert does not make a NEEDLE out of a short live value', async () => {
    // `redactSecretsForState`'s whole-value branch matches at any length, so a
    // sub-floor live value registered here rewrites every unrelated delta leaf
    // equal to it into this token — the #1904 wrong-reference corruption, after
    // which the next deploy ships the literal token to AWS.
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      effectiveProperties: { Env: { DB: 'ok', LEVEL: 'ok' } },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Env: { DB: UNSUPPORTED_EXPR, LEVEL: 'info' } },
          observedProperties: { Env: { DB: UNSUPPORTED_EXPR, LEVEL: 'info' } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // The live value at the token position is 2 characters, and an unrelated
      // sibling happens to equal it.
      readCurrentState: async () => ({ Env: { DB: 'ok', LEVEL: 'debug' } }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls[0]![2].resources['Consumer']!
      .observedProperties as { Env: Record<string, unknown> };
    // The unrelated sibling keeps its own value instead of being rewritten to
    // the token.
    expect(observed.Env['LEVEL']).toBe('ok');
  });

  it('--revert does not register a live value for a look-alike spelling', async () => {
    // `isSecretBySpelling` declares these non-secret one function up;
    // registering their live values here would contradict that in the same
    // round, turning ordinary data into a redaction needle.
    const ODD = '{{resolve:notaservice:/x}}';
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      effectiveProperties: { Env: { DB: 'ordinary-live-value', LEVEL: 'ordinary-live-value' } },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Env: { DB: ODD, LEVEL: 'info' } },
          observedProperties: { Env: { DB: ODD, LEVEL: 'info' } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Env: { DB: 'ordinary-live-value', LEVEL: 'debug' },
      }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls[0]![2].resources['Consumer']!
      .observedProperties as { Env: Record<string, unknown> };
    expect(observed.Env['LEVEL']).toBe('ordinary-live-value');
  });

  it('--revert masks a pinned live value out of the AWS error text', async () => {
    // Consequence A of the same gap: the payload now carries a plaintext the
    // secrets map never knew about, so the error mask was a no-op — the leak
    // fixed at four sites, reopened through a fifth door.
    const update = vi
      .fn()
      .mockRejectedValue(new Error(`ValidationException: bad value '${SECURE_PLAINTEXT}'`));
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'td',
          resourceType: 'AWS::ECS::TaskDefinition',
          properties: { Env: { DB: UNSUPPORTED_EXPR, LEVEL: 'info' } },
          observedProperties: { Env: { DB: UNSUPPORTED_EXPR, LEVEL: 'info' } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Env: { DB: SECURE_PLAINTEXT, LEVEL: 'debug' } }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    const reported = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(reported).toContain('AWS update failed');
    expect(reported).not.toContain(SECURE_PLAINTEXT);
    expect(reported).toContain(SECRET_MASK);
  });

  it('does not treat an arbitrary unsupported spelling as a secret', async () => {
    // Only `ssm-secure` is a secret by definition. Text that merely LOOKS like
    // a reference must keep its real values, or the path is masked, refused by
    // `--accept`, pinned by the revert, and permanently stuck with no remedy.
    const ODD = '{{resolve:notaservice:/x}}';
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Tags: [{ Key: 'k', Value: ODD }] },
          observedProperties: { Tags: [{ Key: 'k', Value: ODD }] },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Tags: [{ Key: 'k', Value: 'plain-edit' }] }),
    });

    const { output } = await runDrift(['TestStack']);

    expect(output).toContain('plain-edit');
    expect(output).not.toContain(SECRET_MASK);
  });

  it('withholds the revert plan key lists when ONE reference of several was unresolvable', async () => {
    // `o.secrets.size === 0` is the wrong question: this resource has a
    // resolvable secretsmanager reference (non-empty map) AND an `ssm-secure`
    // survivor, so the map exists but cannot answer for the survivor's
    // position.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: {
            Secret: SECRET_EXPR,
            Secure: UNSUPPORTED_EXPR,
            Tags: [{ Key: 'a', Value: 'x' }],
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Secret: SECRET_PLAINTEXT,
        Secure: SECURE_PLAINTEXT,
        Tags: [
          { Key: 'a', Value: 'drifted' },
          { Key: 'aws:cloudformation:managed', Value: 'service' },
          // An ordinary AWS-authored key the template never declared, so the
          // plan's UNBASELINED block has something to say too — its withhold is
          // a separate branch from the preserved-tag one.
          { Key: 'extra', Value: 'authored-by-aws' },
        ],
      }),
      update: vi.fn().mockResolvedValue({ physicalId: 'fn' }),
    });

    const { output } = await runDrift(['TestStack', '--revert', '--dry-run']);

    // The withheld NOTE replaces the detail list. (The drift diff line above it
    // still prints the whole `Tags` array, which is a different surface: that
    // value is masked by `redactDriftChanges` when the map can answer, and this
    // resource's map — non-empty, but built solely from the RESOLVABLE
    // reference — has no entry for the ssm-secure one. That is the residual
    // named in the code, not something the plan's withhold claims to fix.)
    expect(output).toContain('withheld');
    expect(output).not.toContain('reverting this tag list KEEPS');
    // The unbaselined block withholds too, rather than being skipped silently:
    // its note replaces the normal detail header and the path list under it.
    // (The drift diff line above still prints the whole `Tags` array — the same
    // separate, map-dependent surface noted above.)
    expect(output).toContain('will be left untouched');
    expect(output).not.toContain('has no observed-capture baseline');
  });

  it('MASKS a value at a path whose reference cdkd cannot resolve', async () => {
    // The blocker round 3 opened. Downgrading the survivor from a throw to a
    // warning moved this input off the offline-seed path onto the PROVEN one,
    // where nothing marks it — so the position went unmasked. The shape is a
    // CFn-migrated record: CloudFormation resolves `ssm-secure` SERVER-side, so
    // AWS holds the plaintext while state holds the literal token, and
    // `diffAt` never descends arrays, so the whole array lands as `awsValue`.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'td',
          resourceType: 'AWS::ECS::TaskDefinition',
          properties: { Secrets: [{ Name: 'DB', ValueFrom: UNSUPPORTED_EXPR }] },
          observedProperties: { Secrets: [{ Name: 'DB', ValueFrom: UNSUPPORTED_EXPR }] },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Secrets: [{ Name: 'DB', ValueFrom: SECURE_PLAINTEXT }] }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(SECURE_PLAINTEXT);
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ path: string; awsValue: unknown }> }>;
    }>;
    expect(payload[0]!.drifted).toHaveLength(1);
    expect(payload[0]!.drifted[0]!.changes[0]!.path).toBe('Secrets');
    expect(payload[0]!.drifted[0]!.changes[0]!.awsValue).toBe(SECRET_MASK);
  });

  it('--revert leaves the LIVE value alone at a reference cdkd cannot resolve', async () => {
    // The other half of the same blocker, and a live-AWS destructive write. On
    // a CFn-migrated record the state token is NOT what AWS holds, so the
    // round-3 "replaying it is a no-op" premise is false: a revert triggered by
    // a SIBLING key overlays the whole top-level subtree and would push the
    // literal token over the resolved secret.
    const update = vi.fn().mockResolvedValue({ physicalId: 'td' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'td',
          resourceType: 'AWS::ECS::TaskDefinition',
          properties: {
            Env: { DB: UNSUPPORTED_EXPR, LEVEL: 'info' },
          },
          observedProperties: {
            Env: { DB: UNSUPPORTED_EXPR, LEVEL: 'info' },
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      // AWS holds the RESOLVED value (CloudFormation put it there), and a
      // sibling key drifted so the subtree is overlaid.
      readCurrentState: async () => ({ Env: { DB: SECURE_PLAINTEXT, LEVEL: 'debug' } }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as { Env: Record<string, unknown> };
    // The live value survives; only the genuinely drifted sibling is reverted.
    expect(sent.Env['DB']).toBe(SECURE_PLAINTEXT);
    expect(sent.Env['LEVEL']).toBe('info');
  });

  it('--revert still sends the literal where AWS has nothing at that position', async () => {
    // The residual, and it is what keeps a cdkd-DEPLOYED record behaving as it
    // did: with no live value to preserve, the token is what `cdkd deploy`
    // sends and therefore the right thing to send.
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Env: { DB: UNSUPPORTED_EXPR, LEVEL: 'info' } },
          observedProperties: { Env: { DB: UNSUPPORTED_EXPR, LEVEL: 'info' } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Env: { LEVEL: 'debug' } }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as { Env: Record<string, unknown> };
    expect(sent.Env['DB']).toBe(UNSUPPORTED_EXPR);
  });

  it('does not report a `{{resolve:...}}`-shaped substring of a resolved SECRET as unresolved', async () => {
    // `survivingDynamicReferences` scans the RESOLVED string, so a secret whose
    // plaintext happens to look like a reference would be echoed by the very
    // warning that exists to avoid printing values. Only tokens present in the
    // INPUT are reported.
    const SHAPED = '{{resolve:ssm-secure:/not/a/real/reference}}';
    mockSecretsManagerSend.mockImplementation(async () => ({
      SecretString: JSON.stringify({ password: SHAPED }),
    }));
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ SECRET_PASSWORD: SHAPED, PLAIN: 'edited' }),
    });

    await runDrift(['TestStack']);

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).not.toContain('cannot resolve');
    expect(warned).not.toContain(SHAPED);
  });

  it('reports a token containing `{`, which the RESOLVER matches', async () => {
    // The two regexes must agree. `intrinsic-function-resolver.ts` scans with
    // `[^}]+`, so `{{resolve:ssm-secure:/a{b}}` IS a token to it — it tries the
    // reference, warns, and leaves the literal. Scanning with `[^{}]*` here
    // would miss it, so nothing marks the path and nothing reports it: the
    // warning is lost AND the live plaintext at that position goes unmasked.
    //
    // Held inside an ARRAY for the same reason the ECS case above is: a leaf
    // whose state side is still a token is skipped by the comparator, so the
    // only way the value reaches a report at all is a drift reported at the
    // array that contains it.
    const BRACED = '{{resolve:ssm-secure:/a{b}}';
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Task: {
          physicalId: 'td',
          resourceType: 'AWS::ECS::TaskDefinition',
          properties: { Secrets: [{ Name: 'DB', ValueFrom: BRACED }] },
          observedProperties: { Secrets: [{ Name: 'DB', ValueFrom: BRACED }] },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ Secrets: [{ Name: 'DB', ValueFrom: SECURE_PLAINTEXT }] }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(SECURE_PLAINTEXT);
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ awsValue: unknown }> }>;
    }>;
    expect(payload[0]!.drifted).toHaveLength(1);
    expect(payload[0]!.drifted[0]!.changes[0]!.awsValue).toBe(SECRET_MASK);
    expect(
      warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes(BRACED))
    ).toBe(true);
  });

  it('marks a secret-bearing path from the BASELINE resolve alone', async () => {
    // A record with no `observedProperties` skips the `properties` pass
    // entirely, so the baseline resolve is the ONLY `secretPaths` source. A
    // rotated value at that path must still be masked.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Environment: { Variables: { SECRET_PASSWORD: SECRET_EXPR } } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { SECRET_PASSWORD: 'cdkd-previous-pw-000' } },
      }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain('cdkd-previous-pw-000');
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ awsValue: unknown }> }>;
    }>;
    expect(payload[0]!.drifted).toHaveLength(1);
    expect(payload[0]!.drifted[0]!.changes[0]!.awsValue).toBe(SECRET_MASK);
  });

  it('marks a path whose leaf merely EMBEDS a secret above the needle floor', async () => {
    // The POSITIVE direction of `carriesRecordedSecret`'s substring branch,
    // which the over-marking case cannot reach: an `Fn::Sub`-shaped leaf whose
    // resolved value CONTAINS the secret rather than equalling it.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Environment: { Variables: { DSN: `postgres://u:${SECRET_EXPR}@h/db` } } },
          observedProperties: {
            Environment: { Variables: { DSN: `postgres://u:${SECRET_EXPR}@h/db` } },
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { DSN: 'postgres://u:cdkd-previous-pw-000@h/db' } },
      }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain('cdkd-previous-pw-000');
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ awsValue: unknown }> }>;
    }>;
    expect(payload[0]!.drifted).toHaveLength(1);
    expect(payload[0]!.drifted[0]!.changes[0]!.awsValue).toBe(SECRET_MASK);
  });

  it('does not refuse a legitimate `***` value at a path with no secret', async () => {
    // The refusal is keyed on the set of paths the redaction actually masked,
    // not on comparing the value to `SECRET_MASK` — otherwise a property whose
    // real value IS `***` is refused forever for no reason.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: SECRET_MASK }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    const observed = mockSaveState.mock.calls[0]![2].resources['Consumer']!
      .observedProperties as { Environment: { Variables: Record<string, unknown> } };
    expect(observed.Environment.Variables['PLAIN']).toBe(SECRET_MASK);
  });

  it('warns when an accepted value is overwritten by an unresolved reference in state', async () => {
    // A PUBLIC `{{resolve:ssm:...}}` can sit in `properties` (the `cdkd import`
    // warn path), so that path is not secret-bearing and the change IS
    // accepted — and then `trustAnyExpression` copies the source expression
    // straight over it. Silent permanent no-op unless the write is checked.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Environment: { Variables: { PUB: PUBLIC_SSM_EXPR } } },
          observedProperties: { Environment: { Variables: { PUB: PUBLIC_SSM_VALUE } } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { PUB: 'changed-in-console' } },
      }),
    });

    await runDrift(['TestStack', '--accept', '--yes']);

    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('was NOT recorded')
      )
    ).toBe(true);
  });

  it('masks the AWS error text of an effectiveProperties read failure', async () => {
    const update = vi.fn().mockResolvedValue({
      physicalId: 'fn',
      get effectiveProperties(): Record<string, unknown> {
        throw new Error(`could not serialise value '${SECRET_PLAINTEXT}'`);
      },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: 'edited' }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('effective properties could not be read');
    expect(warned).not.toContain(SECRET_PLAINTEXT);
    expect(warned).toContain(SECRET_MASK);
  });

  it('masks the retry logger, which echoes the failing call verbatim', async () => {
    // `withRetry`'s debug channel prints the AWS error on every attempt, and
    // the payload it describes carries resolved secrets. Fenced separately from
    // the final error report, which is a different call site.
    // Retryable on purpose: `withRetry` logs its "Retrying ..." line only when
    // it is actually going to retry, and that line is what carries the AWS
    // message.
    const throttled = Object.assign(
      new Error(`Rate exceeded while setting '${SECRET_PLAINTEXT}'`),
      { name: 'ThrottlingException' }
    );
    const update = vi.fn().mockRejectedValue(throttled);
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: 'edited' }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    const debugged = debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugged).toContain('Retrying');
    expect(debugged).not.toContain(SECRET_PLAINTEXT);
    expect(debugged).toContain(SECRET_MASK);
  }, 60000);

  it('masks a VALUE at a path whose name carries a secret', async () => {
    // `nameCarriesSecret` feeds `secretBearing`, not just `maskedPaths`: a
    // readback keyed BY a secret must have its VALUE masked too, or the entry
    // reads `Environment.Variables.***: <real value>` and the pairing tells the
    // reader which key it was.
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ [SECRET_PLAINTEXT]: 'value-under-a-secret-key' }),
    });

    const { output } = await runDrift(['TestStack', '--json']);

    expect(output).not.toContain(SECRET_PLAINTEXT);
    expect(output).not.toContain('value-under-a-secret-key');
  });

  it('reports a revert it cannot perform, rather than silently skipping it', async () => {
    // `buildRevertNewProperties` keys its overlay on the TOP-LEVEL segment, so
    // a path whose first segment is the mask matches nothing and the subtree is
    // never reverted — while the plan promised it and `--accept` pointed here.
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: lambdaResource({
          FunctionName: 'fn',
          [SECRET_PLAINTEXT]: { Nested: 'v' },
        }),
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({ FunctionName: 'fn', [SECRET_PLAINTEXT]: { Nested: 'w' } }),
      update,
    });

    const { output } = await runDrift(['TestStack', '--revert', '--yes']);

    expect(output).not.toContain(SECRET_PLAINTEXT);
    expect(
      warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('cannot revert'))
    ).toBe(true);
  });

  it('counts an unresolvable reference apart from an AWS update failure', async () => {
    mockSecretsManagerSend.mockImplementation(async () => {
      throw new Error('AccessDeniedException: not authorized');
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => awsEnv({ PLAIN: 'edited' }),
      update: vi.fn(),
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    // The PartialFailureError goes through the shared handler, which logs and
    // then exits — so the message is on the error logger, not on the throw.
    const reported = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(reported).toContain('0 AWS update failure(s)');
    expect(reported).toContain('1 whose dynamic reference(s) could not be resolved');
  });

  it('--revert replays an unresolvable token as the LITERAL it was deployed as, and warns', async () => {
    // `ssm-secure:` hits the resolver's unsupported-service arm, which warns
    // and returns the literal — and `cdkd deploy` resolves through that same
    // arm, so AWS is ALREADY holding the literal token and state records it.
    // Replaying it is a correct no-op. Failing the resource over it would
    // abandon every other drifted property on it and exit 2 over nothing.
    const update = vi.fn().mockResolvedValue({ physicalId: 'fn' });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: {
            Environment: { Variables: { SECURE: UNSUPPORTED_EXPR, PLAIN: 'ok' } },
          },
          observedProperties: {
            Environment: { Variables: { SECURE: UNSUPPORTED_EXPR, PLAIN: 'ok' } },
          },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { SECURE: UNSUPPORTED_EXPR, PLAIN: 'edited' } },
      }),
      update,
    });

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as { Environment: { Variables: Record<string, unknown> } };
    expect(sent.Environment.Variables['SECURE']).toBe(UNSUPPORTED_EXPR);
    expect(sent.Environment.Variables['PLAIN']).toBe('ok');
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          // The REVERT-side warning specifically. The detection-side one names
          // the same token, so a grep for the token alone is satisfied by
          // either and the revert message could be deleted with the suite
          // still green.
          typeof c[0] === 'string' && c[0].includes('[revert]') && c[0].includes(UNSUPPORTED_EXPR)
      )
    ).toBe(true);
  });

  it('never prints a DECRYPTED sibling token when reporting an unresolvable one', async () => {
    // `resolveDynamicReferences` substitutes token by token, so a leaf holding
    // BOTH a secretsmanager reference and an unsupported one comes back with
    // the first already replaced by its plaintext. Naming the leaf in the
    // warning would print that secret — from the command whose purpose is not
    // to. Only the surviving TOKENS may be named; a token is a reference name.
    const mixed = `postgres://u:${SECRET_EXPR}@h/${UNSUPPORTED_EXPR}`;
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(
      makeState({
        Consumer: {
          physicalId: 'fn',
          resourceType: LAMBDA_TYPE,
          properties: { Environment: { Variables: { DSN: mixed, PLAIN: 'ok' } } },
          observedProperties: { Environment: { Variables: { DSN: mixed, PLAIN: 'ok' } } },
        },
      })
    );
    mockRegistryGetProvider.mockReturnValue({
      readCurrentState: async () => ({
        Environment: { Variables: { DSN: mixed, PLAIN: 'edited' } },
      }),
    });

    const { output } = await runDrift(['TestStack']);

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain(UNSUPPORTED_EXPR);
    expect(warned).not.toContain(SECRET_PLAINTEXT);
    expect(output).not.toContain(SECRET_PLAINTEXT);
  });

  // --- Resolution failure: warn per resource, never abort the run ----------

  describe('when a dynamic reference cannot be resolved', () => {
    beforeEach(() => {
      mockSecretsManagerSend.mockImplementation(async () => {
        throw new Error(
          'AccessDeniedException: not authorized to perform secretsmanager:GetSecretValue'
        );
      });
    });

    it('warns and keeps going instead of aborting the whole drift run', async () => {
      // Before this issue `cdkd drift` made no secret lookups at all, so a
      // least-privilege role that was never granted `GetSecretValue` is a
      // failure mode the fix INTRODUCED. Letting it propagate would abort the
      // command over one unreadable reference on one resource.
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Consumer: lambdaResource(),
          Bucket: {
            physicalId: 'b',
            resourceType: 'AWS::S3::Bucket',
            properties: { BucketName: 'b' },
            observedProperties: { BucketName: 'b' },
          },
        })
      );
      mockRegistryGetProvider.mockImplementation((type: string) =>
        type === LAMBDA_TYPE
          ? { readCurrentState: async () => awsEnv() }
          : { readCurrentState: async () => ({ BucketName: 'changed-out-of-band' }) }
      );

      const { output } = await runDrift(['TestStack']);

      // The unreadable resource is warned about by name...
      expect(
        warnSpy.mock.calls.some(
          (c) =>
            typeof c[0] === 'string' && c[0].includes('Consumer') && c[0].includes('NOT compared')
        )
      ).toBe(true);
      // ...its secret-bearing property is neither reported nor leaked (the
      // unresolved baseline falls back to the comparator's `{{resolve:` skip)...
      expect(output).not.toContain('Environment.Variables.SECRET_PASSWORD');
      expect(output).not.toContain(SECRET_PLAINTEXT);
      // ...and the sibling resource in the SAME stack is still compared.
      expect(output).toContain('BucketName');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('masks a plaintext an EARLIER leaf resolved out of the failure message', async () => {
      // The resolution is partial: one reference succeeded and recorded its
      // plaintext before a sibling threw. The error text comes from an external
      // system whose wording cdkd does not control, so it is masked with the
      // map as it stands — which is only possible because the map is cleared
      // AFTER the log, not before.
      mockSecretsManagerSend.mockImplementation(
        async (command: { input?: { SecretId?: string } }) => {
          if (command?.input?.SecretId === 'cdkd-other-secret') {
            throw new Error(`AccessDenied while reading a secret near '${SECRET_PLAINTEXT}'`);
          }
          return { SecretString: JSON.stringify({ password: SECRET_PLAINTEXT }) };
        }
      );
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Consumer: {
            physicalId: 'fn',
            resourceType: LAMBDA_TYPE,
            properties: { Environment: { Variables: { A: SECRET_EXPR, B: OTHER_EXPR } } },
            observedProperties: { Environment: { Variables: { A: SECRET_EXPR, B: OTHER_EXPR } } },
          },
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => ({ Environment: { Variables: { A: 'x', B: 'y' } } }),
      });

      await runDrift(['TestStack']);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('NOT compared');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    it('still masks by POSITION when the drift is reported above a leaf it never resolved', async () => {
      // The composition the review found. The comparator's `{{resolve:` skip
      // only re-arms for a LEAF whose state side is a string; here the observed
      // baseline lacks the parent entirely, so the drift is reported at the
      // ANCESTOR with the whole AWS subtree — plaintext included — as
      // `awsValue`. With no secrets map to scan, only the OFFLINE path seed
      // (taken from where the `{{resolve:` strings are, needing no AWS call)
      // can mask it.
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Consumer: {
            physicalId: 'fn',
            resourceType: LAMBDA_TYPE,
            properties: {
              FunctionName: 'fn',
              Environment: { Variables: { SECRET_PASSWORD: SECRET_EXPR, PLAIN: 'ok' } },
            },
            // Captured with the container present but EMPTY — the shape the
            // top-level state-keys-only walk still descends into, so the drift
            // lands one level above the secret leaf rather than on it.
            observedProperties: { FunctionName: 'fn', Environment: {} },
          },
        })
      );
      mockRegistryGetProvider.mockReturnValue({ readCurrentState: async () => awsEnv() });

      const { output } = await runDrift(['TestStack', '--json']);

      expect(output).not.toContain(SECRET_PLAINTEXT);
      const payload = JSON.parse(output) as Array<{
        drifted: Array<{ changes: Array<{ path: string; awsValue: unknown }> }>;
      }>;
      expect(payload[0]!.drifted).toHaveLength(1);
      expect(payload[0]!.drifted[0]!.changes[0]!.path).toBe('Environment.Variables');
      expect(payload[0]!.drifted[0]!.changes[0]!.awsValue).toBe(SECRET_MASK);
    });

    it('still keeps a pre-fix plaintext out of the --accept write with no secrets map', async () => {
      // Issue #1900's offline net: with no map at all, positioning the bag
      // against the record's own `properties` is the only mechanism left — and
      // it is exactly the one that needs no secret fetch.
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(
        makeState({
          Consumer: lambdaResource({
            FunctionName: 'fn',
            Environment: { Variables: { SECRET_PASSWORD: SECRET_PLAINTEXT, PLAIN: 'ok' } },
          }),
        })
      );
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => awsEnv({ PLAIN: 'edited-in-the-console' }),
      });

      await runDrift(['TestStack', '--accept', '--yes']);

      expect(mockSaveState).toHaveBeenCalledTimes(1);
      const saved = mockSaveState.mock.calls[0]![2];
      expect(JSON.stringify(saved)).not.toContain(SECRET_PLAINTEXT);
      const observed = saved.resources['Consumer']!.observedProperties as {
        Environment: { Variables: Record<string, unknown> };
      };
      expect(observed.Environment.Variables['SECRET_PASSWORD']).toBe(SECRET_EXPR);
      expect(observed.Environment.Variables['PLAIN']).toBe('edited-in-the-console');
    });

    it('fails --revert per resource rather than shipping the unresolved bag to AWS', async () => {
      // Reachable precisely BECAUSE detection degraded rather than aborting: a
      // throw is not cached, so the revert's own resolve asks again and fails
      // again. Without this arm the command would either crash or hand AWS a
      // bag it could not resolve.
      const update = vi.fn();
      mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
      mockGetState.mockResolvedValueOnce(makeState({ Consumer: lambdaResource() }));
      mockRegistryGetProvider.mockReturnValue({
        readCurrentState: async () => awsEnv({ PLAIN: 'edited-in-the-console' }),
        update,
      });

      await runDrift(['TestStack', '--revert', '--yes']);

      expect(update).not.toHaveBeenCalled();
      expect(
        errorSpy.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('could not re-resolve')
        )
      ).toBe(true);
    });
  });
});
