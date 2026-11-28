import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#7177, the EMAIL_OTP sibling of #7175 / #7172. `readCurrentState`
// reports `EMAIL_OTP` plus the email-OTP message and subject whenever
// `GetUserPoolMfaConfig` returns an `EmailMfaConfiguration`, and a pool a
// pre-#7135 release moved from OPTIONAL + email OTP to OFF keeps that block
// (measured, below). The `drift --revert` bag carried it under OFF and the MFA
// pre-flight refused every revert of the pool, and `cdkd drift` reported the
// leftover clean. The REAL Cognito provider runs under the REAL drift command;
// every other mock is infrastructure.

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
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { withoutOffFactorEchoes } from '../../../src/provisioning/providers/cognito/mfa-request.js';

const POOL_ID = 'us-east-1_abc123';
const POOL_ARN = `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${POOL_ID}`;
const RESOURCE_TYPE = 'AWS::Cognito::UserPool';
const EMAIL = 'EMAIL_OTP';
const TOTP = 'SOFTWARE_TOKEN_MFA';
const EMAIL_BLOCK = { Message: 'Your code is {####}', Subject: 'Sign-in code' };

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** The pool's live `GetUserPoolMfaConfig` answer; a `SetUserPoolMfaConfig` replaces it. */
let liveMfa: Record<string, unknown>;
let liveName: string;
/** A failing `GetUserPoolMfaConfig` (a permission gap), set after the baseline is captured. */
let mfaReadFails: boolean;

function sent(name: string): Record<string, unknown>[] {
  return mockSend.mock.calls
    .map((c) => c[0] as SentCommand)
    .filter((cmd) => cmd.constructor.name === name)
    .map((cmd) => cmd.input);
}

async function runDrift(args: string[]): Promise<{ output: string; error: unknown }> {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  let error: unknown;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = original;
  }
  return { output: output.join(''), error };
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

function savedPool(): ResourceState | undefined {
  const call = mockSaveState.mock.calls.at(-1) as unknown as
    | [string, string, { resources: Record<string, ResourceState> }]
    | undefined;
  return call?.[2].resources['UserPool'];
}

/** The template after the OFF update: no factor, MFA OFF. */
const OFF_PROPERTIES = { UserPoolName: 'pool', MfaConfiguration: 'OFF' };

function resetMocks(): void {
  mockSend.mockReset();
  vi.clearAllMocks();
  mockRegistryGetProvider.mockReturnValue(new CognitoUserPoolProvider());
  mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  mockSaveState.mockResolvedValue('"etag-2"');
  mockSend.mockImplementation(async (cmd: SentCommand) => {
    switch (cmd.constructor.name) {
      case 'DescribeUserPoolCommand':
        return {
          UserPool: {
            Id: POOL_ID,
            Name: liveName,
            Arn: POOL_ARN,
            MfaConfiguration: liveMfa['MfaConfiguration'],
          },
        };
      case 'UpdateUserPoolCommand':
        if (typeof cmd.input['PoolName'] === 'string') liveName = cmd.input['PoolName'];
        return {};
      case 'GetUserPoolMfaConfigCommand':
        if (mfaReadFails) {
          throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
        }
        return liveMfa;
      case 'SetUserPoolMfaConfigCommand': {
        // MEASURED us-east-1 2026-11-28 (throwaway Essentials pool, a
        // temporarily verified SES email identity): OFF beside a factor block
        // is rejected, and the call is a full replace, so a bare OFF clears
        // the email block that `UpdateUserPool` OFF had left in place.
        const { UserPoolId: _id, ...rest } = cmd.input;
        if (
          rest['MfaConfiguration'] === 'OFF' &&
          (rest['EmailMfaConfiguration'] ||
            rest['SmsMfaConfiguration'] ||
            rest['SoftwareTokenMfaConfiguration'])
        ) {
          throw new Error(
            "InvalidParameterException: Invalid MFA configuration given, can't turn off MFA and configure an MFA together"
          );
        }
        liveMfa = rest;
        return liveMfa;
      }
      default:
        return {};
    }
  });
}

