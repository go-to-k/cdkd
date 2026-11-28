import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#7134: a user pool a pre-#7128 release updated from OPTIONAL +
// software token to OFF still holds the software-token factor, and its
// `observedProperties` baseline (captured after that update) records it, so
// `cdkd drift` compared the leftover against itself and reported the pool
// clean. The REAL Cognito provider runs under the REAL drift command here;
// every other mock is infrastructure.

// The fake AWS below does change on a reset, but the post-revert re-read is
// covered by `drift-revert-verify-7025.test.ts`; stub it as the sibling
// revert-caller suites do.
vi.mock('../../../src/cli/commands/drift/revert-verify.js', () => ({
  verifyRevertedStack: vi.fn(async () => ({ notApplied: 0, unverified: 0 })),
}));
import type { ResourceState, StackState } from '../../../src/types/state.js';

const { mockSend, infoSpy, warnSpy, errorSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  infoSpy: vi.fn(),
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
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
      child: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    get iam() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({}),
}));

const mockGetState = vi.fn<
  (stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>
>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockSaveState = vi.fn<() => Promise<string>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: vi.fn(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
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
import { stillReportedAfterAccept } from '../../../src/cli/commands/drift/accept.js';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';

const POOL_ID = 'us-east-1_abc123';
const POOL_ARN = `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${POOL_ID}`;
const RESOURCE_TYPE = 'AWS::Cognito::UserPool';
const TOTP = 'SOFTWARE_TOKEN_MFA';
const LIVE_WEBAUTHN = {
  RelyingPartyId: 'example.com',
  UserVerification: 'required',
  FactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
};

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** The pool's live `GetUserPoolMfaConfig` answer; a `SetUserPoolMfaConfig` replaces it. */
let liveMfa: Record<string, unknown>;

function sent(name: string): Record<string, unknown>[] {
  return mockSend.mock.calls
    .map((c) => c[0] as SentCommand)
    .filter((cmd) => cmd.constructor.name === name)
    .map((cmd) => cmd.input);
}

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
      resources: { UserPool: resource },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

/** What the provider's readback captured as the baseline for the live pool right now. */
async function capturedBaseline(): Promise<Record<string, unknown>> {
  const read = await new CognitoUserPoolProvider().readCurrentState(
    POOL_ID,
    'UserPool',
    RESOURCE_TYPE
  );
  return read as Record<string, unknown>;
}

function record(
  properties: Record<string, unknown>,
  observedProperties: Record<string, unknown>
): ResourceState {
  return {
    physicalId: POOL_ID,
    resourceType: RESOURCE_TYPE,
    properties,
    observedProperties,
    attributes: { Arn: POOL_ARN, UserPoolId: POOL_ID },
    dependencies: [],
  };
}

/** The template after the OFF update: no factor, MFA OFF. */
const OFF_PROPERTIES = { UserPoolName: 'pool', MfaConfiguration: 'OFF' };

describe('cdkd drift on a pool a pre-#7128 release left holding the software token (#7134)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    exitSpy.mockRestore();
  });

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
    mockSend.mockReset();
    vi.clearAllMocks();
    mockRegistryGetProvider.mockReturnValue(new CognitoUserPoolProvider());
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockSaveState.mockResolvedValue('"etag-2"');
    // The leftover as measured: MFA OFF, the software token still enabled.
    liveMfa = { MfaConfiguration: 'OFF', SoftwareTokenMfaConfiguration: { Enabled: true } };
    mockSend.mockImplementation(async (cmd: SentCommand) => {
      switch (cmd.constructor.name) {
        case 'DescribeUserPoolCommand':
          return {
            UserPool: {
              Id: POOL_ID,
              Name: 'pool',
              Arn: POOL_ARN,
              MfaConfiguration: liveMfa['MfaConfiguration'],
            },
          };
        case 'GetUserPoolMfaConfigCommand':
          return liveMfa;
        case 'SetUserPoolMfaConfigCommand': {
          const { UserPoolId: _id, ...rest } = cmd.input;
          liveMfa = rest;
          return rest;
        }
        default:
          return {};
      }
    });
  });

  it('reports the leftover factor on EnabledMfas, then --revert sends the OFF reset', async () => {
    // The pre-fix capture: the readback right after the OFF update, factor and all.
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    expect(resource.observedProperties?.['EnabledMfas']).toEqual([TOTP]);

    mockGetState.mockResolvedValue(makeState(resource));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).toContain('EnabledMfas');
    expect(drift.output).toContain(TOTP);
    expect(exitSpy).toHaveBeenCalledWith(1);

    vi.clearAllMocks();
    mockRegistryGetProvider.mockReturnValue(new CognitoUserPoolProvider());
    mockGetState.mockResolvedValue(makeState(resource));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);
    expect(revert.error).toBeUndefined();
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([
      { UserPoolId: POOL_ID, MfaConfiguration: 'OFF' },
    ]);
    expect(liveMfa).toEqual({ MfaConfiguration: 'OFF' });
  });

  it('a revert over a live WebAuthn block keeps that block and drops only the factor', async () => {
    liveMfa = { ...liveMfa, WebAuthnConfiguration: LIVE_WEBAUTHN };
    const resource = record(OFF_PROPERTIES, await capturedBaseline());

    mockGetState.mockResolvedValue(makeState(resource));
    await runDrift(['TestStack', '--revert', '--yes']);
    const calls = sent('SetUserPoolMfaConfigCommand');
    expect(calls).toHaveLength(1);
    expect(calls[0]!['MfaConfiguration']).toBe('OFF');
    expect(calls[0]!['SoftwareTokenMfaConfiguration']).toBeUndefined();
    expect(calls[0]!['WebAuthnConfiguration']).toEqual(LIVE_WEBAUTHN);
  });

  it('--accept records the live factor as read, not a stripped list', async () => {
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    mockGetState.mockResolvedValue(makeState(resource));
    await runDrift(['TestStack', '--accept', '--yes']);
    const saved = (
      mockSaveState.mock.calls.at(-1) as unknown as [
        string,
        string,
        { resources: Record<string, ResourceState> },
      ]
    )[2].resources['UserPool']!;
    expect(saved.observedProperties?.['EnabledMfas']).toEqual([TOTP]);
    // `--accept` never edits the template intent.
    expect(saved.properties).toEqual(OFF_PROPERTIES);
    // ...and says the accepted value keeps being reported.
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("'EnabledMfas' was recorded, but cdkd drift will keep reporting it");
    expect(warned).toContain('cdkd drift --revert');
  });

  it('--accept warns about nothing on an ordinary accept', async () => {
    liveMfa = { MfaConfiguration: 'OFF' };
    const baseline = await capturedBaseline();
    const resource = record(OFF_PROPERTIES, { ...baseline, UserPoolName: 'old-name' });
    mockGetState.mockResolvedValue(makeState(resource));
    await runDrift(['TestStack', '--accept', '--yes']);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(
      'will keep reporting it'
    );
  });

  // Why the integ fixture seeds the legacy baseline by writing state: a
  // post-#7135 capture records `EnabledMfas: []`, an undeclared key captured
  // EMPTY, which the comparator skips (`undeclaredEmptyObservedKeys`). So the
  // leftover seeded out of band over it is not drift, and `--accept` has
  // nothing to write.
  it('a post-#7135 baseline ([]) does not compare the undeclared list, so --accept writes nothing', async () => {
    liveMfa = { MfaConfiguration: 'OFF' };
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    liveMfa = { MfaConfiguration: 'OFF', SoftwareTokenMfaConfiguration: { Enabled: true } };
    mockGetState.mockResolvedValue(makeState(resource));
    const out = await runDrift(['TestStack', '--accept', '--yes']);
    expect(out.output).toContain('no drift detected');
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('a pool the fixed release updated (no factor on either side) stays clean', async () => {
    liveMfa = { MfaConfiguration: 'OFF' };
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    expect(resource.observedProperties?.['EnabledMfas']).toEqual([]);

    mockGetState.mockResolvedValue(makeState(resource));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).not.toContain('EnabledMfas');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a record that declares the software token compares it as before: clean', async () => {
    liveMfa = { MfaConfiguration: 'OPTIONAL', SoftwareTokenMfaConfiguration: { Enabled: true } };
    const resource = record(
      { UserPoolName: 'pool', MfaConfiguration: 'OPTIONAL', EnabledMfas: [TOTP] },
      await capturedBaseline()
    );

    mockGetState.mockResolvedValue(makeState(resource));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).not.toContain('EnabledMfas');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('CognitoUserPoolProvider.canonicalizeDriftPair (#7134)', () => {
  const provider = new CognitoUserPoolProvider();
  const legacy = { MfaConfiguration: 'OFF', EnabledMfas: [TOTP] };
  const live = { MfaConfiguration: 'OFF', EnabledMfas: [TOTP] };

  it('drops the software token from the baseline only, leaving the readback by identity', async () => {
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, legacy, live, {
      MfaConfiguration: 'OFF',
    });
    expect(out.baseline['EnabledMfas']).toEqual([]);
    expect(out.aws).toBe(live);
    expect(legacy.EnabledMfas).toEqual([TOTP]);
  });

  it('applies when the record leaves MfaConfiguration absent too', async () => {
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, legacy, live, {});
    expect(out.baseline['EnabledMfas']).toEqual([]);
  });

  it('leaves a list holding SMS_MFA beside the token as recorded (its revert is refused under OFF)', async () => {
    const baseline = { MfaConfiguration: 'OFF', EnabledMfas: ['SMS_MFA', TOTP] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, live, {
      MfaConfiguration: 'OFF',
    });
    expect(out.baseline).toBe(baseline);
  });

  it('leaves an empty list by identity', async () => {
    const baseline = { MfaConfiguration: 'OFF', EnabledMfas: [] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, live, {});
    expect(out.baseline).toBe(baseline);
  });

  it.each([
    ['the record declares the factor', { MfaConfiguration: 'OPTIONAL', EnabledMfas: [TOTP] }],
    ['the record declares MFA ON', { MfaConfiguration: 'ON' }],
    ['the record declares a WebAuthn property', { WebAuthnRelyingPartyID: 'example.com' }],
    ['the record declares an email-OTP message', { EmailAuthenticationMessage: 'code {####}' }],
  ])('returns both bags by identity when %s', async (_label, properties) => {
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, legacy, live, properties);
    expect(out.baseline).toBe(legacy);
    expect(out.aws).toBe(live);
  });

  it('returns both bags by identity when the baseline itself is not OFF', async () => {
    const baseline = { MfaConfiguration: 'OPTIONAL', EnabledMfas: [TOTP] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, live, {});
    expect(out.baseline).toBe(baseline);
  });

  it('returns both bags by identity for another type', async () => {
    const out = await provider.canonicalizeDriftPair('AWS::Cognito::UserPoolClient', legacy, live);
    expect(out.baseline).toBe(legacy);
  });
});

