/**
 * `cdkd drift`'s DETECTION pass masks a physical name derived from a secret on
 * every line logged while a resource is read (go-to-k/cdkd#3869 item 1). The
 * read called `provider.readCurrentState` with nothing bound, so the provider's
 * own debug lines, and the command's warning quoting a failed read's AWS error,
 * printed the name: the secret-named resource's own id, and a reader's (an
 * access key's `UserName`). It now runs under the per-resource printing bag
 * `cdkd drift --revert` and `cdkd destroy` bind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

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
const mockSaveState = vi.fn(async (..._args: unknown[]) => '"etag-2"');
const mockGetState = vi.fn<() => Promise<{ state: StackState; etag: string } | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: vi.fn(async () => [{ stackName: 'TestStack', region: 'us-east-1' }]),
    verifyBucketExists: vi.fn(async () => undefined),
    saveState: mockSaveState,
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
import { getLogger } from '../../../src/utils/logger.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const USER_ID = 'team-secret-drift-user';

function stateWith(
  userName: string,
  keyUser: string = USER_ID,
  keyExtra: Record<string, unknown> = {}
): { state: StackState; etag: string } {
  return {
    state: {
      version: STATE_SCHEMA_VERSION_CURRENT,
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
          properties: {
            UserName: keyUser,
            Status: 'Active',
            Tags: [{ Key: 'owner', Value: keyUser }],
            ...keyExtra,
          },
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

interface DetectOptions {
  /** Which record's read throws AWS's error naming the user. */
  readonly fail?: 'key' | 'user';
  /** The access key's live `UserName`, when it differs from the record (drift). */
  readonly liveKeyUser?: string;
  readonly args?: readonly string[];
  /** The access key's RECORDED `UserName` (default: the secret-named user). */
  readonly recordedKeyUser?: string;
  /** Extra properties on the key's record and on its live read. */
  readonly keyExtra?: { readonly recorded: Record<string, unknown>; readonly live: Record<string, unknown> };
}

/** Run the command; returns the log lines and what it wrote to stdout. */
async function detect(
  userName: string,
  options: DetectOptions = {}
): Promise<{ lines: string[]; stdout: string }> {
  logLines.length = 0;
  // Each provider logs through the module logger, as the real ones do.
  const log = getLogger();
  const notFound = (): Error => {
    const err = new Error(`The user with name ${USER_ID} cannot be found.`);
    err.name = 'NoSuchEntity';
    return err;
  };
  const keyProvider = {
    readCurrentState: vi.fn(async () => {
      log.debug(`Reading access keys of user ${USER_ID}`);
      if (options.fail === 'key') throw notFound();
      return {
        UserName: options.liveKeyUser ?? USER_ID,
        Status: 'Active',
        Tags: [{ Key: 'owner', Value: options.liveKeyUser ?? USER_ID }],
        ...(options.keyExtra?.live ?? {}),
      };
    }),
  };
  const userProvider = {
    readCurrentState: vi.fn(async () => {
      log.debug(`Reading user ${USER_ID}`);
      if (options.fail === 'user') throw notFound();
      return { UserName: userName };
    }),
  };
  mockGetProvider.mockImplementation((type: string) =>
    type === 'AWS::IAM::AccessKey' ? keyProvider : userProvider
  );
  mockGetState.mockResolvedValue(
    stateWith(userName, options.recordedKeyUser, options.keyExtra?.recorded)
  );
  const stdout: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const cmd = createDriftCommand();
    cmd.exitOverride();
    await cmd.parseAsync(
      ['TestStack', '--state-bucket', 'b', '--region', 'us-east-1', ...(options.args ?? [])],
      { from: 'user' }
    );
  } catch {
    // exit / process.exit stub
  } finally {
    process.stdout.write = original;
  }
  // Premise: both reads ran.
  expect(keyProvider.readCurrentState).toHaveBeenCalledTimes(1);
  expect(userProvider.readCurrentState).toHaveBeenCalledTimes(1);
  return { lines: [...logLines], stdout: stdout.join('') };
}

const SECRET_NAMED: Array<[string, string]> = [
  ['a secret reference', '{{resolve:secretsmanager:team-name}}'],
  ['the redaction mask', '***'],
];

