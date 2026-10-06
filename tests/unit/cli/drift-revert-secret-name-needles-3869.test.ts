/**
 * `cdkd drift --revert` masks a physical name derived from a secret on every
 * line the reverting provider logs (go-to-k/cdkd#3869 security review). The
 * revert called `provider.update` with nothing bound, so a reader of a
 * secret-named resource (an access key's `UserName`) printed the name. It now
 * runs under the same per-resource printing bag as a `cdkd destroy` delete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const make = (): Record<string, unknown> => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
  getAwsClients: vi.fn(),
}));
const mockGetState = vi.fn<() => Promise<{ state: StackState; etag: string } | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
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

const USER_ID = 'team-secret-drift-user';

function stateWith(userName: string): { state: StackState; etag: string } {
  return {
    state: {
      version: 2,
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
          properties: { UserName: USER_ID, Status: 'Active' },
          attributes: {},
          dependencies: ['User'],
        },
      },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

async function revertLine(userName: string): Promise<string | undefined> {
  let line: string | undefined;
  const keyProvider = {
    readCurrentState: vi.fn(async () => ({ UserName: USER_ID, Status: 'Inactive' })),
    update: vi.fn(async () => {
      const text = `Updating access key of user ${USER_ID}`;
      line = currentLogLineMasker()?.(text) ?? text;
      return { physicalId: 'AKIAEXAMPLEKEY', wasReplaced: false };
    }),
  };
  const userProvider = { readCurrentState: vi.fn(async () => undefined) };
  mockGetProvider.mockImplementation((type: string) =>
    type === 'AWS::IAM::AccessKey' ? keyProvider : userProvider
  );
  mockGetState.mockResolvedValue(stateWith(userName));
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
  expect(keyProvider.update).toHaveBeenCalledTimes(1);
  return line;
}

describe('cdkd drift --revert masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
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

  it("masks a reader's revert line naming a secret-named user", async () => {
    expect(await revertLine('***')).toBe('Updating access key of user ***');
  });

  it('negative control: an ordinary name prints as it is', async () => {
    expect(await revertLine('plain-user-name')).toBe(`Updating access key of user ${USER_ID}`);
  });
});
