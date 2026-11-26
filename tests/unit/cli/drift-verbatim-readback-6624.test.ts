import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6624 end to end through `cdkd drift` / `--revert` on the
 * template-only `properties` baseline, for the resource policies the
 * `drift-verbatim-readback` integ fixture measured: each service returns the
 * submitted document with no key of its own. S3, SQS, SNS, KMS, Secrets
 * Manager and IAM's role trust policy return a single-object `Statement` as a
 * one-element list (a clean stack read as drift before the fix); the Cloud
 * Control-routed IAM inline policies return it as an object, keys reordered (a
 * `Condition` added out of band read clean before the fix).
 */

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    getLevel: () => 'info',
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({}),
}));

const mockGetState =
  vi.fn<(stackName: string, region: string) => Promise<{ state: StackState; etag: string } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
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

const mockRegistryGetProvider = vi.fn<(resourceType: string) => unknown>();

vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProvider: mockRegistryGetProvider,
    getProviderFor: (input: { resourceType: string }) => ({
      provider: mockRegistryGetProvider(input.resourceType),
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
  CloudControlProvider: vi.fn(() => ({
    readCurrentState: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../../src/provisioning/read-only-properties.js', () => ({
  getReadOnlyPropertyPaths: vi.fn(async () => undefined),
}));

import { createDriftCommand } from '../../../src/cli/commands/drift.js';

const ACCOUNT = '123456789012';
const ROOT = { AWS: `arn:aws:iam::${ACCOUNT}:root` };
const doc = (statement: unknown): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: statement,
});

/** How the service hands a stored document back (measured). */
type Echo = 'list' | 'object-reordered';
const reorder = (s: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(s).reverse());
function echo(how: Echo, document: Record<string, unknown>): Record<string, unknown> {
  const statement = document['Statement'];
  if (how === 'list') {
    return { ...document, Statement: Array.isArray(statement) ? statement : [statement] };
  }
  return {
    ...document,
    Statement: Array.isArray(statement)
      ? statement
      : reorder(statement as Record<string, unknown>),
  };
}

interface Case {
  type: string;
  physicalId: string;
  docKey: string;
  echo: Echo;
  statement: Record<string, unknown>;
  properties: (document: Record<string, unknown>) => Record<string, unknown>;
  readback: (document: Record<string, unknown>) => Record<string, unknown>;
}

const QUEUE_ARN = `arn:aws:sqs:us-east-1:${ACCOUNT}:cdkd-dvr-queue`;
const TOPIC_ARN = `arn:aws:sns:us-east-1:${ACCOUNT}:cdkd-dvr-topic`;
const LEGAL_HOLD = { Effect: 'Deny', Action: 's3:PutObjectLegalHold', Resource: '*' };

const CASES: Case[] = [
  {
    type: 'AWS::S3::BucketPolicy',
    physicalId: 'cdkd-dvr-bucket',
    docKey: 'PolicyDocument',
    echo: 'list',
    statement: {
      Effect: 'Deny',
      Principal: ROOT,
      Action: 's3:PutObjectLegalHold',
      Resource: 'arn:aws:s3:::cdkd-dvr-bucket/*',
    },
    properties: (d) => ({ Bucket: 'cdkd-dvr-bucket', PolicyDocument: d }),
    readback: (d) => ({ Bucket: 'cdkd-dvr-bucket', PolicyDocument: d }),
  },
  {
    type: 'AWS::SQS::QueuePolicy',
    physicalId: 'cdkd-dvr-queue-policy',
    docKey: 'PolicyDocument',
    echo: 'list',
    statement: { Effect: 'Deny', Principal: ROOT, Action: 'sqs:PurgeQueue', Resource: QUEUE_ARN },
    properties: (d) => ({ Queues: ['https://sqs/q'], PolicyDocument: d }),
    readback: (d) => ({ Queues: ['https://sqs/q'], PolicyDocument: d }),
  },
  {
    type: 'AWS::SNS::TopicPolicy',
    physicalId: 'cdkd-dvr-topic-policy',
    docKey: 'PolicyDocument',
    echo: 'list',
    statement: {
      Effect: 'Deny',
      Principal: ROOT,
      Action: 'sns:ListSubscriptionsByTopic',
      Resource: TOPIC_ARN,
    },
    properties: (d) => ({ Topics: [TOPIC_ARN], PolicyDocument: d }),
    readback: (d) => ({ Topics: [TOPIC_ARN], PolicyDocument: d }),
  },
  {
    type: 'AWS::KMS::Key',
    physicalId: 'key-id',
    docKey: 'KeyPolicy',
    echo: 'list',
    statement: { Effect: 'Allow', Principal: ROOT, Action: 'kms:*', Resource: '*' },
    properties: (d) => ({ KeyPolicy: d }),
    // kms-key provider: the key's own fields beside the policy (measured).
    readback: (d) => ({
      KeyPolicy: d,
      Description: '',
      EnableKeyRotation: false,
      Enabled: true,
      KeySpec: 'SYMMETRIC_DEFAULT',
      KeyUsage: 'ENCRYPT_DECRYPT',
      MultiRegion: false,
      Origin: 'AWS_KMS',
      Tags: [],
    }),
  },
  {
    type: 'AWS::SecretsManager::ResourcePolicy',
    physicalId: 'arn:secret',
    docKey: 'ResourcePolicy',
    echo: 'list',
    statement: {
      Effect: 'Deny',
      Principal: ROOT,
      Action: 'secretsmanager:RestoreSecret',
      Resource: '*',
    },
    properties: (d) => ({ SecretId: 'arn:secret', ResourcePolicy: d }),
    readback: (d) => ({ Id: 'arn:secret', SecretId: 'arn:secret', ResourcePolicy: d }),
  },
  ...(['Role', 'User', 'Group'] as const).map(
    (kind): Case => ({
      type: `AWS::IAM::${kind}Policy`,
      physicalId: `cdkd-dvr-${kind.toLowerCase()}-policy`,
      docKey: 'PolicyDocument',
      echo: 'object-reordered',
      statement: LEGAL_HOLD,
      properties: (d) => ({
        [`${kind}Name`]: `cdkd-dvr-sibling-${kind.toLowerCase()}`,
        PolicyName: `cdkd-dvr-${kind.toLowerCase()}-policy`,
        PolicyDocument: d,
      }),
      readback: (d) => ({
        [`${kind}Name`]: `cdkd-dvr-sibling-${kind.toLowerCase()}`,
        PolicyName: `cdkd-dvr-${kind.toLowerCase()}-policy`,
        PolicyDocument: d,
      }),
    })
  ),
];

