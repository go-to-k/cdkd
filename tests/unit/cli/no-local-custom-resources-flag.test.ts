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

/** Make `path`'s action a no-op on `built`, so a parse only runs the `preAction` hook. */
function quiet(built: Command, path: string[]): void {
  find(built, path).action(() => {});
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
    const program = buildProgram();
    quiet(program, ['deploy']);
    await program.parseAsync(['deploy', '--no-local-custom-resources'], {
      from: 'user',
    });
    expect(localCustomResourceRuntimeActive()).toBe(false);
  });

  it('leaves the gate on without the flag', async () => {
    setLocalCustomResourceRuntimeEnabled(false);
    const program = buildProgram();
    quiet(program, ['deploy']);
    await program.parseAsync(['deploy'], { from: 'user' });
    expect(localCustomResourceRuntimeActive()).toBe(true);
  });

  it('turns the gate off on destroy', async () => {
    const program = buildProgram();
    quiet(program, ['destroy']);
    await program.parseAsync(['destroy', '--no-local-custom-resources'], {
      from: 'user',
    });
    expect(localCustomResourceRuntimeActive()).toBe(false);
  });

  it('records the command a fallback warning speaks for: rollback', async () => {
    const program = buildProgram();
    quiet(program, ['rollback']);
    await program.parseAsync(['rollback', 'MyStack'], { from: 'user' });
    expect(localCustomResourceCommand()).toBe('rollback');
  });

  it('records the command a fallback warning speaks for: state destroy', async () => {
    const program = buildProgram();
    quiet(program, ['state', 'destroy']);
    await program.parseAsync(['state', 'destroy', 'MyStack'], {
      from: 'user',
    });
    expect(localCustomResourceCommand()).toBe('state destroy');
  });

  it('records the command a fallback warning speaks for: destroy', async () => {
    const program = buildProgram();
    quiet(program, ['destroy']);
    await program.parseAsync(['destroy', 'MyStack'], { from: 'user' });
    expect(localCustomResourceCommand()).toBe('destroy');
  });
});
