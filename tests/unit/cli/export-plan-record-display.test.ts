/**
 * The import plan `cdkd export` prints DIRECTLY above its destructive
 * confirmation renders each recorded identifier value with its own boundary
 * (go-to-k/cdkd#3375): a state record's `physicalId` is anyone's who can write
 * the record, and a raw one carrying a newline forged plan rows under the
 * genuine ones. Driven through `createExportCommand()` with `--dry-run`, which
 * prints the plan and the pre-delete listing and returns before any AWS write
 * — the same harness `export-non-interactive-confirm.test.ts` uses.
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
//
// With `phase1Succeeds` set, a REAL run gets through phase 1: the IMPORT
// changeset creates and executes, and the stack reaches IMPORT_COMPLETE, so
// the run reaches the pre-delete of the Stage row. Every later CFn call fails,
// which ends the run there.
const cfnState = vi.hoisted(() => ({ phase1Succeeds: false, describeStacksCalls: 0 }));
const cfnSend = vi.hoisted(() =>
  vi.fn(async (cmd: { constructor: { name: string }; input?: { ChangeSetType?: string } }) => {
    const name = cmd.constructor.name;
    if (cfnState.phase1Succeeds) {
      if (name === 'DescribeStacksCommand' && cfnState.describeStacksCalls++ > 0) {
        return { Stacks: [{ StackName: 'Exported', StackStatus: 'IMPORT_COMPLETE' }] };
      }
      if (name === 'CreateChangeSetCommand' && cmd.input?.ChangeSetType === 'IMPORT') return {};
      if (name === 'DescribeChangeSetCommand') {
        return { Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE' };
      }
      if (name === 'ExecuteChangeSetCommand') return {};
    }
    throw new Error('Stack with id Exported does not exist');
  })
);

// The Stage pre-delete builds its OWN client, so the SDK package is mocked.
const deleteStage = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-apigatewayv2')>();
  return {
    ...actual,
    ApiGatewayV2Client: vi.fn().mockImplementation(() => ({ send: deleteStage })),
  };
});
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

// readline: mocked so a run that reached the confirmation fails as an
// assertion here rather than hanging — `--dry-run` must return before it.
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

/**
 * One importable S3 bucket (a phase-1 plan row) and one
 * `AWS::ApiGatewayV2::Stage` (a pre-delete + re-CREATE listing row).
 */
const TEMPLATE = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    MyStage: { Type: 'AWS::ApiGatewayV2::Stage', Properties: { ApiId: 'a1b2c3', StageName: 's' } },
  },
};

let bucketPhysicalId = 'my-bucket-phys';
let stagePhysicalId = 'stage-phys';

