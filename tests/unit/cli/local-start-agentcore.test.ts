import { describe, expect, it } from 'vite-plus/test';
import { createLocalStartAgentCoreCommand } from '../../../src/cli/commands/local-start-agentcore.js';

// Unit coverage for the cdkd `local start-agentcore` wrapper (issue #765 /
// #766). start-agentcore is a THIN pass-through to cdk-local's factory: the
// serve behavior + the agentcore-specific option block (`--port` / `--host` /
// `--session-id` / `--bearer-token` / `--no-verify-auth` / `--env-vars` /
// `--platform` / `--no-pull` / `--no-build` / `--container-host` / `--timeout` /
// `--assume-role` / `--ecr-role-arn` / `--from-cfn-stack` / `--stack-region`)
// live in cdk-local's `addStartAgentCoreSpecificOptions` and are covered by
// cdk-local's own tests; cdkd inherits them via the factory. UNLIKE
// start-cloudfront, cdk-local's start-agentcore factory accepts an
// `extraStateProviders` option, so cdkd threads its S3-backed `--from-state`
// factory in (via `cdkdExtraStateProviders`) and layers the cdkd-specific
// `--from-state` / `--state-bucket` / `--state-prefix` flags on top. The
// contract THIS test pins is the cdkd-side wiring: the presence of those three
// flags + their defaults, plus the inherited cdk-local flags. End-to-end
// behavior is exercised by the `local-start-agentcore` integ fixture.

describe('createLocalStartAgentCoreCommand', () => {
  // `cmd.parse([...])` runs the registered `.action(handler)` body. The
  // production handler boots a real Docker container + WebSocket bridge; stub to
  // a no-op so parse() only exercises Commander's option parser (the
  // cmd-parse-stub-gate hook enforces this stub for any cmd.parse() in tests).
  const cmd = createLocalStartAgentCoreCommand();
  cmd.action(() => {});

  it('registers the start-agentcore subcommand name', () => {
    expect(cmd.name()).toBe('start-agentcore');
  });

  it('accepts a single optional positional target (not variadic)', () => {
    const args = cmd.registeredArguments.map((a) => a.name());
    expect(args).toEqual(['target']);
    expect(cmd.registeredArguments[0]?.variadic).toBe(false);
    expect(cmd.registeredArguments[0]?.required).toBe(false);
  });

  it('inherits the agentcore-specific options from cdk-local', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--session-id');
    expect(longs).toContain('--bearer-token');
    expect(longs).toContain('--no-verify-auth');
    // --sigv4 (per-request inbound SigV4 signing, #777) + --watch (warm-container
    // reload, #778) auto-inherit via cdk-local's addStartAgentCoreSpecificOptions;
    // assert them so a future bump that drops either flag is caught here.
    expect(longs).toContain('--sigv4');
    expect(longs).toContain('--watch');
    expect(longs).toContain('--env-vars');
    expect(longs).toContain('--timeout');
    expect(longs).toContain('--assume-role');
    expect(longs).toContain('--ecr-role-arn');
  });

  it('inherits cdk-local CFn state-source flags (--from-cfn-stack / --stack-region)', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-cfn-stack');
    expect(longs).toContain('--stack-region');
  });

  it('declares the cdkd S3-backed state-source options (issue #766)', () => {
    // --from-state / --state-bucket / --state-prefix are the cdkd-specific flags
    // layered on top of cdk-local's --from-cfn-stack via the factory's
    // extraStateProviders seam.
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--state-bucket');
    expect(longs).toContain('--state-prefix');
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
    const fresh = createLocalStartAgentCoreCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'My/Agent', '--from-state'], { from: 'user' });
    expect(parsed.opts().fromState).toBe(true);
  });

  it('parses --state-bucket <bucket>', () => {
    const fresh = createLocalStartAgentCoreCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'My/Agent', '--state-bucket', 'my-bucket'], {
      from: 'user',
    });
    expect(parsed.opts().stateBucket).toBe('my-bucket');
  });
});
