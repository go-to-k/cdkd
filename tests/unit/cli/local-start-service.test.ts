import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalStartServiceCommand,
  serviceStrategy,
} from '../../../src/cli/commands/local-start-service.js';
import { LocalStartServiceError } from '../../../src/utils/error-handler.js';
import type { EcsServiceEmulatorOptions } from '../../../src/cli/commands/ecs-service-emulator.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

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

  it('accepts one or more positional target arguments (variadic)', () => {
    // Phase 3 of #262 (Issue #460) — `cdkd local start-service` now
    // accepts multiple targets in one invocation. The variadic
    // argument name is `targets`.
    const args = cmd.registeredArguments.map((a) => a.name());
    expect(args).toEqual(['targets']);
    expect(cmd.registeredArguments[0]?.variadic).toBe(true);
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

  it('inherits the start-service-specific options from addStartServiceSpecificOptions', () => {
    // `--host-port` and `--watch` ride in via cdk-local's
    // `addStartServiceSpecificOptions` helper (added in cdk-local 0.69.0
    // alongside the Phase 4 bind-mount source fast path of issue #214).
    // cdkd inherits both verbatim through the shim in
    // `ecs-service-emulator.ts`, so any future option added there lands in
    // `cdkd local start-service --help` with no manual sync.
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--host-port');
    expect(longs).toContain('--watch');
  });

  it('defaults --watch to false (opt-in hot reload)', () => {
    // `--watch` is intentionally off by default — the default `start-service`
    // boot is one-shot. The Phase 4 fast path only fires when the user opts
    // in to `--watch`.
    const opt = cmd.options.find((o) => o.long === '--watch');
    expect(opt?.defaultValue).toBe(false);
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

  it('accepts --max-tasks at the subnet-allocator cap (83)', () => {
    // Issue #544 — cdk-local's `parseMaxTasks` (re-exported via the
    // `ecs-service-emulator` shim and registered by
    // `addCommonEcsServiceOptions`) enforces a cap of 83 because the
    // engine's per-replica link-local /24 subnet allocator skips one
    // octet (the shared-svc network's `169.254.171.0/24`).
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'Svc', '--max-tasks', '83'], { from: 'user' });
    expect(parsed.opts().maxTasks).toBe(83);
  });

  it('rejects --max-tasks above the subnet-allocator cap (84)', () => {
    // cdk-local's `parseMaxTasks` (consumed via the
    // `ecs-service-emulator` shim) serves 83 distinct octets out of
    // the link-local /24 range 169.254.170.0..169.254.253.0 (one
    // octet reserved for the shared-svc network). At index 83 the
    // modulo wraps and collapses the /24 onto an earlier replica's
    // allocation, causing Docker to reject the duplicate-subnet
    // network creation. Surfacing the cap at parse time gives the
    // user an actionable error before any boot work.
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    expect(() =>
      fresh.parse(['node', 'cdkd', 'Svc', '--max-tasks', '84'], { from: 'user' })
    ).toThrow(/--max-tasks 84 exceeds the per-replica link-local \/24 subnet allocator's range \(83\)/);
  });

  it('rejects --max-tasks 100 (PR #504 review canonical case)', () => {
    const fresh = createLocalStartServiceCommand();
    fresh.action(() => {});
    expect(() =>
      fresh.parse(['node', 'cdkd', 'Svc', '--max-tasks', '100'], { from: 'user' })
    ).toThrow(/--max-tasks 100 exceeds.*83/);
  });
});

describe('serviceStrategy (engine plumbing for runEcsServiceEmulator)', () => {
  // Mirrors `albStrategy.resolveBoots` coverage in `local-start-alb.test.ts`.
  // `serviceStrategy` is the load-bearing logic the engine consumes per CLI
  // invocation — the engine's `runEcsServiceEmulator` calls each field on the
  // returned `EmulatorStrategy` exactly once + this test pins each field's
  // contract without spinning up the engine.

  function makeOptions(over: Partial<EcsServiceEmulatorOptions> = {}): EcsServiceEmulatorOptions {
    return {
      output: 'cdk.out',
      verbose: false,
      cluster: 'cdkd-local',
      containerHost: '127.0.0.1',
      pull: true,
      maxTasks: 3,
      restartPolicy: 'on-failure',
      ...over,
    } as EcsServiceEmulatorOptions;
  }

  it('declares the picker text + noun the engine surfaces in TTY mode', () => {
    const strategy = serviceStrategy(makeOptions());
    expect(strategy.pickerMessage).toMatch(/Select.*ECS services/i);
    expect(strategy.pickerNoun).toBe('ECS services');
  });

  it("onMissing throws LocalStartServiceError carrying cdkd's branded CLI name", () => {
    // Engine calls strategy.onMissing() when no <target> is supplied in a
    // non-interactive context. The thrown class is cdkd's so the surface
    // matches the rest of cdkd's error handling.
    const strategy = serviceStrategy(makeOptions());
    const err = strategy.onMissing();
    expect(err).toBeInstanceOf(LocalStartServiceError);
    // The message embeds `getEmbedConfig().cliName` (= 'cdkd local' under
    // cdkd's setEmbedConfig install in local-invoke.ts createLocalCommand).
    expect(err.message).toMatch(/start-service requires at least one <target>/);
  });

  it('declares an empty lbPortOverrides (no listener ports for start-service)', () => {
    // start-service has no front-door / listener layer (unlike start-alb),
    // so the override map MUST be empty even when --lb-port-like options
    // ride through the shared options bag.
    const strategy = serviceStrategy(makeOptions());
    expect(strategy.lbPortOverrides).toEqual({});
  });

  it('opts into --watch via supportsWatch: true', () => {
    // The engine's `--watch` block is gated on
    // `options.watch === true && strategy.supportsWatch === true` — without
    // this flag `--watch` is silently a no-op for start-service. cdk-local's
    // own `serviceStrategy` (the bundled `cdkl start-service`) sets it; the
    // cdkd-local copy must match so Phase 4 of cdk-local#214 (bind-mount
    // source fast path) fires for `cdkd local start-service --watch`.
    const strategy = serviceStrategy(makeOptions());
    expect(strategy.supportsWatch).toBe(true);
  });

  it('resolveBoots maps each chosen target to a ServiceBoot with no front-door', () => {
    // The engine's bootOneTarget resolves the cdk template internally, so
    // serviceStrategy.resolveBoots only needs to forward the chosen target
    // strings. The return shape pins the contract: ServiceBoot[] + empty
    // warnings + no frontDoor (start-service has no listeners).
    const strategy = serviceStrategy(makeOptions());
    const stacks: StackInfo[] = [];
    const out = strategy.resolveBoots(stacks, ['MyStack:Orders', 'MyStack:Web']);
    expect(out.boots).toEqual([{ target: 'MyStack:Orders' }, { target: 'MyStack:Web' }]);
    expect(out.warnings).toEqual([]);
    expect(out.frontDoor).toBeUndefined();
  });

  it('resolveBoots preserves target order (peer-discovery boot order is producer-first)', () => {
    // Issue #460: peer-discovery requires booting producers before consumers
    // so the Cloud Map registry populates BEFORE consumers' `docker run`
    // reads it. The engine boots sequentially; the strategy MUST NOT
    // re-order chosenTargets.
    const strategy = serviceStrategy(makeOptions());
    const out = strategy.resolveBoots(
      [],
      ['Stack:Producer', 'Stack:Middle', 'Stack:Consumer']
    );
    expect(out.boots.map((b) => b.target)).toEqual([
      'Stack:Producer',
      'Stack:Middle',
      'Stack:Consumer',
    ]);
  });

  it('resolveBoots on an empty target list returns empty boots + empty warnings', () => {
    // Edge: an empty target list comes from the TTY picker if the user
    // cancels mid-selection. The engine then surfaces "no runnable target"
    // via its own check; the strategy itself MUST NOT throw.
    const strategy = serviceStrategy(makeOptions());
    const out = strategy.resolveBoots([], []);
    expect(out.boots).toEqual([]);
    expect(out.warnings).toEqual([]);
  });
});
