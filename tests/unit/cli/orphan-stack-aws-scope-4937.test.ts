/**
 * `cdkd orphan` of a stack pinned to a region other than the CLI's reads its
 * live `Fn::GetAtt` values in the STACK's region (go-to-k/cdkd#4937). The
 * rewrite falls back to `provider.getAttribute` when the orphan's record cannot
 * serve an attribute; a provider reads its region from `getAwsClients()` or
 * `ambientRegion()` (directly, or through `awsClientDefaults()`), and outside a
 * stack AWS scope all three are the CLI's `--region` / `AWS_REGION`. The read
 * then hit the wrong region: a NotFound aborted the orphan, or a same-named
 * resource's value was written into a sibling's state.
 *
 * Drives the REAL command with the REAL `aws-clients.ts` /
 * `aws-client-defaults.ts` / `stack-aws-scope.ts` modules and records the doors
 * a provider reads its region through, at registration and at the read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => undefined),
}));

/** The S3 client the state backend is handed: the state bucket's, not the stack's. */
const backendS3 = vi.hoisted(() => [] as { config: { region: () => Promise<string> } }[]);
const mockGetState = vi.hoisted(() => vi.fn());
const mockSaveState = vi.hoisted(() => vi.fn(async () => '"etag-2"'));
const stackRegion = vi.hoisted(() => ({ value: 'us-west-2' as string | undefined }));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation((s3: { config: { region: () => Promise<string> } }) => {
    backendS3.push(s3);
    return {
      destroyClient: vi.fn(),
      getState: mockGetState,
      saveState: mockSaveState,
      listStacks: vi.fn(async () => [
        stackRegion.value === undefined
          ? { stackName: 'App' }
          : { stackName: 'App', region: stackRegion.value },
      ]),
      verifyBucketExists: vi.fn(async () => undefined),
      rotateCreateTokenNonce: vi.fn(async () => undefined),
    };
  }),
}));
/** The S3 client the lock manager is handed: likewise the state bucket's. */
const lockS3 = vi.hoisted(() => [] as { config: { region: () => Promise<string> } }[]);
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation((s3: { config: { region: () => Promise<string> } }) => {
    lockS3.push(s3);
    return {
      acquireLock: vi.fn(async () => true),
      getLockInfo: vi.fn(async () => null),
      releaseLock: vi.fn(async () => undefined),
    };
  }),
}));
const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

/** `ambientRegion()` where `registerAllProviders` constructs the providers. */
const registeredRegions = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('../../../src/provisioning/register-providers.js', async () => {
  const { ambientRegion } = await import('../../../src/utils/stack-aws-scope.js');
  return {
    loadProviderClasses: vi.fn(async () => ({})),
    registerAllProviders: vi.fn(() => {
      registeredRegions.push(ambientRegion());
    }),
  };
});
const mockGetAttribute = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: { getAttribute: mockGetAttribute } }),
  })),
}));

import { createOrphanCommand } from '../../../src/cli/commands/orphan.js';
import { AwsClients, getAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import { awsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import { ambientRegion } from '../../../src/utils/stack-aws-scope.js';
import { SQSClient } from '@aws-sdk/client-sqs';

const CLI_REGION = 'us-east-1';

interface Observation {
  clientsRegion: string | undefined;
  clientsProfile: string | undefined;
  ambientRegion: string | undefined;
  sdkClientRegion: string;
  envRegion: string | undefined;
}
const readObservations: Observation[] = [];

/** `undefined`: an env-agnostic stack whose single record is a legacy one naming no region. */
async function orphan(region: string | undefined, extraArgs: string[] = []): Promise<void> {
  stackRegion.value = region;
  mockSynthesize.mockResolvedValue({
    stacks: [
      {
        stackName: 'App',
        displayName: 'App',
        template: {
          Resources: {
            Queue: { Type: 'AWS::SQS::Queue', Metadata: { 'aws:cdk:path': 'App/Queue' } },
            Keeper: { Type: 'AWS::SSM::Parameter', Metadata: { 'aws:cdk:path': 'App/Keeper' } },
          },
        },
        region,
      },
    ],
  });
  mockGetState.mockResolvedValue({
    state: {
      version: 12,
      stackName: 'App',
      region,
      resources: {
        // No recorded `attributes`: the rewrite must read `Arn` live.
        Queue: {
          physicalId: 'https://sqs.example/123456789012/shared-name',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: {},
          dependencies: [],
        },
        Keeper: {
          physicalId: 'keeper-param',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Value: { 'Fn::GetAtt': ['Queue', 'Arn'] } },
          attributes: {},
          dependencies: ['Queue'],
        },
      },
      outputs: {},
      lastModified: 1,
    },
    etag: '"e"',
  });
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createOrphanCommand();
    cmd.exitOverride();
    await cmd.parseAsync(
      ['App/Queue', '--app', 'noop', '--yes', '--region', CLI_REGION, ...extraArgs],
      { from: 'user' }
    );
  } finally {
    process.stdout.write = original;
  }
}

