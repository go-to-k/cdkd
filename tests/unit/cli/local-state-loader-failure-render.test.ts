import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CdkdError, StateError } from '../../../src/utils/error-handler.js';
import { getLogger } from '../../../src/utils/logger.js';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';

/**
 * go-to-k/cdkd#4857: the three `--from-state` state-bucket warns render a
 * failure through the `cdkd local` AWS-failure policy (go-to-k/cdkd#2300). A
 * credential-chain failure's text -- a `credential_process` helper's command
 * line -- is withheld to its class with the full text at debug, while cdkd's
 * own remedies (`cdkd bootstrap`) still print.
 */
const mocks = vi.hoisted(() => ({
  resolveBucket: vi.fn(),
  verifyBucketExists: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: mocks.resolveBucket,
}));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mocks.verifyBucketExists,
  })),
}));
vi.mock('../../../src/utils/aws-clients.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../src/utils/aws-clients.js'
  );
  return {
    ...actual,
    AwsClients: vi.fn().mockImplementation(() => ({ s3: {}, destroy: vi.fn() })),
  };
});

const { formatError } = await import('../../../src/utils/error-handler.js');
const { loadStateForStack, buildCrossStackResolver, describeStateBucketAccessFailure } =
  await import('../../../src/cli/commands/local-state-loader.js');

const SECRET_CMD = '/usr/local/bin/get-creds --token hunter2-not-a-real-token';
function credentialFailure(): Error {
  return Object.assign(new Error(`credential_process ${SECRET_CMD} exited with code 1`), {
    name: 'CredentialsProviderError',
    $metadata: { attempts: 1, totalRetryDelay: 0 },
  });
}
const NO_BUCKET = new StateError(
  "No cdkd state bucket found for account 123456789012. Run 'cdkd bootstrap' to create 'cdkd-state-123456789012'."
);

// cdk-local logs the withheld text at debug on its own logger, which cdkd's
// embed config hands to cdkd's logger (go-to-k/cdkd#2429): install it the way
// every `cdkd local` command does.
createLocalCommand();
const warnSpy = vi.spyOn(getLogger(), 'warn');
const debugSpy = vi.spyOn(getLogger(), 'debug');
const warned = (needle: string): string[] =>
  warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(needle));
const debugged = (): string => debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
// The other polarity: the withheld text reaches cdkd's logger and NOT the
// console through cdk-local's own logger.
const consoleSpies = (['log', 'info', 'debug', 'warn', 'error'] as const).map((m) =>
  vi.spyOn(console, m)
);
const consoled = (): string =>
  consoleSpies.flatMap((spy) => spy.mock.calls.map((c) => c.map(String).join(' '))).join('\n');

beforeEach(() => {
  mocks.resolveBucket.mockReset();
  mocks.verifyBucketExists.mockReset();
  warnSpy.mockReset();
  warnSpy.mockImplementation(() => {});
  debugSpy.mockReset();
  debugSpy.mockImplementation(() => {});
  for (const spy of consoleSpies) {
    spy.mockReset();
    spy.mockImplementation(() => {});
  }
});

const resolutionSites = [
  {
    name: 'loadStateForStack',
    needle: '--from-state: could not resolve state bucket: ',
    run: () => loadStateForStack('MyStack', 'us-east-1', { statePrefix: 'cdkd', region: 'us-east-1' }),
  },
  {
    name: 'buildCrossStackResolver',
    needle: '--from-state: cross-stack resolver could not resolve state bucket: ',
    run: () => buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' }),
  },
] as const;

describe.each(resolutionSites)('$name: state-bucket resolution failure', ({ needle, run }) => {
  it('withholds a credential-chain failure and logs it at debug', async () => {
    mocks.resolveBucket.mockRejectedValue(credentialFailure());
    await run();
    const lines = warned(needle);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${needle}CredentialsProviderError; `);
    expect(lines[0]).not.toContain('hunter2');
    expect(debugged()).toContain(SECRET_CMD);
    expect(consoled()).not.toContain(SECRET_CMD);
  });

  it("prints cdkd's own 'cdkd bootstrap' remedy in full", async () => {
    mocks.resolveBucket.mockRejectedValue(NO_BUCKET);
    await run();
    expect(warned(needle)[0]).toContain(`${needle}${NO_BUCKET.message.slice(0, -1)}. `);
  });
});

describe('buildCrossStackResolver: state-bucket access failure', () => {
  const needle = '--from-state: cross-stack resolver could not access state bucket my-bucket: ';

  it('withholds the credential-chain text verifyBucketExists wrapped into its StateError', async () => {
    mocks.resolveBucket.mockResolvedValue('my-bucket');
    const raw = credentialFailure();
    mocks.verifyBucketExists.mockRejectedValue(
      new StateError(`Failed to verify state bucket 'my-bucket': ${raw.message}`, raw)
    );
    await buildCrossStackResolver('us-east-1', { statePrefix: 'cdkd' });
    const lines = warned(needle);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${needle}CredentialsProviderError; `);
    expect(lines[0]).not.toContain('hunter2');
    expect(debugged()).toContain(SECRET_CMD);
    expect(consoled()).not.toContain(SECRET_CMD);
  });
});

