/**
 * Issue [#3465](https://github.com/go-to-k/cdkd/issues/3465), the WIRING half:
 * `cdkd export` hands `reportDriftBaselineGaps` the template it migrates
 * against when it SYNTHESIZED the app, so a REASON-LESS refused baseline is
 * classified the way the next deploy reads it — and NOT a `--template` file,
 * which the next deploy does not read. The classification itself is pinned in
 * `export.test.ts` by calling the report directly; this drives the real
 * command through `createExportCommand()` (the harness of
 * `export-non-interactive-confirm.test.ts`, plus a `Synthesizer` double) and
 * reads what it warned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
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

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'node app.js'),
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
    destroyClient: vi.fn(),
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

// readline: mocked so nothing can block on a prompt (`--yes` skips it).
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

function template(bucketName: unknown): Record<string, unknown> {
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Parameters: { Env: { Type: 'String', Default: 'dev' } },
    Resources: {
      MyBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: bucketName } },
    },
  };
}

function stateRecord(): { state: Record<string, unknown>; etag: string } {
  return {
    state: {
      version: 10,
      stackName: STACK,
      region: REGION,
      resources: {
        MyBucket: {
          physicalId: 'my-bucket-phys',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: {},
          dependencies: [],
          // An older cdkd's marker: no `observedBaselineRefusalReason`.
          observedBaselineRefused: true,
        },
      },
      outputs: {},
      lastModified: 1,
    },
    etag: 'e0',
  };
}

async function refusedWarning(
  bucketName: unknown,
  source: 'synth' | 'file'
): Promise<string | undefined> {
  const tpl = template(bucketName);
  writeFileSync(templatePath, JSON.stringify(tpl), 'utf-8');
  mockSynthesize.mockResolvedValue({
    stacks: [{ stackName: STACK, displayName: STACK, region: REGION, template: tpl }],
  });
  const cmd = createExportCommand();
  cmd.exitOverride();
  // Two literal argv lists rather than a conditional spread, so the
  // commander-arity convention test can read both sites.
  const run =
    source === 'file'
      ? cmd.parseAsync(
          [
            STACK,
            '--template',
            templatePath,
            '--state-bucket',
            'test-bucket',
            '--stack-region',
            REGION,
            '--skip-import-support-preflight',
            '--yes',
          ],
          { from: 'user' }
        )
      : cmd.parseAsync(
          [
            STACK,
            '--state-bucket',
            'test-bucket',
            '--stack-region',
            REGION,
            '--skip-import-support-preflight',
            '--yes',
          ],
          { from: 'user' }
        );
  await run.catch((e: unknown) => {
    // The changeset step fails against the CFn double AFTER the report ran.
    if (!(e instanceof Error) || e.message !== 'process.exit-mock') throw e;
  });
  return warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('REFUSED'));
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  cfnCalls.length = 0;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
  tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-refused-'));
  templatePath = join(tmp, 'template.json');
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
  rmSync(tmp, { recursive: true, force: true });
});

describe('cdkd export classifies a reason-less refused baseline against its template (issue #3465)', () => {
  it('names the sticky remedy when the resource reads a declared parameter', async () => {
    const warning = await refusedWarning({ Ref: 'Env' }, 'synth');
    expect(mockSynthesize).toHaveBeenCalled();
    expect(warning).toBeDefined();
    expect(warning).toMatch(/For each one: Deploying a change does NOT clear this refusal/);
    expect(warning).not.toMatch(/recorded without a reason/);
  });

  it('names the deploy remedy when the resource reads no parameter', async () => {
    const warning = await refusedWarning('literal-bucket', 'synth');
    expect(mockSynthesize).toHaveBeenCalled();
    expect(warning).toBeDefined();
    expect(warning).toMatch(/Deploy a change to each one to restore its baseline\.$/);
    expect(warning).not.toMatch(/recorded without a reason/);
  });

  it('keeps the hedged remedy under --template, which the next deploy does not read', async () => {
    // The same template that classified as sticky through synthesis above.
    const warning = await refusedWarning({ Ref: 'Env' }, 'file');
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(warning).toBeDefined();
    expect(warning).toMatch(/For each one: This refusal was recorded without a reason/);
  });
});
