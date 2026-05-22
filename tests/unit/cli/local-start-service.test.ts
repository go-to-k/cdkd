import { describe, expect, it } from 'vite-plus/test';
import { createLocalStartServiceCommand } from '../../../src/cli/commands/local-start-service.js';

describe('createLocalStartServiceCommand', () => {
  // `cmd.parse([...])` runs the registered `.action(handler)` body. The
  // production handler hits real synthesis / docker; stub to a no-op so
  // parse() only exercises Commander's option parser. The
  // cmd-parse-stub-gate hook enforces this stub for any cmd.parse() in
  // tests.
  const cmd = createLocalStartServiceCommand();
  cmd.action(() => {});

  it('registers the start-service subcommand name', () => {
    expect(cmd.name()).toBe('start-service');
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
    expect(longs).toContain('--max-tasks');
    expect(longs).toContain('--restart-policy');
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--stack-region');
  });

  it('does NOT declare --detach (services are long-running)', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).not.toContain('--detach');
  });

  it('does NOT declare --keep-running (replicas are recycled by the runner)', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).not.toContain('--keep-running');
  });

  it('defaults --max-tasks to 3', () => {
    const opt = cmd.options.find((o) => o.long === '--max-tasks');
    expect(opt?.defaultValue).toBe(3);
  });

  it("defaults --restart-policy to 'on-failure'", () => {
    const opt = cmd.options.find((o) => o.long === '--restart-policy');
    expect(opt?.defaultValue).toBe('on-failure');
  });

  it('parses --max-tasks <n> as a positive integer', () => {
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'Svc', '--max-tasks', '5'], { from: 'user' });
    expect(parsed.opts().maxTasks).toBe(5);
  });

  it('parses --restart-policy values', () => {
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'Svc', '--restart-policy', 'always'], {
      from: 'user',
    });
    expect(parsed.opts().restartPolicy).toBe('always');
  });

  it('rejects --max-tasks=0 (positive-integer constraint)', () => {
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    expect(() =>
      fresh.parse(['node', 'cdkd', 'Svc', '--max-tasks', '0'], { from: 'user' })
    ).toThrow(/--max-tasks must be a positive integer/);
  });

  it('rejects invalid --restart-policy values', () => {
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    expect(() =>
      fresh.parse(['node', 'cdkd', 'Svc', '--restart-policy', 'forever'], { from: 'user' })
    ).toThrow(/--restart-policy must be one of/);
  });

  it('parses --no-pull as pull=false (Commander auto-negation)', () => {
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'Svc', '--no-pull'], { from: 'user' });
    expect(parsed.opts().pull).toBe(false);
  });

  it('accepts --max-tasks at the subnet-allocator cap (84)', () => {
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'Svc', '--max-tasks', '84'], { from: 'user' });
    expect(parsed.opts().maxTasks).toBe(84);
  });

  it('rejects --max-tasks above the subnet-allocator cap (85)', () => {
    // The per-replica subnet allocator in `ecs-service-runner.ts`
    // (`170 + (index % 84)`) wraps at index 84, collapsing replica 84's
    // /24 onto replica 0's allocation and causing Docker to reject the
    // duplicate-subnet network creation. Surfacing the cap at parse
    // time gives the user an actionable error before any boot work.
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    expect(() =>
      fresh.parse(['node', 'cdkd', 'Svc', '--max-tasks', '85'], { from: 'user' })
    ).toThrow(/--max-tasks 85 exceeds the per-replica link-local \/24 subnet allocator's range \(84\)/);
  });

  it('rejects --max-tasks 100 (PR #504 review canonical case)', () => {
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    expect(() =>
      fresh.parse(['node', 'cdkd', 'Svc', '--max-tasks', '100'], { from: 'user' })
    ).toThrow(/--max-tasks 100 exceeds.*84/);
  });
});