const CONDITION = { StringEquals: { 'aws:PrincipalTag/team': 'ops' } };
const templateDoc = (c: Case): Record<string, unknown> => doc(c.statement);
const withCondition = (c: Case): Record<string, unknown> =>
  echo(c.echo, doc({ ...c.statement, Condition: CONDITION }));

/** What the service holds, in the shape it returns it. */
let liveDoc: Record<string, unknown> = {};
const sentBags: Record<string, unknown>[] = [];

function providerFor(c: Case): unknown {
  return {
    readCurrentState: async () => c.readback(structuredClone(liveDoc)),
    update: async (
      _lid: string,
      physicalId: string,
      _type: string,
      properties: Record<string, unknown>
    ) => {
      sentBags.push(structuredClone(properties));
      liveDoc = echo(c.echo, structuredClone(properties[c.docKey]) as Record<string, unknown>);
      return { physicalId, wasReplaced: false };
    },
  };
}

function stack(c: Case): { state: StackState; etag: string } {
  const resource: ResourceState = {
    physicalId: c.physicalId,
    resourceType: c.type,
    properties: c.properties(templateDoc(c)),
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { Subject: resource },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdout = '';

async function runDrift(flags: string[]): Promise<number | undefined> {
  const original = process.stdout.write.bind(process.stdout);
  stdout = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  exitSpy.mockClear();
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', ...flags], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
  }
  const calls = exitSpy.mock.calls;
  return calls.length === 0 ? 0 : (calls[calls.length - 1]![0] as number | undefined);
}

function changedPaths(): string[] {
  const [report] = JSON.parse(stdout) as Array<{
    drifted: Array<{ changes: Array<{ path: string }> }>;
  }>;
  return report!.drifted.flatMap((d) => d.changes.map((ch) => ch.path));
}

describe.each(CASES)('cdkd drift on a template-only $type baseline (go-to-k/cdkd#6624)', (c) => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockRegistryGetProvider.mockImplementation(() => providerFor(c));
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    mockGetState.mockImplementation(async () => stack(c));
    sentBags.length = 0;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('the measured readback of the deployed document is clean', async () => {
    liveDoc = echo(c.echo, templateDoc(c));
    expect(await runDrift([])).toBe(0);
  });

  it('a Condition added to the Statement out of band is drift', async () => {
    liveDoc = withCondition(c);
    expect(await runDrift(['--json'])).toBe(1);
    // A list readback compares as a list, so the drift names the Statement.
    expect(changedPaths()).toEqual([
      c.echo === 'list' ? `${c.docKey}.Statement` : `${c.docKey}.Statement.Condition`,
    ]);
  });

  it('--revert sends the template document whole, and the next drift is clean', async () => {
    liveDoc = withCondition(c);
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sentBags).toHaveLength(1);
    expect(sentBags[0]![c.docKey]).toEqual(templateDoc(c));
    expect(stdout).not.toContain('AWS-authored');
    expect(liveDoc).toEqual(echo(c.echo, templateDoc(c)));
    expect(await runDrift([])).toBe(0);
  });
});
