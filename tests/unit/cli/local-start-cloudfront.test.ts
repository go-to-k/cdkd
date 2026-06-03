import { describe, expect, it } from 'vite-plus/test';
import { createLocalStartCloudFrontCommand } from '../../../src/cli/commands/local-start-cloudfront.js';

// Unit coverage for the cdkd `local start-cloudfront` wrapper. start-cloudfront
// is a THIN pass-through to cdk-local's factory: it is pure-local (no Docker,
// no AWS call) and adds NO cdkd-specific options. The serve behavior + the
// cloudfront-specific option block (`--port` / `--host` / `--origin` / `--tls`
// / `--tls-cert` / `--tls-key` / `--watch`) live in cdk-local and are covered
// by cdk-local's own tests; cdkd inherits them via the factory. The contract
// THIS test pins is the cdkd-side asymmetry vs the api / alb / service
// wrappers: because there is no deployed state to bind, the command must carry
// NEITHER the cdkd state-source options (`--from-state` / `--state-bucket` /
// `--state-prefix`) NOR cdk-local's `--from-cfn-stack` / `--assume-role`.
// End-to-end behavior is exercised by the `local-start-cloudfront` integ fixture.

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
    expect(longs).toContain('--tls');
    expect(longs).toContain('--tls-cert');
    expect(longs).toContain('--tls-key');
    expect(longs).toContain('--watch');
  });

  it('does NOT carry the cdkd state-source options (no state to bind)', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).not.toContain('--from-state');
    expect(longs).not.toContain('--state-bucket');
    expect(longs).not.toContain('--state-prefix');
  });

  it('does NOT carry --from-cfn-stack / --assume-role (start-cloudfront makes no AWS call)', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).not.toContain('--from-cfn-stack');
    expect(longs).not.toContain('--assume-role');
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
