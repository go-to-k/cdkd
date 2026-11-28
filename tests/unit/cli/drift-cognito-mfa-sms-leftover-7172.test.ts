import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#7172, the SMS sibling of #7134: a user pool a pre-#7128
// release updated from OPTIONAL + SMS + software token to OFF still holds
// both factors (SMS survives every OFF call, the token survived the pre-fix
// `UpdateUserPool` OFF), and its `observedProperties` baseline records both,
// so `cdkd drift` reported it clean. The REAL Cognito provider runs under the
// REAL drift command here; every other mock is infrastructure.

// The post-revert re-read is covered by `drift-revert-verify-7025.test.ts`;
// stub it as the sibling revert-caller suites do. The drift AFTER the revert
// is run below against the state the revert saved.
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
import { withoutOffSmsEcho } from '../../../src/provisioning/providers/cognito/mfa-request.js';

const POOL_ID = 'us-east-1_abc123';
const POOL_ARN = `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${POOL_ID}`;
const RESOURCE_TYPE = 'AWS::Cognito::UserPool';
const SMS = 'SMS_MFA';
const TOTP = 'SOFTWARE_TOKEN_MFA';
const SMS_CONFIGURATION = {
  SnsCallerArn: 'arn:aws:iam::123456789012:role/pool-sms',
  ExternalId: 'pool-external',
  SnsRegion: 'us-east-1',
};
// MEASURED us-east-1 2026-11-28: what `GetUserPoolMfaConfig` reads on a pool
// with an `SmsConfiguration`, under OFF too, SMS MFA never enabled.
const SMS_MFA_CONFIGURATION = { SmsConfiguration: SMS_CONFIGURATION };

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


/** The template after the OFF update: no factor, MFA OFF, the SMS role still declared. */
const OFF_PROPERTIES = {
  UserPoolName: 'pool',
  MfaConfiguration: 'OFF',
  SmsConfiguration: SMS_CONFIGURATION,
};

function savedPool(): ResourceState | undefined {
  const call = mockSaveState.mock.calls.at(-1) as unknown as
    | [string, string, { resources: Record<string, ResourceState> }]
    | undefined;
  return call?.[2].resources['UserPool'];
}

