/**
 * go-to-k/cdkd#6410, the WIRING half: `cdkd export` reads each SSM-typed
 * Parameter's SSM parameter BEFORE the lock, `--dry-run` included, and refuses
 * a missing one. The helper's own cases are in
 * `export-ssm-parameter-preflight-6410.test.ts`; this file drives the command
 * through `createExportCommand()` with the harness of
 * `export-non-interactive-confirm.test.ts`.
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
  // No cdk.json "tags" (go-to-k/cdkd#6909).
  loadCdkJson: vi.fn(() => null),
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
  AwsClients: vi.fn(() => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return { send: cfnSend };
    },
    get ssm() {
      return { send: ssmSend };
    },
    get ec2() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ sts: { send: vi.fn() } })),
}));


/** SSM parameter names that exist; every other GetParameter is ParameterNotFound. */
const ssmExisting = vi.hoisted(() => new Set<string>());
const ssmNames = vi.hoisted(() => [] as string[]);
const ssmSend = vi.hoisted(() =>
  vi.fn(async (cmd: { input: { Name: string } }) => {
    ssmNames.push(cmd.input.Name);
    if (ssmExisting.has(cmd.input.Name)) {
      return { Parameter: { Value: '30', Type: 'String' } };
    }
    throw Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
  })
);
const mockVerifyBucketExists = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockListStacks = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());
const mockGetState = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockLoadRollbackJournal = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockDeleteState = vi.hoisted(() => vi.fn<() => Promise<void>>());
const mockSaveState = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn(() => ({
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
  LockManager: vi.fn(() => ({
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
const BOOTSTRAP_PATH = '/cdk-bootstrap/hnb659fds/version';

let tmp: string;
let templatePath: string;

/** One importable S3 bucket, plus the `BootstrapVersion` every CDK stack declares. */
const TEMPLATE = {
  AWSTemplateFormatVersion: '2010-09-09',
  Parameters: {
    BootstrapVersion: { Type: 'AWS::SSM::Parameter::Value<String>', Default: BOOTSTRAP_PATH },
  },
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

async function runExport(args: string[]): Promise<string | undefined> {
  const cmd = createExportCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' }).catch((e: unknown) => {
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
  ssmNames.length = 0;
  ssmExisting.clear();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  tmp = mkdtempSync(join(tmpdir(), 'cdkd-export-ssm-'));
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

function args(...extra: string[]): string[] {
  return [
    STACK,
    '--template',
    templatePath,
    '--state-bucket',
    'test-bucket',
    '--stack-region',
    REGION,
    '--skip-import-support-preflight',
    ...extra,
  ];
}

describe('cdkd export refuses a missing SSM parameter before the lock (go-to-k/cdkd#6410)', () => {
  it('refuses a --dry-run whose BootstrapVersion parameter does not exist', async () => {
    const message = await runExport(args('--dry-run'));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(ssmNames).toEqual([BOOTSTRAP_PATH]);
    expect(message).toContain(`'BootstrapVersion': SSM parameter ${BOOTSTRAP_PATH}`);
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).not.toContain(
      '--dry-run: no CloudFormation changeset will be created.'
    );
  });

  it('refuses a real run before the lock and before any changeset', async () => {
    const message = await runExport(args('-y'));

    expect(message).toContain('Refusing to export');
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(cfnCalls).not.toContain('CreateChangeSetCommand');
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('names the missing parameter beside resources that block the export', async () => {
    // A template resource absent from cdkd state blocks the export.
    writeFileSync(
      templatePath,
      JSON.stringify({
        ...TEMPLATE,
        Resources: {
          ...TEMPLATE.Resources,
          NotInState: { Type: 'AWS::S3::Bucket', Properties: {} },
        },
      }),
      'utf-8'
    );

    const message = await runExport(args('--dry-run'));

    expect(message).toContain(`'BootstrapVersion': SSM parameter ${BOOTSTRAP_PATH}`);
    expect(message).toContain('The following resources block migration:');
    expect(message).toContain('NotInState');
  });

  it('lets the --dry-run through once the parameter exists', async () => {
    ssmExisting.add(BOOTSTRAP_PATH);

    const message = await runExport(args('--dry-run'));

    expect(message).toBeUndefined();
    expect(ssmNames).toEqual([BOOTSTRAP_PATH]);
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContain(
      '--dry-run: no CloudFormation changeset will be created.'
    );
  });
});
