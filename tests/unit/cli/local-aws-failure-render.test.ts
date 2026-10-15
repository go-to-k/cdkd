import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import { getLogger } from '../../../src/utils/logger.js';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';

/**
 * Issue go-to-k/cdkd#2300: every STS failure the `cdkd local *` commands relay
 * into a default-level `warn` renders through ONE policy, cdk-local's: a
 * modeled service exception keeps its message (flattened, capped), anything
 * else is withheld to its class plus a character count, with the full text at
 * `debug` through cdkd's OWN logger -- the one `--verbose` raises.
 *
 * The withheld case is the one that matters: the SDK's `credential_process`
 * provider copies the failed command line into its error, so the warn used to
 * print it. `SECRET_CMD` stands in for that text.
 */
const SECRET_CMD = '/usr/local/bin/fetch-creds --token=hunter2-not-a-real-token';
const ARN = 'arn:aws:iam::123456789012:role/ExecRole';

const sts = vi.hoisted(() => ({ fail: undefined as unknown, empty: false, credsFail: undefined as unknown }));

// The fromS3 path downloads the bundle after its `--assume-role` fallback warn;
// stop it there rather than reach S3.
vi.mock('../../../src/local/agentcore-s3-bundle.js', () => ({
  downloadAndExtractS3Bundle: vi.fn(async () => {
    throw new Error('test: bundle download stubbed');
  }),
}));

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(function STSClient(this: unknown) {
    return {
      send: vi.fn(async () => {
        if (sts.fail !== undefined) throw sts.fail;
        if (sts.empty) return {};
        return { Account: '123456789012' };
      }),
      destroy: vi.fn(),
      config: {
        credentials: async () => {
          if (sts.credsFail !== undefined) throw sts.credsFail;
          return { accessKeyId: 'AKIA', secretAccessKey: 'secret' };
        },
      },
    };
  }),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
  AssumeRoleCommand: vi.fn(function AssumeRoleCommand(this: unknown) {}),
}));

const { describeLocalAwsFailureForWarn } = await import(
  '../../../src/utils/local-aws-failure.js'
);
const { resolvePseudoParametersForInvoke, applyLambdaCredentialEnv } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { resolvePseudoParametersForStartApi, assumeLambdaExecutionRole, resolveProfileCredentials } =
  await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { buildEcsImageResolutionContext, assumeTaskRole, resolvePlaceholderAccount } = await import(
  '../../../src/cli/commands/local-run-task.js'
);
const {
  buildAgentCoreImageContext,
  applyAgentCoreCredentialEnv,
  resolveHostCredentialsForSigV4,
  resolveAgentCoreCodeImageFromS3,
} = await import('../../../src/cli/commands/local-invoke-agentcore.js');
const realSts =
  await vi.importActual<typeof import('@aws-sdk/client-sts')>('@aws-sdk/client-sts');

/**
 * A credential-provider failure: no `$fault`, so not AWS's own reply -- but
 * carrying the `$metadata` the SDK's retry middleware attaches to ANY failure
 * that passes through it, so "`$metadata` without `$fault` is still withheld"
 * is pinned at every site.
 */
function credentialProcessError(): Error {
  return Object.assign(new Error(`Error: credential_process ${SECRET_CMD} exited with code 1`), {
    name: 'CredentialsProviderError',
    $metadata: { attempts: 1, totalRetryDelay: 0 },
  });
}

/** A modeled STS exception, as every `@smithy/smithy-client` `ServiceException` carries. */
function serviceError(name: string, message: string): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
}

function ecsStack(): StackInfo {
  return {
    stackName: 'RenderStack',
    displayName: 'RenderStack',
    artifactId: 'RenderStack',
    dependencyNames: [],
    region: 'us-east-1',
    template: {
      Resources: {
        TaskDef: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: 'public.ecr.aws/docker/library/busybox:latest',
                Environment: [
                  { Name: 'ACCOUNT', Value: { 'Fn::Join': ['', [{ Ref: 'AWS::AccountId' }]] } },
                ],
              },
            ],
          },
        },
      },
    },
  } as unknown as StackInfo;
}

function emptyStack(): StackInfo {
  return { ...ecsStack(), template: { Resources: {} } } as unknown as StackInfo;
}

function stubProvider(): never {
  return { label: '--from-state', load: vi.fn(async () => undefined), dispose: vi.fn() } as never;
}

const stateOptions = { region: 'us-east-1', statePrefix: 'cdkd', fromState: true };

