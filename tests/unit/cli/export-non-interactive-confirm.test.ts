/**
 * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275), the ROUTING half
 * for `cdkd export`'s TWO in-command confirmation prompts.
 *
 * `cdkd export` has THREE prompt call sites and they are reached from two
 * entry points. `tests/unit/cli/export-nested-loop.test.ts` covers the third
 * (the nested-stack tree-wide confirm, inside `runPerStackImportLoop`, which
 * is exported and drivable on its own). The other two live inside
 * `exportCommand`, which is NOT exported — this file drives them through
 * `createExportCommand()`, the same way `import.test.ts` drives its command:
 *
 *   1. the rollback-journal override ("Export anyway?"), which fires BEFORE
 *      the lock is acquired; and
 *   2. the single-stack migration confirm, which fires AFTER it.
 *
 * They were reported as unclosable because `exportCommand` is not exported.
 * The factory is (`export.ts`'s `createExportCommand`), and parsing argv
 * through it exercises the real handler.
 *
 * `--template <path>` rather than a synthesized app: it takes the same code
 * path from `pickStackRegion` onward and needs no `Synthesizer` double, so
 * what the cases pin is the prompt routing rather than a mock of synthesis.
 *
 * WHAT THIS DOES NOT PROVE: the refusal's own shape. The
 * `NON_INTERACTIVE_CONFIRM` code, the wording, and the fence against a
 * question that never settles are pinned per-helper in
 * `tests/unit/cli/non-interactive-confirm-guards.test.ts`. Here the subject is
 * only whether the COMMAND still reaches that helper — and, for each site,
 * that nothing was mutated on the way out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => undefined),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

// `assertCfnStackAbsent` treats a "does not exist" rejection as "free to
// create", which is the shape a real DescribeStacks returns for an absent
// stack. `ec2` is consulted by `buildImportPlan` only for rows cdkd state
// cannot answer for (issue #1791), which this fixture has none of.
const cfnCalls = vi.hoisted(() => [] as string[]);
const cfnSend = vi.hoisted(() =>
  vi.fn(async (cmd: { constructor: { name: string } }) => {
    cfnCalls.push(cmd.constructor.name);
    // Answering every CFn call with the not-found rejection is deliberate:
    // it is exactly what `assertCfnStackAbsent` needs, and no OTHER CFn call
    // should be reached before the prompt. `cfnCalls` is what the cases
    // assert on, so an unexpected one is visible by NAME rather than as an
    // opaque count.
    throw new Error('Stack with id Exported does not exist');
  })
);
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return { send: cfnSend };
    },
    get ec2() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ sts: { send: vi.fn() } })),
}));

const mockVerifyBucketExists = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockListStacks = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const mockGetState = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockLoadRollbackJournal = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockDeleteState = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockSaveState = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: mockVerifyBucketExists,
    listStacks: mockListStacks,
    getState: mockGetState,
    loadRollbackJournal: mockLoadRollbackJournal,
    deleteState: mockDeleteState,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const mockGetLockInfo = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockReleaseLock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: mockGetLockInfo,
    releaseLock: mockReleaseLock,
  })),
}));

// readline: mocked so a REGRESSION (guard removed) fails as an assertion here
// rather than hanging. The hang itself is fenced, against real readline, in
// `non-interactive-confirm-guards.test.ts`.
const readlineQuestion = vi.hoisted(() => vi.fn<(p: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
const createInterfaceMock = vi.hoisted(() =>
  vi.fn(() => ({ question: readlineQuestion, close: readlineClose }))
);
vi.mock('node:readline/promises', () => ({ createInterface: createInterfaceMock }));

import { createExportCommand } from '../../../src/cli/commands/export.js';

const STACK = 'Exported';
const REGION = 'us-east-1';

let tmp: string;
let templatePath: string;

/** One importable S3 bucket — the smallest template that yields a phase-1 plan. */
const TEMPLATE = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: { MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
};

function stateRecord(): { state: Record<string, unknown>; etag: string } {
  return {
    state: {
      version: 9,
      stackName: STACK,
      region: REGION,
      resources: {
        MyBucket: {
          physicalId: 'my-bucket-phys',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 1,
    },
    etag: 'e0',
  };
}

/**
 * Run the command and return the message `handleError` printed, or
 * `undefined` when the run completed without one.
 *
 * The action is wrapped in `withErrorHandling`, which CATCHES the refusal and
 * routes it to `handleError` -> `logger.error` + `process.exit(1)`. So the
 * throw never escapes `parseAsync`, and reading the logged message (plus the
 * exit spy) is the only way to observe it from here. `formatError` renders
 * `<name>: <message>`, so the name pins that this is a `CdkdError` rather
 * than a bare `Error` -- the shape CI branches on.
 */
async function runExport(args: string[]): Promise<string | undefined> {
  const cmd = createExportCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' }).catch((e: unknown) => {
    // `process.exit` is stubbed to throw, so a handled error surfaces here.
    if (!(e instanceof Error) || e.message !== 'process.exit-mock') throw e;
  });
  const logged = errorSpy.mock.calls.map((c) => String(c[0]));
  return logged.length > 0 ? logged.join('\n') : undefined;
}

