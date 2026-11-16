import { describe, expect, it } from 'vite-plus/test';
import { createDeployCommand } from '../../../src/cli/commands/deploy.js';

/**
 * go-to-k/cdkd#6437: `--update-policy` / `--no-update-policy` is a PAIR with
 * no default, so "neither" stays `undefined` and `resolveUpdatePolicy` can fall
 * through to cdk.json. A default on either Option would collapse that.
 */
function parsedUpdatePolicy(args: string[]): unknown {
  const cmd = createDeployCommand();
  cmd.exitOverride();
  cmd.action(() => {});
  cmd.parse(args, { from: 'user' });
  return cmd.opts()['updatePolicy'];
}

describe('deploy --update-policy flag pair (go-to-k/cdkd#6437)', () => {
  it('is undefined when neither flag is passed', () => {
    expect(parsedUpdatePolicy([])).toBeUndefined();
  });

  it('--update-policy parses to true', () => {
    expect(parsedUpdatePolicy(['--update-policy'])).toBe(true);
  });

  it('--no-update-policy parses to false', () => {
    expect(parsedUpdatePolicy(['--no-update-policy'])).toBe(false);
  });
});
