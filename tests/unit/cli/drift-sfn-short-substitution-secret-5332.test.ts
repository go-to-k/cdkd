import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * go-to-k/cdkd#5332: `StepFunctionsProvider.canonicalizeDriftProperties` folds
 * `DefinitionSubstitutions` into `Definition` for the comparison, so a secret
 * proven at `DefinitionSubstitutions.<name>` is compared, and printed, at a
 * `Definition.*` leaf. The value scan cannot mask a secret shorter than its
 * needle floor, so the position mask has to follow the value there
 * (`getDriftSecretPathAliases`). Real resolver, real provider; only the AWS
 * sends and the readback are mocked. Harness copied from
 * `drift-secret-redaction.test.ts`.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
// The retry logger's channel: `withRetry` echoes the failing AWS error here on
// every attempt, and the payload it describes carries resolved secrets.
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  // Issue #2230: `drift.ts` calls this on the `--json` path to claim stdout for
  // the payload. Absent from the mock it is `undefined`, the call throws before
  // `writeJsonReport`, and every `--json` case in the file parses an EMPTY
  // string -- which is how a missing mock export reads as a broken payload.
  reserveStdoutForPayload: vi.fn(),
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
// A spelling cdkd resolves for NOBODY: the resolver's unsupported-service arm
// warns and returns the literal, and `cdkd deploy` does the same, so AWS holds
// this string verbatim. Since issue #2482 no CloudFormation service is in that
// position (`ssm-secure` was, and resolves like `ssm` now), so the survivor is
// text that merely looks like a reference — and NOT a secret.
const UNSUPPORTED_EXPR = '{{resolve:notaservice:/cdkd/test/unsupported}}';
// What AWS holds at a look-alike position: ordinary data, never masked.
const LIVE_AT_UNSUPPORTED = 'cdkd-live-at-lookalike-000';
// Issue #2482: the CloudFormation `ssm-secure` spelling, resolved through the
// same `GetParameter` as SECURE_EXPR — the mock answers `SecureString` for this
// name, so both spellings decrypt to SECURE_PLAINTEXT.
const SSM_SECURE_EXPR = '{{resolve:ssm-secure:/cdkd/test/secure}}';
const ROTATED_SECURE_PLAINTEXT = 'cdkd-rotated-secure-value-999';
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
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
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
    destroyClient: vi.fn(),
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
  loadProviderClasses: vi.fn(async () => ({})),
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


import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';

const SFN_TYPE = 'AWS::StepFunctions::StateMachine';