describe('cdkd drift detection masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mockGetState.mockReset();
    mockGetProvider.mockReset();
    mockSaveState.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it.each(SECRET_NAMED)(
    "masks the secret-named user's own read line and a reader's (%s)",
    async (_l, userName) => {
      const { lines } = await detect(userName);
      expect(lines).toContain('debug Reading user ***');
      expect(lines).toContain('debug Reading access keys of user ***');
      expect(lines.join('\n')).not.toContain(USER_ID);
    }
  );

  it.each(
    SECRET_NAMED.flatMap(([label, userName]) =>
      (['key', 'user'] as const).map((fail) => [label, userName, fail] as const)
    )
  )("masks a failed read's warning quoting AWS's error text (%s, %s read fails)", async (_l, userName, fail) => {
    const { lines } = await detect(userName, { fail });
    const failure = lines.filter((l) => l.includes('cannot be found'));
    // Premise: the command logged the failure.
    expect(failure.length).toBeGreaterThan(0);
    expect(failure.join('\n')).not.toContain(USER_ID);
  });

  it.each([
    ['the human report', [] as string[]],
    ['--json', ['--json']],
    ['the --accept plan', ['--accept', '--dry-run']],
    ['the --revert plan', ['--revert', '--dry-run']],
  ])(
    "masks a reader's stored copy of the name in %s's drifted rows, and --accept writes it raw",
    async (_l, args) => {
      const live = `${USER_ID}-renamed`;
      const { stdout } = await detect('***', { liveKeyUser: live, args });
      // Premise: the row is rendered, both sides.
      expect(stdout).toContain('UserName');
      // An object-valued row too (the tag list), masked through maskDeep.
      expect(stdout).toContain('Tags');
      expect(stdout).toContain('***-renamed');
      expect(stdout).not.toContain(USER_ID);
    }
  );

  it("masks a row whose AWS side drifted ONTO the secret-named user", async () => {
    // The key's record holds an ordinary user, so its own bag holds no needle
    // for the secret-named one; the stack-wide needles mask the live side.
    const { stdout } = await detect('***', {
      recordedKeyUser: 'plain-other-user',
      liveKeyUser: USER_ID,
    });
    expect(stdout).toContain('plain-other-user');
    expect(stdout).not.toContain(USER_ID);
  });

  it('--json masks keys and string leaves, keeping the shape: no collapse, no depth cut', async () => {
    // Twelve levels deep, past any walk's depth cap, ending in the name.
    const deep = (leaf: string): Record<string, unknown> => {
      let node: Record<string, unknown> = { leaf };
      for (let i = 0; i < 12; i++) node = { [`level${i}`]: node };
      return node;
    };
    // Keys holding the name: the bare name and a literal `***` mask alike, so
    // the masked one takes a suffix rather than collapsing into the other.
    // Inside a list, so the row's value is the whole object (a list drifts as
    // one row).
    const entry = (b: string, leaf: string): Record<string, unknown> => ({
      [USER_ID]: 'x',
      '***': 'literal',
      [`${USER_ID}-b`]: b,
      Deep: deep(leaf),
    });
    const recorded = { Meta: [entry('y', 'plain')] };
    const live = { Meta: [entry('z', USER_ID)] };
    const { stdout } = await detect('***', { keyExtra: { recorded, live }, args: ['--json'] });
    const payload = JSON.parse(stdout) as Array<{
      drifted: Array<{ changes: Array<{ path: string; awsValue: unknown }> }>;
    }>;
    const changes = payload.flatMap((p) => p.drifted.flatMap((d) => d.changes));
    const meta = changes.find((c) => c.path === 'Meta');
    // Premise: the drifted Meta row is reported.
    expect(meta).toBeDefined();
    const [shown] = meta!.awsValue as Array<Record<string, unknown>>;
    // Every key survives as its own entry, none naming the user.
    expect(Object.keys(shown!).sort()).toEqual(['***', '***#2', '***-b', 'Deep'].sort());
    expect(shown!['***']).toBe('literal');
    expect(JSON.stringify(changes)).not.toContain(USER_ID);
    // The deep leaf is masked in place, the path to it kept whole.
    expect(JSON.stringify(shown)).toContain('"level11"');
    expect(JSON.stringify(shown)).toContain('"leaf":"***"');
  });

  it.each([
    ['the human report', [] as string[]],
    ['--json', ['--json']],
    ['the --accept plan', ['--accept', '--dry-run']],
    ['the --revert plan', ['--revert', '--dry-run']],
  ])("masks a path segment keyed by the name in %s", async (_l, args) => {
    // A map keyed by the secret-named user: the drifted row's PATH ends in it.
    const { stdout } = await detect('***', {
      keyExtra: { recorded: { Meta: { [USER_ID]: 'a' } }, live: { Meta: { [USER_ID]: 'b' } } },
      args,
    });
    // Premise: the row is rendered.
    expect(stdout).toContain('Meta.***');
    expect(stdout).not.toContain(USER_ID);
  });

  it('--accept masks the path in its refusal warning', async () => {
    const { lines } = await detect('***', {
      keyExtra: { recorded: { Meta: { [USER_ID]: '***' } }, live: { Meta: { [USER_ID]: 'b' } } },
      args: ['--accept', '--yes'],
    });
    const refused = lines.filter((l) => l.includes('not accepting'));
    // Premise: the refusal arm ran for the Meta row.
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.join('\n')).toContain('Meta.***');
    expect(lines.join('\n')).not.toContain(USER_ID);
  });

  it('--accept saves the raw value: the mask is display only', async () => {
    const live = `${USER_ID}-renamed`;
    await detect('***', { liveKeyUser: live, args: ['--accept', '--yes'] });
    expect(mockSaveState).toHaveBeenCalled();
    const saved = mockSaveState.mock.calls.at(-1)![2] as StackState;
    expect(JSON.stringify(saved.resources['Key'])).toContain(live);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const { lines } = await detect('plain-user-name', { fail: 'key' });
    expect(lines).toContain(`debug Reading user ${USER_ID}`);
    expect(lines).toContain(`debug Reading access keys of user ${USER_ID}`);
    expect(lines.filter((l) => l.includes('cannot be found')).join('\n')).toContain(USER_ID);
    const { stdout } = await detect('plain-user-name', { liveKeyUser: `${USER_ID}-renamed` });
    expect(stdout).toContain(`${USER_ID}-renamed`);
  });
});
