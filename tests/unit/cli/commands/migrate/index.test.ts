import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// Mocks for child_process — both spawn (cdk migrate / npm install /
// cdk synth) and execFile (verifyCdkCliAvailable).
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  // Module-level slot for the next execFile response; set per-test.
  _execStdout: '2.1112.0\n' as string,
  _execError: undefined as NodeJS.ErrnoException | undefined,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => mocks.spawn(...args),
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (
        err: NodeJS.ErrnoException | null,
        stdout?: string | { stdout: string }
      ) => void;
      const cmd = allArgs[0] as string;
      const args = allArgs[1] as string[];
      mocks.execFile(cmd, args);
      Promise.resolve().then(() => {
        if (mocks._execError) {
          cb(mocks._execError);
        } else {
          cb(null, { stdout: mocks._execStdout });
        }
      });
    },
  };
});

// Mock the CFn client by intercepting `send` on the AWS SDK class.
const mockCfnSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: mockCfnSend,
      destroy: vi.fn(),
    })),
  };
});

// Mock logger.
vi.mock('../../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  }),
}));

import { runMigrateLibrary } from '../../../../../src/cli/commands/migrate/index.js';
import { MissingCdkCliError, LocalMigrateError } from '../../../../../src/utils/error-handler.js';

function buildFakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/**
 * Drive every subprocess (spawn) to a successful exit. Used to make
 * `cdk migrate` / `npm install` / `cdk synth` all "succeed" in tests
 * that focus on the orchestrator's branching, not subprocess output.
 */
function setupAllSubprocessesSucceed(): void {
  mocks.spawn.mockImplementation(() => {
    const child = buildFakeChild();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
}

function setupCfnResponses(responses: Record<string, unknown>): void {
  mockCfnSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const key = cmd.constructor.name;
    if (!(key in responses)) {
      throw new Error(`Unexpected CFn command: ${key}`);
    }
    const r = responses[key];
    if (r instanceof Error) throw r;
    return r;
  });
}

describe('runMigrateLibrary', () => {
  let tmp: string;

  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.execFile.mockReset();
    mockCfnSend.mockReset();
    mocks._execStdout = '2.1112.0\n';
    mocks._execError = undefined;
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-migrate-orchestrator-test-'));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('runs the full orchestrator end-to-end on a clean stack', async () => {
    setupCfnResponses({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: {
        StackResources: [
          {
            LogicalResourceId: 'B',
            PhysicalResourceId: 'b',
            ResourceType: 'AWS::S3::Bucket',
          },
        ],
      },
      GetTemplateCommand: { TemplateBody: JSON.stringify({ Resources: {} }) },
    });
    const outputDir = join(tmp, 'S');

    // Drive subprocesses: `cdk migrate` populates the outputDir on
    // success; `cdk synth` populates cdk.out/. We simulate the
    // post-state of each subprocess BEFORE emitting `close 0` so the
    // downstream synth step can locate the generated template.
    let spawnCount = 0;
    mocks.spawn.mockImplementation((_bin: string, args: string[]) => {
      const child = buildFakeChild();
      spawnCount++;
      // First spawn call = `cdk migrate`. Create the outputDir so the
      // guard against an empty post-codegen dir doesn't trip.
      if (args[0] === 'migrate') {
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(join(outputDir, 'package.json'), '{}');
      } else if (args[0] === 'synth') {
        // `cdk synth --quiet` populates cdk.out/.
        mkdirSync(join(outputDir, 'cdk.out'), { recursive: true });
        writeFileSync(
          join(outputDir, 'cdk.out', 'S.template.json'),
          JSON.stringify({ Resources: { B: { Type: 'AWS::S3::Bucket' } } })
        );
      }
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    });

    const result = await runMigrateLibrary({
      fromCfnStack: 'S',
      outputDir: tmp,
      skipInstall: true,
    });

    expect(spawnCount).toBeGreaterThanOrEqual(2); // cdk migrate + cdk synth
    expect(result.outputDir).toBe(outputDir);
    expect(result.assemblyDir).toBe(join(outputDir, 'cdk.out'));
    expect(result.templateBody).toEqual({
      Resources: { B: { Type: 'AWS::S3::Bucket' } },
    });
    expect(result.sourceResources).toHaveLength(1);
    expect(result.sourceResources[0]!.LogicalResourceId).toBe('B');
  });

  it('hard-fails before any other check when the cdk CLI is missing', async () => {
    mocks._execStdout = 'garbage output\n';
    setupCfnResponses({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
    });
    setupAllSubprocessesSucceed();

    await expect(
      runMigrateLibrary({ fromCfnStack: 'S', outputDir: tmp })
    ).rejects.toBeInstanceOf(MissingCdkCliError);

    expect(mockCfnSend).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects when source CFn stack contains a Custom Resource', async () => {
    setupCfnResponses({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: {
        StackResources: [
          {
            LogicalResourceId: 'CR',
            PhysicalResourceId: 'arn:aws:cloudformation:...',
            ResourceType: 'Custom::Foo',
          },
        ],
      },
      GetTemplateCommand: { TemplateBody: JSON.stringify({ Resources: {} }) },
    });
    setupAllSubprocessesSucceed();
    await expect(
      runMigrateLibrary({ fromCfnStack: 'S', outputDir: tmp })
    ).rejects.toBeInstanceOf(LocalMigrateError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects when output dir already exists and is non-empty', async () => {
    setupCfnResponses({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: { StackResources: [] },
      GetTemplateCommand: { TemplateBody: JSON.stringify({ Resources: {} }) },
    });
    setupAllSubprocessesSucceed();

    mkdirSync(join(tmp, 'S'));
    writeFileSync(join(tmp, 'S', 'sentinel.txt'), 'oops');

    await expect(
      runMigrateLibrary({ fromCfnStack: 'S', outputDir: tmp })
    ).rejects.toBeInstanceOf(LocalMigrateError);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('returns null templateBody when skipSynth is true', async () => {
    setupCfnResponses({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: { StackResources: [] },
      GetTemplateCommand: { TemplateBody: JSON.stringify({ Resources: {} }) },
    });
    setupAllSubprocessesSucceed();

    const result = await runMigrateLibrary({
      fromCfnStack: 'S',
      outputDir: tmp,
      skipInstall: true,
      skipSynth: true,
    });
    expect(result.templateBody).toBeNull();
    expect(result.assemblyDir.endsWith('/cdk.out')).toBe(true);
  });
});