describe('cdkd drift on a pool a pre-#7128 release left holding SMS + the software token (#7172)', () => {
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
    // The leftover as measured: MFA OFF, SMS and the software token both still enabled.
    liveMfa = {
      MfaConfiguration: 'OFF',
      SmsMfaConfiguration: SMS_MFA_CONFIGURATION,
      SoftwareTokenMfaConfiguration: { Enabled: true },
    };
    mockSend.mockImplementation(async (cmd: SentCommand) => {
      switch (cmd.constructor.name) {
        case 'DescribeUserPoolCommand':
          return {
            UserPool: {
              Id: POOL_ID,
              Name: 'pool',
              Arn: POOL_ARN,
              MfaConfiguration: liveMfa['MfaConfiguration'],
              SmsConfiguration: SMS_CONFIGURATION,
            },
          };
        case 'GetUserPoolMfaConfigCommand':
          return liveMfa;
        case 'SetUserPoolMfaConfigCommand': {
          // MEASURED (#7135 / #7172): a bare OFF call drops the software
          // token and keeps the pool's `SmsMfaConfiguration`.
          const { UserPoolId: _id, ...rest } = cmd.input;
          const keptSms =
            rest['SmsMfaConfiguration'] === undefined && liveMfa['SmsMfaConfiguration']
              ? { SmsMfaConfiguration: liveMfa['SmsMfaConfiguration'] }
              : {};
          liveMfa = { ...rest, ...keptSms };
          return liveMfa;
        }
        default:
          return {};
      }
    });
  });

  it('reports the leftover token, --revert sends the bare OFF reset, and the next drift is clean', async () => {
    // The pre-fix capture: the readback right after the OFF update, both factors.
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    expect(resource.observedProperties?.['EnabledMfas']).toEqual([SMS, TOTP]);

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
    // No factor block under OFF: an SMS block there is refused by the
    // pre-flight, and AWS refuses OFF beside a factor block.
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([
      { UserPoolId: POOL_ID, MfaConfiguration: 'OFF' },
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(liveMfa).toEqual({ MfaConfiguration: 'OFF', SmsMfaConfiguration: SMS_MFA_CONFIGURATION });

    // The drift after the revert, against whatever state the revert saved
    // (the original record when it saved none).
    const afterRevert = savedPool() ?? resource;
    vi.clearAllMocks();
    exitSpy.mockClear();
    mockRegistryGetProvider.mockReturnValue(new CognitoUserPoolProvider());
    mockGetState.mockResolvedValue(makeState(afterRevert));
    const next = await runDrift(['TestStack']);
    expect(next.output).not.toContain('EnabledMfas');
    expect(next.output).toContain('no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('the original record (nothing re-recorded) compares clean against the post-reset pool', async () => {
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    liveMfa = { MfaConfiguration: 'OFF', SmsMfaConfiguration: SMS_MFA_CONFIGURATION };
    mockGetState.mockResolvedValue(makeState(resource));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).not.toContain('EnabledMfas');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--accept records the live list as read and warns that it keeps being reported', async () => {
    const resource = record(OFF_PROPERTIES, await capturedBaseline());
    mockGetState.mockResolvedValue(makeState(resource));
    await runDrift(['TestStack', '--accept', '--yes']);
    const saved = savedPool()!;
    expect(saved.observedProperties?.['EnabledMfas']).toEqual([SMS, TOTP]);
    expect(saved.properties).toEqual(OFF_PROPERTIES);
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("'EnabledMfas' was recorded, but cdkd drift will keep reporting it");
  });

  it('a record that declares SMS + token under OPTIONAL compares them as before: clean', async () => {
    liveMfa = { ...liveMfa, MfaConfiguration: 'OPTIONAL' };
    const resource = record(
      { UserPoolName: 'pool', MfaConfiguration: 'OPTIONAL', EnabledMfas: [SMS, TOTP] },
      await capturedBaseline()
    );
    mockGetState.mockResolvedValue(makeState(resource));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).not.toContain('EnabledMfas');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('cdkd drift --revert on an SMS-configured pool under OFF (#7172)', () => {
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
    // An ordinary pool: an SmsConfiguration (CDK's phone sign-in or
    // `enableSmsRole`), MFA OFF, no factor ever enabled.
    liveMfa = { MfaConfiguration: 'OFF', SmsMfaConfiguration: SMS_MFA_CONFIGURATION };
    let liveName = 'pool';
    mockSend.mockImplementation(async (cmd: SentCommand) => {
      switch (cmd.constructor.name) {
        case 'DescribeUserPoolCommand':
          return {
            UserPool: {
              Id: POOL_ID,
              Name: liveName,
              Arn: POOL_ARN,
              MfaConfiguration: liveMfa['MfaConfiguration'],
              SmsConfiguration: SMS_CONFIGURATION,
            },
          };
        case 'UpdateUserPoolCommand':
          if (typeof cmd.input['PoolName'] === 'string') liveName = cmd.input['PoolName'];
          return {};
        case 'GetUserPoolMfaConfigCommand':
          return liveMfa;
        case 'SetUserPoolMfaConfigCommand': {
          const { UserPoolId: _id, ...rest } = cmd.input;
          liveMfa = { ...rest, SmsMfaConfiguration: SMS_MFA_CONFIGURATION };
          return liveMfa;
        }
        default:
          return {};
      }
    });
  });

  it('reverts an unrelated drift without sending SMS under OFF, and the next drift is clean', async () => {
    const baseline = await capturedBaseline();
    expect(baseline['EnabledMfas']).toEqual([SMS]);
    // The drift: the pool was renamed out of band.
    const recorded = record(OFF_PROPERTIES, { ...baseline, UserPoolName: 'recorded-name' });

    mockGetState.mockResolvedValue(makeState(recorded));
    const drift = await runDrift(['TestStack']);
    expect(drift.output).toContain('UserPoolName');
    expect(drift.output).not.toContain('EnabledMfas');

    vi.clearAllMocks();
    mockRegistryGetProvider.mockReturnValue(new CognitoUserPoolProvider());
    mockGetState.mockResolvedValue(makeState(recorded));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);
    expect(errorSpy.mock.calls).toEqual([]);
    expect(revert.error).toBeUndefined();
    // Nothing to send on the MFA API: the SMS block is the pool's own echo.
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([]);
    expect(sent('UpdateUserPoolCommand').map((c) => c['PoolName'])).toContain('recorded-name');

    const afterRevert = savedPool() ?? recorded;
    vi.clearAllMocks();
    exitSpy.mockClear();
    mockRegistryGetProvider.mockReturnValue(new CognitoUserPoolProvider());
    mockGetState.mockResolvedValue(makeState(afterRevert));
    const next = await runDrift(['TestStack']);
    expect(next.output).toContain('no drift detected');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('a live WebAuthn block goes back without an SMS block beside OFF', async () => {
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
    expect(calls[0]!['SmsMfaConfiguration']).toBeUndefined();
    expect(calls[0]!['WebAuthnConfiguration']).toMatchObject({ RelyingPartyId: 'example.com' });
  });

  it('a narrowed revert record keeps the SMS_MFA the pool still reads back', async () => {
    // A create-time-only difference makes `update()` report effective
    // properties (the warn arm a readback-derived bag takes); they must
    // describe the bag received, not the one sent without the SMS echo.
    const live = await capturedBaseline();
    const desired = { ...live, UsernameAttributes: ['email'] };
    const result = await new CognitoUserPoolProvider().update(
      'UserPool',
      POOL_ID,
      RESOURCE_TYPE,
      desired,
      live,
      { desiredFromAwsReadback: true }
    );
    expect(result.effectiveProperties).toBeDefined();
    expect(result.effectiveProperties?.['EnabledMfas']).toEqual([SMS]);
    expect(result.effectiveProperties?.['UsernameAttributes']).toEqual(live['UsernameAttributes']);
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([]);
  });

  it('an OPTIONAL + SMS pool keeps its SMS factor in the revert request', async () => {
    liveMfa = { MfaConfiguration: 'OPTIONAL', SmsMfaConfiguration: SMS_MFA_CONFIGURATION };
    const optional = {
      UserPoolName: 'pool',
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: [SMS],
      SmsConfiguration: SMS_CONFIGURATION,
    };
    const recorded = record(optional, {
      ...(await capturedBaseline()),
      UserPoolName: 'recorded-name',
    });
    expect(recorded.observedProperties?.['EnabledMfas']).toEqual([SMS]);
    mockGetState.mockResolvedValue(makeState(recorded));
    const revert = await runDrift(['TestStack', '--revert', '--yes']);
    expect(errorSpy.mock.calls).toEqual([]);
    expect(revert.error).toBeUndefined();
    const calls = sent('SetUserPoolMfaConfigCommand');
    expect(calls).toHaveLength(1);
    expect(calls[0]!['MfaConfiguration']).toBe('OPTIONAL');
    expect(calls[0]!['SmsMfaConfiguration']).toBeDefined();
  });
});

describe('CognitoUserPoolProvider.canonicalizeDriftPair, SMS beside the token (#7172)', () => {
  const provider = new CognitoUserPoolProvider();
  const legacy = { MfaConfiguration: 'OFF', EnabledMfas: [SMS, TOTP] };

  it('drops the token from the baseline only, keeping SMS and the readback by identity', async () => {
    const live = { MfaConfiguration: 'OFF', EnabledMfas: [SMS, TOTP] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, legacy, live, {
      MfaConfiguration: 'OFF',
    });
    expect(out.baseline['EnabledMfas']).toEqual([SMS]);
    expect(out.aws).toBe(live);
    expect(legacy.EnabledMfas).toEqual([SMS, TOTP]);
  });

  it.each([
    ['SMS alone (no token to drop)', [SMS]],
    ['email OTP beside the token (its leftover is unmeasured)', [TOTP, 'EMAIL_OTP']],
    ['all three factors', [SMS, TOTP, 'EMAIL_OTP']],
    ['an empty list', []],
  ])('leaves %s as recorded, both bags by identity', async (_label, factors) => {
    const baseline = { MfaConfiguration: 'OFF', EnabledMfas: factors };
    const live = { MfaConfiguration: 'OFF', EnabledMfas: [SMS, TOTP] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, baseline, live, {});
    expect(out.baseline).toBe(baseline);
    expect(out.aws).toBe(live);
  });

  it('returns both bags by identity when the record declares SMS under OPTIONAL', async () => {
    const live = { MfaConfiguration: 'OPTIONAL', EnabledMfas: [SMS, TOTP] };
    const out = await provider.canonicalizeDriftPair(RESOURCE_TYPE, legacy, live, {
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: [SMS],
    });
    expect(out.baseline).toBe(legacy);
    expect(out.aws).toBe(live);
  });
});

describe('withoutOffSmsEcho (#7172)', () => {
  it('drops SMS_MFA under OFF, copy-on-write', () => {
    const bag = { MfaConfiguration: 'OFF', EnabledMfas: [SMS, TOTP] };
    expect(withoutOffSmsEcho(bag)).toEqual({ MfaConfiguration: 'OFF', EnabledMfas: [TOTP] });
    expect(bag.EnabledMfas).toEqual([SMS, TOTP]);
  });

  it.each([
    ['OPTIONAL', { MfaConfiguration: 'OPTIONAL', EnabledMfas: [SMS] }],
    ['ON', { MfaConfiguration: 'ON', EnabledMfas: [SMS] }],
    ['an absent MfaConfiguration', { EnabledMfas: [SMS] }],
    ['OFF without SMS', { MfaConfiguration: 'OFF', EnabledMfas: [TOTP] }],
    ['OFF without a list', { MfaConfiguration: 'OFF' }],
  ])('returns the bag by identity under %s', (_label, bag) => {
    expect(withoutOffSmsEcho(bag)).toBe(bag);
  });
});

describe('stillReportedAfterAccept (#7172)', () => {
  it('names EnabledMfas after accepting SMS + the token under OFF', async () => {
    const paths = await stillReportedAfterAccept(
      new CognitoUserPoolProvider(),
      RESOURCE_TYPE,
      { MfaConfiguration: 'OFF', EnabledMfas: [SMS, TOTP] },
      { MfaConfiguration: 'OFF', EnabledMfas: [SMS, TOTP] },
      { MfaConfiguration: 'OFF' },
      ['EnabledMfas']
    );
    expect(paths).toEqual(['EnabledMfas']);
  });
});

describe('the SMS echo filter is gated on a readback-derived bag (#7175)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
    mockSend.mockImplementation(async (cmd: SentCommand) => {
      if (cmd.constructor.name === 'DescribeUserPoolCommand') {
        return { UserPool: { Id: POOL_ID, Name: 'pool', Arn: POOL_ARN, MfaConfiguration: 'OFF' } };
      }
      if (cmd.constructor.name === 'GetUserPoolMfaConfigCommand') return { MfaConfiguration: 'OFF' };
      return {};
    });
  });

  const declaresSmsUnderOff = {
    UserPoolName: 'pool',
    MfaConfiguration: 'OFF',
    EnabledMfas: [SMS],
    SmsConfiguration: SMS_CONFIGURATION,
  };
  const previous = { UserPoolName: 'pool', MfaConfiguration: 'OFF' };

  it.each([
    ['a template-path update (no context)', undefined],
    ['a rollback revert (replayingState)', { replayingState: true }],
  ])('%s declaring SMS_MFA under OFF is still refused by the pre-flight', async (_label, context) => {
    await expect(
      new CognitoUserPoolProvider().update(
        'UserPool',
        POOL_ID,
        RESOURCE_TYPE,
        declaresSmsUnderOff,
        previous,
        context
      )
    ).rejects.toThrow(/MfaConfiguration is OFF while an MFA factor is configured/);
    expect(sent('UpdateUserPoolCommand')).toEqual([]);
    expect(sent('SetUserPoolMfaConfigCommand')).toEqual([]);
  });
});
