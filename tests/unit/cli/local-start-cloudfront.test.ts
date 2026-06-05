import { describe, expect, it } from 'vite-plus/test';
import { createLocalStartCloudFrontCommand } from '../../../src/cli/commands/local-start-cloudfront.js';

// Unit coverage for the cdkd `local start-cloudfront` wrapper. start-cloudfront
// is a THIN pass-through to cdk-local's factory: the serve behavior + the
// cloudfront-specific option block (`--port` / `--host` / `--origin` /
// `--kvs-file` / `--cache-origin` / `--no-pull` / `--tls` / `--tls-cert` /
// `--tls-key` / `--watch`) live in cdk-local and are covered by cdk-local's own
// tests; cdkd inherits them via the factory. As of cdk-local#380 the command
// also serves Lambda Function URL origins (RIE) + deployed-S3 origins, so it
// inherits cdk-local's `--from-cfn-stack` / `--stack-region` / `--assume-role`
// state-source flags. As of cdk-local 0.128.0 (cdk-local#426 / #436) the
// factory accepts the `extraStateProviders` seam, so cdkd now threads its
// S3-backed `--from-state` factory in and layers `--from-state` /
// `--state-bucket` / `--state-prefix` on top (issue #766) — the same wiring as
// the agentcore / alb / service wrappers. The contract THIS test pins is that
// wiring: the cdkd state-source flags are present + defaulted, alongside the
// inherited CFn ones. End-to-end behavior is exercised by the
// `local-start-cloudfront` integ fixture.

describe('createLocalStartCloudFrontCommand', () => {
  // `cmd.parse([...])` runs the registered `.action(handler)` body. The
  // production handler boots a real local server; stub to a no-op so parse()
  // only exercises Commander's option parser (the cmd-parse-stub-gate hook
  // enforces this stub for any cmd.parse() in tests).
  const cmd = createLocalStartCloudFrontCommand();
  cmd.action(() => {});

  it('registers the start-cloudfront subcommand name', () => {
    expect(cmd.name()).toBe('start-cloudfront');
  });

  it('accepts a single optional positional target (not variadic)', () => {
    const args = cmd.registeredArguments.map((a) => a.name());
    expect(args).toEqual(['target']);
    expect(cmd.registeredArguments[0]?.variadic).toBe(false);
    expect(cmd.registeredArguments[0]?.required).toBe(false);
  });

  it('inherits the cloudfront-specific options from cdk-local', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--origin');
    expect(longs).toContain('--kvs-file');
    expect(longs).toContain('--tls');
    expect(longs).toContain('--tls-cert');
    expect(longs).toContain('--tls-key');
    expect(longs).toContain('--watch');
  });

  it("inherits cdk-local's CFn state-source flags (Function URL + deployed-S3 origins, #380)", () => {
    // start-cloudfront now serves Lambda Function URL origins (RIE) and
    // deployed-S3 origins, so cdk-local's factory carries --from-cfn-stack /
    // --stack-region / --assume-role to bind them to deployed CloudFormation state.
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-cfn-stack');
    expect(longs).toContain('--stack-region');
    expect(longs).toContain('--assume-role');
  });

  it("declares cdkd's S3-backed state-source options (#766, via cdk-local#426 seam)", () => {
    // cdk-local 0.128.0's start-cloudfront factory accepts `extraStateProviders`,
    // so cdkd threads its --from-state factory in and layers these three flags
    // on top — mirroring start-agentcore / start-alb / start-service.
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--state-bucket');
    expect(longs).toContain('--state-prefix');
  });

  it('defaults --from-state to false and --state-prefix to "cdkd"', () => {
    expect(cmd.options.find((o) => o.long === '--from-state')?.defaultValue).toBe(false);
    expect(cmd.options.find((o) => o.long === '--state-prefix')?.defaultValue).toBe('cdkd');
  });

  it('defaults --port to "0" and --host to "127.0.0.1"', () => {
    expect(cmd.options.find((o) => o.long === '--port')?.defaultValue).toBe('0');
    expect(cmd.options.find((o) => o.long === '--host')?.defaultValue).toBe('127.0.0.1');
  });

  it('parses --tls as a boolean flag (no value)', () => {
    const fresh = createLocalStartCloudFrontCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'My/Dist', '--tls'], { from: 'user' });
    expect(parsed.opts().tls).toBe(true);
  });

  it('parses --origin as a repeatable flag that builds an array', () => {
    const fresh = createLocalStartCloudFrontCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(
      ['node', 'cdkd', 'My/Dist', '--origin', 'O1=./dist', '--origin', 'O2=./admin'],
      { from: 'user' }
    );
    expect(parsed.opts().origin).toEqual(['O1=./dist', 'O2=./admin']);
  });

  it('parses --port <port>', () => {
    const fresh = createLocalStartCloudFrontCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'My/Dist', '--port', '8080'], { from: 'user' });
    expect(parsed.opts().port).toBe('8080');
  });
});
