import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * `cdkd import` of a resource the TEMPLATE names from a secret (go-to-k/cdkd#3869,
 * maintainer decision: masked, as go-to-k/cdkd#4811 masks `cdkd destroy`'s
 * listings): the provider's lines during the read, a failed read's AWS error,
 * and the `Import plan:` listing print `***` for the physical id.
 */

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
  return { getLogger: () => make(), reserveStdoutForPayload: vi.fn() };
});

const profile = vi.hoisted(() => ({ region: 'ap-northeast-1' as string | undefined }));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    config: {
      region: async (): Promise<string> => {
        if (!profile.region) throw new Error('Region is missing');
        return profile.region;
      },
    },
    send: vi.fn(async () => ({ Account: '123456789012' })),
    destroy: vi.fn(),
  })),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'cdk-out'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/assets/asset-redirect.js')>()),
  createAssetRedirectResolver: vi.fn(() => async (): Promise<unknown> => undefined),
}));

const stsSend = vi.hoisted(() => vi.fn(async () => ({ Account: '123456789012' })));
// Every CloudFormation `send` answers "no such stack", so the import takes its
// cdkd-native path.
const cfnSend = vi.hoisted(() =>
  vi.fn(async (command: { input: { StackName?: string } }) => {
    const err = new Error(`Stack with id ${command.input.StackName ?? ''} does not exist`);
    err.name = 'ValidationError';
    throw err;
  })
);
/** The region of the client each CloudFormation call went through. */
const cfnRegions = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation((cfg?: { region?: string }) => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return {
        clientRegion: cfg?.region,
        send: (command: { input: { StackName?: string } }) => {
          cfnRegions.push(cfg?.region);
          return cfnSend(command);
        },
      };
    },
    get sts() {
      return { send: stsSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ sts: { send: stsSend } })),
}));

vi.mock('../../../src/cli/commands/retire-cfn-stack.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/cli/commands/retire-cfn-stack.js')
  >('../../../src/cli/commands/retire-cfn-stack.js');
  return {
    prepareCloudFormationStackRetirement: vi.fn(async () => ({
      outcome: 'ready',
      templateUpdated: false,
    })),
    deleteRetiredCloudFormationStack: vi.fn(async () => undefined),
    findReplacedCfnResources: actual.findReplacedCfnResources,
    SUPERSEDED_COPY_HINT: actual.SUPERSEDED_COPY_HINT,
    cfnFailureText: actual.cfnFailureText,
    getCloudFormationResourceTree: vi.fn(async () => ({
      stackName: 'S',
      physicalId: 'S',
      resources: new Map(),
      nested: new Map(),
    })),
    tryGetCloudFormationResourceMap: vi.fn(async () => null),
    NESTED_STACK_RESOURCE_TYPE: actual.NESTED_STACK_RESOURCE_TYPE,
  };
});

/** `stackName -> regions` in which a state record exists. */
const held = vi.hoisted(() => ({ value: new Map<string, Set<string>>() }));
const backend = vi.hoisted(() => ({
  getState: vi.fn(),
  saveState: vi.fn(),
  stateExistsOwnedBy: vi.fn(),
}));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    verifyBucketExists: vi.fn(async () => undefined),
    getState: backend.getState,
    saveState: backend.saveState,
    stateExistsOwnedBy: backend.stateExistsOwnedBy,
    rawObjectExists: vi.fn(async () => false),
    markRollbackJournalImported: vi.fn(async () => []),
  })),
}));

const releaseLock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    getLockInfo: vi.fn(async () => null),
    releaseLock,
  })),
}));

const synthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const providerImport = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/provider-registry.js', () => {
  const provider = { import: providerImport };
  return {
    ProviderRegistry: vi.fn().mockImplementation(() => ({
      hasProvider: () => true,
      getProvider: () => provider,
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    })),
  };
});

import { createImportCommand } from '../../../src/cli/commands/import.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';

const ROLE_ID = 'S-team-secret-role';

