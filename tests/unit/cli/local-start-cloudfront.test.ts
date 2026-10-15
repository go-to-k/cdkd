import type { Command } from 'commander';
import { describe, expect, it } from 'vite-plus/test';
import { createLocalStateProvider as createCdkLocalStateProvider } from 'cdk-local';
import { createLocalStartCloudFrontCommand } from '../../../src/cli/commands/local-start-cloudfront.js';
import { cdkdExtraStateProviders } from '../../../src/cli/commands/local-state-source.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';

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
  // only exercises Commander's option parser (a no-op action stub
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
    const parsed = fresh.parse(['My/Dist', '--tls'], { from: 'user' });
    expect(parsed.opts().tls).toBe(true);
  });

  it('parses --origin as a repeatable flag that builds an array', () => {
    const fresh = createLocalStartCloudFrontCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(
      ['My/Dist', '--origin', 'O1=./dist', '--origin', 'O2=./admin'],
      { from: 'user' }
    );
    expect(parsed.opts().origin).toEqual(['O1=./dist', 'O2=./admin']);
  });

  it('parses --port <port>', () => {
    const fresh = createLocalStartCloudFrontCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['My/Dist', '--port', '8080'], { from: 'user' });
    expect(parsed.opts().port).toBe('8080');
  });
});

/**
 * Issue [#2600](https://github.com/go-to-k/cdkd/issues/2600): cdk-local 0.151.0
 * (go-to-k/cdk-local#699) consults a host's `extraStateProviders` on every
 * state-backed path of start-cloudfront — the deployed-S3 origin, the KVS
 * bindings and the Function URL / Lambda@Edge container env — and hands the
 * factory the FULL parsed options bag. That consultation is upstream's and is
 * tested there; what cdkd owns, and what is pinned here, is that the flags are
 * ACCEPTED again (the #2528 refusal is gone) and that the registry cdkd hands
 * the factory selects cdkd's S3 provider from the bag this command parses,
 * companions included. Real end to end: the `local-start-cloudfront-from-state`
 * integ, which serves a cdkd-deployed S3 origin under `--from-state`.
 */
describe('start-cloudfront honors --from-state (#2600)', () => {
  function parsed(argv: string[]): Command {
    const cmd = createLocalStartCloudFrontCommand();
    cmd.action(() => {});
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: () => {} });
    cmd.parse(['My/Dist', ...argv], { from: 'user' });
    return cmd;
  }

  it('accepts --from-state with its companion flags', () => {
    const cmd = parsed(['--from-state', '--state-bucket', 'my-bucket', '--state-prefix', 'p']);
    expect(cmd.opts()).toMatchObject({
      fromState: true,
      stateBucket: 'my-bucket',
      statePrefix: 'p',
    });
  });

  it('no longer marks the flags unsupported in --help', () => {
    const cmd = createLocalStartCloudFrontCommand();
    for (const long of ['--from-state', '--state-bucket', '--state-prefix']) {
      const option = cmd.options.find((o) => o.long === long);
      expect(option, `${long} is no longer declared`).toBeDefined();
      expect(option?.description).not.toContain('not supported');
    }
  });

  it("selects cdkd's S3 provider from the parsed bag, through cdk-local's dispatcher", () => {
    const cmd = parsed(['--from-state', '--state-bucket', 'my-bucket', '--state-prefix', 'p']);
    // The same dispatcher cdk-local's start-cloudfront calls on each path, with
    // the same registry the command was built with.
    const provider = createCdkLocalStateProvider(
      cmd.opts() as never,
      'MyStack',
      'us-east-1',
      cdkdExtraStateProviders
    );
    expect(provider).toBeInstanceOf(S3LocalStateProvider);
    // The companions reached the factory: it reads them from the same bag.
    expect((provider as unknown as { opts: unknown }).opts).toMatchObject({
      stateBucket: 'my-bucket',
      statePrefix: 'p',
    });
    provider?.dispose();
  });

  it('keeps --from-state and --from-cfn-stack mutually exclusive', () => {
    const cmd = parsed(['--from-state', '--from-cfn-stack', 'MyStack']);
    expect(() =>
      createCdkLocalStateProvider(cmd.opts() as never, 'MyStack', 'us-east-1', cdkdExtraStateProviders)
    ).toThrow(/mutually exclusive/);
  });
});