/** Every site that relays an STS failure, driven through its own exported entry point. */
const sites: Array<{ name: string; operation: string; run: () => Promise<unknown> }> = [
  {
    name: 'local invoke: resolvePseudoParametersForInvoke',
    operation: 'STS GetCallerIdentity failed',
    run: () => resolvePseudoParametersForInvoke(undefined, stateOptions as never),
  },
  {
    name: 'local invoke: applyLambdaCredentialEnv',
    operation: `STS AssumeRole(${ARN}) failed`,
    run: () => applyLambdaCredentialEnv({}, { assumeRoleArn: ARN }),
  },
  {
    name: 'local start-api: resolvePseudoParametersForStartApi',
    operation: 'STS GetCallerIdentity failed',
    run: () => resolvePseudoParametersForStartApi('us-east-1', stateOptions as never),
  },
  {
    name: 'local run-task: buildEcsImageResolutionContext',
    operation: 'STS GetCallerIdentity failed',
    run: () => buildEcsImageResolutionContext(ecsStack(), stubProvider(), stateOptions as never),
  },
  {
    name: 'local invoke-agentcore: buildAgentCoreImageContext',
    operation: 'STS GetCallerIdentity failed',
    run: () => buildAgentCoreImageContext(emptyStack(), stubProvider(), stateOptions as never),
  },
  {
    name: 'local invoke-agentcore: applyAgentCoreCredentialEnv',
    operation: `STS AssumeRole(${ARN}) failed`,
    run: () => applyAgentCoreCredentialEnv({}, { assumeRoleArn: ARN }),
  },
  {
    name: 'local invoke-agentcore: resolveAgentCoreCodeImageFromS3 (assumeRoleFallbackWarning)',
    operation: `STS AssumeRole(${ARN}) failed for the fromS3 bundle download`,
    run: () =>
      resolveAgentCoreCodeImageFromS3(
        { logicalId: 'Runtime', stack: emptyStack(), properties: {} } as never,
        { runtime: 'PYTHON_3_12', entryPoint: ['main.py'] } as never,
        { bucket: 'bundle-bucket', key: 'bundle.zip' },
        { assumeRole: ARN, region: 'us-east-1' } as never,
        'arm64',
        undefined
      ),
  },
  {
    name: 'local invoke-agentcore: resolveHostCredentialsForSigV4 (assumeRoleFallbackWarning)',
    operation: `STS AssumeRole(${ARN}) failed for --sigv4 signing`,
    run: () =>
      resolveHostCredentialsForSigV4(
        { assumeRole: ARN } as never,
        { logicalId: 'Runtime', stack: emptyStack(), properties: {} } as never,
        undefined,
        'us-east-1'
      ),
  },
];

const ENV_KEYS = [
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
// cdk-local logs the withheld text at debug on its own logger; cdkd's embed
// config hands that to cdkd's logger (go-to-k/cdkd#2429). Install it the way
// every `cdkd local` command does, so the debug spy sees what a user would.
createLocalCommand();
const warnSpy = vi.spyOn(getLogger(), 'warn');
const debugSpy = vi.spyOn(getLogger(), 'debug');

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetAwsClientDefaults();
  sts.fail = undefined;
  sts.empty = false;
  sts.credsFail = undefined;
  warnSpy.mockReset();
  warnSpy.mockImplementation(() => {});
  debugSpy.mockReset();
  debugSpy.mockImplementation(() => {});
});

