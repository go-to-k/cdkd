import { describe, expect, it } from 'vitest';
import { createLocalRunTaskCommand } from '../../../src/cli/commands/local-run-task.js';

describe('createLocalRunTaskCommand', () => {
  const cmd = createLocalRunTaskCommand();

  it('registers the run-task subcommand name', () => {
    expect(cmd.name()).toBe('run-task');
  });

  it('requires a positional target argument', () => {
    const args = cmd.registeredArguments.map((a) => a.name());
    expect(args).toEqual(['target']);
  });

  it('declares the documented options', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--cluster');
    expect(longs).toContain('--env-vars');
    expect(longs).toContain('--container-host');
    expect(longs).toContain('--assume-task-role');
    expect(longs).toContain('--no-pull');
    expect(longs).toContain('--platform');
    expect(longs).toContain('--keep-running');
    expect(longs).toContain('--detach');
  });

  it('defaults --cluster to cdkd-local and --container-host to 127.0.0.1', () => {
    const cluster = cmd.options.find((o) => o.long === '--cluster');
    expect(cluster?.defaultValue).toBe('cdkd-local');
    const host = cmd.options.find((o) => o.long === '--container-host');
    expect(host?.defaultValue).toBe('127.0.0.1');
  });

  it('parses --assume-task-role as optional-arg form', () => {
    const o = cmd.options.find((o) => o.long === '--assume-task-role');
    expect(o).toBeDefined();
    expect(o?.optional).toBe(true);
  });

  it('parses bare --assume-task-role as boolean true', () => {
    const parsed = cmd.parse(['node', 'cdkd', 'TD', '--assume-task-role'], { from: 'user' });
    expect(parsed.opts().assumeTaskRole).toBe(true);
  });

  it('parses --assume-task-role <arn> as the ARN string', () => {
    const parsed = cmd.parse(
      ['node', 'cdkd', 'TD', '--assume-task-role', 'arn:aws:iam::123:role/foo'],
      { from: 'user' }
    );
    expect(parsed.opts().assumeTaskRole).toBe('arn:aws:iam::123:role/foo');
  });

  it('parses --no-pull as pull=false', () => {
    const parsed = cmd.parse(['node', 'cdkd', 'TD', '--no-pull'], { from: 'user' });
    expect(parsed.opts().pull).toBe(false);
  });
});
