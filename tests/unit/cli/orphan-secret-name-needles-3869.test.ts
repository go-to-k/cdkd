/**
 * `cdkd orphan` masks a physical name derived from a secret while it rewrites
 * the references to an orphaned resource (go-to-k/cdkd#3869 item 1): a live
 * `Fn::GetAtt` read's provider line, and the audit line naming the id a `Ref`
 * is rewritten to. `cdkd state orphan --resource` shares the bag; its cases
 * are in `state-secret-name-needles-3869.test.ts`.
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
  resolveApp: vi.fn(() => undefined),
}));
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
const mockGetState = vi.hoisted(() => vi.fn());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    saveState: vi.fn(async () => '"etag-2"'),
    listStacks: vi.fn(async () => [{ stackName: 'App', region: 'us-east-1' }]),
    verifyBucketExists: vi.fn(async () => undefined),
    rotateCreateTokenNonce: vi.fn(async () => undefined),
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    getLockInfo: vi.fn(async () => null),
    releaseLock: vi.fn(async () => undefined),
  })),
}));
const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const mockGetAttribute = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: { getAttribute: mockGetAttribute } }),
  })),
}));

import { createOrphanCommand } from '../../../src/cli/commands/orphan.js';
import { getLogger } from '../../../src/utils/logger.js';

const ROLE_ID = 'App-team-secret-role';

async function orphanRole(roleName: string, readFails = false): Promise<string[]> {
  mockSynthesize.mockResolvedValue({
    stacks: [
      {
        stackName: 'App',
        displayName: 'App',
        template: {
          Resources: {
            Role: { Type: 'AWS::IAM::Role', Metadata: { 'aws:cdk:path': 'App/Role' } },
            Keeper: { Type: 'AWS::SSM::Parameter', Metadata: { 'aws:cdk:path': 'App/Keeper' } },
          },
        },
        region: 'us-east-1',
      },
    ],
  });
  mockGetState.mockResolvedValue({
    state: {
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
    },
    etag: '"e"',
  });
  const log = getLogger();
  mockGetAttribute.mockImplementation(async (physicalId: string) => {
    log.debug(`Reading attribute Arn of role ${physicalId}`);
    if (readFails) throw new Error(`The role with name ${physicalId} cannot be found.`);
    return `arn:aws:iam::123456789012:role/${physicalId}`;
  });
  logLines.length = 0;
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createOrphanCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['App/Role', '--app', 'noop', '--yes'], { from: 'user' });
  } catch (err) {
    // A failed read aborts the orphan (unresolvable); anything else is a defect.
    if (!readFails) throw err;
  } finally {
    process.stdout.write = original;
  }
  // Premise: the live read ran and the audit printed the rewrite.
  expect(mockGetAttribute).toHaveBeenCalled();
  expect(logLines.some((l) => l.includes(readFails ? 'cannot be found' : 'Keeper.properties.Value'))).toBe(
    true
  );
  return [...logLines];
}

describe('cdkd orphan masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  let originalIsTTY: boolean | undefined;
  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    setStdinIsTty(true);
    mockGetState.mockReset();
    mockGetAttribute.mockReset();
  });
  afterEach(() => {
    setStdinIsTty(originalIsTTY);
  });

  it.each([
    ['a secret reference', '{{resolve:secretsmanager:team-name}}'],
    ['the redaction mask', '***'],
  ])("masks the provider's line and the audit's rewritten id (%s)", async (_l, roleName) => {
    const lines = await orphanRole(roleName);
    expect(lines).toContain('debug Reading attribute Arn of role ***');
    expect(lines.join('\n')).not.toContain(ROLE_ID);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await orphanRole('plain-role-name');
    expect(lines).toContain(`debug Reading attribute Arn of role ${ROLE_ID}`);
    expect(lines.filter((l) => l.includes('Keeper.properties.Value')).join('\n')).toContain(
      ROLE_ID
    );
  });
});

describe('cdkd orphan masks an unresolvable read naming the name (go-to-k/cdkd#3869)', () => {
  let originalIsTTY: boolean | undefined;
  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    setStdinIsTty(true);
    mockGetState.mockReset();
    mockGetAttribute.mockReset();
  });
  afterEach(() => {
    setStdinIsTty(originalIsTTY);
  });

  it("masks the unresolvable report quoting AWS's error", async () => {
    const lines = await orphanRole('***', true);
    expect(lines.join('\n')).not.toContain(ROLE_ID);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await orphanRole('plain-role-name', true);
    expect(lines.filter((l) => l.includes('cannot be found')).join('\n')).toContain(ROLE_ID);
  });
});
