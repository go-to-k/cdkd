import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2100 (orchestrator review G1): every command that resolves the
 * DEFAULT state bucket hands the resolver the old us-east-1 default as the
 * second legacy candidate when its region was inferred — and none when the
 * user named one. Each command is driven only up to that call: the mocked
 * resolver records its arguments and then stops the command.
 */

const STOP = 'stop-after-bucket-resolution';
const calls = vi.hoisted(() => ({ value: [] as unknown[][] }));
vi.mock('../../../src/cli/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const record = (...args: unknown[]): never => {
    calls.value.push(args);
    throw new Error('stop-after-bucket-resolution');
  };
  return {
    ...actual,
    resolveApp: vi.fn(() => 'node app.js'),
    resolveStateBucketWithDefault: vi.fn(async (...args: unknown[]) => record(...args)),
    resolveStateBucketWithDefaultAndSource: vi.fn(async (...args: unknown[]) => record(...args)),
  };
});

const profile = vi.hoisted(() => ({ region: 'ap-northeast-1' as string | undefined }));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      config: {
        region: async (): Promise<string> => {
          if (!profile.region) throw new Error('Region is missing');
          return profile.region;
        },
      },
      send: vi.fn(async () => ({ Account: '111111111111' })),
      destroy: vi.fn(),
    })),
  };
});

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn(async () => {
      throw new Error('stop-after-bucket-resolution');
    }),
  })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

const { createDiffCommand } = await import('../../../src/cli/commands/diff.js');
const { createDriftCommand } = await import('../../../src/cli/commands/drift.js');
const { createEventsCommand } = await import('../../../src/cli/commands/events.js');
const { createExportCommand } = await import('../../../src/cli/commands/export.js');
const { createOrphanCommand } = await import('../../../src/cli/commands/orphan.js');
const { createImportCommand } = await import('../../../src/cli/commands/import.js');
const { createStateCommand } = await import('../../../src/cli/commands/state.js');
const { createForceUnlockCommand } = await import('../../../src/cli/commands/force-unlock.js');

type Factory = () => import('commander').Command;
const CASES: Array<{ name: string; factory: Factory; argv: string[] }> = [
  { name: 'diff', factory: createDiffCommand, argv: ['MyStack'] },
  { name: 'drift', factory: createDriftCommand, argv: ['MyStack'] },
  { name: 'events', factory: createEventsCommand, argv: ['MyStack'] },
  { name: 'events prune', factory: createEventsCommand, argv: ['prune', 'MyStack', '--all'] },
  { name: 'export', factory: createExportCommand, argv: ['MyStack'] },
  { name: 'orphan', factory: createOrphanCommand, argv: ['MyStack/Bucket'] },
  { name: 'import', factory: createImportCommand, argv: ['MyStack', '--app', 'x'] },
  { name: 'state info', factory: createStateCommand, argv: ['info'] },
  { name: 'state show', factory: createStateCommand, argv: ['show', 'MyStack'] },
  { name: 'force-unlock', factory: createForceUnlockCommand, argv: ['MyStack'] },
];

async function run(factory: Factory, argv: string[]): Promise<void> {
  const cmd = factory();
  cmd.exitOverride();
  cmd.commands.forEach((sub) => sub.exitOverride());
  // Node-style argv: the arity convention scans `{ from: 'user' }` sites,
  // and this one's operands come from the table above.
  await cmd.parseAsync(['node', 'cdkd', ...argv]).catch(() => undefined);
}

const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls.value.length = 0;
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
  profile.region = 'ap-northeast-1';
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error(STOP);
  }) as never);
});
afterEach(() => {
  exitSpy.mockRestore();
  if (saved.region === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = saved.region;
  if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
  else process.env['AWS_DEFAULT_REGION'] = saved.def;
});

describe('the legacy state-bucket second candidate, per command (go-to-k/cdkd#2100)', () => {
  it.each(CASES)('$name: an INFERRED region passes us-east-1 as the second candidate', async (c) => {
    await run(c.factory, c.argv);
    expect(calls.value).toEqual([[undefined, 'ap-northeast-1', 'us-east-1']]);
  });

  it.each(CASES)(
    '$name: an AWS_DEFAULT_REGION answer is copied into AWS_REGION for the SDK (review L1)',
    async (c) => {
      // The JS SDK never reads AWS_DEFAULT_REGION; a region-less client of
      // this command would otherwise follow the profile.
      process.env['AWS_DEFAULT_REGION'] = 'eu-west-1';
      await run(c.factory, c.argv);
      expect(calls.value).toEqual([[undefined, 'eu-west-1', 'us-east-1']]);
      expect(process.env['AWS_REGION']).toBe('eu-west-1');
    }
  );

  it.each(CASES)('$name: a NAMED region (AWS_REGION) passes none', async (c) => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    await run(c.factory, c.argv);
    expect(calls.value).toEqual([[undefined, 'ap-northeast-1', undefined]]);
  });
});
