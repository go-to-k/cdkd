import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  GetBucketLocationCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { ResolvedStateBucket } from '../../../src/cli/config-loader.js';

/**
 * Issue [#2280](https://github.com/go-to-k/cdkd/issues/2280): the four
 * `cdkd state` subcommands with a `--json` mode (`list` / `resources` /
 * `show` / `info`) must put NOTHING but the payload on stdout, and must still
 * SHOW the operator every human-facing line they would otherwise have printed
 * there.
 *
 * THE LOGGER IS DELIBERATELY NOT MOCKED IN THIS FILE, unlike the other
 * `state` suites. The whole defect is which `console` method
 * `ConsoleLogger.emit` picks, and a `vi.fn()` standing in for `getLogger()`
 * answers that question by construction: it records the call and writes
 * nothing, so `--json` output looks clean whether or not the fix exists.
 * Here the real logger runs and the CONSOLE METHODS are spied instead —
 * see `tests/unit/cli/drift-json-stream.test.ts` for the measurement behind
 * that choice (Vitest intercepts `console`, so a stream-method capture is
 * blind to every logger line).
 *
 * The discriminating prose is REAL production code: every case passes
 * `--role-arn`, so `applyRoleArnIfSet` (`src/utils/role-arn.ts`) emits its
 * `Assumed role ...` INFO line — through a `child()` logger a command file
 * cannot reach, which is exactly why the reservation is module-level.
 */

// Mock the resolvers so we don't talk to STS for the bucket name.
const mockResolveWithSource =
  vi.fn<(cliBucket: string | undefined, region: string) => Promise<ResolvedStateBucket>>();
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveStateBucketWithDefaultAndSource: (
    cliBucket: string | undefined,
    region: string
  ): Promise<ResolvedStateBucket> => mockResolveWithSource(cliBucket, region),
}));

// Mock S3 client — `state info` issues raw GetBucketLocation / ListObjectsV2 /
// GetObject calls; the other three subcommands never touch it (their backend
// is mocked below).
const mockS3Send =
  vi.fn<
    (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>
  >();
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return { send: mockS3Send, destroy: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

// `state info` region-corrects its raw-read client; `null` = keep original.
vi.mock('../../../src/utils/bucket-region-client.js', () => ({
  rebuildClientForBucketRegion: vi.fn(async () => null),
}));

const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockGetState = vi.fn<(stackName: string, region: string) => Promise<unknown>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    listStacks: mockListStacks,
    getState: mockGetState,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockGetLockInfo = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: vi.fn(async () => false),
    getLockInfo: mockGetLockInfo,
  })),
}));

vi.mock('../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation(() => ({})),
}));

/**
 * STS is mocked so the REAL `applyRoleArnIfSet` runs — its `Assumed role ...`
 * INFO line (`src/utils/role-arn.ts`) is the shared-module prose this fence
 * has to see moved.
 */
const mockStsSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: vi.fn(),
  })),
  AssumeRoleCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';
import { getLogger, releaseStdoutForPayload } from '../../../src/utils/logger.js';

interface Streams {
  /** Everything a pipe reading fd 1 would receive, in order. */
  stdout: string;
  /** Everything a terminal reading fd 2 would receive, in order. */
  stderr: string;
  error: unknown;
}

/**
 * Run a `state` subcommand with fd 1 and fd 2 modelled separately. Both the
 * direct `process.stdout.write` calls (the payload) and the `console.*` calls
 * the real logger makes are funnelled into the same two buffers, so `stdout`
 * is the byte stream a consumer's `JSON.parse` actually sees.
 */
async function runState(args: string[]): Promise<Streams> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  const toFd1 = (line: unknown): void => void out.push(`${String(line)}\n`);
  const toFd2 = (line: unknown): void => void err.push(`${String(line)}\n`);
  const consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(toFd1),
    vi.spyOn(console, 'info').mockImplementation(toFd1),
    vi.spyOn(console, 'debug').mockImplementation(toFd1),
    vi.spyOn(console, 'warn').mockImplementation(toFd2),
    vi.spyOn(console, 'error').mockImplementation(toFd2),
  ];

  let error: unknown;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    for (const spy of consoleSpies) spy.mockRestore();
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

const ROLE_ARN = 'arn:aws:iam::111122223333:role/cdkd-json-stream-reader';
const ASSUMED_LINE = `Assumed role ${ROLE_ARN}`;

