/**
 * go-to-k/cdkd#6905: `-c` / `--context`, and `cdkd export`'s `--parameter` /
 * `--cfn-child-stack-name`, take ONE value per flag and repeat, as the AWS CDK
 * CLI declares `--context` (`nargs: 1`). Variadic, they swallowed the stack
 * name after them: `cdkd deploy -c env=prod MyStack` selected no stack.
 */
import { describe, it, expect } from 'vite-plus/test';
import { createDeployCommand } from '../../../src/cli/commands/deploy.js';
import { createSynthCommand } from '../../../src/cli/commands/synth.js';
import { createExportCommand } from '../../../src/cli/commands/export.js';

type Parsed = { opts: Record<string, unknown>; operands: string[] };

function parsedDeploy(args: string[]): Parsed {
  const cmd = createDeployCommand();
  cmd.exitOverride();
  cmd.action(() => {});
  cmd.parse(args, { from: 'user' });
  return { opts: cmd.opts(), operands: cmd.args };
}
function parsedSynth(args: string[]): Parsed {
  const cmd = createSynthCommand();
  cmd.exitOverride();
  cmd.action(() => {});
  cmd.parse(args, { from: 'user' });
  return { opts: cmd.opts(), operands: cmd.args };
}
function parsedExport(args: string[]): Parsed {
  const cmd = createExportCommand();
  cmd.exitOverride();
  cmd.action(() => {});
  cmd.parse(args, { from: 'user' });
  return { opts: cmd.opts(), operands: cmd.args };
}

describe('single-value repeatable flags keep a following stack name (go-to-k/cdkd#6905)', () => {
  it('deploy -c: one value per flag, repeated, the stack after it kept', () => {
    const { opts, operands } = parsedDeploy(['-c', 'env=prod', 'MyStack', '--context', 'b=2']);
    expect(opts['context']).toEqual(['env=prod', 'b=2']);
    expect(operands).toEqual(['MyStack']);
  });

  it('synth -c: the shared option behaves the same on another command', () => {
    const { opts, operands } = parsedSynth(['-c', 'env=prod', 'MyStack']);
    expect(opts['context']).toEqual(['env=prod']);
    expect(operands).toEqual(['MyStack']);
  });

  it('export --parameter / --cfn-child-stack-name: one value per flag, the stack kept', () => {
    const { opts, operands } = parsedExport([
      '--parameter',
      'A=1',
      '--cfn-child-stack-name',
      'App~Db=app-db',
      'MyStack',
      '--parameter',
      'B=2',
    ]);
    expect(opts['parameter']).toEqual(['A=1', 'B=2']);
    expect(opts['cfnChildStackName']).toEqual(['App~Db=app-db']);
    expect(operands).toEqual(['MyStack']);
  });

  it('no flag leaves each option unset', () => {
    expect(parsedDeploy(['MyStack']).opts['context']).toBeUndefined();
    const exp = parsedExport(['MyStack']).opts;
    expect(exp['parameter']).toBeUndefined();
    expect(exp['cfnChildStackName']).toBeUndefined();
  });
});
