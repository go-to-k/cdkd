import { Command, CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../src/cli/aws-emulator-activation.js', () => ({
  // The real activation probes the emulator's health endpoint over the network.
  activateAwsEmulatorForCommand: vi.fn(async () => {}),
}));

import { buildProgram } from '../../../src/cli/program.js';
import { getLogger } from '../../../src/utils/logger.js';
import { setPasteableAwsCaBundle } from '../../../src/utils/pasteable-aws-profile.js';
import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';
import { setChildProcessAwsEnv } from '../../../src/utils/child-process-aws-env.js';

/**
 * go-to-k/cdkd#6382: `--aws-emulator <word>` before a REQUIRED target. The URL
 * is optional, so the target is taken as the URL; the value check must run at
 * parse time, before commander's own required-argument check, or the user sees
 * only `missing required argument` and never the placement remedy.
 */

const REMEDY = 'put --aws-emulator after the target, or write --aws-emulator=<url>';

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('AWS_') || k.startsWith('CDKD_')) delete process.env[k];
  }
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  setAwsEndpointOverrideSource(undefined);
  setPasteableAwsCaBundle(undefined);
  setChildProcessAwsEnv(undefined);
});

const declaresFlag = (cmd: Command): boolean => {
  for (let c: Command | null = cmd; c !== null; c = c.parent) {
    if (c.options.some((o) => o.long === '--aws-emulator')) return true;
  }
  return false;
};

/** Every leaf command under the flag whose first positional is required. */
function requiredTargetCommands(program: Command): string[][] {
  const out: string[][] = [];
  const walk = (cmd: Command, path: string[]): void => {
    for (const sub of cmd.commands) {
      const p = [...path, sub.name()];
      if (
        sub.commands.length === 0 &&
        declaresFlag(sub) &&
        sub.registeredArguments[0]?.required === true
      ) {
        out.push(p);
      }
      walk(sub, p);
    }
  };
  walk(program, []);
  return out;
}

/** Make commander throw instead of exiting, and keep its stderr quiet. */
function quiet(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  for (const sub of cmd.commands) quiet(sub);
}

function find(program: Command, path: string[]): Command {
  let cmd = program;
  for (const name of path) cmd = cmd.commands.find((c) => c.name() === name)!;
  return cmd;
}

/** A `process.exit` that stops the run where `handleError` would end it. */
class Exited extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

interface Outcome {
  ran: boolean;
  exitCode?: number | string | null;
  errors: string[];
  thrown?: unknown;
}

async function parse(path: string[], argv: string[]): Promise<Outcome> {
  const program = buildProgram();
  quiet(program);
  let ran = false;
  find(program, path).action(() => {
    ran = true;
  });
  const errors: string[] = [];
  const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
  const error = vi.spyOn(getLogger(), 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Exited(code);
  });
  try {
    // argv-shaped (`from: 'node'`): the path is spread in.
    await program.parseAsync(['node', 'cdkd', ...path, ...argv], { from: 'node' });
    return { ran, errors };
  } catch (err) {
    if (err instanceof Exited) return { ran, exitCode: err.code, errors };
    return { ran, errors, thrown: err };
  } finally {
    info.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
}

describe('--aws-emulator before a required target (go-to-k/cdkd#6382)', () => {
  const population = requiredTargetCommands(buildProgram());

  it('the population is the commands the issue enumerated, at least', () => {
    const names = population.map((p) => p.join(' '));
    for (const expected of [
      'local invoke',
      'local run-task',
      'state show',
      'state resources',
      'state orphan',
      'events prune',
      'orphan',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(population.map((p) => [p.join(' '), p]))(
    'cdkd %s --aws-emulator <target> refuses with the placement remedy',
    async (_name, path) => {
      const out = await parse(path as string[], ['--aws-emulator', 'MyStack/Handler']);
      // Commander's own `missing required argument` is a CommanderError.
      expect(out.thrown).not.toBeInstanceOf(CommanderError);
      expect(out.thrown).toBeUndefined();
      expect(out.ran).toBe(false);
      // Rendered and exited through handleError, not thrown as `Fatal error:`.
      expect(out.exitCode).toBe(1);
      expect(out.errors.join('\n')).toContain(REMEDY);
    }
  );

  it('the flag after the target, bare or with =<url>, still parses', async () => {
    for (const argv of [
      ['MyStack/Handler', '--aws-emulator'],
      ['MyStack/Handler', '--aws-emulator=https://127.0.0.1:1'],
      ['MyStack/Handler', '--aws-emulator', 'https://127.0.0.1:1'],
    ]) {
      const out = await parse(['local', 'invoke'], argv);
      expect(out.thrown, argv.join(' ')).toBeUndefined();
      expect(out.exitCode, argv.join(' ')).toBeUndefined();
      expect(out.ran, argv.join(' ')).toBe(true);
    }
  });

  it('an optional-target command keeps the same refusal and rendering (deploy)', async () => {
    const out = await parse(['deploy'], ['--aws-emulator', 'MyStack']);
    expect(out.thrown).toBeUndefined();
    expect(out.ran).toBe(false);
    expect(out.exitCode).toBe(1);
    expect(out.errors.join('\n')).toContain(REMEDY);
  });
});