describe('state --json subcommands keep stdout to the payload (issue #2280)', () => {
  // `applyRoleArnIfSet` WRITES the assumed credentials into `process.env`.
  let envBefore: Record<string, string | undefined>;

  beforeEach(() => {
    mockResolveWithSource.mockReset();
    mockS3Send.mockReset();
    mockListStacks.mockReset();
    mockGetState.mockReset();
    mockVerifyBucketExists.mockReset().mockResolvedValue(undefined);
    mockGetLockInfo.mockReset().mockResolvedValue(null);
    mockStsSend.mockReset().mockResolvedValue({
      Credentials: {
        AccessKeyId: 'AKIA_LANE2280_TEST',
        SecretAccessKey: 'secret-lane2280-test',
        SessionToken: 'token-lane2280-test',
        Expiration: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    envBefore = {
      AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
      AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
      AWS_SESSION_TOKEN: process.env['AWS_SESSION_TOKEN'],
    };
    mockListStacks.mockResolvedValue([{ stackName: 'TestStack', region: 'us-east-1' }]);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // The reservation is module-global by design; release it so one case
    // cannot decide the next one's routing.
    releaseStdoutForPayload();
    // Second global: `--verbose` raises the SINGLETON's level and nothing
    // lowers it, so later cases would render in verbose form.
    getLogger().setLevel('info');
  });

  it('state list --json --verbose --role-arn leaves stdout a single JSON document', async () => {
    const { stdout, stderr, error } = await runState([
      'list',
      '--json',
      '--verbose',
      '--role-arn',
      ROLE_ARN,
      '--state-bucket',
      'b',
    ]);

    expect(error).toBeUndefined();
    const payload = JSON.parse(stdout) as Array<{ stackName: string; region: string | null }>;
    expect(payload).toEqual([{ stackName: 'TestStack', region: 'us-east-1' }]);

    // MOVED, not dropped: the operator still sees the role-assumption notice.
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  it('state resources --json --verbose --role-arn does the same', async () => {
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'TestStack',
        region: 'us-east-1',
        resources: {
          Bucket1: {
            physicalId: 'phys-1',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
          },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"etag-1"',
    });

    const { stdout, stderr, error } = await runState([
      'resources',
      'TestStack',
      '--json',
      '--verbose',
      '--role-arn',
      ROLE_ARN,
      '--state-bucket',
      'b',
    ]);

    expect(error).toBeUndefined();
    const payload = JSON.parse(stdout) as Array<{ logicalId: string }>;
    expect(payload.map((r) => r.logicalId)).toEqual(['Bucket1']);
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  it('state show --json --verbose --role-arn does the same', async () => {
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'TestStack',
        region: 'us-east-1',
        resources: {},
        outputs: {},
        lastModified: 0,
      },
      etag: '"etag-1"',
    });

    const { stdout, stderr, error } = await runState([
      'show',
      'TestStack',
      '--json',
      '--verbose',
      '--role-arn',
      ROLE_ARN,
      '--state-bucket',
      'b',
    ]);

    expect(error).toBeUndefined();
    const payload = JSON.parse(stdout) as { state: { stackName: string }; lock: unknown };
    expect(payload.state.stackName).toBe('TestStack');
    expect(payload.lock).toBeNull();
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  it('state info --json --verbose --role-arn does the same', async () => {
    mockResolveWithSource.mockResolvedValue({ bucket: 'test-bucket', source: 'cli-flag' });
    mockS3Send.mockImplementation(async (command) => {
      if (command instanceof GetBucketLocationCommand) {
        return { LocationConstraint: undefined }; // us-east-1
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = (command.input['Prefix'] as string | undefined) ?? '';
        return {
          Contents: ['cdkd/TestStack/us-east-1/state.json']
            .filter((k) => k.startsWith(prefix))
            .map((Key) => ({ Key })),
          NextContinuationToken: undefined,
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          Body: {
            transformToString: async () =>
              JSON.stringify({
                version: 2,
                stackName: 'TestStack',
                resources: {},
                outputs: {},
                lastModified: 0,
              }),
          },
        };
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    });

    const { stdout, stderr, error } = await runState([
      'info',
      '--json',
      '--verbose',
      '--role-arn',
      ROLE_ARN,
      '--state-bucket',
      'test-bucket',
    ]);

    expect(error).toBeUndefined();
    const payload = JSON.parse(stdout) as { bucket: string; stackCount: number };
    expect(payload.bucket).toBe('test-bucket');
    expect(payload.stackCount).toBe(1);
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  /**
   * Issue [#2435](https://github.com/go-to-k/cdkd/issues/2435): `state list`'s
   * reservation is UNCONDITIONAL. `--json` picks the payload's ENCODING; it
   * was never what made stdout a payload stream, and the DEFAULT mode writes
   * one `Stack (region)` reference per line — the shape
   * `cdkd state list | while read -r ref` consumes, the same contract as
   * `cdkd list`'s default mode (issue #2410, `list-json-stream.test.ts`).
   *
   * The case this replaces asserted the opposite ("no `--json` ⇒ prose stays
   * on stdout"), which #2435 deliberately made false. The over-tightening
   * control it used to provide now lives on `state resources` at the bottom of
   * this file, where the `--json` gate is still the intended behaviour.
   */
  it('state list with NO flags leaves stdout to the stack references (issue #2435)', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'TestStack', region: 'us-east-1' },
      { stackName: 'OtherStack', region: 'us-west-2' },
    ]);

    const { stdout, stderr, error } = await runState([
      'list',
      '--role-arn',
      ROLE_ARN,
      '--state-bucket',
      'b',
    ]);

    expect(error).toBeUndefined();
    // Byte-exact: the payload is the reference list and nothing else, sorted.
    // `toContain` would pass with the role-assumption notice appended, which
    // is precisely the corruption a `while read -r ref` loop sees.
    expect(stdout).toBe('OtherStack (us-west-2)\nTestStack (us-east-1)\n');

    // MOVED, not dropped — the operator still sees the notice.
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  /**
   * The spelling the issue MEASURED: `--verbose` with no `--json` put 1,094
   * bytes of DEBUG stack trace on stdout. `--verbose` also reaches a different
   * `ConsoleLogger.emit` arm from the INFO case above (`console.debug`), so
   * this is not a second spelling of it.
   */
  it('state list --verbose keeps DEBUG prose off stdout with no --json (issue #2435)', async () => {
    const { stdout, stderr, error } = await runState([
      'list',
      '--verbose',
      '--role-arn',
      ROLE_ARN,
      '--state-bucket',
      'b',
    ]);

    expect(error).toBeUndefined();
    expect(stdout).toBe('TestStack (us-east-1)\n');
    expect(stderr).toContain('Assuming role');
    expect(stdout).not.toContain('Assuming role');
  });

  /**
   * `--long` without `--json` is a formatted VIEW, not a record set, and it is
   * swept along by the same reservation because the claim is taken before the
   * mode is known. Fenced so that "swept along" is a decision on record rather
   * than an accident: the view itself must still be on stdout (it is a direct
   * `process.stdout.write`), and only the logger prose moves.
   */
  it('state list --long without --json keeps its view on stdout, prose on stderr', async () => {
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'TestStack',
        region: 'us-east-1',
        resources: {},
        outputs: {},
        lastModified: 0,
      },
      etag: '"etag-1"',
    });

    const { stdout, stderr, error } = await runState([
      'list',
      '--long',
      '--role-arn',
      ROLE_ARN,
      '--state-bucket',
      'b',
    ]);

    expect(error).toBeUndefined();
    expect(stdout).toContain('TestStack (us-east-1)');
    expect(stdout).toContain('Resources: 0');
    expect(stderr).toContain(ASSUMED_LINE);
    expect(stdout).not.toContain(ASSUMED_LINE);
  });

  /**
   * THE OVER-TIGHTENING CONTROL, and the fence on issue #2435's scope line.
   * `state resources` / `show` / `info` keep the `--json` gate deliberately:
   * their flagless output is a formatted human VIEW (aligned columns, rendered
   * blocks) with no record-set mode behind it, so reserving stdout there would
   * move an operator's prose off the stream they are already reading it on for
   * no consumer's benefit.
   *
   * Without this case, "make every `state` reservation unconditional" would
   * pass the whole file — which is the change the issue explicitly declined.
   */
  it('state resources WITHOUT --json still keeps its logger prose on stdout', async () => {
    mockGetState.mockResolvedValue({
      state: {
        version: 2,
        stackName: 'TestStack',
        region: 'us-east-1',
        resources: {
          Bucket1: { physicalId: 'phys-1', resourceType: 'AWS::S3::Bucket', properties: {} },
        },
        outputs: {},
        lastModified: 0,
      },
      etag: '"etag-1"',
    });

    const { stdout, stderr, error } = await runState([
      'resources',
      'TestStack',
      '--role-arn',
      ROLE_ARN,
      '--state-bucket',
      'b',
    ]);

    expect(error).toBeUndefined();
    expect(stdout).toContain('Bucket1');
    expect(stdout).toContain(ASSUMED_LINE);
    expect(stderr).not.toContain(ASSUMED_LINE);
  });
});