describe('loadStateForStack: an uncaught verifyBucketExists failure (#4857)', () => {
  it('rethrows it rendered, with no SDK text on the Caused by line', async () => {
    mocks.resolveBucket.mockResolvedValue('my-bucket');
    const raw = credentialFailure();
    mocks.verifyBucketExists.mockRejectedValue(
      new StateError(`Failed to verify state bucket 'my-bucket': ${raw.message}`, raw)
    );
    const err = await loadStateForStack('MyStack', 'us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(StateError);
    const printed = formatError(err);
    expect(printed).toContain(
      '--from-state: could not access state bucket my-bucket: CredentialsProviderError; '
    );
    expect(printed).not.toContain('hunter2');
    expect(((err as Error).cause as Error | undefined)?.name).toBe('CredentialsProviderError');
  });

  it("keeps the missing-bucket StateError's cdkd bootstrap remedy", async () => {
    mocks.resolveBucket.mockResolvedValue('my-bucket');
    mocks.verifyBucketExists.mockRejectedValue(
      new StateError(
        "State bucket 'my-bucket' does not exist. Run 'cdkd bootstrap' to create it.",
        Object.assign(new Error('Not Found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      )
    );
    const err = await loadStateForStack('MyStack', 'us-east-1', {
      statePrefix: 'cdkd',
      region: 'us-east-1',
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toBe(
      "--from-state: could not access state bucket my-bucket: State bucket 'my-bucket' does not exist. Run 'cdkd bootstrap' to create it."
    );
  });
});

describe('describeStateBucketAccessFailure', () => {
  it.each(['NotFound', 'NoSuchBucket'])(
    "prints the missing-bucket StateError's own remedy (%s)",
    (name) => {
      const err = new StateError(
        "State bucket 'b' does not exist. Run 'cdkd bootstrap' to create it.",
        Object.assign(new Error('Not Found'), {
          name,
          $fault: 'client',
          $metadata: { httpStatusCode: 404 },
        })
      );
      // The renderer drops the one trailing period the call site re-adds.
      expect(describeStateBucketAccessFailure(err)).toBe(err.message.slice(0, -1));
    }
  );

  it("withholds normalizeAwsError's non-Error arm, which carries the thrown value's text", () => {
    const thrown = { toString: () => `boom ${SECRET_CMD}` };
    const wrapped = new Error(String(thrown), { cause: thrown });
    const err = new StateError(`Failed to verify state bucket 'b': ${wrapped.message}`, wrapped);
    const rendered = describeStateBucketAccessFailure(err);
    expect(rendered).toMatch(/^Error; \d+-character message withheld/);
    expect(rendered).not.toContain('hunter2');
  });

  it("prints normalizeAwsError's cdkd-written rewrite, not a withheld class", () => {
    const sdk = Object.assign(new Error('UnknownError'), {
      name: 'Unknown',
      $metadata: { httpStatusCode: 403 },
    });
    const rewrite = new Error("Access denied to state bucket 'b'. Verify credentials and bucket policy.", {
      cause: sdk,
    });
    const err = new StateError(`Failed to verify state bucket 'b': ${rewrite.message}`, rewrite);
    expect(describeStateBucketAccessFailure(err)).toBe(rewrite.message.slice(0, -1));
  });

  it("recognises the rewrite by the SDK's `UnknownError` message alone", () => {
    const sdk = Object.assign(new Error('UnknownError'), {
      name: 'SomeOtherName',
      $metadata: { httpStatusCode: 403 },
    });
    const rewrite = new Error("Access denied to state bucket 'b'. Verify credentials and bucket policy.", {
      cause: sdk,
    });
    const err = new StateError(`Failed to verify state bucket 'b': ${rewrite.message}`, rewrite);
    expect(describeStateBucketAccessFailure(err)).toBe(rewrite.message.slice(0, -1));
  });

  it('keeps a modeled service exception message from the cause', () => {
    const sdk = Object.assign(new Error('Forbidden'), {
      name: 'AccessDenied',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    });
    const err = new StateError(`Failed to verify state bucket 'b': ${sdk.message}`, sdk);
    expect(describeStateBucketAccessFailure(err)).toBe('AccessDenied: Forbidden');
  });

  it('renders a non-CdkdError through the shared policy', () => {
    expect(describeStateBucketAccessFailure(credentialFailure())).toMatch(
      /^CredentialsProviderError; \d+-character message withheld/
    );
    expect(describeStateBucketAccessFailure(new CdkdError('cdkd text', 'X'))).toBe('cdkd text');
  });
});
