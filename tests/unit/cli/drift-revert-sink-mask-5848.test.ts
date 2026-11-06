/**
 * `cdkd drift --revert` masks a RESOLVED secret on a line the reverting
 * provider logs itself (go-to-k/cdkd#5848). The revert re-resolves the state's
 * `{{resolve:secretsmanager:...}}` expression into plaintext before
 * `provider.update`, but bound only the secret-NAME printing bag (#3869), not
 * that resolved bag. A provider's own `this.logger.*` line that skipped
 * `context.maskSecrets` therefore printed the plaintext. The update now runs
 * under `withPrintingSecrets(secrets, ...)`, so `ConsoleLogger`'s sink masks it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

// Each line through the sink masker `ConsoleLogger` applies, so a line the
// command masks only by the bag bound around it reads as the terminal shows it.
const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', async () => {
  const { currentLogLineMasker: sink } = await import('../../../src/utils/log-line-masker.js');
  const push =
    (level: string) =>
    (...args: unknown[]): void => {
      const line = args.map(String).join(' ');
      logLines.push(`${level} ${sink()?.(line) ?? line}`);
    };
  const make = (): Record<string, unknown> => ({
    setLevel: vi.fn(),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => make(),
  });
  return { reserveStdoutForPayload: vi.fn(), getLogger: () => make() };
});
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

const SECRET_EXPR = '{{resolve:secretsmanager:cdkd-test-secret:SecretString:password::}}';
const SECRET_PLAINTEXT = 'cdkd-revert-pw-5848';
const LITERAL = 'cdkd-literal-pw-5848';

// The drift command constructs its own `AwsClients` (s3), while the resolver
// reaches for the ambient one (secretsManager). Both come from this module.
const mockSecretsManagerSend = vi.hoisted(() =>
  vi.fn(async () => ({ SecretString: JSON.stringify({ password: 'cdkd-revert-pw-5848' }) }))
);
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({ secretsManager: { send: mockSecretsManagerSend } }),
}));
const mockGetState = vi.fn<() => Promise<{ state: StackState; etag: string } | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: vi.fn(async () => [{ stackName: 'TestStack', region: 'us-east-1' }]),
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: vi.fn(async () => '"etag-2"'),
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    getLockInfo: vi.fn(async () => null),
    releaseLock: vi.fn(async () => undefined),
  })),
}));
const mockGetProvider = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: (type: string) => mockGetProvider(type),
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockGetProvider(input.resourceType),
      provisionedBy: 'sdk',
    }),
    shouldSkipResource: () => false,
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
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';

function stateWith(password: string): { state: StackState; etag: string } {
  return {
    state: {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::Test::Database',
          properties: { Password: password, Description: 'desired' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

interface RevertRun {
  /** What `update` received as `Password`: the premise that it was plaintext. */
  received: unknown;
  /** The provider's own line, as the sink masker renders it. */
  line: string | undefined;
}

async function revert(password: string, fail = false): Promise<RevertRun> {
  const run: RevertRun = { received: undefined, line: undefined };
  logLines.length = 0;
  const provider = {
    // Only `Description` drifted; the revert pushes the re-resolved baseline back.
    readCurrentState: vi.fn(async () => ({
      Password: password === SECRET_EXPR ? SECRET_PLAINTEXT : password,
      Description: 'changed',
    })),
    update: vi.fn(
      async (
        _logicalId: string,
        _physicalId: string,
        _type: string,
        properties: Record<string, unknown>
      ) => {
        run.received = properties['Password'];
        if (fail) {
          // A non-retryable refusal quoting the value, logged by the
          // command's own failure line.
          throw markNonRetryable(new Error(`Rejected password ${String(properties['Password'])}`));
        }
        // A provider `this.logger.*` line that skipped `context.maskSecrets`:
        // the only masker it meets is the sink's.
        const text = `Applying password ${String(properties['Password'])}`;
        run.line = currentLogLineMasker()?.(text) ?? text;
        return { physicalId: 'db-1', wasReplaced: false };
      }
    ),
  };
  mockGetProvider.mockImplementation(() => provider);
  mockGetState.mockResolvedValue(stateWith(password));
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(
      ['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', '--revert', '--yes'],
      { from: 'user' }
    );
  } catch {
    // exit / process.exit stub
  } finally {
    process.stdout.write = original;
  }
  // Once on the success path; a non-retryable failure is not retried either.
  expect(provider.update).toHaveBeenCalledTimes(1);
  return run;
}

describe('cdkd drift --revert masks a resolved secret in a provider log line (go-to-k/cdkd#5848)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockGetState.mockReset();
    mockGetProvider.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('masks the plaintext the revert resolved, on the provider’s own line', async () => {
    const run = await revert(SECRET_EXPR);
    // Premise: the provider was handed the PLAINTEXT, not the expression.
    expect(run.received).toBe(SECRET_PLAINTEXT);
    expect(run.line).toBe('Applying password ***');
  });

  it('negative control: a literal value prints as it is', async () => {
    const run = await revert(LITERAL);
    expect(run.received).toBe(LITERAL);
    expect(run.line).toBe(`Applying password ${LITERAL}`);
  });

  it('keeps the plaintext masked when the update throws it', async () => {
    const run = await revert(SECRET_EXPR, true);
    expect(run.received).toBe(SECRET_PLAINTEXT);
    const failure = logLines.filter((l) => l.includes('Rejected password'));
    // Premise: the command logged the failure.
    expect(failure.length).toBeGreaterThan(0);
    expect(logLines.join('\n')).not.toContain(SECRET_PLAINTEXT);
  });
});
