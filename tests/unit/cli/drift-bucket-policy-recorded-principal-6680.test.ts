import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#7025 step 6: this file's fake AWS keeps answering the drifted
// read after an update, so the post-revert re-read is stubbed out here; it is
// covered by `tests/unit/cli/drift-revert-verify-7025.test.ts`.
vi.mock('../../../src/cli/commands/drift/revert-verify.js', () => ({
  verifyRevertedStack: vi.fn(async () => ({ notApplied: 0, unverified: 0 })),
}));
import type { ResourceState, StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6680: the `drift-revert` fixture's step 6b rewrites the bucket
 * policy's recorded baseline so one principal is an IAM unique id belonging to
 * nobody. go-to-k/cdkd#6629's pre-fix-baseline heal skipped `PolicyDocument`
 * whenever the LIVE policy was the declared one, whatever the baseline held,
 * so the recorded principal was never compared and `cdkd drift` read clean.
 * Driven end to end through the command, over a mocked IAM and a stub provider
 * answering the live policy.
 */

const mockIamSend = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
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
    get iam() {
      return { send: mockIamSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: () => ({ iam: { send: mockIamSend } }),
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

import { createDriftCommand } from '../../../src/cli/commands/drift.js';

const BUCKET = 'cdkddriftrevertexample-driftbucket-abc';
const ROLE_ARN =
  'arn:aws:iam::123456789012:role/CdkdDriftRevertExample-CustomS3AutoDeleteObjectsCustomR-30ff9234';
/** The role's real unique id: what `GetRole` answers. */
const ROLE_UNIQUE_ID = ['AROA', 'XXXJN2LNV2SMSFATO'].join('');
/**
 * `inject-principal-uniqueid.ts`'s id that belongs to nobody. Ids are built at
 * runtime: a literal matches git-secrets' AWS key-id pattern.
 */
const BOGUS_UNIQUE_ID = ['AROA', 'Z'.repeat(17)].join('');
const OTHER_ACCOUNT_ROLE = 'arn:aws:iam::999999999999:role/attacker';

/** The CDK `autoDeleteObjects` bucket policy, as the `drift-revert` fixture declares it. */
function policy(principal: string, action: unknown = ['s3:PutBucketPolicy', 's3:GetBucket*', 's3:List*', 's3:DeleteObject*']) {
  return {
    Bucket: BUCKET,
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: principal },
          Action: action,
          Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`],
        },
      ],
    },
  };
}

let live: Record<string, unknown> = policy(ROLE_ARN);
const updates: Array<Record<string, unknown>> = [];

function stateWith(observed: Record<string, unknown> | undefined): {
  state: StackState;
  etag: string;
} {
  const resource: ResourceState = {
    physicalId: BUCKET,
    resourceType: 'AWS::S3::BucketPolicy',
    properties: policy(ROLE_ARN),
    ...(observed !== undefined && { observedProperties: observed }),
  };
  return {
    state: {
      version: 3,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: { DriftBucketPolicy: resource },
      outputs: {},
      lastModified: 0,
    },
    etag: '"etag-1"',
  };
}

let exitSpy: ReturnType<typeof vi.spyOn>;

/** Run `cdkd drift TestStack [...flags]`: the exit code it asked for, and stdout. */
async function runDrift(flags: string[]): Promise<{ code: number | undefined; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' '));
  });
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['TestStack', ...flags], { from: 'user' });
  } catch {
    // The command exits through the stubbed `process.exit`.
  } finally {
    process.stdout.write = original;
    logSpy.mockRestore();
  }
  const calls = exitSpy.mock.calls;
  const code = calls.length === 0 ? undefined : (calls[calls.length - 1]![0] as number | undefined);
  return { code, out: chunks.join('\n') };
}

describe('cdkd drift on a bucket policy whose recorded principal is not the live one (go-to-k/cdkd#6680)', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockListStacks.mockReset();
    mockRegistryGetProvider.mockReset();
    mockIamSend.mockReset();
    warnSpy.mockReset();
    // `GetRole` answers the role's real unique id.
    mockIamSend.mockResolvedValue({ Role: { Arn: ROLE_ARN, RoleId: ROLE_UNIQUE_ID } });
    live = policy(ROLE_ARN);
    updates.length = 0;
    mockRegistryGetProvider.mockImplementation(() => ({
      readCurrentState: async () => live,
      update: async (_lid: string, _pid: string, _type: string, desired: Record<string, unknown>) => {
        updates.push(desired);
        return { physicalId: BUCKET, wasReplaced: false };
      },
    }));
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  describe('the recorded principal (drift-revert steps 6b / 6c)', () => {
    it('a unique id that belongs to nobody is drift, though the live policy is the declared one', async () => {
      mockGetState.mockResolvedValue(stateWith(policy(BOGUS_UNIQUE_ID)));

      const { code, out } = await runDrift([]);

      expect(code).toBe(1);
      expect(out).toContain('DriftBucketPolicy');
      expect(out).toContain('PolicyDocument');
    });

    it("the role's real unique id is the same principal: no drift", async () => {
      mockGetState.mockResolvedValue(stateWith(policy(ROLE_UNIQUE_ID)));

      const { code, out } = await runDrift([]);

      expect(code ?? 0).toBe(0);
      expect(out).toContain('no drift detected');
      expect(mockIamSend).toHaveBeenCalledTimes(1);
    });

    it('a real unique id the lookup cannot prove (GetRole denied) stays drift', async () => {
      mockIamSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
      mockGetState.mockResolvedValue(stateWith(policy(ROLE_UNIQUE_ID)));

      const { code, out } = await runDrift([]);

      expect(code).toBe(1);
      expect(out).toContain('DriftBucketPolicy');
    });
  });

  it('a principal the lookup answers for another account is drift, explained once at warn without the ARN', async () => {
    // `GetRole` takes a name, so it answers about this account's same-named role.
    mockIamSend.mockResolvedValue({
      Role: { Arn: ROLE_ARN.replace('123456789012', '999999999999'), RoleId: ROLE_UNIQUE_ID },
    });
    mockGetState.mockResolvedValue(stateWith(policy(ROLE_UNIQUE_ID)));

    const { code, out } = await runDrift([]);

    expect(code).toBe(1);
    expect(out).toContain('DriftBucketPolicy');
    const warned = warnSpy.mock.calls.map((c) => String(c[0]));
    const explained = warned.filter((w) => w.includes('cannot be matched'));
    expect(explained).toHaveLength(1);
    expect(explained[0]).toContain('--accept');
    expect(explained[0]).not.toContain('arn:aws:iam::');
  });

  // go-to-k/cdkd#6854: `GetRole` finds a role case-insensitively, but IAM and
  // S3 refuse a principal ARN whose name or path differs only in case
  // ("Invalid principal in policy", measured), so that ARN is another
  // principal and its unique id is not proven equal.
  describe('a principal ARN spelled in another case than the live role (go-to-k/cdkd#6854)', () => {
    const CASED_PATH_ARN = 'arn:aws:iam::123456789012:role/Prod/MyRole';
    const casedState = (recorded: string, declared: string) => {
      const s = stateWith(policy(recorded));
      s.state.resources['DriftBucketPolicy']!.properties = policy(declared);
      return s;
    };

    it('the exact ARN proves the unique id: no drift (positive control)', async () => {
      mockIamSend.mockResolvedValue({ Role: { Arn: CASED_PATH_ARN, RoleId: ROLE_UNIQUE_ID } });
      live = policy(CASED_PATH_ARN);
      mockGetState.mockResolvedValue(casedState(ROLE_UNIQUE_ID, CASED_PATH_ARN));

      const { code, out } = await runDrift([]);

      expect(code ?? 0).toBe(0);
      expect(out).toContain('no drift detected');
    });

    it('a role NAME differing only in case is drift', async () => {
      mockIamSend.mockResolvedValue({ Role: { Arn: CASED_PATH_ARN, RoleId: ROLE_UNIQUE_ID } });
      const lowerName = 'arn:aws:iam::123456789012:role/Prod/myrole';
      live = policy(lowerName);
      mockGetState.mockResolvedValue(casedState(ROLE_UNIQUE_ID, lowerName));

      const { code, out } = await runDrift([]);

      expect(code).toBe(1);
      expect(out).toContain('DriftBucketPolicy');
    });

    it('an IAM PATH differing only in case is drift', async () => {
      mockIamSend.mockResolvedValue({ Role: { Arn: CASED_PATH_ARN, RoleId: ROLE_UNIQUE_ID } });
      const lowerPath = 'arn:aws:iam::123456789012:role/prod/MyRole';
      live = policy(lowerPath);
      mockGetState.mockResolvedValue(casedState(ROLE_UNIQUE_ID, lowerPath));

      const { code, out } = await runDrift([]);

      expect(code).toBe(1);
      expect(out).toContain('DriftBucketPolicy');
      const warned = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warned.filter((w) => w.includes('cannot be matched'))).toHaveLength(1);
    });
  });

  describe('an out-of-band change to the live policy (blast radius)', () => {
    it.each([
      ['principal swapped for another account', policy(OTHER_ACCOUNT_ROLE)],
      ['principal rendered as another role unique id', policy(['AROA', 'OTHERROLE0000000'].join(''))],
      ['Action widened', policy(ROLE_ARN, 's3:*')],
      [
        'statement added',
        {
          ...policy(ROLE_ARN),
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              ...(policy(ROLE_ARN).PolicyDocument.Statement as unknown[]),
              {
                Effect: 'Allow',
                Principal: { AWS: OTHER_ACCOUNT_ROLE },
                Action: 's3:GetObject',
                Resource: `arn:aws:s3:::${BUCKET}/*`,
              },
            ],
          },
        },
      ],
    ])('%s: drift, and --revert writes the declared policy back', async (_label, changed) => {
      live = changed;
      mockGetState.mockResolvedValue(stateWith(policy(ROLE_ARN)));

      const { code, out } = await runDrift([]);
      expect(code).toBe(1);
      expect(out).toContain('DriftBucketPolicy');

      exitSpy.mockClear();
      mockGetState.mockResolvedValue(stateWith(policy(ROLE_ARN)));
      await runDrift(['--revert', '--yes']);
      expect(updates).toHaveLength(1);
      expect(updates[0]!['PolicyDocument']).toEqual(policy(ROLE_ARN).PolicyDocument);
    });
  });

  describe('go-to-k/cdkd#6629: a baseline an earlier cdkd captured before its own write showed', () => {
    it.each([
      ['the document the write replaced', policy(ROLE_ARN, 's3:GetBucket*')],
      ['no document', { Bucket: BUCKET }],
    ])('recorded %s, live the declared policy: no drift', async (_label, observed) => {
      mockGetState.mockResolvedValue(stateWith(observed));

      const { code, out } = await runDrift([]);

      expect(code ?? 0).toBe(0);
      expect(out).toContain('no drift detected');
    });
  });
});
