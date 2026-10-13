import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import { getLogger } from '../../../src/utils/logger.js';

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

const sts = vi.hoisted(() => ({ fail: undefined as unknown, empty: false }));

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
    };
  }),
  GetCallerIdentityCommand: vi.fn(function GetCallerIdentityCommand(this: unknown) {}),
  AssumeRoleCommand: vi.fn(function AssumeRoleCommand(this: unknown) {}),
}));

const { describeLocalAwsFailureForWarn } = await import(
  '../../../src/cli/commands/local-aws-failure.js'
);
const { resolvePseudoParametersForInvoke, applyLambdaCredentialEnv } = await import(
  '../../../src/cli/commands/local-invoke.js'
);
const { resolvePseudoParametersForStartApi } = await import(
  '../../../src/cli/commands/local-start-api.js'
);
const { buildEcsImageResolutionContext } = await import(
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
    expect(describeLocalAwsFailureForWarn(err, 'STS AssumeRole')).toBe(err.message);
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
      'InternalFailure: We encountered an internal error. Please try again.'
    );
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