async function driftAfter(resource: ResourceState): Promise<{ output: string }> {
  resetMocks();
  exitSpy.mockClear();
  mockGetState.mockResolvedValue(makeState(resource));
  return runDrift(['TestStack']);
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
  liveName = 'pool';
  mfaReadFails = false;
  liveMfa = { MfaConfiguration: 'OFF', EmailMfaConfiguration: EMAIL_BLOCK };
  resetMocks();
});

afterEach(() => {
  exitSpy.mockRestore();
});

describe('cdkd drift on a pool whose OFF readback carries the email-OTP leftover (#7177)', () => {
  it('reports the leftover beside an unrelated drift, --revert clears it with the bare OFF reset, and the next drift is clean', async () => {
    const baseline = await capturedBaseline();
    expect(baseline['EnabledMfas']).toEqual([EMAIL]);
    expect(baseline['EmailAuthenticationMessage']).toBe(EMAIL_BLOCK.Message);
    const recorded = record(OFF_PROPERTIES, { ...baseline, UserPoolName: 'recorded-name' });

    mockGetState.mockResolvedValue(makeState(recorded));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).toContain('UserPoolName');
    expect(drift.output).toContain('EnabledMfas');
    expect(drift.output).toContain(EMAIL);
    expect(exitSpy).toHaveBeenCalledWith(1);

    resetMocks();
    mockGetState.mockResolvedValue(makeState(recorded));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);
    expect(errorSpy.mock.calls).toEqual([]);
    expect(revert.error).toBeUndefined();
    // No email block beside OFF: the reset alone, which clears the block.
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([
      { UserPoolId: POOL_ID, MfaConfiguration: 'OFF' },
    ]);
    expect(sent('UpdateUserPoolCommand').map((c) => c['PoolName'])).toContain('recorded-name');
    expect(liveMfa).toEqual({ MfaConfiguration: 'OFF' });

    const next = await driftAfter(savedPool() ?? recorded);
    expect(next.output).toContain('no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--accept records the live list as read and warns that it keeps being reported', async () => {
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    mockGetState.mockResolvedValue(makeState(resource));
    await runDrift(['TestStack', '--accept', '--yes']);
    const saved = savedPool()!;
    expect(saved.observedProperties?.['EnabledMfas']).toEqual([EMAIL]);
    expect(saved.properties).toEqual(OFF_PROPERTIES);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("'EnabledMfas' was recorded, but cdkd drift will keep reporting it");
  });

  it('a live WebAuthn block goes back without an email block beside OFF', async () => {
    liveMfa = {
      ...liveMfa,
      WebAuthnConfiguration: { RelyingPartyId: 'example.com', UserVerification: 'required' },
    };
    const recorded = record(OFF_PROPERTIES, {
      ...(await capturedBaseline()),
      UserPoolName: 'recorded-name',
    });
    mockGetState.mockResolvedValue(makeState(recorded));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);
    expect(errorSpy.mock.calls).toEqual([]);
    expect(revert.error).toBeUndefined();
    const calls = sent('SetUserPoolMfaConfigCommand');
    expect(calls).toHaveLength(1);
    expect(calls[0]!['MfaConfiguration']).toBe('OFF');
    expect(calls[0]!['EmailMfaConfiguration']).toBeUndefined();
    expect(calls[0]!['WebAuthnConfiguration']).toMatchObject({ RelyingPartyId: 'example.com' });
  });

  it('a readback-derived desired bag holding the block under OFF is sent without it, and the record drops it', async () => {
    // The desired side of the filter on its own: the live readback as the
    // desired bag (what the revert sends for an undrifted key), with a
    // create-time-only difference so `update()` reports effective properties.
    const live = await capturedBaseline();
    const result = await new CognitoUserPoolProvider().update(
      'UserPool',
      POOL_ID,
      RESOURCE_TYPE,
      { ...live, UsernameAttributes: ['email'] },
      live,
      { desiredFromAwsReadback: true }
    );
    // The reset below clears the block, so the record no longer lists it.
    expect(result.effectiveProperties).toBeDefined();
    expect(result.effectiveProperties?.['EnabledMfas']).toEqual([]);
    expect(result.effectiveProperties?.['EmailAuthenticationMessage']).toBe('');
    expect(result.effectiveProperties?.['EmailAuthenticationSubject']).toBe('');
    expect(result.effectiveProperties?.['UsernameAttributes']).toEqual(live['UsernameAttributes']);
    // The previous side keeps EMAIL_OTP, so the reset that clears it is sent.
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([
      { UserPoolId: POOL_ID, MfaConfiguration: 'OFF' },
    ]);
  });

  it('a template declaring WebAuthn only reports the leftover, and the full-replace revert leaves a clean next drift', async () => {
    const webAuthn = { RelyingPartyId: 'example.com', UserVerification: 'required' };
    liveMfa = { ...liveMfa, WebAuthnConfiguration: webAuthn };
    const properties = {
      ...OFF_PROPERTIES,
      WebAuthnRelyingPartyID: 'example.com',
      WebAuthnUserVerification: 'required',
    };
    const recorded = record(properties, {
      ...(await capturedBaseline()),
      UserPoolName: 'recorded-name',
    });
    mockGetState.mockResolvedValue(makeState(recorded));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).toContain('EnabledMfas');

    resetMocks();
    mockGetState.mockResolvedValue(makeState(recorded));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);
    expect(errorSpy.mock.calls).toEqual([]);
    expect(revert.error).toBeUndefined();
    const calls = sent('SetUserPoolMfaConfigCommand');
    expect(calls).toHaveLength(1);
    expect(calls[0]!['MfaConfiguration']).toBe('OFF');
    expect(calls[0]!['EmailMfaConfiguration']).toBeUndefined();
    expect(liveMfa['EmailMfaConfiguration']).toBeUndefined();

    const next = await driftAfter(savedPool() ?? recorded);
    expect(next.output).toContain('no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a reset skipped on a failed MFA read keeps the record as received', async () => {
    const live = await capturedBaseline();
    mfaReadFails = true;
    const result = await new CognitoUserPoolProvider().update(
      'UserPool',
      POOL_ID,
      RESOURCE_TYPE,
      { ...live, UsernameAttributes: ['email'] },
      live,
      { desiredFromAwsReadback: true }
    );
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([]);
    expect(result.effectiveProperties?.['EnabledMfas']).toEqual([EMAIL]);
    expect(result.effectiveProperties?.['EmailAuthenticationMessage']).toBe(EMAIL_BLOCK.Message);
    expect(result.effectiveProperties?.['EmailAuthenticationSubject']).toBe(EMAIL_BLOCK.Subject);
    expect(liveMfa['EmailMfaConfiguration']).toEqual(EMAIL_BLOCK);
  });

  it('an OPTIONAL + EMAIL_OTP pool keeps its email block in the revert request', async () => {
    liveMfa = { MfaConfiguration: 'OPTIONAL', EmailMfaConfiguration: EMAIL_BLOCK };
    const optional = {
      UserPoolName: 'pool',
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: [EMAIL],
      EmailAuthenticationMessage: EMAIL_BLOCK.Message,
      EmailAuthenticationSubject: EMAIL_BLOCK.Subject,
    };
    const recorded = record(optional, {
      ...(await capturedBaseline()),
      UserPoolName: 'recorded-name',
    });
    mockGetState.mockResolvedValue(makeState(recorded));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);
    expect(errorSpy.mock.calls).toEqual([]);
    expect(revert.error).toBeUndefined();
    const calls = sent('SetUserPoolMfaConfigCommand');
    expect(calls).toHaveLength(1);
    expect(calls[0]!['MfaConfiguration']).toBe('OPTIONAL');
    expect(calls[0]!['EmailMfaConfiguration']).toEqual(EMAIL_BLOCK);
  });
});

