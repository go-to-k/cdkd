/**
 * `cdkd export`'s stack selection (issue go-to-k/cdkd#3507), the export twin
 * of the `cdkd import` cases in `tests/unit/cli/import.test.ts`.
 *
 * A CDK Stage that failed to load fails synthesis, so export never selects
 * among the stacks that did load. A selection that matches nothing goes
 * through the shared `renderNoStackMatch`, which is called REAL here: this is
 * a wiring test, so only the synthesizer and the AWS-facing layers are
 * doubled.
 *
 * `exportCommand` is not exported; the cases drive it through
 * `createExportCommand()`, as `export-non-interactive-confirm.test.ts` does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'node app.js'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

// Every CloudFormation call answers "does not exist": nothing past selection
// is under test, and the control case only needs the run to get there.
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return {
        send: vi.fn(async () => {
          throw new Error('Stack with id Other does not exist');
        }),
      };
    },
    get ec2() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ sts: { send: vi.fn() } })),
}));

const mockGetState = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockSaveState = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockDeleteState = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: vi.fn(async () => undefined),
    listStacks: vi.fn(async () => [{ stackName: 'Other', region: 'us-east-1' }]),
    getState: mockGetState,
    loadRollbackJournal: vi.fn(async () => null),
    deleteState: mockDeleteState,
    saveState: mockSaveState,
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: vi.fn(async () => null),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

import { createExportCommand } from '../../../src/cli/commands/export.js';
import { describeStack } from '../../../src/cli/stack-matcher.js';
import { stageLoadError } from '../../../src/synthesis/failed-stages.js';


interface Stack {
  stackName: string;
  displayName?: string;
  region: string;
  template: Record<string, unknown>;
}
const stack = (stackName: string, displayName?: string): Stack => ({
  stackName,
  ...(displayName !== undefined && { displayName }),
  region: 'us-east-1',
  template: { Resources: {} },
});
const other = (): Stack => stack('Other');
const synthesized = (stacks: Stack[]): { stacks: Stack[] } => ({ stacks });

/** Run the command; a refusal is logged by `handleError`, then `process.exit`. */
async function runExport(args: string[]): Promise<void> {
  const cmd = createExportCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' }).catch((e: unknown) => {
    if (!(e instanceof Error) || e.message !== 'process.exit-mock') throw e;
  });
}
const errorText = (): string => errorSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

let exitSpy: ReturnType<typeof vi.spyOn>;

describe('cdkd export: stack selection (go-to-k/cdkd#3507)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSynthesize.mockReset();
    mockGetState.mockResolvedValue(null);
    mockAcquireLock.mockResolvedValue(true);
    mockSaveState.mockResolvedValue('etag-1');
    mockDeleteState.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  // Refused at SELECTION: no state read, no lock, nothing written or deleted.
  const expectNoStateTouched = (): void => {
    expect(mockGetState).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  };

  it('fails with the synthesis error when a Stage failed to load, before any state read', async () => {
    const expectFatal = (label: string): void => {
      expect(exitSpy, label).toHaveBeenCalledWith(1);
      expect(errorText(), label).toContain(
        'Stage MyStage failed to load: ENOENT reading assembly-MyStage/manifest.json'
      );
      expectNoStateTouched();
      errorSpy.mockClear();
      exitSpy.mockClear();
    };
    mockSynthesize.mockRejectedValue(
      stageLoadError('MyStage', 'ENOENT reading assembly-MyStage/manifest.json')
    );

    await runExport(['--yes']);
    expectFatal('bare');
    await runExport(['Other', '--yes']);
    expectFatal('exact');
  });

  it('names the argument and the available stacks when nothing matched', async () => {
    mockSynthesize.mockResolvedValue(synthesized([other()]));

    await runExport(['Nope', '--yes']);

    expect(errorText()).toContain('No stacks matching Nope found in assembly. Available: Other');
    expect(errorText()).not.toContain('is not a wildcard');
    expectNoStateTouched();
  });

  it('refuses a zero-stack app before the selection chain, with and without an argument', async () => {
    mockSynthesize.mockResolvedValue(synthesized([]));

    await runExport(['--yes']);
    expect(errorText()).toContain('No stacks found in assembly');
    expect(errorText()).not.toContain('Multiple stacks found');

    errorSpy.mockClear();
    await runExport(['MyStage/MyStack', '--yes']);
    expect(errorText()).toContain(
      'No stacks matching MyStage/MyStack found in assembly. The assembly has no stacks'
    );
    expectNoStateTouched();
  });

  it('control: the single-stack auto-pick reaches the state read', async () => {
    mockSynthesize.mockResolvedValue(synthesized([other()]));

    await runExport(['--yes']);

    expect(errorText()).not.toContain('refusing');
    expect(mockGetState).toHaveBeenCalled();
  });

  it('says export matches exactly when the argument looks like a wildcard', async () => {
    mockSynthesize.mockResolvedValue(synthesized([stack('MyStage-Api', 'MyStage/Api')]));

    await runExport(['MyStage/*', '--yes']);

    expect(errorText()).toContain(
      'No stacks matching MyStage/* found in assembly. Available: MyStage-Api (MyStage/Api). ' +
        "cdkd export matches a stack name exactly, so '*' is not a wildcard here"
    );
    expectNoStateTouched();
  });

  it('adds no exact-match suffix on a zero-stack app, refused before the lookup', async () => {
    mockSynthesize.mockResolvedValue(synthesized([]));

    await runExport(['MyStage/*', '--yes']);

    expect(errorText()).toContain(
      'No stacks matching MyStage/* found in assembly. The assembly has no stacks'
    );
    expect(errorText()).not.toContain('is not a wildcard');
    expectNoStateTouched();
  });

  it('renders a non-plain stack name through the shared sanitizer, not raw', async () => {
    const bad = stack('Bad\u001b[2KName');
    mockSynthesize.mockResolvedValue(synthesized([other(), bad]));

    await runExport(['--yes']);

    // The sanitized token itself, so dropping the stack or blanking it fails too.
    expect(describeStack(bad)).not.toBe('');
    expect(errorText()).toContain(`Multiple stacks found: Other, ${describeStack(bad)}. `);
    expect(errorText()).not.toContain('\u001b');
    expect(errorText()).not.toContain('not shown');
  });

  it('lists every stack with its display path when several remain and none was named', async () => {
    mockSynthesize.mockResolvedValue(
      synthesized([other(), stack('MyStage-Api', 'MyStage/Api')])
    );

    await runExport(['--yes']);

    expect(errorText()).toContain(
      'Multiple stacks found: Other, MyStage-Api (MyStage/Api). ' +
        'Specify the stack name as a positional argument.'
    );
    expectNoStateTouched();
  });

  it('control: an argument naming a surviving stack proceeds past selection', async () => {
    mockSynthesize.mockResolvedValue(synthesized([other()]));

    await runExport(['Other', '--yes']);

    expect(errorText()).not.toContain('found in assembly');
    expect(infoSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining("Migrating cdkd stack 'Other'")
    );
  });
});
