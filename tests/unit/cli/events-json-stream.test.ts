import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue [#2280](https://github.com/go-to-k/cdkd/issues/2280): `cdkd events
 * --json` (and its `--format json` alias) must put NOTHING but the payload on
 * stdout, and must still SHOW the operator every human-facing line it would
 * otherwise have printed there.
 *
 * THE LOGGER IS DELIBERATELY NOT MOCKED IN THIS FILE: the defect is which
 * `console` method `ConsoleLogger.emit` picks, so the real logger runs and
 * the console methods are spied into an ordered fd-1 / fd-2 transcript — the
 * measurement behind that harness shape is documented in
 * `tests/unit/cli/drift-json-stream.test.ts`.
 *
 * `cdkd events` has no `--role-arn` path, so the shared-module prose the
 * reservation exists for (`role-arn.ts` / `s3-state-backend.ts`) is not
 * reachable from a unit harness without standing up the whole S3 pipeline.
 * The discriminating emission therefore MODELS it: the mocked backend's
 * `verifyBucketExists` emits INFO + DEBUG lines through the REAL global
 * logger's `child('S3StateBackend')` — the exact logger shape the production
 * sites use (`getLogger().child('S3StateBackend')`, e.g. the legacy-layout
 * migration notice in `src/state/s3-state-backend.ts`). The child-logger
 * inheritance of the reservation is separately fenced in
 * `tests/unit/utils/logger-stdout-reservation.test.ts`; what this file adds
 * is that `eventsCommand` actually claims stdout before backend work runs.
 */

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
  getAwsClients: vi.fn(),
}));

const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockListRawKeys = vi.fn<(prefix: string) => Promise<string[]>>();
const mockGetRawObject = vi.fn<(key: string) => Promise<string | null>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    prefix: 'cdkd',
    verifyBucketExists: mockVerifyBucketExists,
    listRawKeys: mockListRawKeys,
    getRawObject: mockGetRawObject,
  })),
}));

import { createEventsCommand } from '../../../src/cli/commands/events.js';
import { getLogger, releaseStdoutForPayload } from '../../../src/utils/logger.js';

interface Streams {
  stdout: string;
  stderr: string;
  error: unknown;
}

async function runEvents(args: string[]): Promise<Streams> {
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
    const cmd = createEventsCommand();
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

const MIGRATED_LINE = "Migrated state for stack 'TestStack' to region-scoped layout (us-east-1)";
const DEBUG_LINE = 'probing state bucket for TestStack';

const INDEX_KEY = 'cdkd/TestStack/us-east-1/deployments/index.json';
const RUN_KEY = 'cdkd/TestStack/us-east-1/deployments/20260101T000000-abc.jsonl';

const RUN_SUMMARY = {
  runId: '20260101T000000-abc',
  command: 'deploy',
  cdkdVersion: '0.285.0',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
  result: 'SUCCEEDED',
  eventCount: 2,
};

function scriptBackend(): void {
  mockVerifyBucketExists.mockImplementation(async () => {
    // Model of the shared-module prose (see the file header). INFO + DEBUG so
    // both `--json` alone and `--json --verbose` have something to move.
    const child = getLogger().child('S3StateBackend');
    child.info(MIGRATED_LINE);
    child.debug(DEBUG_LINE);
  });
  mockListRawKeys.mockImplementation(async (prefix: string) =>
    [INDEX_KEY, RUN_KEY].filter((k) => k.startsWith(prefix))
  );
  mockGetRawObject.mockImplementation(async (key: string) => {
    if (key === INDEX_KEY) return JSON.stringify({ runs: [RUN_SUMMARY] });
    if (key === RUN_KEY) {
      return [
        JSON.stringify({
          eventType: 'RUN_STARTED',
          timestamp: RUN_SUMMARY.startedAt,
          command: 'deploy',
          cdkdVersion: RUN_SUMMARY.cdkdVersion,
        }),
        JSON.stringify({
          eventType: 'RUN_FINISHED',
          timestamp: RUN_SUMMARY.finishedAt,
          result: 'SUCCEEDED',
        }),
      ].join('\n');
    }
    return null;
  });
}

describe('events --json keeps stdout to the payload (issue #2280)', () => {
  beforeEach(() => {
    mockVerifyBucketExists.mockReset();
    mockListRawKeys.mockReset();
    mockGetRawObject.mockReset();
    scriptBackend();
  });

  afterEach(() => {
    releaseStdoutForPayload();
    getLogger().setLevel('info');
  });

  it('--json run listing leaves stdout a single JSON document', async () => {
    const { stdout, stderr, error } = await runEvents(['TestStack', '--json']);

    expect(error).toBeUndefined();
    const payload = JSON.parse(stdout) as {
      stackName: string;
      region: string;
      runs: Array<{ runId: string }>;
    };
    expect(payload.stackName).toBe('TestStack');
    expect(payload.region).toBe('us-east-1');
    expect(payload.runs.map((r) => r.runId)).toEqual([RUN_SUMMARY.runId]);

    // MOVED, not dropped.
    expect(stderr).toContain(MIGRATED_LINE);
    expect(stdout).not.toContain(MIGRATED_LINE);
  });

  it('--json --verbose moves the DEBUG prose too', async () => {
    const { stdout, stderr, error } = await runEvents(['TestStack', '--json', '--verbose']);

    expect(error).toBeUndefined();
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain(DEBUG_LINE);
    expect(stdout).not.toContain(DEBUG_LINE);
  });

  it('--run <id> --json leaves stdout a single JSON document', async () => {
    const { stdout, stderr, error } = await runEvents([
      'TestStack',
      '--run',
      RUN_SUMMARY.runId,
      '--json',
    ]);

    expect(error).toBeUndefined();
    const events = JSON.parse(stdout) as Array<{ eventType: string }>;
    expect(events.map((e) => e.eventType)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
    expect(stderr).toContain(MIGRATED_LINE);
    expect(stdout).not.toContain(MIGRATED_LINE);
  });

  it("--format json (the alias the issue's #808 spelling uses) reserves too", async () => {
    const { stdout, stderr, error } = await runEvents(['TestStack', '--format', 'json']);

    expect(error).toBeUndefined();
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain(MIGRATED_LINE);
    expect(stdout).not.toContain(MIGRATED_LINE);
  });

  /**
   * The other direction: the reservation is scoped to `--json`. The human run
   * listing renders through `logger.info`, which must STAY on stdout.
   */
  it('events WITHOUT --json keeps its human listing on stdout', async () => {
    const { stdout, error } = await runEvents(['TestStack']);

    expect(error).toBeUndefined();
    expect(stdout).toContain('Deployment runs for');
    expect(stdout).toContain(RUN_SUMMARY.runId);
  });
});