let originalIsTTY: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  cfnCalls.length = 0;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-confirm-'));
  templatePath = join(tmp, 'template.json');
  writeFileSync(templatePath, JSON.stringify(TEMPLATE), 'utf-8');

  mockVerifyBucketExists.mockResolvedValue(undefined);
  mockListStacks.mockResolvedValue([{ stackName: STACK, region: REGION }]);
  mockGetState.mockResolvedValue(stateRecord());
  mockLoadRollbackJournal.mockResolvedValue(null);
  mockAcquireLock.mockResolvedValue(true);
  mockGetLockInfo.mockResolvedValue(null);
  mockReleaseLock.mockResolvedValue(undefined);
  mockDeleteState.mockResolvedValue(undefined);
  mockSaveState.mockResolvedValue('etag-1');
});

afterEach(() => {
  exitSpy.mockRestore();
  setStdinIsTty(originalIsTTY);
  rmSync(tmp, { recursive: true, force: true });
});

/** The argv every case starts from: a real-run, flagless single-stack export. */
function baseArgs(): string[] {
  return [
    STACK,
    '--template',
    templatePath,
    '--state-bucket',
    'test-bucket',
    '--stack-region',
    REGION,
    '--skip-import-support-preflight',
  ];
}

describe('cdkd export prompts REFUSE a non-interactive stdin (issue #2275)', () => {
  describe('the rollback-journal override ("Export anyway?")', () => {
    /** A journal with one segment, which is what makes the override fire. */
    function withJournal(): void {
      mockLoadRollbackJournal.mockResolvedValue({
        journalVersion: 1,
        stackName: STACK,
        region: REGION,
        segments: [
          { timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [] },
        ],
      });
    }

    it('REFUSES before the lock is taken', async () => {
      setStdinIsTty(undefined);
      withJournal();

      const message = await runExport(baseArgs());

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(message).toContain('CdkdError');
      expect(message).toContain('The cdkd export confirmation prompt cannot run');
      expect(message).toContain('-y / --yes');
      expect(createInterfaceMock).not.toHaveBeenCalled();
      // This prompt sits AHEAD of `acquireLock`, so a refusal here must not
      // have touched the lock at all — nothing to leak, nothing to release.
      expect(mockAcquireLock).not.toHaveBeenCalled();
      expect(mockDeleteState).not.toHaveBeenCalled();
    });

    it('still PROMPTS on a TTY, and a decline stops the export', async () => {
      // The negative control. Without it a guard that refused unconditionally
      // would satisfy the case above while breaking every interactive run,
      // and a guard hoisted ABOVE the `--yes` short-circuit would too.
      withJournal();
      readlineQuestion.mockResolvedValue('n');

      const message = await runExport(baseArgs());

      expect(message).toBeUndefined();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(readlineQuestion).toHaveBeenCalledTimes(1);
      expect(readlineQuestion).toHaveBeenCalledWith('Export anyway? [y/N] ');
      expect(mockAcquireLock).not.toHaveBeenCalled();
    });
  });

  describe('the single-stack migration confirm', () => {
    it('REFUSES after the lock is taken, and releases it on the way out', async () => {
      setStdinIsTty(undefined);

      const message = await runExport(baseArgs());

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(message).toContain('CdkdError');
      expect(message).toContain('The cdkd export confirmation prompt cannot run');
      expect(createInterfaceMock).not.toHaveBeenCalled();
      // This prompt sits INSIDE the lock's `try`, which is exactly why the
      // refusal must not leak it: `docs/cli-destroy.md` claims every lock
      // held at a prompt is released in a `finally`, and this is the arm that
      // makes the claim true for `cdkd export`.
      expect(mockAcquireLock).toHaveBeenCalledTimes(1);
      expect(mockReleaseLock).toHaveBeenCalledTimes(1);
      // Nothing migrated: no changeset, no state deletion.
      expect(cfnCalls).not.toContain('CreateChangeSetCommand');
      expect(cfnCalls).not.toContain('ExecuteChangeSetCommand');
      expect(mockDeleteState).not.toHaveBeenCalled();
    });

    it('still PROMPTS on a TTY, and a decline stops the export', async () => {
      readlineQuestion.mockResolvedValue('n');

      const message = await runExport(baseArgs());

      expect(message).toBeUndefined();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(readlineQuestion).toHaveBeenCalledTimes(1);
      expect(readlineQuestion.mock.calls[0]?.[0]).toContain(
        `Create CloudFormation stack '${STACK}' by importing 1 resource(s)`
      );
      expect(mockDeleteState).not.toHaveBeenCalled();
    });
  });
});
