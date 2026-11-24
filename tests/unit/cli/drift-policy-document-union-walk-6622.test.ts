import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6622 end to end through `cdkd drift` / `--revert` on the
 * template-only `properties` baseline (no `observedProperties`: a deploy with
 * capture off, or a failed capture). A `Condition` added out of band to an
 * IAM policy document's object-form `Statement` narrows a `Deny`; it read
 * clean, and `--revert` merged it back into the bag it sent. Each provider
 * below stores and returns the document as submitted, as IAM does.
 */

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
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
const DENY = { Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' };
const CONDITION = { StringEquals: { 'aws:PrincipalTag/team': 'ops' } };
const doc = (statement: unknown): Record<string, unknown> => ({
  Version: '2012-10-17',
  Statement: statement,
});

interface Case {
  type: string;
  physicalId: string;
  docKey: string;
  /** The template's properties around the document. */
  properties: (document: Record<string, unknown>) => Record<string, unknown>;
  /** What the SDK reader returns around the live document. */
  readback: (document: Record<string, unknown>) => Record<string, unknown>;
}

const POLICY_ARN = `arn:aws:iam::${ACCOUNT}:policy/DenyPolicy`;
const TRUST = (statement: unknown): Record<string, unknown> => doc(statement);
const TRUST_STATEMENT = {
  Effect: 'Allow',
  Principal: { Service: 'lambda.amazonaws.com' },
  Action: 'sts:AssumeRole',
};

const CASES: Case[] = [
  {
    type: 'AWS::IAM::ManagedPolicy',
    physicalId: POLICY_ARN,
    docKey: 'PolicyDocument',
    properties: (d) => ({ PolicyDocument: d }),
    // iam-managed-policy/read-state.ts: the default version's document plus
    // the policy's own fields.
    readback: (d) => ({
      PolicyDocument: d,
      ManagedPolicyName: 'DenyPolicy',
      Path: '/',
      Description: '',
      Roles: [],
      Groups: [],
      Users: [],
    }),
  },
  {
    type: 'AWS::IAM::Policy',
    physicalId: 'DenyInline',
    docKey: 'PolicyDocument',
    properties: (d) => ({ PolicyName: 'DenyInline', PolicyDocument: d, Roles: ['TargetRole'] }),
    readback: (d) => ({ PolicyName: 'DenyInline', PolicyDocument: d, Roles: ['TargetRole'] }),
  },
  {
    type: 'AWS::IAM::Role',
    physicalId: 'DenyRole',
    docKey: 'AssumeRolePolicyDocument',
    properties: (d) => ({ AssumeRolePolicyDocument: d }),
    // iam-role/read-state.ts: GetRole's fields beside the decoded trust policy.
    readback: (d) => ({
      AssumeRolePolicyDocument: d,
      RoleName: 'DenyRole',
      Path: '/',
      MaxSessionDuration: 3600,
      Description: '',
      ManagedPolicyArns: [],
      Policies: [],
      Tags: [],
    }),
  },
];

/** The template's document of each case: an object-form Statement. */
const templateDoc = (c: Case): Record<string, unknown> =>
  c.type === 'AWS::IAM::Role' ? TRUST(TRUST_STATEMENT) : doc(DENY);
const withCondition = (c: Case): Record<string, unknown> =>
  c.type === 'AWS::IAM::Role'
    ? TRUST({ ...TRUST_STATEMENT, Condition: { StringEquals: { 'aws:SourceAccount': ACCOUNT } } })
    : doc({ ...DENY, Condition: CONDITION });

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
      // IAM stores the submitted document as is.
      liveDoc = structuredClone(properties[c.docKey]) as Record<string, unknown>;
      return { physicalId, wasReplaced: false };
    },
  };
}

function stack(c: Case, observed?: Record<string, unknown>): { state: StackState; etag: string } {
  const resource: ResourceState = {
    physicalId: c.physicalId,
    resourceType: c.type,
    properties: c.properties(templateDoc(c)),
    ...(observed ? { observedProperties: observed } : {}),
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

function setUp(c: Case, observed?: Record<string, unknown>): void {
  mockGetState.mockReset();
  mockListStacks.mockReset();
  mockRegistryGetProvider.mockReset();
  mockRegistryGetProvider.mockImplementation(() => providerFor(c));
  mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  mockGetState.mockImplementation(async () => stack(c, observed));
  sentBags.length = 0;
}

describe.each(CASES)(
  'cdkd drift on a template-only $type baseline (go-to-k/cdkd#6622)',
  (c) => {
    beforeEach(() => {
      setUp(c);
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('__exit__');
      }) as never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('an unchanged document with the reader\'s other fields is clean', async () => {
      liveDoc = templateDoc(c);
      expect(await runDrift([])).toBe(0);
    });

    it('a Condition added to the object-form Statement is drift, named by path', async () => {
      liveDoc = withCondition(c);
      expect(await runDrift(['--json'])).toBe(1);
      expect(changedPaths()).toEqual([`${c.docKey}.Statement.Condition`]);
    });

    it('--revert sends the template document whole and removes the Condition', async () => {
      liveDoc = withCondition(c);
      expect(await runDrift(['--revert', '--yes'])).toBe(0);
      expect(sentBags).toHaveLength(1);
      expect(sentBags[0]![c.docKey]).toEqual(templateDoc(c));
      expect(stdout).not.toContain('AWS-authored');
      expect(liveDoc).toEqual(templateDoc(c));
      expect(await runDrift([])).toBe(0);
    });
  }
);

describe('the baselines and types the change leaves alone (go-to-k/cdkd#6622)', () => {
  afterEach(() => {
    exitSpy.mockRestore();
  });
  const arm = (): void => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  };

  it('an observed baseline still reports the added Condition (union walk as before)', async () => {
    const c = CASES[0]!;
    setUp(c, c.readback(templateDoc(c)));
    arm();
    liveDoc = withCondition(c);
    expect(await runDrift(['--json'])).toBe(1);
    expect(changedPaths()).toEqual(['PolicyDocument.Statement.Condition']);
  });

  it('an unlisted type keeps the state-keys-only walk and the untemplated-key merge', async () => {
    // OpenSearch access policies are not declared verbatim-echo (unmeasured),
    // so a key only the live side holds is still not compared there...
    const c: Case = {
      type: 'AWS::OpenSearchService::Domain',
      physicalId: 'my-domain',
      docKey: 'AccessPolicies',
      properties: (d) => ({ DomainName: 'my-domain', AccessPolicies: d }),
      readback: (d) => ({ DomainName: 'my-domain', AccessPolicies: d }),
    };
    setUp(c);
    arm();
    liveDoc = doc({ ...DENY, Condition: CONDITION });
    expect(await runDrift([])).toBe(0);
    // ...and a revert driven by a value drift beside it keeps that key.
    liveDoc = doc({ ...DENY, Action: 's3:PutObject', Condition: CONDITION });
    expect(await runDrift(['--revert', '--yes'])).toBe(0);
    expect(sentBags).toHaveLength(1);
    expect(sentBags[0]!['AccessPolicies']).toEqual(doc({ ...DENY, Condition: CONDITION }));
    expect(stdout).toContain('AWS-authored');
  });
});
