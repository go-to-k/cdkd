import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * go-to-k/cdkd#2100: `cdkd import` of an ENV-AGNOSTIC stack takes the run's
 * region, which now comes from the AWS profile. The region is reconciled per
 * stack: a stack the old `us-east-1` default already recorded is re-imported
 * THERE (no second record beside the first), a fresh stack whose held siblings
 * all live in us-east-1 joins them, and a fresh stack of a fresh app goes to
 * the profile's region.
 */

const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
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

vi.mock('../../../src/provisioning/provider-registry.js', () => {
  const provider = {
    import: vi.fn(async (input: { logicalId: string }) => ({
      physicalId: `${input.logicalId}-id`,
      attributes: {},
    })),
  };
  return {
    ProviderRegistry: vi.fn().mockImplementation(() => ({
      hasProvider: () => true,
      getProvider: () => provider,
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    })),
  };
});

import { createImportCommand } from '../../../src/cli/commands/import.js';
import { AwsClients, setAwsClients } from '../../../src/utils/aws-clients.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

function bucketTemplate(): CloudFormationTemplate {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {}, Metadata: { 'aws:cdk:path': 'S/Bucket' } },
    },
  };
}

/** An env-agnostic synthesized stack: no `region`. */
function envAgnostic(name: string) {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: bucketTemplate(),
    dependencyNames: [],
  };
}

async function runImport(args: string[]): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createImportCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    process.stdout.write = original;
  }
}

/** Every region the command read or wrote `name`'s state record in. */
function stateRegions(name: string): { read: unknown[]; written: unknown[] } {
  return {
    read: backend.getState.mock.calls.filter((c) => c[0] === name).map((c) => c[1]),
    written: backend.saveState.mock.calls.filter((c) => c[0] === name).map((c) => c[1]),
  };
}

const savedEnv = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
let originalIsTTY: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  vi.clearAllMocks();
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  profile.region = 'ap-northeast-1';
  held.value.clear();
  backend.stateExistsOwnedBy.mockImplementation(async (stack: string, region: string) =>
    held.value.get(stack)?.has(region) === true
  );
  // The existing-state guard reads nothing back, so the import proceeds; the
  // assertions are on WHICH region it reads and writes.
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
  if (savedEnv.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedEnv.region;
  if (savedEnv.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = savedEnv.def;
});

const infoLines = (): string => infoSpy.mock.calls.map((c) => String(c[0])).join('\n');

describe('cdkd import of an env-agnostic stack, under a profile region (go-to-k/cdkd#2100)', () => {
  it('re-imports into us-east-1 when the old default already holds the stack', async () => {
    held.value.set('S', new Set(['us-east-1']));
    synthesize.mockResolvedValue({ stacks: [envAgnostic('S')] });

    await runImport(['S', '--app', 'x', '--yes']);

    expect(stateRegions('S')).toEqual({ read: ['us-east-1'], written: ['us-east-1'] });
    expect(infoLines()).toContain('Target stack: S (us-east-1)');
    expect(infoLines()).toContain('Continuing to use us-east-1 so the existing stack is not duplicated');
  });

  it('a fresh stack joins its held sibling in us-east-1, so the app stays in one region', async () => {
    held.value.set('Other', new Set(['us-east-1']));
    synthesize.mockResolvedValue({ stacks: [envAgnostic('S'), envAgnostic('Other')] });

    await runImport(['S', '--app', 'x', '--yes']);

    expect(stateRegions('S')).toEqual({ read: ['us-east-1'], written: ['us-east-1'] });
    expect(infoLines()).toContain('so the app stays in one region');
  });

  it('THE OTHER POLARITY: a fresh stack with no held sibling goes to the profile region', async () => {
    synthesize.mockResolvedValue({ stacks: [envAgnostic('S')] });

    await runImport(['S', '--app', 'x', '--yes']);

    expect(stateRegions('S')).toEqual({ read: ['ap-northeast-1'], written: ['ap-northeast-1'] });
    expect(infoLines()).toContain('Target stack: S (ap-northeast-1)');
    expect(infoLines()).not.toContain('Continuing to use us-east-1');
    expect(infoLines()).not.toContain('so the app stays in one region');
  });

  it('THE OTHER POLARITY: a sibling held in us-east-1 does not pull a stack that has state in the profile region', async () => {
    held.value.set('S', new Set(['ap-northeast-1']));
    held.value.set('Other', new Set(['us-east-1']));
    synthesize.mockResolvedValue({ stacks: [envAgnostic('S'), envAgnostic('Other')] });

    await runImport(['S', '--app', 'x', '--yes']);

    expect(stateRegions('S')).toEqual({ read: ['ap-northeast-1'], written: ['ap-northeast-1'] });
  });
});

/**
 * Orchestrator review B2 (go-to-k/cdkd#2100): the import's PROVIDERS search
 * the region the state is written under. Providers capture their clients when
 * registered, so the registry must be built after the clients point there.
 */
describe('cdkd import runs its providers in the target region (review B2)', () => {
  const clientRegions = (): unknown[] =>
    vi.mocked(AwsClients).mock.calls.map((c) => (c[0] as { region?: string } | undefined)?.region);

  it('a held stack gets us-east-1 clients, set BEFORE the providers are registered', async () => {
    cfnRegions.length = 0;
    held.value.set('S', new Set(['us-east-1']));
    synthesize.mockResolvedValue({ stacks: [envAgnostic('S')] });

    await runImport(['S', '--app', 'x', '--yes']);

    expect(clientRegions()).toEqual(['ap-northeast-1', 'us-east-1']);
    const targetInstance = vi.mocked(AwsClients).mock.results[1]!.value;
    const setCalls = vi.mocked(setAwsClients).mock;
    const setIndex = setCalls.calls.findIndex((c) => c[0] === targetInstance);
    expect(setIndex).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(registerAllProviders).mock.invocationCallOrder[0]!).toBeGreaterThan(
      setCalls.invocationCallOrder[setIndex]!
    );
    expect(process.env['AWS_REGION']).toBe('us-east-1');
    // Its CloudFormation lookup (a CFn stack of the same name) is handed the
    // us-east-1 client.
    const { tryGetCloudFormationResourceMap } = await import(
      '../../../src/cli/commands/retire-cfn-stack.js'
    );
    const lookups = vi.mocked(tryGetCloudFormationResourceMap).mock.calls;
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.map((c) => (c[1] as unknown as { clientRegion?: string }).clientRegion)).toEqual(
      lookups.map(() => 'us-east-1')
    );
    expect(cfnRegions.every((r) => r === 'us-east-1')).toBe(true);
  });

  it("THE OTHER POLARITY: a stack in the run's own region gets no second client set", async () => {
    synthesize.mockResolvedValue({ stacks: [envAgnostic('S')] });
    await runImport(['S', '--app', 'x', '--yes']);
    expect(clientRegions()).toEqual(['ap-northeast-1']);
  });

  it('a NAMED region (AWS_REGION) is obeyed: no probe, no hold, one client set', async () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    held.value.set('S', new Set(['us-east-1']));
    synthesize.mockResolvedValue({ stacks: [envAgnostic('S')] });

    await runImport(['S', '--app', 'x', '--yes']);

    expect(backend.stateExistsOwnedBy).not.toHaveBeenCalled();
    expect(stateRegions('S')).toEqual({ read: ['ap-northeast-1'], written: ['ap-northeast-1'] });
    expect(clientRegions()).toEqual(['ap-northeast-1']);
  });
});