function makeState(resources: Record<string, ResourceState>): { state: StackState; etag: string } {
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
// Shorter than the value scan's needle floor (4), so ONLY a position mask can
// keep it out of the report.
const SHORT_SECRET = 'q7Z';
const SHORT_EXPR = '{{resolve:secretsmanager:cdkd-short-secret:SecretString:token::}}';

const asl = (result: string) => ({
  StartAt: 'Call',
  States: { Call: { Type: 'Pass', Result: result, ResultPath: '$.auth', End: true } },
});

/** A record captured before observed baselines: drift compares `properties`. */
function fallbackRecord(): ResourceState {
  return {
    physicalId: 'arn:aws:states:us-east-1:123456789012:stateMachine:sm',
    resourceType: SFN_TYPE,
    properties: {
      StateMachineName: 'sm',
      RoleArn: 'arn:aws:iam::123456789012:role/sfn',
      DefinitionString: JSON.stringify(asl('Bearer ${Token}')),
      DefinitionSubstitutions: { Token: SHORT_EXPR },
    },
  };
}

function sfnProvider(liveResult: string): StepFunctionsProvider {
  const provider = new StepFunctionsProvider();
  vi.spyOn(provider, 'readCurrentState').mockResolvedValue({
    StateMachineName: 'sm',
    RoleArn: 'arn:aws:iam::123456789012:role/sfn',
    Definition: asl(liveResult),
  });
  return provider;
}

describe('cdkd drift — a short DefinitionSubstitutions secret folded into Definition (issue #5332)', () => {
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
      command?.input?.SecretId === 'cdkd-short-secret'
        ? { SecretString: JSON.stringify({ token: SHORT_SECRET }) }
        : { SecretString: JSON.stringify({ password: SECRET_PLAINTEXT }) }
    );
    errorSpy.mockReset();
    warnSpy.mockReset();
    infoSpy.mockReset();
    debugSpy.mockReset();
    resetAccountInfoCache();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('reports no drift for an unchanged machine (the fold resolves the secret on both sides)', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: fallbackRecord() }));
    mockRegistryGetProvider.mockReturnValue(sfnProvider(`Bearer ${SHORT_SECRET}`));

    const { output } = await runDrift(['TestStack', '--json']);
    expect(output).not.toContain('Definition.States.Call.Result');
    expect(mockSecretsManagerSend).toHaveBeenCalled();
  });

  it.each([false, true])('masks the folded leaf when a console edit makes it drift (--json: %s)', async (json) => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: fallbackRecord() }));
    mockRegistryGetProvider.mockReturnValue(sfnProvider('Bearer edited'));

    const { output } = json
      ? await runDrift(['TestStack', '--json'])
      : await runDrift(['TestStack']);
    // The drift is still REPORTED at the folded leaf...
    expect(output).toContain('Definition.States.Call.Result');
    // ...but the baseline side, which holds the 3-character secret, is not
    // printed: the value scan cannot see a needle that short.
    expect(output).not.toContain(`Bearer ${SHORT_SECRET}`);
    expect(output).not.toContain(SHORT_SECRET);
  });

  // Composition with #5315 (PR #5327): an OBSERVED baseline whose substituted
  // Definition leaf the readback certification masked. The fold is identity on
  // that bag, the uncertified-baseline partition runs before the alias masks,
  // and neither path may print the secret, through the REAL provider's hooks.
  function observedMaskedRecord(): ResourceState {
    return {
      ...fallbackRecord(),
      observedProperties: {
        StateMachineName: 'sm',
        RoleArn: 'arn:aws:iam::123456789012:role/sfn',
        Definition: asl(SECRET_MASK),
      },
    };
  }

  it('an unchanged machine with a #5315-masked observed leaf is notCompared, not drift', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: observedMaskedRecord() }));
    mockRegistryGetProvider.mockReturnValue(sfnProvider(`Bearer ${SHORT_SECRET}`));

    const { output } = await runDrift(['TestStack', '--json']);
    expect(output).not.toContain(SHORT_SECRET);
    const payload = JSON.parse(output) as Array<{
      drifted: unknown[];
      notCompared: Array<{ cause: string }>;
    }>;
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.notCompared.map((n) => n.cause)).toEqual(['uncertifiedBaseline']);
  });

  it('an edit beside the #5315 mask is drift, and the masked leaf still prints nothing', async () => {
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: observedMaskedRecord() }));
    const provider = new StepFunctionsProvider();
    vi.spyOn(provider, 'readCurrentState').mockResolvedValue({
      StateMachineName: 'sm',
      RoleArn: 'arn:aws:iam::123456789012:role/sfn',
      Definition: { ...asl(`Bearer ${SHORT_SECRET}`), StartAt: 'Edited' },
    });
    mockRegistryGetProvider.mockReturnValue(provider);

    const { output } = await runDrift(['TestStack', '--json']);
    expect(output).not.toContain(SHORT_SECRET);
    const payload = JSON.parse(output) as Array<{
      drifted: Array<{ changes: Array<{ path: string }> }>;
    }>;
    expect(payload[0]!.drifted[0]!.changes.map((c) => c.path)).toEqual(['Definition.StartAt']);
  });

  // --revert sends its DESIRED bag through `canonicalizeDriftPair`, not the
  // per-side fold. Unfolded, the overlay of the folded `Definition.*` change onto
  // the AWS bag (which has no DefinitionSubstitutions) wrote the template's
  // literal `${Token}` over the live secret.
  it.each([
    [
      'object Definition',
      { Definition: asl('Bearer ${Token}') } as Record<string, unknown>,
    ],
    [
      'string DefinitionString',
      { DefinitionString: JSON.stringify(asl('Bearer ${Token}')) } as Record<string, unknown>,
    ],
  ])('--revert sends the substituted %s, never a placeholder', async (_label, body) => {
    const record = fallbackRecord();
    delete record.properties!['DefinitionString'];
    Object.assign(record.properties!, body);
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: record }));
    const provider = new StepFunctionsProvider();
    vi.spyOn(provider, 'readCurrentState').mockResolvedValue({
      StateMachineName: 'sm',
      RoleArn: 'arn:aws:iam::123456789012:role/sfn',
      // A console edit to a NON-secret leaf beside the substituted one.
      Definition: { ...asl(`Bearer ${SHORT_SECRET}`), StartAt: 'Edited' },
    });
    const update = vi
      .spyOn(provider, 'update')
      .mockResolvedValue({ physicalId: record.physicalId, wasReplaced: false });
    mockRegistryGetProvider.mockReturnValue(provider);

    await runDrift(['TestStack', '--revert', '--yes']);

    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as Record<string, unknown>;
    expect(JSON.stringify(sent)).not.toContain('${Token}');
    expect(JSON.stringify(sent)).not.toContain('{{resolve:');
    // The reverted definition: template StartAt back, the secret substituted.
    expect(sent['Definition']).toEqual(asl(`Bearer ${SHORT_SECRET}`));
  });

  it('masks a folded leaf whose substitution is a NoEcho `***` (a mask position, not a reference)', async () => {
    const record = fallbackRecord();
    record.properties!['DefinitionSubstitutions'] = { Token: SECRET_MASK };
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: record }));
    mockRegistryGetProvider.mockReturnValue(sfnProvider(`Bearer ${SHORT_SECRET}`));

    const { output } = await runDrift(['TestStack', '--json']);
    expect(output).not.toContain(SHORT_SECRET);
  });

  it('--revert never writes a NoEcho `***` spliced into a leaf (the live value is kept)', async () => {
    const record = fallbackRecord();
    record.properties!['DefinitionSubstitutions'] = { Token: SECRET_MASK };
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: record }));
    const provider = new StepFunctionsProvider();
    vi.spyOn(provider, 'readCurrentState').mockResolvedValue({
      StateMachineName: 'sm',
      RoleArn: 'arn:aws:iam::123456789012:role/sfn',
      Definition: { ...asl(`Bearer ${SHORT_SECRET}`), StartAt: 'Edited' },
    });
    const update = vi
      .spyOn(provider, 'update')
      .mockResolvedValue({ physicalId: record.physicalId, wasReplaced: false });
    mockRegistryGetProvider.mockReturnValue(provider);

    await runDrift(['TestStack', '--revert', '--yes']);

    // The template StartAt goes back; the masked leaf keeps AWS's own value.
    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as Record<string, unknown>;
    expect(JSON.stringify(sent)).not.toContain(SECRET_MASK);
    expect(sent['Definition']).toEqual(asl(`Bearer ${SHORT_SECRET}`));
  });

  it('a NoEcho `***` outside quotes (body unparseable) is notCompared, and --revert sends no `***`', async () => {
    // The fold masks the whole `Definition`; since #5333 a mask matches any
    // live value, so the position is an uncertified baseline (exit 2), and a
    // --revert driven by a real edit elsewhere sends AWS its own Definition.
    const record = fallbackRecord();
    record.properties!['DefinitionString'] =
      '{"StartAt":"W","States":{"W":{"Type":"Wait","Seconds":${Token},"End":true}}}';
    record.properties!['DefinitionSubstitutions'] = { Token: SECRET_MASK };
    const live = { StartAt: 'W', States: { W: { Type: 'Wait', Seconds: 901, End: true } } };
    const provider = (roleArn: string): StepFunctionsProvider => {
      const p = new StepFunctionsProvider();
      vi.spyOn(p, 'readCurrentState').mockResolvedValue({
        StateMachineName: 'sm',
        RoleArn: roleArn,
        Definition: live,
      });
      return p;
    };

    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: structuredClone(record) }));
    mockRegistryGetProvider.mockReturnValue(provider('arn:aws:iam::123456789012:role/sfn'));
    const { output } = await runDrift(['TestStack', '--json']);
    const payload = JSON.parse(output) as Array<{
      drifted: unknown[];
      notCompared: Array<{ cause: string }>;
    }>;
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.notCompared.map((n) => n.cause)).toEqual(['uncertifiedBaseline']);

    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: structuredClone(record) }));
    const edited = provider('arn:aws:iam::123456789012:role/edited');
    const update = vi
      .spyOn(edited, 'update')
      .mockResolvedValue({ physicalId: record.physicalId, wasReplaced: false });
    mockRegistryGetProvider.mockReturnValue(edited);
    await runDrift(['TestStack', '--revert', '--yes']);
    expect(update).toHaveBeenCalledTimes(1);
    const sent = update.mock.calls[0]![3] as Record<string, unknown>;
    expect(JSON.stringify(sent)).not.toContain(SECRET_MASK);
    expect(sent['Definition']).toEqual(live);
  });

  it('a NoEcho `***` used as a state-name KEY folds into an uncertified baseline (exit 2), #5333', async () => {
    const record = fallbackRecord();
    record.properties!['DefinitionString'] =
      '{"StartAt":"${Token}","States":{"${Token}":{"Type":"Pass","End":true}}}';
    record.properties!['DefinitionSubstitutions'] = { Token: SECRET_MASK };
    const provider = new StepFunctionsProvider();
    vi.spyOn(provider, 'readCurrentState').mockResolvedValue({
      StateMachineName: 'sm',
      RoleArn: 'arn:aws:iam::123456789012:role/sfn',
      Definition: { StartAt: 'nk-secret', States: { 'nk-secret': { Type: 'Pass', End: true } } },
    });
    mockListStacks.mockResolvedValueOnce([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockResolvedValueOnce(makeState({ Machine: record }));
    mockRegistryGetProvider.mockReturnValue(provider);

    const { output } = await runDrift(['TestStack', '--json']);
    expect(output).not.toContain('nk-secret');
    const payload = JSON.parse(output) as Array<{
      drifted: unknown[];
      notCompared: Array<{ cause: string }>;
    }>;
    expect(payload[0]!.drifted).toEqual([]);
    expect(payload[0]!.notCompared.map((n) => n.cause)).toEqual(['uncertifiedBaseline']);
  });
});
