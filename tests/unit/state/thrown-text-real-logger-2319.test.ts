/**
 * The debug line that carries AWS's withheld text (go-to-k/cdkd#2319) is
 * masked by the REAL logger: `ConsoleLogger` applies the bound-secret masker
 * to every line it formats. `s3-state-backend-thrown-text-2319.test.ts` mocks
 * the logger, so this file drives one `S3StateBackend` site and one
 * `LockManager` site through the real one and reads what reached the console.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { LockManager } from '../../../src/state/lock-manager.js';
import { getLogger } from '../../../src/utils/logger.js';
import { withPrintingSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import { recordLogOnlyValue, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { StateBackendConfig } from '../../../src/types/config.js';

vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return { ...actual, resolveBucketRegion: vi.fn().mockResolvedValue('us-east-1') };
});

const SECRET = 'debug-secret-k3';
const AWS_TEXT = `User: arn:aws:sts::123456789012:assumed-role/Deployer/${SECRET} is not authorized`;

const failingClient = (command: string): S3Client =>
  ({
    send: vi.fn(async (c: { constructor: { name: string } }) => {
      if (c.constructor.name === command) {
        throw new S3ServiceException({
          name: 'AccessDenied',
          message: AWS_TEXT,
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        } as never);
      }
      return {};
    }),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () => Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'x' }),
    },
  }) as unknown as S3Client;

const config: StateBackendConfig = { bucket: 'b', prefix: 'stacks' };

let previousLevel: ReturnType<ReturnType<typeof getLogger>['getLevel']>;
let printed: string[];

beforeEach(() => {
  previousLevel = getLogger().getLevel();
  getLogger().setLevel('debug');
  printed = [];
  for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  getLogger().setLevel(previousLevel);
  vi.restoreAllMocks();
});

const sites = [
  {
    site: 'S3StateBackend.listStacks',
    head: 'Failed to list stacks: ',
    run: () => new S3StateBackend(failingClient('ListObjectsV2Command'), config).listStacks(),
  },
  {
    site: 'LockManager.acquireLock',
    head: 'Failed to acquire lock for stack MyStack (us-east-1): ',
    run: () =>
      new LockManager(failingClient('PutObjectCommand'), config, {
        disableRenewal: true,
      }).acquireLock('MyStack', 'us-east-1'),
  },
];

describe("the withheld AWS text's debug line, through the real logger (go-to-k/cdkd#2319)", () => {
  it.each(sites)('$site: printed, and masked under a bound secret', async (s) => {
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, SECRET);
    await withPrintingSecrets(bag, () => s.run().catch(() => undefined));
    const lines = printed.filter((l) => l.includes(s.head) && l.includes('is not authorized'));
    // Positive control: the line was emitted, with AWS's text in it.
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).toContain(SECRET_MASK);
  });

  it.each(sites)('$site: unmasked when no secret is bound (the mask is what removed it)', async (s) => {
    await s.run().catch(() => undefined);
    const lines = printed.filter((l) => l.includes(s.head) && l.includes('is not authorized'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(SECRET);
  });
});