function stateRecord(): { state: Record<string, unknown>; etag: string } {
  return {
    state: {
      version: 9,
      stackName: STACK,
      region: REGION,
      resources: {
        MyBucket: {
          physicalId: bucketPhysicalId,
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: {},
          dependencies: [],
        },
        MyStage: {
          physicalId: stagePhysicalId,
          resourceType: 'AWS::ApiGatewayV2::Stage',
          properties: { ApiId: 'a1b2c3', StageName: 's' },
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
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  bucketPhysicalId = 'my-bucket-phys';
  stagePhysicalId = 'stage-phys';
  cfnState.phase1Succeeds = false;
  cfnState.describeStacksCalls = 0;
  deleteStage.mockReset();
  tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-plan-display-'));
  templatePath = join(tmp, 'template.json');
  writeFileSync(templatePath, JSON.stringify(TEMPLATE), 'utf-8');

  mockVerifyBucketExists.mockResolvedValue(undefined);
  mockListStacks.mockResolvedValue([{ stackName: STACK, region: REGION }]);
  mockGetState.mockImplementation(async () => stateRecord());
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

/** A `--dry-run` export: prints the plan, then returns before any AWS write. */
function dryRunArgs(): string[] {
  return [
    STACK,
    '--dry-run',
    '--template',
    templatePath,
    '--state-bucket',
    'test-bucket',
    '--stack-region',
    REGION,
    '--skip-import-support-preflight',
  ];
}


/** Every line `logger.info` printed during the run. */
function infoLines(): string[] {
  // The run returned at `--dry-run`, before the prompt and any state write.
  expect(createInterfaceMock).not.toHaveBeenCalled();
  expect(mockDeleteState).not.toHaveBeenCalled();
  expect(mockSaveState).not.toHaveBeenCalled();
  return infoSpy.mock.calls.map((c) => String(c[0]));
}

describe('cdkd export --dry-run renders recorded ids in the plan with their own boundary', () => {
  it('renders an ordinary record exactly as before', async () => {
    expect(await runExport(dryRunArgs())).toBeUndefined();
    const lines = infoLines();
    expect(lines).toContain('  MyBucket (AWS::S3::Bucket) ← BucketName=my-bucket-phys');
    expect(lines).toContain('  MyStage (AWS::ApiGatewayV2::Stage) — physicalId: stage-phys');
  });

  it('renders a real `$`-prefixed Stage id bare, as the export fixture expects', async () => {
    stagePhysicalId = '$default';
    expect(await runExport(dryRunArgs())).toBeUndefined();
    expect(infoLines()).toContain('  MyStage (AWS::ApiGatewayV2::Stage) — physicalId: $default');
  });

  it('keeps a planted newline from forging a plan row, and quotes the value', async () => {
    // A second row spelled exactly like a genuine one, and a quote to close
    // any hand-written one around the value.
    bucketPhysicalId = "my-bucket\n  Other (AWS::S3::Bucket) ← BucketName=x'";
    stagePhysicalId = "stage\n  Forged (AWS::ApiGatewayV2::Stage) — physicalId: y'";

    expect(await runExport(dryRunArgs())).toBeUndefined();
    const lines = infoLines();
    // Nothing printed begins a row the record did not have.
    expect(lines.some((l) => l.includes('\n'))).toBe(false);
    const planRow = lines.find((l) => l.startsWith('  MyBucket (AWS::S3::Bucket) ← '))!;
    // One JSON literal, every non-printable-ASCII character escaped: the
    // newline and the `←` inside the VALUE are `\n` and `\u2190`, so the
    // value is recoverable and cannot start or spell a row.
    expect(planRow).toBe(
      '  MyBucket (AWS::S3::Bucket) ← BucketName=' +
        String.raw`"my-bucket\n  Other (AWS::S3::Bucket) \u2190 BucketName=x'"`
    );
    const stageRow = lines.find((l) => l.startsWith('  MyStage (AWS::ApiGatewayV2::Stage) — '))!;
    expect(stageRow).toBe(
      '  MyStage (AWS::ApiGatewayV2::Stage) — physicalId: ' +
        String.raw`"stage\n  Forged (AWS::ApiGatewayV2::Stage) \u2014 physicalId: y'"`
    );
  });

  it('keeps two distinct non-ASCII ids distinct on the plan row', async () => {
    // A legitimate id may be UTF-8 (a CloudWatch AlarmName). An ASCII
    // allowlist would print both of these as "CPU-alarm"; the escape keeps
    // each recoverable, so the plan never shows two ids as the same text.
    const rows: string[] = [];
    for (const id of ['\u9ad8CPU-alarm', '\u4f4eCPU-alarm']) {
      infoSpy.mockClear();
      bucketPhysicalId = id;
      expect(await runExport(dryRunArgs())).toBeUndefined();
      rows.push(infoLines().find((l) => l.startsWith('  MyBucket (AWS::S3::Bucket) ← '))!);
    }
    expect(rows).toEqual([
      '  MyBucket (AWS::S3::Bucket) ← BucketName=' + String.raw`"\u9ad8CPU-alarm"`,
      '  MyBucket (AWS::S3::Bucket) ← BucketName=' + String.raw`"\u4f4eCPU-alarm"`,
    ]);
  });

  it('caps a planted multi-kilobyte id on the plan row', async () => {
    bucketPhysicalId = 'b'.repeat(5000);
    expect(await runExport(dryRunArgs())).toBeUndefined();
    const planRow = infoLines().find((l) => l.startsWith('  MyBucket (AWS::S3::Bucket) ← '))!;
    expect(planRow).toContain(`[cut: ${5000 - 2048} more characters withheld]`);
    expect(planRow).not.toContain('b'.repeat(2049));
  });
});

describe('cdkd export renders the pre-deleted Stage id with its own boundary on a real run', () => {
  /** A real, confirmed run: past phase 1, into the Stage pre-delete. */
  function realRunArgs(): string[] {
    return dryRunArgs()
      .filter((a) => a !== '--dry-run')
      .concat('--yes');
  }

  beforeEach(() => {
    cfnState.phase1Succeeds = true;
    stagePhysicalId = "stage\n  ✓ deleted prod'";
  });

  it('prints the success line with the recorded id escaped, on one line', async () => {
    deleteStage.mockResolvedValue({});
    // Phase 2 then fails against the stub; the line under test precedes it.
    await runExport(realRunArgs());
    expect(deleteStage).toHaveBeenCalledTimes(1);
    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('  ' + String.raw`✓ deleted "stage\n  \u2713 deleted prod'"`);
  });

  it('bounds the AWS error and escapes the recorded id when the pre-delete fails', async () => {
    deleteStage.mockRejectedValue(new Error(`AccessDenied\nRe-run with: rm -rf ~ ${'e'.repeat(5000)}`));
    const message = await runExport(realRunArgs());
    expect(message).toBeDefined();
    expect(message).toContain(
      'physicalId: ' + String.raw`"stage\n  \u2713 deleted prod'"` + ') failed: AccessDenied Re-run with'
    );
    expect(message).toContain('more characters withheld]');
    expect(message).not.toContain('e'.repeat(4097));
  });
});
