import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { Command } from 'commander';

/**
 * go-to-k/cdkd#6206: `--no-local-custom-resources` exists on every command
 * that can invoke a custom resource, and the `preAction` hook turns the
 * `--aws-emulator` custom-resource runtime's gate off with it.
 */

// The gate also needs `--aws-emulator`; stand in for its active wiring.
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveWorkloadAwsWiring: () => ({ mode: 'emulator' }),
}));

const { buildProgram } = await import('../../../src/cli/program.js');
const {
  localCustomResourceCommand,
  localCustomResourceRuntimeActive,
  setLocalCustomResourceRuntimeEnabled,
} =
  await import('../../../src/local/custom-resource-runtime-gate.js');

function find(program: Command, path: string[]): Command {
  let cmd: Command = program;
  for (const name of path) {
    const next = cmd.commands.find((c) => c.name() === name);
    if (!next) throw new Error(`no ${path.join(' ')} command`);
    cmd = next;
  }
  return cmd;
}

async function run(path: string[], argv: string[]): Promise<void> {
  const program = buildProgram();
  find(program, path).action(() => {});
  await program.parseAsync([...path, ...argv], { from: 'user' });
}

beforeEach(() => {
  setLocalCustomResourceRuntimeEnabled(true);
});

describe('--no-local-custom-resources', () => {
  it.each([[['deploy']], [['destroy']], [['rollback']], [['state', 'destroy']]])(
    'is declared on %j',
    (path) => {
      const cmd = find(buildProgram(), path);
      expect(cmd.options.some((o) => o.long === '--no-local-custom-resources')).toBe(true);
    }
  );

  it('turns the gate off on deploy', async () => {
    await run(['deploy'], ['--no-local-custom-resources']);
    expect(localCustomResourceRuntimeActive()).toBe(false);
  });

  it('leaves the gate on without the flag', async () => {
    setLocalCustomResourceRuntimeEnabled(false);
    await run(['deploy'], []);
    expect(localCustomResourceRuntimeActive()).toBe(true);
  });

  it.each([
    [['rollback'], 'rollback'],
    [['state', 'destroy'], 'state destroy'],
    [['destroy'], 'destroy'],
  ])('records %j as the command a fallback warning speaks for', async (path, expected) => {
    await run(path, ['MyStack']);
    expect(localCustomResourceCommand()).toBe(expected);
  });

  it('turns the gate off on destroy', async () => {
    await run(['destroy'], ['--no-local-custom-resources']);
    expect(localCustomResourceRuntimeActive()).toBe(false);
  });
});
