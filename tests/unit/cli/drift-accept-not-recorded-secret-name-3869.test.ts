/**
 * `cdkd drift --accept`'s "was NOT recorded" warning prints the change's path
 * masked with the row's printing bag (go-to-k/cdkd#3869). The arm is reached as
 * in drift-secret-redaction.test.ts: a PUBLIC `{{resolve:ssm:...}}` in
 * `properties` is copied back over the accepted value by the redaction, here at
 * a path keyed by a secret-derived name.
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
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  // The resolver's ambient clients: a PUBLIC ssm parameter.
  getAwsClients: () => ({
    ssm: {
      send: async () => ({ Parameter: { Value: 'public-v1', Type: 'String' } }),
    },
  }),
}));
const mockSaveState = vi.fn(async (..._args: unknown[]) => '"etag-2"');
const mockGetState = vi.fn<() => Promise<{ state: StackState; etag: string } | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: vi.fn(async () => [{ stackName: 'TestStack', region: 'us-east-1' }]),
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
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
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const USER_ID = 'team-secret-drift-user';
const PUBLIC_SSM_EXPR = '{{resolve:ssm:/cdkd/test/public}}';

async function accept(userName: string): Promise<string[]> {
  logLines.length = 0;
  mockGetState.mockResolvedValue({
    state: {
      version: STATE_SCHEMA_VERSION_CURRENT,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: {
        User: {
          physicalId: USER_ID,
          resourceType: 'AWS::IAM::User',
          properties: { UserName: userName },
          attributes: {},
          dependencies: [],
        },
        Key: {
          physicalId: 'AKIAEXAMPLEKEY',
          resourceType: 'AWS::IAM::AccessKey',
          properties: { UserName: USER_ID, Meta: { [USER_ID]: PUBLIC_SSM_EXPR } },
          observedProperties: { UserName: USER_ID, Meta: { [USER_ID]: 'public-v1' } },
          attributes: {},
          dependencies: ['User'],
        },
      },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  });
  mockGetProvider.mockImplementation((type: string) =>
    type === 'AWS::IAM::AccessKey'
      ? {
          readCurrentState: async () => ({
            UserName: USER_ID,
            Meta: { [USER_ID]: 'changed-in-console' },
          }),
        }
      : { readCurrentState: async () => ({ UserName: userName }) }
  );
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(
      ['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', '--accept', '--yes'],
      { from: 'user' }
    );
  } catch {
    // exit / process.exit stub
  } finally {
    process.stdout.write = original;
  }
  return [...logLines];
}

describe("cdkd drift --accept's not-recorded warning masks the path (go-to-k/cdkd#3869)", () => {
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

  it.each([
    ['a secret-named user', '***', 'Meta.***'],
    ['negative control, an ordinary name', 'plain-user-name', `Meta.${USER_ID}`],
  ])('%s', async (_l, userName, expected) => {
    const lines = await accept(userName);
    const warned = lines.filter((l) => l.includes('was NOT recorded'));
    // Premise: the not-recorded arm ran.
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain(`'${expected}'`);
  });
});
