/**
 * go-to-k/cdkd#6499: `cdkd drift --revert` on a Cloud Control routed resource
 * sends the TEMPLATE value of a readable top-level property holding a nested
 * write-only member. The readback-shaped container lacked the member, so an
 * `AWS::Events::Connection`'s `AuthParameters` arrived without `ApiKeyValue`
 * and Cloud Control refused every revert of a connection. A
 * `{{resolve:secretsmanager:...}}` value is sent resolved, and the resolved
 * plaintext stays masked on what the update prints.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

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

const SECRET_EXPR = '{{resolve:secretsmanager:cdkd-test-key:SecretString:key::}}';
const SECRET_PLAINTEXT = 'cdkd-conn-key-6499';

const mockSecretsManagerSend = vi.hoisted(() =>
  vi.fn(async () => ({ SecretString: JSON.stringify({ key: 'cdkd-conn-key-6499' }) }))
);
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
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
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: vi.fn(async () => [{ stackName: 'TestStack', region: 'us-east-1' }]),
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: vi.fn(async () => '"etag-2"'),
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

const provider = {
  readCurrentState: vi.fn(),
  update: vi.fn(),
};
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProvider: () => provider,
    getProviderFor: () => ({ provider, provisionedBy: 'cc-api' }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
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
vi.mock('../../../src/provisioning/read-only-properties.js', () => ({
  getReadOnlyPropertyPaths: vi.fn(async () => ['Arn', 'SecretArn']),
}));
vi.mock('../../../src/provisioning/write-only-properties.js', () => ({
  tryGetTopLevelWriteOnlyProperties: vi.fn(async () => new Set(['AuthParameters'])),
  getTopLevelKeysHoldingUnreadableCreateOnly: vi.fn(() => new Set()),
  getSettledWriteOnlyPropertyPaths: () => [['AuthParameters', 'ApiKeyAuthParameters', 'ApiKeyValue']],
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';

const TYPE = 'AWS::Events::Connection';
const NAME = 'conn-1';

function stack(apiKeyValue: string): { state: StackState; etag: string } {
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: {
        Conn: {
          physicalId: NAME,
          resourceType: TYPE,
          provisionedBy: 'cc-api',
          properties: {
            AuthorizationType: 'API_KEY',
            Description: 'v1',
            AuthParameters: { ApiKeyAuthParameters: { ApiKeyName: 'x-api-key', ApiKeyValue: apiKeyValue } },
          },
          observedProperties: {
            AuthorizationType: 'API_KEY',
            Description: 'v1',
            AuthParameters: { ApiKeyAuthParameters: { ApiKeyName: 'x-api-key' } },
          },
        },
      },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdout = '';

async function runDrift(flags: string[]): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', ...flags], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
}

/** The `AuthParameters` the one update was sent. */
function sentAuth(): unknown {
  expect(provider.update).toHaveBeenCalledTimes(1);
  return (provider.update.mock.calls[0]![3] as Record<string, unknown>)['AuthParameters'];
}

describe('cdkd drift --revert sends a nested write-only member at its template value (go-to-k/cdkd#6499)', () => {
  beforeEach(() => {
    logLines.length = 0;
    mockGetState.mockReset();
    mockSecretsManagerSend.mockClear();
    provider.readCurrentState.mockReset();
    provider.readCurrentState.mockResolvedValue({
      AuthorizationType: 'API_KEY',
      Description: 'oob',
      AuthParameters: { ApiKeyAuthParameters: { ApiKeyName: 'x-api-key' } },
    });
    provider.update.mockReset();
    provider.update.mockImplementation(async (_l: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
    }));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('a literal key goes back inside the container, beside the reverted drift', async () => {
    mockGetState.mockResolvedValue(stack('plain-key'));
    await runDrift(['--revert', '--yes']);
    expect(sentAuth()).toEqual({
      ApiKeyAuthParameters: { ApiKeyName: 'x-api-key', ApiKeyValue: 'plain-key' },
    });
    expect((provider.update.mock.calls[0]![3] as Record<string, unknown>)['Description']).toBe('v1');
  });

  it('a dynamic reference is sent resolved, and masked on the update’s own log line', async () => {
    mockGetState.mockResolvedValue(stack(SECRET_EXPR));
    provider.update.mockImplementation(async (_l: string, physicalId: string, _t: string, props) => {
      const auth = (props as Record<string, Record<string, Record<string, string>>>)['AuthParameters'];
      const { getLogger } = await import('../../../src/utils/logger.js');
      getLogger().info(`Applying key ${auth!['ApiKeyAuthParameters']!['ApiKeyValue']}`);
      return { physicalId, wasReplaced: false };
    });
    await runDrift(['--revert', '--yes']);
    expect(sentAuth()).toEqual({
      ApiKeyAuthParameters: { ApiKeyName: 'x-api-key', ApiKeyValue: SECRET_PLAINTEXT },
    });
    expect(logLines).toContain('info Applying key ***');
    expect(logLines.join('\n')).not.toContain(SECRET_PLAINTEXT);
  });

  it('keeps the resolved key masked when the update throws it', async () => {
    mockGetState.mockResolvedValue(stack(SECRET_EXPR));
    provider.update.mockImplementation(async () => {
      throw new Error(`rejected key ${SECRET_PLAINTEXT}`);
    });
    await runDrift(['--revert', '--yes']);
    expect(logLines.some((l) => l.includes('rejected key ***'))).toBe(true);
    expect(logLines.join('\n')).not.toContain(SECRET_PLAINTEXT);
  });

  it('never sends an unresolvable reference as text: the container stays readback-shaped', async () => {
    const unsupported = '{{resolve:unknownsvc:whatever}}';
    mockGetState.mockResolvedValue(stack(unsupported));
    await runDrift(['--revert', '--yes']);
    expect(JSON.stringify(provider.update.mock.calls.map((c) => c[3]))).not.toContain(unsupported);
  });

  it('keeps an accepted readable member: only the write-only key comes from the template', async () => {
    const s = stack('plain-key');
    const conn = s.state.resources['Conn']!;
    (conn.observedProperties as Record<string, unknown>)['AuthParameters'] = {
      ApiKeyAuthParameters: { ApiKeyName: 'x-accepted' },
    };
    mockGetState.mockResolvedValue(s);
    provider.readCurrentState.mockResolvedValue({
      AuthorizationType: 'API_KEY',
      Description: 'v1',
      AuthParameters: { ApiKeyAuthParameters: { ApiKeyName: 'x-third' } },
    });
    await runDrift(['--revert', '--yes']);
    expect(sentAuth()).toEqual({
      ApiKeyAuthParameters: { ApiKeyName: 'x-accepted', ApiKeyValue: 'plain-key' },
    });
  });

  it('warns when a named key could not be sent', async () => {
    mockGetState.mockResolvedValue(stack('{{resolve:unknownsvc:whatever}}'));
    await runDrift(['--revert', '--yes']);
    expect(
      logLines.some((l) => l.includes("could not send the template's write-only fields of AuthParameters"))
    ).toBe(true);
  });

  it('names the container in the plan, never the key', async () => {
    mockGetState.mockResolvedValue(stack(SECRET_EXPR));
    await runDrift(['--revert', '--dry-run']);
    expect(provider.update).not.toHaveBeenCalled();
    expect(stdout).toContain(
      "    + also sends the template's write-only fields of AuthParameters (AWS never returns them on a read)"
    );
    expect(stdout).not.toContain(SECRET_PLAINTEXT);
  });
});