describe('cdkd drift on a pool a pre-#7135 release left holding email OTP + the software token (#7177)', () => {
  it('reports both, --revert sends the bare OFF reset, and the next drift is clean', async () => {
    liveMfa = {
      MfaConfiguration: 'OFF',
      EmailMfaConfiguration: EMAIL_BLOCK,
      SoftwareTokenMfaConfiguration: { Enabled: true },
    };
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    expect(resource.observedProperties?.['EnabledMfas']).toEqual([TOTP, EMAIL]);

    mockGetState.mockResolvedValue(makeState(resource));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).toContain('EnabledMfas');
    expect(drift.output).toContain(TOTP);
    expect(exitSpy).toHaveBeenCalledWith(1);

    resetMocks();
    mockGetState.mockResolvedValue(makeState(resource));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);
    expect(errorSpy.mock.calls).toEqual([]);
    expect(revert.error).toBeUndefined();
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([
      { UserPoolId: POOL_ID, MfaConfiguration: 'OFF' },
    ]);
    expect(liveMfa).toEqual({ MfaConfiguration: 'OFF' });

    const next = await driftAfter(savedPool() ?? resource);
    expect(next.output).toContain('no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('the email-OTP echo filter is gated on a readback-derived bag (#7177)', () => {
  const declaresEmailUnderOff = {
    UserPoolName: 'pool',
    MfaConfiguration: 'OFF',
    EnabledMfas: [EMAIL],
    EmailAuthenticationMessage: EMAIL_BLOCK.Message,
  };
  const previous = { UserPoolName: 'pool', MfaConfiguration: 'OFF' };

  it.each([
    ['a template-path update (no context)', undefined],
    ['a rollback revert (replayingState)', { replayingState: true }],
  ])('%s declaring EMAIL_OTP under OFF is still refused by the pre-flight', async (_l, context) => {
    liveMfa = { MfaConfiguration: 'OFF' };
    await expect(
      new CognitoUserPoolProvider().update(
        'UserPool',
        POOL_ID,
        RESOURCE_TYPE,
        declaresEmailUnderOff,
        previous,
        context
      )
    ).rejects.toThrow(/MfaConfiguration is OFF while an MFA factor is configured/);
    expect(sent('UpdateUserPoolCommand')).toEqual([]);
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([]);
  });
});

describe('CognitoUserPoolProvider.canonicalizeDriftPair, the email-OTP leftover (#7177)', () => {
  const provider = new CognitoUserPoolProvider();
  const message = {
    EmailAuthenticationMessage: EMAIL_BLOCK.Message,
    EmailAuthenticationSubject: EMAIL_BLOCK.Subject,
  };
  const cleared = { EmailAuthenticationMessage: '', EmailAuthenticationSubject: '' };

  it.each([
    ['EMAIL_OTP alone', [EMAIL], []],
    ['EMAIL_OTP beside the token', [TOTP, EMAIL], []],
    ['all three factors', ['SMS_MFA', TOTP, EMAIL], ['SMS_MFA']],
  ])('drops %s from the baseline only, the message and subject read empty', async (_l, f, kept) => {
    const baseline = { MfaConfiguration: 'OFF', EnabledMfas: f, ...message };
    const live = { MfaConfiguration: 'OFF', EnabledMfas: f, ...message };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, live, {
      MfaConfiguration: 'OFF',
    });
    expect(out.baseline).toEqual({ MfaConfiguration: 'OFF', EnabledMfas: kept, ...cleared });
    expect(out.aws).toBe(live);
    expect(baseline.EnabledMfas).toEqual(f);
    expect(baseline.EmailAuthenticationMessage).toBe(EMAIL_BLOCK.Message);
  });

  it('adds no message key to a baseline that recorded none', async () => {
    const baseline = { MfaConfiguration: 'OFF', EnabledMfas: [EMAIL] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, {}, {});
    expect(out.baseline).toEqual({ MfaConfiguration: 'OFF', EnabledMfas: [] });
  });

  it.each([
    ['SMS alone', ['SMS_MFA']],
    ['an empty list', []],
    ['EMAIL_OTP beside an unknown member', [EMAIL, 'UNKNOWN']],
  ])('leaves %s as recorded, both bags by identity', async (_label, factors) => {
    const baseline = { MfaConfiguration: 'OFF', EnabledMfas: factors, ...message };
    const live = { MfaConfiguration: 'OFF', EnabledMfas: [EMAIL] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, live, {});
    expect(out.baseline).toBe(baseline);
    expect(out.aws).toBe(live);
  });

  it('returns both bags by identity when the record declares EMAIL_OTP under OPTIONAL', async () => {
    const baseline = { MfaConfiguration: 'OFF', EnabledMfas: [EMAIL], ...message };
    const live = { MfaConfiguration: 'OPTIONAL', EnabledMfas: [EMAIL] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, live, {
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: [EMAIL],
    });
    expect(out.baseline).toBe(baseline);
    expect(out.aws).toBe(live);
  });
});

describe('withoutOffFactorEchoes, the email-OTP echo (#7177)', () => {
  const bag = {
    UserPoolName: 'pool',
    MfaConfiguration: 'OFF',
    EnabledMfas: ['SMS_MFA', TOTP, EMAIL],
    EmailAuthenticationMessage: EMAIL_BLOCK.Message,
    EmailAuthenticationSubject: EMAIL_BLOCK.Subject,
  };

  it('drops EMAIL_OTP, the message and the subject under OFF, copy-on-write', () => {
    expect(withoutOffFactorEchoes(bag)).toEqual({
      UserPoolName: 'pool',
      MfaConfiguration: 'OFF',
      EnabledMfas: [TOTP],
    });
    expect(bag.EnabledMfas).toEqual(['SMS_MFA', TOTP, EMAIL]);
    expect(bag.EmailAuthenticationMessage).toBe(EMAIL_BLOCK.Message);
  });

  it('keepEmailOtp (the previous side) drops SMS_MFA only', () => {
    expect(withoutOffFactorEchoes(bag, { keepEmailOtp: true })).toEqual({
      ...bag,
      EnabledMfas: [TOTP, EMAIL],
    });
    const emailOnly = { MfaConfiguration: 'OFF', EnabledMfas: [EMAIL], ...EMAIL_BLOCK };
    expect(withoutOffFactorEchoes(emailOnly, { keepEmailOtp: true })).toBe(emailOnly);
  });

  it('drops a bare subject under OFF (it alone builds the email block)', () => {
    const subjectOnly = { MfaConfiguration: 'OFF', EmailAuthenticationSubject: 'Sign-in code' };
    expect(withoutOffFactorEchoes(subjectOnly)).toEqual({ MfaConfiguration: 'OFF' });
  });

  it.each([
    ['OPTIONAL', { MfaConfiguration: 'OPTIONAL', EnabledMfas: [EMAIL], ...EMAIL_BLOCK }],
    ['ON', { MfaConfiguration: 'ON', EnabledMfas: [EMAIL] }],
    ['an absent MfaConfiguration', { EnabledMfas: [EMAIL], EmailAuthenticationMessage: 'm' }],
    [
      'OFF with the readback placeholders only',
      {
        MfaConfiguration: 'OFF',
        EnabledMfas: [],
        EmailAuthenticationMessage: '',
        EmailAuthenticationSubject: '',
      },
    ],
  ])('returns the bag by identity under %s', (_label, input) => {
    expect(withoutOffFactorEchoes(input)).toBe(input);
  });
});