describe('stillReportedAfterAccept (#7134)', () => {
  it('names a path the pair rule rewrites away from the accepted value', async () => {
    const paths = await stillReportedAfterAccept(
      new CognitoUserPoolProvider(),
      RESOURCE_TYPE,
      { MfaConfiguration: 'OFF', EnabledMfas: [TOTP] },
      { MfaConfiguration: 'OFF', EnabledMfas: [TOTP] },
      { MfaConfiguration: 'OFF' },
      ['EnabledMfas']
    );
    expect(paths).toEqual(['EnabledMfas']);
  });

  it('names nothing for a pair rule that rebuilds the bag without rewriting the accepted value', async () => {
    // A rebuilding rule (Step Functions, DLM shape): a new object every time,
    // and another member the comparator would normalize elsewhere left
    // different from the readback. Only a rewrite of the accepted path counts.
    const rebuilding = {
      canonicalizeDriftPair: (
        _type: string,
        baseline: Record<string, unknown>,
        aws: Record<string, unknown>
      ) => Promise.resolve({ baseline: { ...baseline }, aws: { ...aws } }),
    };
    const paths = await stillReportedAfterAccept(
      rebuilding,
      'AWS::StepFunctions::StateMachine',
      { Definition: 'accepted', Tags: [{ Key: 'b' }, { Key: 'a' }] },
      { Definition: 'accepted-but-spelled-raw', Tags: [{ Key: 'a' }, { Key: 'b' }] },
      {},
      ['Definition', 'Tags']
    );
    expect(paths).toEqual([]);
  });

  it('names nothing when the pair rule throws', async () => {
    const throwing = {
      canonicalizeDriftPair: () => Promise.reject(new Error('boom')),
    };
    expect(await stillReportedAfterAccept(throwing, 'X', { A: 1 }, { A: 2 }, {}, ['A'])).toEqual(
      []
    );
  });
});
