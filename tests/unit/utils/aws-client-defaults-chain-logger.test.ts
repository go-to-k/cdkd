import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

import {
  awsClientDefaults,
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  CHAIN_LOGGER,
  PROXY_ENV_VARS,
} from '../../../src/utils/aws-client-defaults.ts';

/**
 * The logger `awsClientDefaults` hands shape 3's injected credential chain
 * (PR [#3223](https://github.com/go-to-k/cdkd/pull/3223) round 6).
 *
 * **Why this is its own FILE.** The warning it drops is guarded by
 * `multipleCredentialSourceWarningEmitted`, a module-global one-shot inside
 * `@aws-sdk/credential-provider-node` that the SDK sets whether or not the
 * logger printed anything. So the "it was dropped" observation can be made at
 * most ONCE per process, and any earlier case that builds a shape-3 chain
 * spends it — which would leave the assertion passing because the SDK had
 * already fallen silent, not because cdkd's logger filtered it. Sharing a file
 * with the assumed-role suite would do exactly that.
 *
 * For the same reason the drop case is declared FIRST and is the only case in
 * this file that depends on the one-shot.
 *
 * **What keeps the drop case honest**, given it asserts an absence: the second
 * case drives the SAME chain and proves a DIFFERENT warning does arrive, so
 * the logger is demonstrably wired in rather than bypassed. Probed alive by
 * changing the matched needle in `aws-client-defaults.ts` to a string the
 * warning does not contain — the drop case then reds with the SDK's text.
 */

const ROLE_KEY = 'ASIAASSUMEDROLECREDS0';
// 21 characters: `git-secrets` matches an AWS access key id as EXACTLY 20.
const CALLER_KEY = 'AKIACALLEROWNCREDS000';

const AWS_ENV = [
  'HOME',
  'USERPROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  ...PROXY_ENV_VARS,
] as const;

const scratch: string[] = [];
let saved: Record<string, string | undefined>;

/** A private AWS home, so the developer's own profiles decide nothing. */
function awsHome(withDefaultProfile: boolean): void {
  const home = mkdtempSync(join(tmpdir(), 'cdkd-chain-logger-'));
  scratch.push(home);
  if (withDefaultProfile) {
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(join(home, '.aws', 'config'), '[default]\nregion = eu-west-1\n');
    writeFileSync(
      join(home, '.aws', 'credentials'),
      `[default]\naws_access_key_id = ${CALLER_KEY}\naws_secret_access_key = callersecret\n`
    );
  }
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
}

/** The state `applyRoleArnIfSet` leaves behind for a caller with no triple. */
function publishRole(): void {
  process.env['AWS_ACCESS_KEY_ID'] = ROLE_KEY;
  process.env['AWS_SECRET_ACCESS_KEY'] = 'assumedsecret';
  process.env['AWS_SESSION_TOKEN'] = 'assumedtoken';
  setAssumedRoleCredentials({
    accessKeyId: ROLE_KEY,
    secretAccessKey: 'assumedsecret',
    sessionToken: 'assumedtoken',
  });
}