afterEach(() => {
  resetAwsClientDefaults();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const lines = (spy: typeof warnSpy) => spy.mock.calls.map((c) => String(c[0]));

describe('describeLocalAwsFailureForWarn', () => {
  it('keeps a modeled service exception message, flattened to one line', () => {
    const rendered = describeLocalAwsFailureForWarn(
      serviceError('AccessDenied', 'User x is not authorized\nto perform: sts:AssumeRole'),
      'STS AssumeRole'
    );
    expect(rendered).toBe('AccessDenied: User x is not authorized to perform: sts:AssumeRole');
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('withholds any other failure to its class and length, with the text at cdkd debug', () => {
    const err = credentialProcessError();
    const rendered = describeLocalAwsFailureForWarn(err, 'STS GetCallerIdentity');
    expect(rendered).toBe(
      `CredentialsProviderError; ${err.message.length}-character message withheld, ` +
        'logged at debug level under --verbose'
    );
    expect(rendered).not.toContain('hunter2');
    // The pointer must be TRUE for cdkd: the text goes through cdkd's logger,
    // the one `--verbose` raises, and not only through cdk-local's.
    const debug = lines(debugSpy);
    expect(debug).toHaveLength(1);
    expect(debug[0]).toBe(
      `STS GetCallerIdentity: the AWS SDK's own failure message was: ${err.message}`
    );
  });

  it('names a clamped err.code on the withheld form', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND sts.us-east-1.amazonaws.com'), {
      code: 'ENOTFOUND',
    });
    expect(describeLocalAwsFailureForWarn(err, 'STS GetCallerIdentity')).toBe(
      `Error ENOTFOUND; ${err.message.length}-character message withheld, logged at debug level under --verbose`
    );
  });

  it('cannot be made to forge a line: a hostile name is clamped, a hostile message flattened', () => {
    const forgedName = Object.assign(new Error('x'), {
      name: 'AccessDenied\n[INFO] Deployed',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    });
    const rendered = describeLocalAwsFailureForWarn(forgedName, 'STS AssumeRole');
    expect(rendered).not.toMatch(/[\n\r]/);
    expect(rendered.startsWith('unknown: ')).toBe(true);

    const nonError = `plain\u001b[2K\nstring`;
    describeLocalAwsFailureForWarn(nonError, 'STS AssumeRole');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(lines(debugSpy).join('')).not.toMatch(/[\u001b\n]/);
  });

  it("prints a CdkdError's own text: cdkd wrote it, so nothing is withheld", async () => {
    const { CdkdError } = await import('../../../src/utils/error-handler.js');
    const err = new CdkdError(`AssumeRole(${ARN}) returned no usable credentials.`, 'X_NO_CREDS');
    expect(describeLocalAwsFailureForWarn(err, 'STS AssumeRole')).toBe(err.message.slice(0, -1));
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('survives an Error whose message getter throws', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'message', {
      get() {
        throw new Error('hostile getter');
      },
    });
    expect(() => describeLocalAwsFailureForWarn(err, 'STS AssumeRole')).not.toThrow();
    expect(lines(debugSpy).join('')).toContain('[unstringifiable throw]');
  });

  it('keeps the message of a REAL smithy STS exception (client fault)', () => {
    const err = new realSts.ExpiredTokenException({
      message: 'The security token included in the request is expired',
      $metadata: { httpStatusCode: 400, attempts: 1, totalRetryDelay: 0 },
    });
    expect(err.$fault).toBe('client');
    expect(describeLocalAwsFailureForWarn(err, 'STS GetCallerIdentity')).toBe(
      'ExpiredTokenException: The security token included in the request is expired'
    );
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('keeps the message of a server-fault service exception too', () => {
    const err = new realSts.STSServiceException({
      name: 'InternalFailure',
      $fault: 'server',
      $metadata: { httpStatusCode: 500 },
      message: 'We encountered an internal error. Please try again.',
    });
    expect(describeLocalAwsFailureForWarn(err, 'STS AssumeRole')).toBe(
      // One trailing period is dropped: every call site appends its own `. `.
      'InternalFailure: We encountered an internal error. Please try again'
    );
  });

  it('leaves an ellipsis alone: only ONE trailing period is dropped', () => {
    expect(
      describeLocalAwsFailureForWarn(serviceError('Throttling', 'Rate exceeded...'), 'STS AssumeRole')
    ).toBe('Throttling: Rate exceeded...');
  });

  it('withholds a non-Error throw too', () => {
    expect(describeLocalAwsFailureForWarn('boom', 'STS AssumeRole')).toBe(
      'unknown; 4-character message withheld, logged at debug level under --verbose'
    );
  });
});

describe.each(sites)('$name', ({ operation, run }) => {
  it('withholds a credential-provider failure from the warn and logs it at debug', async () => {
    sts.fail = credentialProcessError();
    await run().catch(() => undefined);
    const warned = lines(warnSpy).filter((m) => m.includes(operation));
    expect(warned, `no warn named '${operation}'`).toHaveLength(1);
    expect(warned[0]).not.toContain(SECRET_CMD);
    expect(warned[0]).toContain('CredentialsProviderError; ');
    expect(warned[0]).toContain('-character message withheld, logged at debug level under --verbose');
    expect(lines(debugSpy).some((m) => m.includes(SECRET_CMD))).toBe(true);
  });

  it("keeps a REAL smithy STS exception's message", async () => {
    sts.fail = new realSts.ExpiredTokenException({
      message: 'The security token included in the request is expired',
      $metadata: { httpStatusCode: 400 },
    });
    await run().catch(() => undefined);
    const warned = lines(warnSpy).filter((m) => m.includes(operation));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(
      `${operation}: ExpiredTokenException: The security token included in the request is expired.`
    );
  });

  it("keeps a modeled STS exception's message, the diagnosis", async () => {
    sts.fail = serviceError('AccessDenied', 'User x is not authorized to perform: sts:AssumeRole');
    await run().catch(() => undefined);
    const warned = lines(warnSpy).filter((m) => m.includes(operation));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(
      `${operation}: AccessDenied: User x is not authorized to perform: sts:AssumeRole.`
    );
  });

});

describe.each(sites.filter((s) => s.operation.includes('AssumeRole')))('$name', ({ operation, run }) => {
  it("prints cdkd's own 'returned no usable credentials' refusal rather than withholding it", async () => {
    sts.empty = true;
    await run().catch(() => undefined);
    const warned = lines(warnSpy).filter((m) => m.includes(operation));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`${operation}: AssumeRole(${ARN}) returned no usable credentials.`);
  });
});

describe.each([
  ['local invoke: applyLambdaCredentialEnv', () => applyLambdaCredentialEnv({}, { assumeRoleArn: 'not-an-arn' })],
  [
    'local invoke-agentcore: applyAgentCoreCredentialEnv',
    () => applyAgentCoreCredentialEnv({}, { assumeRoleArn: 'not-an-arn' }),
  ],
] as const)('%s: the assertSendableRoleArn backstop', (_name, run) => {
  it('prints its refusal (a CdkdError) rather than withholding it', async () => {
    await run().catch(() => undefined);
    const warned = lines(warnSpy).filter((m) => m.includes('--assume-role: STS AssumeRole('));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('AssumeRole refused');
    expect(warned[0]).not.toContain('message withheld');
  });
});

/**
 * go-to-k/cdkd#4857: three relays that THROW rather than warn had no `catch`,
 * so the raw SDK error reached `formatError`'s `<name>: <message>` unsanitized.
 * Asserted on the full `formatError` output, `Caused by:` line included.
 */
describe.each([
  {
    name: 'local run-task: assumeTaskRole',
    run: () => assumeTaskRole(ARN, 'us-east-1'),
    needle: `--assume-task-role: STS AssumeRole(${ARN}) failed: `,
  },
  {
    name: 'local run-task: resolvePlaceholderAccount',
    run: () =>
      resolvePlaceholderAccount('arn:aws:iam::${AWS::AccountId}:role/TaskRole', {
        region: 'us-east-1',
      } as never),
    needle: "--assume-task-role: STS GetCallerIdentity failed while resolving the task role's account: ",
  },
  {
    name: 'local start-api: assumeLambdaExecutionRole',
    run: () => assumeLambdaExecutionRole(ARN, 'us-east-1'),
    needle: `--assume-role: STS AssumeRole(${ARN}) failed: `,
  },
])('$name: the thrown refusal', ({ run, needle }) => {
  it('withholds a credential-chain failure from the error and its Caused by line', async () => {
    const { formatError } = await import('../../../src/utils/error-handler.js');
    sts.fail = credentialProcessError();
    const err = await run().then(
      () => undefined,
      (e: unknown) => e
    );
    const printed = formatError(err);
    expect(printed).toContain(`${needle}CredentialsProviderError; `);
    expect(printed).not.toContain(SECRET_CMD);
    // Still threaded for the classifiers (go-to-k/cdkd#2075), redacted.
    expect(((err as Error).cause as Error | undefined)?.name).toBe('CredentialsProviderError');
    expect(lines(debugSpy).some((m) => m.includes(SECRET_CMD))).toBe(true);
  });

  it("keeps a modeled STS exception's message", async () => {
    const { formatError } = await import('../../../src/utils/error-handler.js');
    sts.fail = serviceError('AccessDenied', 'User x is not authorized to perform: sts:AssumeRole');
    const err = await run().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(formatError(err)).toContain(
      `${needle}AccessDenied: User x is not authorized to perform: sts:AssumeRole.`
    );
  });
});

/**
 * The three thrown relays let cdkd's own `CdkdError` through untouched: the
 * no-Account / no-credentials refusal must not be re-wrapped in the
 * `... failed:` prefix (go-to-k/cdkd#4857).
 */
describe.each([
  {
    name: 'local run-task: assumeTaskRole',
    run: () => assumeTaskRole(ARN, 'us-east-1'),
    expected: /^CdkdError: AssumeRole\(arn:aws:iam::123456789012:role\/ExecRole\) returned no usable credentials\.$/,
  },
  {
    name: 'local run-task: resolvePlaceholderAccount',
    run: () =>
      resolvePlaceholderAccount('arn:aws:iam::${AWS::AccountId}:role/TaskRole', {
        region: 'us-east-1',
      } as never),
    expected: /^CdkdError: --assume-task-role: GetCallerIdentity returned no Account; /,
  },
  {
    name: 'local start-api: assumeLambdaExecutionRole',
    run: () => assumeLambdaExecutionRole(ARN, 'us-east-1'),
    expected: /^CdkdError: AssumeRole\(arn:aws:iam::123456789012:role\/ExecRole\) returned no usable credentials\.$/,
  },
])('$name: its own refusal', ({ run, expected }) => {
  it('passes through unwrapped', async () => {
    const { formatError } = await import('../../../src/utils/error-handler.js');
    sts.empty = true;
    const err = await run().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(formatError(err)).toMatch(expected);
  });
});

describe('local start-api: resolveProfileCredentials (go-to-k/cdkd#4857)', () => {
  it('withholds a credential-resolution failure from the error and its Caused by line', async () => {
    const { formatError } = await import('../../../src/utils/error-handler.js');
    sts.credsFail = credentialProcessError();
    const err = await resolveProfileCredentials('dev').then(
      () => undefined,
      (e: unknown) => e
    );
    const printed = formatError(err);
    expect(printed).toContain(
      "--profile dev: could not resolve the profile's credentials: CredentialsProviderError; "
    );
    expect(printed).not.toContain(SECRET_CMD);
    expect(((err as Error).cause as Error | undefined)?.name).toBe('CredentialsProviderError');
    expect(lines(debugSpy).some((m) => m.includes(SECRET_CMD))).toBe(true);
  });

  it('passes its own unusable-credentials refusal through unwrapped', async () => {
    const { formatError } = await import('../../../src/utils/error-handler.js');
    sts.credsFail = undefined;
    // `credentials` resolving to an empty bag: the cdkd-authored refusal.
    const { STSClient } = await import('@aws-sdk/client-sts');
    vi.mocked(STSClient).mockImplementationOnce(function STSClient(this: unknown) {
      return { destroy: vi.fn(), config: { credentials: async () => ({}) } } as never;
    } as never);
    const err = await resolveProfileCredentials('dev').then(
      () => undefined,
      (e: unknown) => e
    );
    expect(formatError(err)).toMatch(
      /^CdkdError: --profile dev: credential provider chain resolved without usable credentials\./
    );
  });
});

describe('redactedAwsCause: a cdkd wrapper is unwrapped to the SDK error it holds', () => {
  it("carries the wrapped SDK error's fields, not the wrapper's", async () => {
    const { redactedAwsCause } = await import('../../../src/utils/local-aws-failure.js');
    const { StateError } = await import('../../../src/utils/error-handler.js');
    const sdk = serviceError('SlowDown', 'Please reduce your request rate.');
    const cause = redactedAwsCause(new StateError('Failed to verify', sdk), 'op failed') as Error & {
      $metadata?: unknown;
    };
    expect(cause.name).toBe('SlowDown');
    expect(cause.$metadata).toEqual({ httpStatusCode: 403 });
    expect(cause.message).toBe('op failed');
  });

  it("walks past normalizeAwsError's rewrite to the SDK error behind it", async () => {
    const { redactedAwsCause } = await import('../../../src/utils/local-aws-failure.js');
    const { StateError } = await import('../../../src/utils/error-handler.js');
    const sdk = Object.assign(new Error('UnknownError'), {
      name: 'Unknown',
      $metadata: { httpStatusCode: 503 },
    });
    const rewrite = new Error('S3 error during HeadBucket', { cause: sdk });
    const cause = redactedAwsCause(new StateError('Failed to verify', rewrite), 'op failed') as Error & {
      $metadata?: unknown;
    };
    expect(cause.name).toBe('Unknown');
    expect(cause.$metadata).toEqual({ httpStatusCode: 503 });
  });

  it('stops at the third link when no link carries $metadata', async () => {
    const { redactedAwsCause } = await import('../../../src/utils/local-aws-failure.js');
    const { StateError } = await import('../../../src/utils/error-handler.js');
    const named = (name: string, cause?: Error): Error =>
      Object.assign(new Error(name, cause ? { cause } : {}), { name });
    const chain = new StateError('wrapper', named('L1', named('L2', named('L3', named('L4')))));
    expect(redactedAwsCause(chain, 'op failed')?.name).toBe('L3');
  });
});