const savedEnv: Record<string, string | undefined> = {};
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION']) savedEnv[key] = process.env[key];
  process.env['AWS_REGION'] = CLI_REGION;
  process.env['AWS_DEFAULT_REGION'] = CLI_REGION;
  registeredRegions.length = 0;
  readObservations.length = 0;
  backendS3.length = 0;
  lockS3.length = 0;
  mockSaveState.mockClear();
  mockGetAttribute.mockReset().mockImplementation(async () => {
    // Built with NO region of its own, the way a provider builds a client
    // lazily. Never sent: region resolution is local.
    const client = new SQSClient({ ...awsClientDefaults() });
    readObservations.push({
      clientsRegion: getAwsClients().configuredRegion,
      clientsProfile: getAwsClients().credentialConfig.profile,
      ambientRegion: ambientRegion(),
      sdkClientRegion: await client.config.region(),
      envRegion: process.env['AWS_REGION'],
    });
    client.destroy();
    return `arn:aws:sqs:${ambientRegion()}:123456789012:shared-name`;
  });
});

afterEach(() => {
  setStdinIsTty(originalIsTTY);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAwsClients();
});

describe('cdkd orphan reads live GetAtt values in the stack region, not the CLI region (go-to-k/cdkd#4937)', () => {
  it('constructs the providers inside the stack scope', async () => {
    await orphan('us-west-2');

    expect(registeredRegions).toEqual(['us-west-2']);
  });

  it("reads the orphan's attribute through the stack region's doors", async () => {
    await orphan('us-west-2');

    // Floor: the rewrite reached the live read, so the comparisons are not vacuous.
    expect(mockGetAttribute).toHaveBeenCalledOnce();
    const [seen] = readObservations;
    expect(seen!.clientsRegion, 'getAwsClients()').toBe('us-west-2');
    expect(seen!.ambientRegion, 'ambientRegion()').toBe('us-west-2');
    expect(seen!.sdkClientRegion, 'region-less SDK client').toBe('us-west-2');
    // The scope carries the region; the process-wide variable is left alone.
    expect(seen!.envRegion).toBe(CLI_REGION);
    // The value read there is what the sibling's saved state holds.
    expect(mockSaveState).toHaveBeenCalledOnce();
    const saved = (mockSaveState.mock.calls[0] as unknown[])[2] as {
      resources: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(saved.resources['Keeper']!.properties['Value']).toBe(
      'arn:aws:sqs:us-west-2:123456789012:shared-name'
    );
  });

  it("keeps the state backend and the lock on the CLI region's clients", async () => {
    // The state bucket's region is the CLI's, not the stack's.
    await orphan('us-west-2');

    expect(backendS3).toHaveLength(1);
    expect(await backendS3[0]!.config.region()).toBe(CLI_REGION);
    expect(lockS3).toHaveLength(1);
    expect(await lockS3[0]!.config.region()).toBe(CLI_REGION);
  });

  it("carries --profile into the stack region's clients", async () => {
    // `--profile` reaches this set only through its constructor: a set built
    // without it would read under the default credential chain.
    await orphan('us-west-2', ['--profile', 'team-profile']);

    expect(readObservations.map((o) => [o.clientsRegion, o.clientsProfile])).toEqual([
      ['us-west-2', 'team-profile'],
    ]);
  });

  it("destroys the stack region's clients as well as the CLI's", async () => {
    const destroyed: (string | undefined)[] = [];
    const realDestroy = AwsClients.prototype.destroy;
    const spy = vi
      .spyOn(AwsClients.prototype, 'destroy')
      .mockImplementation(function (this: AwsClients) {
        destroyed.push(this.configuredRegion);
        realDestroy.call(this);
      });
    try {
      await orphan('us-west-2');
    } finally {
      spy.mockRestore();
    }

    expect(destroyed.sort()).toEqual([CLI_REGION, 'us-west-2'].sort());
  });

  it('negative control: a stack in the CLI region reads there', async () => {
    await orphan(CLI_REGION);

    expect(registeredRegions).toEqual([CLI_REGION]);
    expect(readObservations.map((o) => o.clientsRegion)).toEqual([CLI_REGION]);
    expect(readObservations.map((o) => o.ambientRegion)).toEqual([CLI_REGION]);
  });

  it('a legacy record naming no region, for an env-agnostic stack, reads in the CLI region', async () => {
    // `pickStackRegion` answers `''` here; a client set built for it has no
    // configured region, which the scope refuses.
    await orphan(undefined);

    expect(mockGetAttribute).toHaveBeenCalledOnce();
    expect(registeredRegions).toEqual([CLI_REGION]);
    expect(readObservations.map((o) => o.clientsRegion)).toEqual([CLI_REGION]);
  });

  it('leaves no scope behind once the command returns', async () => {
    await orphan('us-west-2');

    // A THIRD region, so a leaked us-west-2 scope cannot pass as the
    // `AWS_REGION` fallback.
    process.env['AWS_REGION'] = 'eu-west-1';
    expect(ambientRegion()).toBe('eu-west-1');
  });
});
