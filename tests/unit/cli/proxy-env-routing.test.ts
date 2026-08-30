import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliPath = join(repoRoot, 'dist', 'cli.js');

/**
 * The reporter's own repro, INVERTED (issue #2388).
 *
 * The bug was that cdkd ignored `HTTPS_PROXY`, so the way to test it without
 * standing up a proxy is to point cdkd at one that cannot possibly work and
 * require the run to FAIL. Before the fix the variable was never consulted and
 * the command succeeded — or failed for an unrelated reason — regardless of
 * what it named.
 *
 * WHAT IS ASSERTED, AND WHY NOT AN ERROR CLASS
 *
 * A non-zero exit plus EVIDENCE OF A CONNECTION ATTEMPT to the named proxy.
 * Not a specific error class: the SDK retries, and which call fails first
 * differs as more construction sites are migrated (PR 2 moves the remaining
 * ones), so binding to a class would make this test fail for a reason that is
 * not a regression.
 *
 * WHAT THIS TEST CANNOT TELL YOU
 *
 * That the sweep is COMPLETE. It passes as soon as ANY one call fails, so a
 * later, still-unrouted client is invisible to it — which is exactly how the
 * `config-loader.ts` gap survived the original bootstrap repro. The check that
 * covers the whole population is `scripts/check-aws-client-defaults.ts` (see
 * `tests/unit/scripts/aws-client-defaults-fence.test.ts`); this one covers the
 * end-to-end wiring that a unit test of the helper cannot reach.
 *
 * `state list` rather than `bootstrap`: bootstrap derives the default bucket
 * name through a pure function and never reaches the `config-loader.ts` probe,
 * so it exercises strictly fewer of the migrated paths — and it creates real
 * AWS resources, which a unit test must not.
 */

/** Refused immediately on every platform: port 1 has no listener. */
const DEAD_PROXY = 'http://127.0.0.1:1';

/**
 * Every spelling, deliberately. `proxy-from-env` prefers the LOWER-CASE form,
 * so setting only `HTTPS_PROXY` while a developer's shell exports
 * `https_proxy` sends the run to their REAL proxy and the test reports a
 * false green. Measured during development: exactly that happened.
 */
const DEAD_PROXY_ENV = {
  HTTPS_PROXY: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  HTTP_PROXY: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
};

/**
 * A credential-free, network-free identity. Static keys resolve without a
 * round trip, so the FIRST network call the process makes is the API call —
 * which is the call this test is about. Without them the run could fail inside
 * credential resolution for a reason unrelated to the proxy.
 */
const FAKE_IDENTITY = {
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_REGION: 'us-east-1',
};

/** Cleared so a developer's or runner's own values cannot decide the outcome. */
const CLEARED = [
  'AWS_PROFILE',
  // Cleared with the keys rather than left behind: an ambient token riding
  // along with the fake keys would make the subprocess's identity depend on
  // the developer's shell. It could only ever reach `127.0.0.1:1` or a real
  // AWS endpoint, so this is hermeticity rather than exposure.
  'AWS_SESSION_TOKEN',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const;

function runCli(extraEnv: Record<string, string>): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...FAKE_IDENTITY };
  for (const name of CLEARED) delete env[name];
  Object.assign(env, extraEnv);

  const result = spawnSync(process.execPath, [cliPath, 'state', 'list'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const distMissing = !existsSync(cliPath);
// Mirrors `tests/unit/cli/version.test.ts`: a skip is correct in a worktree
// that has not been built, and MUST NOT be a skip in the job that builds.
const skipUnbuilt = distMissing && !process.env['CDKD_EXPECT_DIST'];

describe.skipIf(skipUnbuilt)('the CLI routes AWS traffic through the proxy variables', () => {
  function requireBuiltCli(): void {
    expect(
      distMissing,
      'CDKD_EXPECT_DIST is set but dist/cli.js is absent — `vp run build` must run ' +
        'before `vp run test` in .github/workflows/ci.yml.'
    ).toBe(false);
  }

  it('fails, naming the unreachable proxy, when pointed at one that cannot work', () => {
    requireBuiltCli();
    const { status, output } = runCli(DEAD_PROXY_ENV);

    expect(status, `expected a non-zero exit; output was:\n${output}`).not.toBe(0);
    expect(
      output,
      'the run must show a connection ATTEMPT to the configured proxy — without ' +
        'that, a non-zero exit proves only that something failed'
    ).toContain('127.0.0.1:1');
  }, 90_000);

  it('does not name that proxy when no proxy is configured — the control', () => {
    // Without this, the assertion above passes on a build that mentions
    // `127.0.0.1:1` for any reason at all, including one that has nothing to do
    // with routing. It is the half that makes the first half discriminating.
    //
    // The failure REASON here is deliberately not asserted: it is a credential
    // error on a clean runner and a TLS-interception error on a machine behind
    // a transparent proxy, and neither is what this test is about.
    requireBuiltCli();
    const { status, output } = runCli({});

    expect(status).not.toBe(0);
    expect(output).not.toContain('127.0.0.1:1');
  }, 90_000);
});
