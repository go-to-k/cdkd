import type { Command, CommanderError } from 'commander';
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

/**
 * Issue [#2528](https://github.com/go-to-k/cdkd/issues/2528): the three cdkd
 * state-source flags declared above PARSE and do NOTHING on this command.
 *
 * Verified against the installed `cdk-local@0.147.7` bundle: all three
 * consumers miss cdkd's registered provider — `resolveDeployedS3Origins` and
 * `attachKvsModules` both gate on `isCfnFlagPresent(options)` (i.e.
 * `--from-cfn-stack` specifically, not the "any state source is active"
 * predicate `start-api` uses), and the two Lambda boot paths call
 * `resolveLambdaContainerEnv` without its `extraStateProviders` argument at all.
 * A user emulating a cdkd-deployed distribution therefore got the same `502`
 * from an unresolved origin with the flag as without it, on exactly the command
 * where they were already troubleshooting.
 *
 * The issue settles that "a flag that parses and does nothing is worse than one
 * that errors", so cdkd REFUSES them until go-to-k/cdk-local#699 lands. What is
 * pinned here is the issue's own verification bar for the refusal branch: a
 * parse-level case per flag, WITH the `--from-cfn-stack` path still accepted
 * beside it — otherwise a refusal that rejected everything would pass too.
 */
describe('start-cloudfront refuses the state-source flags it cannot honor (#2528)', () => {
  /** A command whose action is stubbed and whose exit/stderr are captured. */
  function refusable(): Command {
    const cmd = createLocalStartCloudFrontCommand();
    cmd.action(() => {});
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: () => {} });
    return cmd;
  }

  function refusalFor(argv: string[]): CommanderError {
    const cmd = refusable();
    try {
      cmd.parse(['My/Dist', ...argv], { from: 'user' });
    } catch (error) {
      return error as CommanderError;
    }
    throw new Error(`expected ${argv.join(' ')} to be refused, but parse() returned normally`);
  }

  it.each([
    [['--from-state'], '--from-state'],
    [['--state-bucket', 'my-bucket'], '--state-bucket'],
    [['--state-prefix', 'custom'], '--state-prefix'],
  ])('refuses %s', (argv, flag) => {
    const error = refusalFor(argv as string[]);
    expect(error.code).toBe('cdkd.startCloudFrontStateFlagUnsupported');
    expect(error.message).toContain(flag as string);
    // The message must point somewhere: a refusal with no remedy just moves the
    // dead end earlier.
    expect(error.message).toContain('--from-cfn-stack');
    // The EXIT CODE, not just the message. `Command.error` was chosen over a
    // thrown CdkdError precisely because a hook throw escapes `withErrorHandling`
    // and surfaces as `Fatal error:` plus a stack; asserting only the text would
    // leave that choice unfenced.
    expect(error.exitCode).toBe(1);
  });

  it('names EVERY offending flag, and agrees with itself on plurality', () => {
    const one = refusalFor(['--from-state']);
    expect(one.message).toMatch(/--from-state is not supported/);
    const many = refusalFor(['--from-state', '--state-bucket', 'b', '--state-prefix', 'p']);
    expect(many.message).toContain('--from-state');
    expect(many.message).toContain('--state-bucket');
    expect(many.message).toContain('--state-prefix');
    // The singular/plural arm is a real branch in a rendered string, so it gets
    // an assertion rather than riding along on a `toContain` of the flag names.
    expect(many.message).toMatch(/--state-prefix are not supported/);
  });

  it('tells the user to DROP the flags, not merely to add --from-cfn-stack', () => {
    // Adding `--from-cfn-stack` while leaving `--from-state` on re-triggers this
    // same refusal, so a remedy naming only the replacement sends the user in a
    // circle.
    expect(refusalFor(['--from-state']).message).toMatch(/DROP the flag/);
  });

  it('marks the three flags as unsupported in their own --help descriptions', () => {
    // The parser and the help must not drift apart again — reverting these three
    // descriptions to the pre-fix wording re-creates exactly the class of defect
    // this PR fixes, and every other case here would stay green.
    const cmd = createLocalStartCloudFrontCommand();
    for (const long of ['--from-state', '--state-bucket', '--state-prefix']) {
      const option = cmd.options.find((o) => o.long === long);
      expect(option, `${long} is no longer declared`).toBeDefined();
      expect(
        option?.description,
        `${long}'s help does not say it is unsupported on this command`
      ).toContain('[not supported on start-cloudfront]');
    }
  });

  it('does NOT refuse the commander-supplied --state-prefix default', () => {
    // The discriminator for the `getOptionValueSource` check: `--state-prefix`
    // carries a default, so a presence test on its VALUE would refuse every
    // invocation of this command, including one passing no state flag at all.
    const cmd = refusable();
    cmd.action(() => {}); // no-op stub — `refusable()` sets one, restated for the gate
    expect(() => cmd.parse(['My/Dist'], { from: 'user' })).not.toThrow();
    expect(cmd.opts().statePrefix).toBe('cdkd');
  });

  it('still accepts --from-cfn-stack, the state source that DOES work here', () => {
    // Without this arm the refusal could pass by rejecting everything.
    const cmd = refusable();
    cmd.action(() => {}); // no-op stub — `refusable()` sets one, restated for the gate
    expect(() =>
      cmd.parse(['My/Dist', '--from-cfn-stack', 'MyStack'], { from: 'user' })
    ).not.toThrow();
    expect(cmd.opts().fromCfnStack).toBe('MyStack');
  });

  it('keeps the flags DECLARED, so the refusal can explain instead of "unknown option"', () => {
    const longs = createLocalStartCloudFrontCommand().options.map((o) => o.long);
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--state-bucket');
    expect(longs).toContain('--state-prefix');
  });
});