function roleTemplate(roleName: string): CloudFormationTemplate {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {
      Role: {
        Type: 'AWS::IAM::Role',
        Properties: { RoleName: roleName, AssumeRolePolicyDocument: {} },
        Metadata: { 'aws:cdk:path': 'S/Role' },
      },
    },
  };
}

async function runImport(roleName: string, readFails: boolean, args: string[] = []): Promise<string[]> {
  logLines.length = 0;
  synthesize.mockResolvedValue({
    stacks: [
      {
        stackName: 'S',
        displayName: 'S',
        artifactId: 'S',
        template: roleTemplate(roleName),
        dependencyNames: [],
        region: 'us-east-1',
      },
    ],
  });
  const log = getLogger();
  providerImport.mockImplementation(async () => {
    log.debug(`Found role ${ROLE_ID}`);
    if (readFails) throw new Error(`The role with name ${ROLE_ID} cannot be found.`);
    return { physicalId: ROLE_ID, attributes: {} };
  });
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createImportCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['S', '--app', 'x', '--yes', '--dry-run', ...args], { from: 'user' });
  } catch {
    // a failed row exits non-zero
  } finally {
    process.stdout.write = original;
  }
  // Premise: the provider read ran and the plan was printed.
  expect(providerImport).toHaveBeenCalled();
  expect(logLines.some((l) => l.includes('Import plan:'))).toBe(true);
  return [...logLines];
}

let originalIsTTY: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  vi.clearAllMocks();
  process.env['AWS_REGION'] = 'us-east-1';
  backend.stateExistsOwnedBy.mockResolvedValue(false);
  backend.getState.mockResolvedValue(null);
  backend.saveState.mockResolvedValue('"new-etag"');
  resetAccountInfoCache();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
});
afterEach(() => {
  exitSpy.mockRestore();
  setStdinIsTty(originalIsTTY);
  delete process.env['AWS_REGION'];
});

describe('cdkd import masks a physical id the template names from a secret (go-to-k/cdkd#3869)', () => {
  const SECRET = '{{resolve:secretsmanager:team-role-name}}';

  // With --resource (or a CloudFormation stack's mapping, which fills the same
  // override): the only way such a resource is found, since a provider looking
  // it up by the template's name sends the literal `{{resolve:` text.
  it("masks the plan's row, and every line, for the found id", async () => {
    const lines = await runImport(SECRET, false, ['--resource', `Role=${ROLE_ID}`]);
    const row = lines.find((l) => l.includes('S/Role') || l.includes(' Role ('));
    expect(row).toBeDefined();
    expect(row).toContain('(***)');
    expect(lines.join('\n')).not.toContain(ROLE_ID);
  });

  it("masks the provider's line and a failed read's error when --resource names the id", async () => {
    const lines = await runImport(SECRET, true, ['--resource', `Role=${ROLE_ID}`]);
    expect(lines).toContain('debug Found role ***');
    const failure = lines.filter((l) => l.includes('cannot be found'));
    expect(failure.length).toBeGreaterThan(0);
    expect(failure.join('\n')).not.toContain(ROLE_ID);
  });

  it("masks the plan row with the FOUND id's spellings when it differs from --resource", async () => {
    // The listing judges the id the provider returned, not the one passed in.
    const lines = await runImport(SECRET, false, ['--resource', 'Role=S-other-role-id']);
    const row = lines.find((l) => l.includes(' Role ('));
    expect(row).toBeDefined();
    expect(row).toContain('(***)');
    expect(row).not.toContain(ROLE_ID);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await runImport('plain-role-name', true, ['--resource', `Role=${ROLE_ID}`]);
    expect(lines).toContain(`debug Found role ${ROLE_ID}`);
    expect(lines.filter((l) => l.includes('cannot be found')).join('\n')).toContain(ROLE_ID);
    const ok = await runImport('plain-role-name', false, ['--resource', `Role=${ROLE_ID}`]);
    expect(ok.join('\n')).toContain(`(${ROLE_ID})`);
  });
});
