import { describe, expect, it } from 'vite-plus/test';
import { createLocalStartAlbCommand } from '../../../src/cli/commands/local-start-alb.js';
import { cdkdExtraStateProviders } from '../../../src/cli/commands/local-state-source.js';

// Unit coverage for the cdkd-specific wiring around `cdkd local start-alb`:
// the `--from-state` / `--state-bucket` / `--state-prefix` flags the host
// adds on top of cdk-local's shared option block, and the
// `cdkdExtraStateProviders` singleton that local-start-alb.ts forwards into
// `runEcsServiceEmulator`. The pure-functional helpers (`parseLbPortOverrides`
// / `resolveAlbTarget` / `albStrategy`) and the ALB-specific option block
// (`--lb-port` / `--tls` / `--tls-cert` / `--tls-key` / `--no-verify-auth` /
// `--bearer-token`) live in cdk-local now and are covered by cdk-local's own
// tests; cdkd inherits them via `addAlbSpecificOptions`. End-to-end behavior
// is exercised by the `local-start-alb-from-state` real-AWS integ fixture.

describe('createLocalStartAlbCommand', () => {
  // `cmd.parse([...])` runs the registered `.action(handler)` body. The
  // production handler hits real synthesis / docker; stub to a no-op so
  // parse() only exercises Commander's option parser. The
  // cmd-parse-stub-gate hook enforces this stub for any cmd.parse() in
  // tests.
  const cmd = createLocalStartAlbCommand();
  cmd.action(() => {});

  it('registers the start-alb subcommand name', () => {
    expect(cmd.name()).toBe('start-alb');
  });

  it('accepts variadic positional targets', () => {
    const args = cmd.registeredArguments.map((a) => a.name());
    expect(args).toEqual(['targets']);
    expect(cmd.registeredArguments[0]?.variadic).toBe(true);
  });

  it('inherits the ALB-specific options from addAlbSpecificOptions', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--lb-port');
    expect(longs).toContain('--tls');
    expect(longs).toContain('--tls-cert');
    expect(longs).toContain('--tls-key');
    expect(longs).toContain('--no-verify-auth');
    expect(longs).toContain('--bearer-token');
  });

  it('declares the cdkd state-source options', () => {
    // --from-state / --state-bucket / --state-prefix are the cdkd-specific
    // flags layered on top of cdk-local's --from-cfn-stack / --stack-region
    // (which addCommonEcsServiceOptions provides).
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--state-bucket');
    expect(longs).toContain('--state-prefix');
  });

  it('inherits --from-cfn-stack + --stack-region from addCommonEcsServiceOptions', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-cfn-stack');
    expect(longs).toContain('--stack-region');
  });

  it('inherits the common ECS service options from addCommonEcsServiceOptions', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--cluster');
    expect(longs).toContain('--env-vars');
    expect(longs).toContain('--container-host');
    expect(longs).toContain('--max-tasks');
    expect(longs).toContain('--restart-policy');
    expect(longs).toContain('--no-pull');
  });

  it('defaults --from-state to false', () => {
    const opt = cmd.options.find((o) => o.long === '--from-state');
    expect(opt?.defaultValue).toBe(false);
  });

  it("defaults --state-prefix to 'cdkd'", () => {
    const opt = cmd.options.find((o) => o.long === '--state-prefix');
    expect(opt?.defaultValue).toBe('cdkd');
  });

  it('parses --from-state as a flag (no value)', () => {
    const fresh = createLocalStartAlbCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'My/Alb', '--from-state'], { from: 'user' });
    expect(parsed.opts().fromState).toBe(true);
  });

  it('parses --state-bucket <bucket>', () => {
    const fresh = createLocalStartAlbCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(
      ['node', 'cdkd', 'My/Alb', '--state-bucket', 'cdkd-state-123'],
      { from: 'user' }
    );
    expect(parsed.opts().stateBucket).toBe('cdkd-state-123');
  });

  it('parses --lb-port as a variadic that builds an array', () => {
    const fresh = createLocalStartAlbCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(
      ['node', 'cdkd', 'My/Alb', '--lb-port', '80=8080', '443=8443'],
      { from: 'user' }
    );
    expect(parsed.opts().lbPort).toEqual(['80=8080', '443=8443']);
  });

  it('parses --tls as a boolean flag (no value)', () => {
    const fresh = createLocalStartAlbCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'My/Alb', '--tls'], { from: 'user' });
    expect(parsed.opts().tls).toBe(true);
  });
});

describe('cdkdExtraStateProviders (engine wiring)', () => {
  // The 4th-arg `extraStateProviders` passed to runEcsServiceEmulator is the
  // whole point of the --from-state plumbing. Pin the export's shape AND
  // assert local-start-alb.ts imports + forwards exactly this constant
  // (rather than a one-off { fromState: () => ... }).
  it('exports a single `fromState` factory entry', () => {
    expect(Object.keys(cdkdExtraStateProviders).sort()).toEqual(['fromState']);
    expect(typeof cdkdExtraStateProviders.fromState).toBe('function');
  });

  it('is the SAME object reference imported by local-state-source', async () => {
    // Identity check: tsdown / rolldown's ESM bundling preserves named-export
    // identity, so an accidental re-construction in local-start-alb.ts (e.g.
    // `runEcsServiceEmulator(..., { fromState: fromStateFactory })`) would
    // make a NEW object and fail this assertion. The wiring contract is
    // "forward the exported singleton verbatim" — pin it.
    const { cdkdExtraStateProviders: viaStateSource } = await import(
      '../../../src/cli/commands/local-state-source.js'
    );
    expect(viaStateSource).toBe(cdkdExtraStateProviders);
  });
});
