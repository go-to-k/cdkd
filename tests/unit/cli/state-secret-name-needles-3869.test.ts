/**
 * Two `cdkd state` subcommands that hand a STATE record to a provider mask a
 * physical name derived from a secret on every line logged meanwhile
 * (go-to-k/cdkd#3869 item 1), as `cdkd drift` does:
 *
 *  - `refresh-observed`: the provider's `readCurrentState` lines, and the
 *    command's warning quoting a failed read's AWS error;
 *  - `orphan --resource`: a live `Fn::GetAtt` read's provider lines, the audit
 *    line naming the id a `Ref` is rewritten to, and an unresolvable read's
 *    reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';

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
  resolveStateBucketWithDefaultAndSource: vi.fn(async () => ({ bucket: 'test-bucket' })),
  resolveApp: vi.fn(() => undefined),
}));
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation((config?: { region?: string }) => ({
    configuredRegion: config?.region,
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(),
}));
const mockGetState = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    saveState: vi.fn(async () => '"etag-2"'),
    listStacks: vi.fn(async () => [{ stackName: 'App', region: 'us-east-1' }]),
    deleteState: vi.fn(),
    verifyBucketExists: vi.fn(async () => undefined),
    rotateCreateTokenNonce: vi.fn(async () => undefined),
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
    forceReleaseLock: vi.fn(async () => undefined),
    isLocked: vi.fn(async () => false),
    getLockInfo: vi.fn(async () => null),
  })),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const mockProvider = vi.hoisted(() => ({
  readCurrentState: vi.fn(),
  getAttribute: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProvider: () => mockProvider,
    getProviderFor: () => ({ provider: mockProvider, provisionedBy: 'sdk' }),
    shouldSkipResource: () => false,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';
import { getLogger } from '../../../src/utils/logger.js';

const ROLE_ID = 'App-team-secret-role';

function stateWith(roleName: string): Record<string, unknown> {
  return {
    version: 10,
    stackName: 'App',
    region: 'us-east-1',
    resources: {
      Role: {
        physicalId: ROLE_ID,
        resourceType: 'AWS::IAM::Role',
        properties: { RoleName: roleName },
        attributes: { Arn: `arn:aws:iam::123456789012:role/${ROLE_ID}` },
        dependencies: [],
      },
      Profile: {
        physicalId: 'App-profile',
        resourceType: 'AWS::IAM::InstanceProfile',
        properties: { Roles: [ROLE_ID] },
        attributes: {},
        dependencies: ['Role'],
      },
      Keeper: {
        physicalId: 'keeper-param',
        resourceType: 'AWS::SSM::Parameter',
        properties: {
          Value: { Ref: 'Role' },
          Description: { 'Fn::GetAtt': ['Role', 'Arn'] },
        },
        attributes: {},
        dependencies: ['Role'],
      },
    },
    outputs: {},
    lastModified: 1,
  };
}

async function run(args: string[]): Promise<string[]> {
  logLines.length = 0;
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(args, { from: 'user' });
  } catch {
    // an aborted orphan, a non-zero refresh exit
  } finally {
    process.stdout.write = original;
  }
  return [...logLines];
}

const SECRET_NAMED: Array<[string, string]> = [
  ['a secret reference', '{{resolve:secretsmanager:team-name}}'],
  ['the redaction mask', '***'],
];

let exitSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: boolean | undefined;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  mockGetState.mockReset();
  mockProvider.readCurrentState.mockReset();
  mockProvider.getAttribute.mockReset();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('__exit__');
  }) as never);
});
afterEach(() => {
  setStdinIsTty(originalIsTTY);
  exitSpy.mockRestore();
});

describe('cdkd state refresh-observed masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  async function refresh(roleName: string): Promise<string[]> {
    mockGetState.mockImplementation(async () => ({ state: stateWith(roleName), etag: 'e' }));
    const log = getLogger();
    mockProvider.readCurrentState.mockImplementation(async (physicalId: string) => {
      log.debug(`Reading ${physicalId}`);
      if (physicalId === 'App-profile') {
        throw new Error(`The role with name ${ROLE_ID} cannot be found.`);
      }
      return {};
    });
    const lines = await run(['refresh-observed', 'App', '--yes']);
    // Premise: every record was read.
    expect(mockProvider.readCurrentState).toHaveBeenCalledTimes(3);
    return lines;
  }

  it.each(SECRET_NAMED)(
    "masks the provider's lines and the failed read's warning (%s)",
    async (_l, roleName) => {
      const lines = await refresh(roleName);
      expect(lines).toContain("debug Reading ***");
      expect(lines).toContain("debug Reading keeper-param");
      const failure = lines.filter((l) => l.includes('cannot be found'));
      expect(failure.length).toBe(1);
      expect(lines.join('\n')).not.toContain(ROLE_ID);
    }
  );

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await refresh('plain-role-name');
    expect(lines).toContain(`debug Reading ${ROLE_ID}`);
    expect(lines.filter((l) => l.includes('cannot be found')).join('\n')).toContain(ROLE_ID);
  });
});

describe('cdkd state orphan --resource masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  /**
   * `readFails`: the live read throws AWS's error naming the role. `force`:
   * `--force`, which on a failed read warns with that error and falls back to
   * the recorded attribute (an ARN carrying the name).
   */
  async function orphan(roleName: string, readFails: boolean, force: boolean): Promise<string[]> {
    mockGetState.mockImplementation(async () => ({ state: stateWith(roleName), etag: 'e' }));
    const log = getLogger();
    mockProvider.getAttribute.mockImplementation(async (physicalId: string) => {
      log.debug(`Reading attribute Arn of role ${physicalId}`);
      if (readFails) throw new Error(`The role with name ${physicalId} cannot be found.`);
      return `arn:aws:iam::123456789012:role/${physicalId}`;
    });
    const lines = await run([
      'orphan',
      'App',
      '--resource',
      'Role',
      '--yes',
      ...(force ? ['--force'] : []),
    ]);
    // Premise: the live read ran, and the audit or the unresolvable report printed.
    expect(mockProvider.getAttribute).toHaveBeenCalled();
    expect(lines.some((l) => l.includes('Keeper.properties.'))).toBe(true);
    if (readFails) expect(lines.some((l) => l.includes('cannot be found'))).toBe(true);
    return lines;
  }

  const SHAPES: Array<[string, boolean, boolean]> = [
    ['a read that answers', false, false],
    ['a read that answers, --force', false, true],
    ['a failed read (unresolvable)', true, false],
    ['a failed read, --force (cache fallback)', true, true],
  ];

  it.each(
    SECRET_NAMED.flatMap(([label, roleName]) =>
      SHAPES.map(([shape, readFails, force]) => [label, shape, roleName, readFails, force] as const)
    )
  )('masks every line naming the role (%s, %s)', async (_l, _s, roleName, readFails, force) => {
    const lines = await orphan(roleName, readFails, force);
    expect(lines).toContain('debug Reading attribute Arn of role ***');
    expect(lines.join('\n')).not.toContain(ROLE_ID);
  });

  it.each(SHAPES)('negative control: an ordinary name prints as it is (%s)', async (_s, readFails, force) => {
    const lines = await orphan('plain-role-name', readFails, force);
    expect(lines).toContain(`debug Reading attribute Arn of role ${ROLE_ID}`);
    expect(lines.filter((l) => !l.startsWith('debug ')).join('\n')).toContain(ROLE_ID);
  });
});