/** Resolve shape 3's chain, returning whatever it did — value or rejection. */
async function runShape3Chain(): Promise<void> {
  const credentials = awsClientDefaults({ ignoreAssumedRole: true }).credentials;
  // A function is the chain; anything else means the call took another shape
  // and this case would be testing nothing.
  expect(typeof credentials).toBe('function');
  await (credentials as () => Promise<unknown>)().catch(() => undefined);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = Object.fromEntries(AWS_ENV.map((n) => [n, process.env[n]]));
  for (const n of AWS_ENV) delete process.env[n];
  resetAwsClientDefaults();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  for (const n of AWS_ENV) {
    const v = saved[n];
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  resetAwsClientDefaults();
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Everything the chain routed to `console.warn`, flattened to one string. */
function warnedText(): string {
  const calls = warnSpy.mock.calls as unknown as unknown[][];
  return calls.map((call) => call.map((arg) => String(arg)).join(' ')).join('\n');
}

it('DROPS the `Multiple credential sources detected` warning, which is false here', async () => {
  // Shape 3 NAMES `default` as the profile in order to subtract the chain's env
  // link, and the env triple is the one cdkd itself wrote — so the SDK's
  // "Both AWS_PROFILE and the pair ... are set" describes a conflict the user
  // did not create and cannot act on. It would otherwise reach `console.warn`,
  // outside cdkd's logger entirely.
  awsHome(true);
  publishRole();

  await runShape3Chain();

  expect(warnedText()).not.toContain('Multiple credential sources detected');
  // The advisory tail goes with it — matching only the headline would leave
  // the rest of the block printed on its own.
  expect(warnedText()).not.toContain('AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY pair');
});

it('FORWARDS a warning it does not match, so the filter is not a silencer', async () => {
  // `@aws-sdk/credential-provider-http`'s `fromHttp` warns when both
  // container-credential token spellings are set. It is one of shape 3's OWN
  // population — a container caller is exactly who takes this path — so a
  // blanket `warn: () => {}` would swallow a real misconfiguration report from
  // the very callers the shape exists for.
  //
  // No `.aws` here, so the chain falls through the ini links and reaches the
  // remote provider. The full URI names a host `fromHttp`'s own `checkUrl`
  // rejects, which happens AFTER the warnings and BEFORE any socket — so the
  // case needs neither the network nor the suite's fence, and costs no retry
  // back-off.
  awsHome(false);
  process.env['AWS_CONTAINER_CREDENTIALS_FULL_URI'] = 'http://not-link-local.example/creds';
  process.env['AWS_CONTAINER_AUTHORIZATION_TOKEN'] = 'inline-token';
  process.env['AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE'] = '/nonexistent/token';
  publishRole();

  await runShape3Chain();

  expect(warnedText()).toContain('awsContainerAuthorizationTokenFile will take precedence');
});

/**
 * The three arms below call the logger DIRECTLY, unlike every case above.
 *
 * They have to: no link in the installed chain calls `logger.error` /
 * `logger?.error` at all (measured 2026-09-17 — `logger?.debug`, `logger?.warn`
 * and `logger.warn` are the only spellings across
 * `@aws-sdk/credential-provider-*`, `@aws-sdk/token-providers` and
 * `@smithy/credential-provider-imds`), so an SDK-driven case cannot reach the
 * arm, and `defaultProvider` closes over the logger rather than exposing it.
 * That is also why the module exports it as a test seam.
 *
 * The arms are DECISIONS the logger's doc comment argues for, and the argument
 * differs per level — `error` is kept defensively, `info` / `debug` / `trace`
 * are no-ops because `defaultProvider` reaches them through `logger?.` and so
 * prints NOTHING without a logger, making a forward a NEW per-link chain trace
 * on every shape-3 run rather than a restored baseline. Nothing else in the
 * tree watches either decision.
 */
it('FORWARDS `error` to the console, the arm no installed chain link reaches', () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const cause = new Error('boom');
    CHAIN_LOGGER.error('Credential renew failed: ', cause);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    // Every argument, in order: the chain passes an error OBJECT alongside the
    // message, and a forward that dropped the tail would read as working.
    expect(errorSpy.mock.calls[0]).toEqual(['Credential renew failed: ', cause]);
  } finally {
    errorSpy.mockRestore();
  }
});

it('does NOT apply the `warn` filter to `error`', () => {
  // The drop is scoped to the one warning it names. An `error` carrying the
  // same text is a different emission and must still be seen — a filter hoisted
  // out of `warn` to "share the logic" would silence it.
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    CHAIN_LOGGER.error('Multiple credential sources detected');

    expect(errorSpy).toHaveBeenCalledTimes(1);
  } finally {
    errorSpy.mockRestore();
  }
});

it('keeps `trace` / `debug` / `info` silent, so no chain trace is newly printed', () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  try {
    CHAIN_LOGGER.trace('per-link trace');
    CHAIN_LOGGER.debug('per-link debug');
    CHAIN_LOGGER.info('per-link info');

    // `warnSpy` is armed by `beforeEach`; the other four cover every console
    // method a "just forward it like warn" edit would plausibly reach for.
    expect(warnedText()).toBe('');
    for (const spy of [errorSpy, logSpy, infoSpy, debugSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
  } finally {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
});
